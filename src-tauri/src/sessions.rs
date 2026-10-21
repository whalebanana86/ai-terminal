//! Claude Code / Codex 세션 기록 색인기. 원본 기록은 **읽기만** 한다.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::env::{home_dir, shell_env};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    /// `claude:<uuid>` / `codex:<uuid>`
    pub id: String,
    pub agent: String,
    pub external_id: String,
    pub title: String,
    pub first_prompt: Option<String>,
    /// CLI 가 기록한 작업 폴더. 재개는 반드시 이 폴더에서 한다.
    pub cwd: Option<String>,
    /// 마지막 기록의 작업 폴더. 대화 도중 cd/워크트리 이동이 있었으면 cwd 와 다르다.
    pub last_cwd: Option<String>,
    /// 세션 시작 때 기록된 브랜치 (과거 기록)
    pub start_branch: Option<String>,
    /// 세션 마지막 기록의 브랜치 (과거 기록)
    pub last_branch: Option<String>,
    /// 밀리초
    pub created_at: i64,
    pub updated_at: i64,
    pub source_path: String,
    pub archived: bool,
    /// cli / sdk-cli / vscode 등 세션을 만든 곳
    pub origin: Option<String>,
}

// ───────────────────────────── 공통 도구 ─────────────────────────────

/// 테스트(디버그 빌드)에서 가짜 HOME 을 쓰는 중인지. 배포 빌드에서는 항상 false.
fn test_home_override() -> bool {
    cfg!(debug_assertions) && std::env::var_os("AITERM_HOME").is_some()
}

pub fn claude_dir() -> PathBuf {
    shell_env()
        .get("CLAUDE_CONFIG_DIR")
        .filter(|_| !test_home_override())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".claude"))
}

pub fn codex_dir() -> PathBuf {
    shell_env()
        .get("CODEX_HOME")
        .filter(|_| !test_home_override())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".codex"))
}

/// "2026-10-20T23:12:08.217Z" → 유닉스 밀리초
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, se) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let mut ms = 0;
    let mut rest = &s[19..];
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: String = frac.chars().take_while(|c| c.is_ascii_digit()).collect();
        let first3 = format!("{:0<3}", &digits[..digits.len().min(3)]);
        ms = first3.parse::<i64>().ok()?;
        rest = &frac[digits.len()..];
    }
    let mut offset_min = 0;
    if let Some(sign) = rest.chars().next().filter(|c| *c == '+' || *c == '-') {
        let oh: i64 = rest.get(1..3)?.parse().ok()?;
        let om: i64 = rest.get(4..6).and_then(|x| x.parse().ok()).unwrap_or(0);
        offset_min = (oh * 60 + om) * if sign == '+' { 1 } else { -1 };
    }
    // days_from_civil (Howard Hinnant)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400 + h * 3600 + mi * 60 + se) - offset_min * 60) * 1000 + ms)
}

fn file_stamp(p: &Path) -> Option<(u64, i64)> {
    let m = std::fs::metadata(p).ok()?;
    let mtime = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64;
    Some((m.len(), mtime))
}

fn truncate_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(n).collect();
        t.push('…');
        t
    }
}

fn one_line(s: &str, n: usize) -> String {
    truncate_chars(&s.split_whitespace().collect::<Vec<_>>().join(" "), n)
}

/// 압축(.zst) 여부와 관계없이 줄 단위로 읽는다.
fn open_lines(path: &Path) -> Result<Box<dyn BufRead>> {
    let f = File::open(path).with_context(|| format!("{} 를 열 수 없습니다", path.display()))?;
    if path.extension().is_some_and(|e| e == "zst") {
        Ok(Box::new(BufReader::new(zstd::stream::read::Decoder::new(f)?)))
    } else {
        Ok(Box::new(BufReader::with_capacity(256 * 1024, f)))
    }
}

/// 파일 끝에서부터 완전한 줄을 최대 `max_bytes` 까지 읽는다(뒤에서 앞 순서).
fn tail_lines(path: &Path, max_bytes: u64) -> Vec<String> {
    let Ok(mut f) = File::open(path) else { return Vec::new() };
    let Ok(len) = f.seek(SeekFrom::End(0)) else { return Vec::new() };
    let start = len.saturating_sub(max_bytes);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.split('\n').collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // 잘린 첫 줄
    }
    lines.into_iter().rev().filter(|l| !l.is_empty()).map(str::to_string).collect()
}

// ───────────────────────────── Claude ─────────────────────────────

/// 제목·첫 메시지로 쓰면 안 되는 Claude 내부 메시지인지
fn is_claude_noise(text: &str) -> bool {
    let t = text.trim_start();
    t.is_empty()
        || t.starts_with("<command-")
        || t.starts_with("<local-command")
        || t.starts_with("<system-reminder")
        || t.starts_with("Caveat:")
        || t.starts_with("[Request interrupted")
        || t.starts_with("<bash-")
        || t.starts_with("<task-notification")
}

fn claude_user_text(v: &Value) -> Option<String> {
    if v.get("type")?.as_str()? != "user" || v.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let content = v.get("message")?.get("content")?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter(|i| i.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|i| i.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    (!is_claude_noise(&text)).then_some(text)
}

/// CLI 인자로 넘길 세션 id 로 안전한지 (옵션으로 해석될 수 있는 값 거부)
pub fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty() && !id.starts_with('-') && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn parse_claude_session(path: &Path) -> Option<SessionMeta> {
    let external_id = path.file_stem()?.to_str()?.to_string();
    if !is_safe_session_id(&external_id) {
        return None;
    }
    let (_, mtime) = file_stamp(path)?;
    let mut meta = SessionMeta {
        id: format!("claude:{external_id}"),
        agent: "claude".into(),
        external_id,
        source_path: path.to_string_lossy().into_owned(),
        updated_at: mtime,
        ..Default::default()
    };

    // 머리: 첫 cwd / gitBranch / 시각 / 사용자 메시지
    let reader = open_lines(path).ok()?;
    let mut read_bytes = 0usize;
    for line in reader.split(b'\n').take(3000) {
        let Ok(line) = line else { break };
        read_bytes += line.len();
        let Ok(v) = serde_json::from_slice::<Value>(&line) else { continue };
        if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if meta.cwd.is_none() {
            meta.cwd = v.get("cwd").and_then(Value::as_str).map(str::to_string);
        }
        if meta.start_branch.is_none() {
            meta.start_branch = v.get("gitBranch").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
        }
        if meta.created_at == 0 {
            meta.created_at = v.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms).unwrap_or(0);
        }
        if meta.origin.is_none() {
            meta.origin = v.get("entrypoint").and_then(Value::as_str).map(str::to_string);
        }
        if meta.first_prompt.is_none() {
            meta.first_prompt = claude_user_text(&v).map(|t| one_line(&t, 300));
        }
        if meta.cwd.is_some() && meta.start_branch.is_some() && meta.first_prompt.is_some() && meta.created_at > 0 {
            break;
        }
        if read_bytes > 16 * 1024 * 1024 {
            break;
        }
    }

    // 꼬리: 마지막 브랜치·시각·제목. 줄이 매우 길 수 있어 점점 넓혀 읽는다.
    let mut ai_title = None;
    let mut custom_title = None;
    let mut summary = None;
    for window in [128 * 1024u64, 1024 * 1024, 8 * 1024 * 1024] {
        let mut found_branch = false;
        for line in tail_lines(path, window) {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            match v.get("type").and_then(Value::as_str) {
                Some("ai-title") if ai_title.is_none() => {
                    ai_title = v.get("aiTitle").and_then(Value::as_str).map(str::to_string)
                }
                Some("custom-title") if custom_title.is_none() => {
                    custom_title = v.get("customTitle").and_then(Value::as_str).map(str::to_string)
                }
                Some("summary") if summary.is_none() => {
                    summary = v.get("summary").and_then(Value::as_str).map(str::to_string)
                }
                _ => {}
            }
            if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            if meta.last_cwd.is_none() {
                meta.last_cwd = v.get("cwd").and_then(Value::as_str).map(str::to_string);
            }
            if !found_branch
                && let Some(b) = v.get("gitBranch").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    meta.last_branch = Some(b.to_string());
                    found_branch = true;
                    if let Some(ts) = v.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms) {
                        meta.updated_at = meta.updated_at.max(ts);
                    }
                }
        }
        if found_branch {
            break;
        }
    }
    meta.cwd.as_ref()?;
    if meta.created_at == 0 {
        meta.created_at = meta.updated_at;
    }
    meta.title = custom_title
        .or(ai_title)
        .or(summary)
        .or_else(|| meta.first_prompt.as_ref().map(|p| one_line(p, 80)))
        .unwrap_or_else(|| "(제목 없음)".into());
    Some(meta)
}

/// `~/.claude/projects/*/<uuid>.jsonl` (하위 폴더의 subagent 기록 제외)
pub fn claude_session_files() -> Vec<PathBuf> {
    let root = claude_dir().join("projects");
    let mut out = Vec::new();
    let Ok(dirs) = std::fs::read_dir(&root) else { return out };
    for d in dirs.flatten() {
        let Ok(files) = std::fs::read_dir(d.path()) else { continue };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().is_some_and(|e| e == "jsonl") && p.is_file() {
                out.push(p);
            }
        }
    }
    out
}

pub fn find_claude_file(external_id: &str) -> Option<PathBuf> {
    claude_session_files().into_iter().find(|p| p.file_stem().is_some_and(|s| s == external_id))
}

// ───────────────────────────── Codex ─────────────────────────────

/// rollout_path 는 `.jsonl` 로 적혀 있어도 실제로는 `.jsonl.zst` 일 수 있다.
pub fn resolve_rollout(p: &str) -> Option<PathBuf> {
    let base = PathBuf::from(p);
    if base.is_file() {
        return Some(base);
    }
    let zst = PathBuf::from(format!("{p}.zst"));
    if zst.is_file() {
        return Some(zst);
    }
    // 보관 처리되며 archived_sessions 로 옮겨진 경우
    let name = base.file_name()?.to_string_lossy().into_owned();
    let archived = codex_dir().join("archived_sessions");
    for cand in [archived.join(&name), archived.join(format!("{name}.zst"))] {
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct RolloutHeader {
    pub id: Option<String>,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub created_at: i64,
    pub origin: Option<String>,
    pub first_prompt: Option<String>,
}

fn is_codex_noise(text: &str) -> bool {
    let t = text.trim_start();
    t.is_empty()
        || t.starts_with("<environment_context>")
        || t.starts_with("<user_instructions>")
        || t.starts_with("<permissions")
        || t.starts_with("<skills_instructions>")
        || t.starts_with("# AGENTS.md")
        || t.starts_with("<turn_aborted>")
}

fn codex_user_text(v: &Value) -> Option<String> {
    let p = v.get("payload")?;
    match (v.get("type")?.as_str()?, p.get("type")?.as_str()?) {
        ("event_msg", "user_message") => p.get("message")?.as_str().map(str::to_string),
        ("event_msg", "item_completed") if p.get("item")?.get("type")?.as_str()? == "UserMessage" => {
            let parts = p.get("item")?.get("content")?.as_array()?;
            Some(parts.iter().filter_map(|x| x.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"))
        }
        _ => None,
    }
    .filter(|t| !is_codex_noise(t))
}

pub fn parse_rollout_header(path: &Path) -> Option<RolloutHeader> {
    let reader = open_lines(path).ok()?;
    let mut h = RolloutHeader::default();
    for line in reader.split(b'\n').take(400) {
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_slice::<Value>(&line) else { continue };
        if v.get("type").and_then(Value::as_str) == Some("session_meta") {
            let p = v.get("payload")?;
            h.id = p.get("id").or_else(|| p.get("session_id")).and_then(Value::as_str).map(str::to_string);
            h.cwd = p.get("cwd").and_then(Value::as_str).map(str::to_string);
            h.branch = p.get("git").and_then(|g| g.get("branch")).and_then(Value::as_str).map(str::to_string);
            h.created_at = p.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms).unwrap_or(0);
            h.origin = p.get("source").and_then(Value::as_str).map(str::to_string);
        } else if h.first_prompt.is_none() {
            h.first_prompt = codex_user_text(&v).map(|t| one_line(&t, 300));
        }
        if h.id.is_some() && h.first_prompt.is_some() {
            break;
        }
    }
    h.id.is_some().then_some(h)
}

#[derive(Debug, Clone, Default)]
pub struct CodexThreadRow {
    pub id: String,
    pub rollout_path: String,
    pub cwd: String,
    pub title: String,
    pub git_branch: Option<String>,
    pub created_ms: i64,
    pub updated_ms: i64,
    pub archived: bool,
    pub source: Option<String>,
    pub first_user_message: Option<String>,
}

/// 가장 높은 버전의 `state_N.sqlite`
pub fn codex_state_db() -> Option<PathBuf> {
    let mut best: Option<(u32, PathBuf)> = None;
    for e in std::fs::read_dir(codex_dir()).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(n) = name.strip_prefix("state_").and_then(|r| r.strip_suffix(".sqlite")) else { continue };
        let Ok(n) = n.parse::<u32>() else { continue };
        if best.as_ref().is_none_or(|(b, _)| n > *b) {
            best = Some((n, e.path()));
        }
    }
    best.map(|(_, p)| p)
}

pub fn read_codex_threads(db: &Path) -> Result<Vec<CodexThreadRow>> {
    use rusqlite::{Connection, OpenFlags};
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI,
    )?;
    conn.busy_timeout(std::time::Duration::from_millis(500))?;
    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(threads)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<_>>()?;
    let has = |c: &str| cols.iter().any(|x| x == c);
    let pick = |c: &str, fallback: &str| if has(c) { c.to_string() } else { fallback.to_string() };
    let sql = format!(
        "SELECT id, rollout_path, cwd, {title}, {branch}, created_at, updated_at, {archived}, {source}, {first}, {cms}, {ums} FROM threads",
        title = if has("name") { "COALESCE(NULLIF(name,''), title)".to_string() } else { pick("title", "''") },
        branch = pick("git_branch", "NULL"),
        archived = pick("archived", "0"),
        source = pick("source", "NULL"),
        first = pick("first_user_message", "NULL"),
        cms = pick("created_at_ms", "NULL"),
        ums = pick("updated_at_ms", "NULL"),
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], |r| {
            let created: i64 = r.get(5)?;
            let updated: i64 = r.get(6)?;
            Ok(CodexThreadRow {
                id: r.get(0)?,
                rollout_path: r.get(1)?,
                cwd: r.get(2)?,
                title: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                git_branch: r.get::<_, Option<String>>(4)?.filter(|s| !s.is_empty()),
                archived: r.get::<_, Option<i64>>(7)?.unwrap_or(0) != 0,
                source: r.get(8)?,
                first_user_message: r.get::<_, Option<String>>(9)?.filter(|s| !s.is_empty()),
                created_ms: r.get::<_, Option<i64>>(10)?.unwrap_or(created * 1000),
                updated_ms: r.get::<_, Option<i64>>(11)?.unwrap_or(updated * 1000),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn codex_rollout_files() -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() && depth < 4 {
                walk(&p, out, depth + 1);
            } else {
                let name = e.file_name().to_string_lossy().into_owned();
                if name.starts_with("rollout-") && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zst")) {
                    out.push(p);
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(&codex_dir().join("sessions"), &mut out, 0);
    out
}

// ───────────────────────────── 색인 캐시 ─────────────────────────────

/// (경로, 크기, mtime) 가 같으면 다시 파싱하지 않는다.
#[derive(Default)]
pub struct SessionIndex {
    claude: HashMap<PathBuf, ((u64, i64), Option<SessionMeta>)>,
    rollout: HashMap<PathBuf, ((u64, i64), Option<RolloutHeader>)>,
}

impl SessionIndex {
    pub fn claude_meta(&mut self, path: &Path) -> Option<SessionMeta> {
        let stamp = file_stamp(path)?;
        if let Some((s, m)) = self.claude.get(path)
            && *s == stamp {
                return m.clone();
            }
        let meta = parse_claude_session(path);
        self.claude.insert(path.to_path_buf(), (stamp, meta.clone()));
        meta
    }

    pub fn rollout_header(&mut self, path: &Path) -> Option<RolloutHeader> {
        let stamp = file_stamp(path)?;
        if let Some((s, h)) = self.rollout.get(path)
            && *s == stamp {
                return h.clone();
            }
        let h = parse_rollout_header(path);
        self.rollout.insert(path.to_path_buf(), (stamp, h.clone()));
        h
    }

    pub fn scan_claude(&mut self) -> Vec<SessionMeta> {
        let files = claude_session_files();
        let keep: std::collections::HashSet<_> = files.iter().cloned().collect();
        self.claude.retain(|k, _| keep.contains(k));
        files.iter().filter_map(|p| self.claude_meta(p)).collect()
    }

    pub fn scan_codex(&mut self) -> Vec<SessionMeta> {
        let mut by_id: HashMap<String, SessionMeta> = HashMap::new();
        if let Some(db) = codex_state_db() {
            match read_codex_threads(&db) {
                Ok(rows) => {
                    for t in rows.into_iter().filter(|t| is_safe_session_id(&t.id)) {
                        let path = resolve_rollout(&t.rollout_path);
                        let header = path.as_ref().and_then(|p| self.rollout_header(p));
                        let mtime = path.as_ref().and_then(|p| file_stamp(p)).map(|s| s.1).unwrap_or(0);
                        let first = t
                            .first_user_message
                            .clone()
                            .filter(|s| !is_codex_noise(s))
                            .map(|s| one_line(&s, 300))
                            .or_else(|| header.as_ref().and_then(|h| h.first_prompt.clone()));
                        let title = if t.title.trim().is_empty() {
                            first.as_ref().map(|f| one_line(f, 80)).unwrap_or_else(|| "(제목 없음)".into())
                        } else {
                            one_line(&t.title, 120)
                        };
                        by_id.insert(
                            t.id.clone(),
                            SessionMeta {
                                id: format!("codex:{}", t.id),
                                agent: "codex".into(),
                                external_id: t.id.clone(),
                                title,
                                first_prompt: first,
                                cwd: Some(t.cwd.clone()).filter(|s| !s.is_empty()),
                                last_cwd: None,
                                start_branch: header.as_ref().and_then(|h| h.branch.clone()).or(t.git_branch.clone()),
                                last_branch: t.git_branch.clone(),
                                created_at: t.created_ms,
                                updated_at: t.updated_ms.max(mtime),
                                source_path: path.map(|p| p.to_string_lossy().into_owned()).unwrap_or(t.rollout_path),
                                archived: t.archived,
                                origin: t.source.clone(),
                            },
                        );
                    }
                }
                Err(e) => eprintln!("[sessions] Codex state DB 를 읽지 못해 rollout 파일로 대체합니다: {e:#}"),
            }
        }
        // DB 에 없는 rollout (옛 버전, DB 없음) 은 파일 머리로 보충한다.
        for p in codex_rollout_files() {
            let Some(h) = self.rollout_header(&p) else { continue };
            let Some(id) = h.id.clone().filter(|i| is_safe_session_id(i)) else { continue };
            if by_id.contains_key(&id) {
                continue;
            }
            let mtime = file_stamp(&p).map(|s| s.1).unwrap_or(0);
            by_id.insert(
                id.clone(),
                SessionMeta {
                    id: format!("codex:{id}"),
                    agent: "codex".into(),
                    external_id: id,
                    title: h.first_prompt.as_ref().map(|f| one_line(f, 80)).unwrap_or_else(|| "(제목 없음)".into()),
                    first_prompt: h.first_prompt.clone(),
                    cwd: h.cwd.clone(),
                    last_cwd: None,
                    start_branch: h.branch.clone(),
                    last_branch: h.branch.clone(),
                    created_at: if h.created_at > 0 { h.created_at } else { mtime },
                    updated_at: mtime,
                    source_path: p.to_string_lossy().into_owned(),
                    archived: false,
                    origin: h.origin.clone(),
                },
            );
        }
        by_id.into_values().filter(|m| m.cwd.is_some()).collect()
    }
}

// ───────────────────────────── 대화 기록 ─────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptItem {
    /// user | assistant | tool
    pub kind: String,
    pub text: String,
    pub tool: Option<String>,
    pub timestamp: Option<i64>,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TouchedFile {
    /// 기록에 적힌 절대 경로
    pub path: String,
    /// edit | write | add | update | delete
    pub op: String,
    pub count: u32,
    pub last_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub items: Vec<TranscriptItem>,
    pub total: usize,
    pub touched_files: Vec<TouchedFile>,
}

const MAX_ITEMS: usize = 400;
const MAX_TEXT: usize = 6000;

struct Collector {
    items: std::collections::VecDeque<TranscriptItem>,
    total: usize,
    touched: Vec<TouchedFile>,
}

impl Collector {
    fn new() -> Self {
        Self { items: Default::default(), total: 0, touched: Vec::new() }
    }
    fn push(&mut self, kind: &str, text: String, tool: Option<String>, ts: Option<i64>, is_error: bool) {
        if text.trim().is_empty() && tool.is_none() {
            return;
        }
        self.total += 1;
        self.items.push_back(TranscriptItem { kind: kind.into(), text: truncate_chars(&text, MAX_TEXT), tool, timestamp: ts, is_error });
        if self.items.len() > MAX_ITEMS {
            self.items.pop_front();
        }
    }
    fn touch(&mut self, path: &str, op: &str, ts: Option<i64>) {
        if let Some(t) = self.touched.iter_mut().find(|t| t.path == path) {
            t.count += 1;
            t.op = op.into();
            t.last_at = ts.or(t.last_at);
        } else {
            self.touched.push(TouchedFile { path: path.into(), op: op.into(), count: 1, last_at: ts });
        }
    }
    fn finish(mut self) -> Transcript {
        self.touched.sort_by(|a, b| b.last_at.cmp(&a.last_at));
        Transcript { items: self.items.into(), total: self.total, touched_files: self.touched }
    }
}

fn tool_summary(name: &str, input: &Value) -> String {
    for key in ["file_path", "notebook_path", "command", "pattern", "url", "query", "description", "path", "prompt"] {
        if let Some(s) = input.get(key).and_then(Value::as_str) {
            return one_line(s, 240);
        }
    }
    let _ = name;
    one_line(&input.to_string(), 240)
}

pub fn claude_transcript(path: &Path) -> Result<Transcript> {
    let mut c = Collector::new();
    for line in open_lines(path)?.split(b'\n') {
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_slice::<Value>(&line) else { continue };
        if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let ts = v.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms);
        match v.get("type").and_then(Value::as_str) {
            Some("user") => {
                if let Some(t) = claude_user_text(&v) {
                    c.push("user", t, None, ts, false);
                } else if let Some(items) = v.pointer("/message/content").and_then(Value::as_array) {
                    for it in items {
                        if it.get("type").and_then(Value::as_str) == Some("tool_result")
                            && it.get("is_error").and_then(Value::as_bool) == Some(true)
                        {
                            let text = match it.get("content") {
                                Some(Value::String(s)) => s.clone(),
                                Some(other) => other.to_string(),
                                None => String::new(),
                            };
                            c.push("tool", one_line(&text, 400), Some("error".into()), ts, true);
                        }
                    }
                }
            }
            Some("assistant") => {
                let Some(items) = v.pointer("/message/content").and_then(Value::as_array) else { continue };
                for it in items {
                    match it.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            let t = it.get("text").and_then(Value::as_str).unwrap_or("");
                            c.push("assistant", t.to_string(), None, ts, false);
                        }
                        Some("tool_use") => {
                            let name = it.get("name").and_then(Value::as_str).unwrap_or("tool").to_string();
                            let input = it.get("input").cloned().unwrap_or(Value::Null);
                            if matches!(name.as_str(), "Edit" | "Write" | "MultiEdit" | "NotebookEdit")
                                && let Some(p) = input.get("file_path").or_else(|| input.get("notebook_path")).and_then(Value::as_str) {
                                    let op = if name == "Write" { "write" } else { "edit" };
                                    c.touch(p, op, ts);
                                }
                            c.push("tool", tool_summary(&name, &input), Some(name), ts, false);
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    Ok(c.finish())
}

pub fn codex_transcript(path: &Path) -> Result<Transcript> {
    let mut c = Collector::new();
    // 새 형식(item_completed)과 옛 형식(user_message/agent_message)이 함께 있으면 새 형식만 쓴다.
    let mut lines: Vec<Value> = Vec::new();
    let mut has_items = false;
    for line in open_lines(path)?.split(b'\n') {
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_slice::<Value>(&line) else { continue };
        if v.pointer("/payload/type").and_then(Value::as_str) == Some("item_completed") {
            has_items = true;
        }
        if v.get("type").and_then(Value::as_str) == Some("event_msg") {
            lines.push(v);
        }
    }
    for v in lines {
        let ts = v.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms);
        let p = &v["payload"];
        match p.get("type").and_then(Value::as_str).unwrap_or("") {
            "item_completed" => {
                let item = &p["item"];
                let texts = |key: &str| {
                    item.get(key)
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter_map(|x| x.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"))
                        .unwrap_or_default()
                };
                match item.get("type").and_then(Value::as_str).unwrap_or("") {
                    "UserMessage" => {
                        let t = texts("content");
                        if !is_codex_noise(&t) {
                            c.push("user", t, None, ts, false);
                        }
                    }
                    "AgentMessage" => c.push("assistant", texts("content"), None, ts, false),
                    "CommandExecution" => {
                        let cmd = item
                            .get("command")
                            .and_then(Value::as_array)
                            .and_then(|a| a.last())
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let failed = item.get("exit_code").and_then(Value::as_i64).is_some_and(|c| c != 0);
                        c.push("tool", one_line(cmd, 240), Some("shell".into()), ts, failed);
                    }
                    "FileChange" => {
                        if let Some(ch) = item.get("changes").and_then(Value::as_object) {
                            let mut names = Vec::new();
                            for (path, change) in ch {
                                let op = change.get("type").and_then(Value::as_str).unwrap_or("update");
                                c.touch(path, op, ts);
                                names.push(format!("{op} {path}"));
                            }
                            c.push("tool", one_line(&names.join(", "), 400), Some("apply_patch".into()), ts, false);
                        }
                    }
                    "McpToolCall" => {
                        let name = format!(
                            "{}.{}",
                            item.get("server").and_then(Value::as_str).unwrap_or("mcp"),
                            item.get("tool").and_then(Value::as_str).unwrap_or("tool")
                        );
                        let args = item.get("arguments").cloned().unwrap_or(Value::Null);
                        c.push("tool", tool_summary(&name, &args), Some(name), ts, false);
                    }
                    "WebSearch" => {
                        let q = item.get("query").and_then(Value::as_str).unwrap_or("");
                        c.push("tool", one_line(q, 240), Some("web_search".into()), ts, false);
                    }
                    _ => {}
                }
            }
            "user_message" if !has_items => {
                let t = p.get("message").and_then(Value::as_str).unwrap_or("");
                if !is_codex_noise(t) {
                    c.push("user", t.to_string(), None, ts, false);
                }
            }
            "agent_message" if !has_items => {
                c.push("assistant", p.get("message").and_then(Value::as_str).unwrap_or("").to_string(), None, ts, false)
            }
            "exec_command_end" if !has_items => {
                let cmd = p.get("command").and_then(Value::as_array).and_then(|a| a.last()).and_then(Value::as_str).unwrap_or("");
                c.push("tool", one_line(cmd, 240), Some("shell".into()), ts, p.get("exit_code").and_then(Value::as_i64).is_some_and(|x| x != 0));
            }
            "patch_apply_end" if !has_items => {
                if let Some(ch) = p.get("changes").and_then(Value::as_object) {
                    for (path, change) in ch {
                        let op = change.as_object().and_then(|o| o.keys().next().cloned()).unwrap_or_else(|| "update".into());
                        c.touch(path, &op, ts);
                    }
                }
            }
            _ => {}
        }
    }
    Ok(c.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn iso_parsing() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_ms("2026-10-20T23:12:08.217Z"), Some(1792537928217));
        assert_eq!(parse_iso_ms("2026-10-21T08:12:08.217+09:00"), Some(1792537928217));
    }

    fn write(dir: &Path, name: &str, lines: &[Value]) -> PathBuf {
        let p = dir.join(name);
        let mut f = File::create(&p).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        p
    }

    #[test]
    fn claude_meta_separates_start_and_last_branch() {
        let dir = tempfile::tempdir().unwrap();
        let p = write(
            dir.path(),
            "11111111-2222-3333-4444-555555555555.jsonl",
            &[
                serde_json::json!({"type":"queue-operation","operation":"enqueue"}),
                serde_json::json!({"type":"user","isMeta":true,"cwd":"/repo","gitBranch":"feat-a","timestamp":"2026-10-01T00:00:00Z","message":{"role":"user","content":"<command-name>/init</command-name>"}}),
                serde_json::json!({"type":"user","cwd":"/repo","gitBranch":"feat-a","timestamp":"2026-10-01T00:00:01Z","entrypoint":"cli","message":{"role":"user","content":"버튼 색을 바꿔 줘"}}),
                serde_json::json!({"type":"assistant","cwd":"/repo","gitBranch":"feat-a","timestamp":"2026-10-01T00:00:02Z","message":{"content":[{"type":"text","text":"네"},{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/a.css"}}]}}),
                serde_json::json!({"type":"user","isSidechain":true,"cwd":"/repo","gitBranch":"zzz","timestamp":"2026-10-01T00:00:03Z","message":{"content":"sub"}}),
                serde_json::json!({"type":"user","cwd":"/repo","gitBranch":"main","timestamp":"2026-10-01T00:05:00Z","message":{"content":"고마워"}}),
                serde_json::json!({"type":"ai-title","aiTitle":"버튼 색 변경","sessionId":"x"}),
            ],
        );
        let m = parse_claude_session(&p).unwrap();
        assert_eq!(m.id, "claude:11111111-2222-3333-4444-555555555555");
        assert_eq!(m.cwd.as_deref(), Some("/repo"));
        assert_eq!(m.start_branch.as_deref(), Some("feat-a"));
        assert_eq!(m.last_branch.as_deref(), Some("main"));
        assert_eq!(m.first_prompt.as_deref(), Some("버튼 색을 바꿔 줘"));
        assert_eq!(m.title, "버튼 색 변경");
        assert_eq!(m.origin.as_deref(), Some("cli"));

        let t = claude_transcript(&p).unwrap();
        let kinds: Vec<_> = t.items.iter().map(|i| i.kind.as_str()).collect();
        assert_eq!(kinds, vec!["user", "assistant", "tool", "user"]);
        assert_eq!(t.touched_files.len(), 1);
        assert_eq!(t.touched_files[0].path, "/repo/a.css");
    }

    #[test]
    fn codex_rollout_header_and_transcript_including_zstd() {
        let dir = tempfile::tempdir().unwrap();
        let lines = vec![
            serde_json::json!({"timestamp":"2026-09-21T05:44:04.415Z","type":"session_meta","payload":{"id":"01a0","cwd":"/w","source":"cli","timestamp":"2026-09-21T05:44:04.415Z","git":{"branch":"agent/x","commit_hash":"abc"}}}),
            serde_json::json!({"timestamp":"2026-09-21T05:44:05Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>..."}]}}),
            serde_json::json!({"timestamp":"2026-09-21T05:44:05Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"README 정리해 줘"}]}}}),
            serde_json::json!({"timestamp":"2026-09-21T05:44:06Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"FileChange","changes":{"/w/README.md":{"type":"update"}}}}}),
            serde_json::json!({"timestamp":"2026-09-21T05:44:07Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","content":[{"type":"Text","text":"완료"}]}}}),
        ];
        let plain = write(dir.path(), "rollout-a.jsonl", &lines);
        let zst = dir.path().join("rollout-a.jsonl.zst");
        let data = std::fs::read(&plain).unwrap();
        std::fs::write(&zst, zstd::encode_all(&data[..], 3).unwrap()).unwrap();
        for p in [&plain, &zst] {
            let h = parse_rollout_header(p).unwrap();
            assert_eq!(h.id.as_deref(), Some("01a0"));
            assert_eq!(h.branch.as_deref(), Some("agent/x"));
            assert_eq!(h.first_prompt.as_deref(), Some("README 정리해 줘"));
            let t = codex_transcript(p).unwrap();
            let kinds: Vec<_> = t.items.iter().map(|i| i.kind.as_str()).collect();
            assert_eq!(kinds, vec!["user", "tool", "assistant"]);
            assert_eq!(t.touched_files[0].path, "/w/README.md");
        }
        // rollout_path 가 .jsonl 로 적혀 있어도 .zst 를 찾는다
        std::fs::remove_file(&plain).unwrap();
        assert_eq!(resolve_rollout(plain.to_str().unwrap()), Some(zst));
    }
}
