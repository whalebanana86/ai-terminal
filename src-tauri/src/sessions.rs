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
    /// 기록 끝부분에서 본 작업 폴더와 그 기록 수(최근 것부터). 마지막 cwd 가 저장소 밖일 때 어디서 일했는지 찾는 데 쓴다.
    #[serde(default, skip_serializing)]
    pub recent_cwds: Vec<(String, u32)>,
    /// 가장 최근 사용자 요청(한 줄)과 그 시각(밀리초). 새 요청을 알아채는 데 쓴다(위쪽 막대의 스틱맨).
    #[serde(default)]
    pub last_prompt: Option<String>,
    #[serde(default)]
    pub last_prompt_at: i64,
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

pub(crate) fn truncate_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(n).collect();
        t.push('…');
        t
    }
}

pub(crate) fn one_line(s: &str, n: usize) -> String {
    truncate_chars(&s.split_whitespace().collect::<Vec<_>>().join(" "), n)
}

/// 압축(.zst) 여부와 관계없이 줄 단위로 읽는다.
pub(crate) fn open_lines(path: &Path) -> Result<Box<dyn BufRead>> {
    let f = File::open(path).with_context(|| tr!("{} 를 열 수 없습니다", "Can't open {}", path.display()))?;
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

/// 파일 끝 `max_bytes` 안의 `"cwd":"…"` 값을 최근 것부터 중복 없이(최대 12개) 기록 수와 함께. JSON 을 통째로 파싱하지 않고 바이트로 찾는다.
fn recent_cwds(path: &Path, max_bytes: u64) -> Vec<(String, u32)> {
    let Ok(mut f) = File::open(path) else { return Vec::new() };
    let Ok(len) = f.seek(SeekFrom::End(0)) else { return Vec::new() };
    let start = len.saturating_sub(max_bytes);
    let mut buf = Vec::new();
    if f.seek(SeekFrom::Start(start)).is_err() || f.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    const KEY: &[u8] = b"\"cwd\":\"";
    let mut out: Vec<(String, u32)> = Vec::new();
    let mut end = buf.len();
    loop {
        let Some(i) = buf[..end].windows(KEY.len()).rposition(|w| w == KEY) else { break };
        end = i;
        // 값 끝(이스케이프되지 않은 따옴표)까지
        let v0 = i + KEY.len() - 1;
        let mut j = v0 + 1;
        while j < buf.len() && buf[j] != b'"' {
            j += if buf[j] == b'\\' { 2 } else { 1 };
        }
        if j >= buf.len() {
            continue;
        }
        if let Ok(v) = serde_json::from_slice::<String>(&buf[v0..=j])
            && !v.is_empty()
        {
            if let Some(i) = out.iter().position(|(c, _)| *c == v) {
                out[i].1 += 1;
            } else if out.len() < 12 {
                out.push((v, 1));
            }
        }
    }
    out
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
    // 대화가 길어져 앞부분을 요약해 넣은 글(사람이 쓴 게 아님)
    if v.get("isCompactSummary").and_then(Value::as_bool) == Some(true) {
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

/// 일하는 중에 대기열로 보낸 사람 요청. Claude Code 는 이것을 user 메시지가 아니라
/// `{"type":"attachment","attachment":{"type":"queued_command","commandMode":"prompt","origin":{"kind":"human"},"prompt":…}}`
/// 로 적는다. 백그라운드 작업 알림(task-notification)·다른 에이전트가 보낸 말(peer)은 빼고 사람이 보낸 것만.
fn claude_queued_text(v: &Value) -> Option<String> {
    if v.get("type")?.as_str()? != "attachment" {
        return None;
    }
    let a = v.get("attachment")?;
    if a.get("type")?.as_str()? != "queued_command" || a.get("commandMode").and_then(Value::as_str) != Some("prompt") {
        return None;
    }
    if !matches!(a.get("origin").and_then(|o| o.get("kind")).and_then(Value::as_str), None | Some("human")) {
        return None;
    }
    let text = match a.get("prompt")? {
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

/// 사람이 보낸 요청: 보통 user 메시지 또는 일하는 중에 대기열로 보낸 것
pub(crate) fn claude_human_text(v: &Value) -> Option<String> {
    claude_user_text(v).or_else(|| claude_queued_text(v))
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
            if meta.last_prompt.is_none()
                && let Some(t) = claude_human_text(&v)
            {
                meta.last_prompt = Some(one_line(&t, 300));
                meta.last_prompt_at = v.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms).unwrap_or(0);
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
        // 최근 요청은 1MB 안에서만 찾는다(도구 출력이 아주 긴 세션에서 매번 8MB 를 읽지 않게).
        if found_branch && (meta.last_prompt.is_some() || window >= 1024 * 1024) {
            break;
        }
    }
    meta.cwd.as_ref()?;
    meta.recent_cwds = recent_cwds(path, 2 * 1024 * 1024);
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

pub(crate) fn is_codex_noise(text: &str) -> bool {
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
    codex_tail: HashMap<PathBuf, ((u64, i64), Option<(String, i64)>)>,
    /// Claude 기록에서 가장 최근 사람 요청을 어디까지 찾아봤는지(파일 길이)와 찾은 것
    claude_prompt: HashMap<PathBuf, (u64, Option<(String, i64)>)>,
}

/// 사람 요청일 수 있는 줄만 골라 JSON 으로 읽는다(도구 결과 같은 큰 줄은 건너뜀)
fn human_prompt_in_line(line: &[u8]) -> Option<(String, i64)> {
    if line.len() > 1024 * 1024 {
        return None;
    }
    let has = |pat: &[u8]| line.windows(pat.len()).any(|w| w == pat);
    if !has(b"\"type\":\"user\"") && !has(b"\"queued_command\"") {
        return None;
    }
    let v: Value = serde_json::from_slice(line).ok()?;
    if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let text = claude_human_text(&v)?;
    let at = v.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms).unwrap_or(0);
    Some((one_line(&text, 300), at))
}

/// 파일 [from, to) 의 완전한 줄들에서 마지막 사람 요청. 반환: (찾은 것, 끝까지 읽은 위치)
fn scan_prompts_forward(path: &Path, from: u64, to: u64) -> (Option<(String, i64)>, u64) {
    let Ok(mut f) = File::open(path) else { return (None, from) };
    if f.seek(SeekFrom::Start(from)).is_err() {
        return (None, from);
    }
    let mut buf = Vec::new();
    if f.take(to - from).read_to_end(&mut buf).is_err() {
        return (None, from);
    }
    // 아직 쓰는 중인 마지막 줄은 다음에 읽는다
    let Some(end) = buf.iter().rposition(|&b| b == b'\n') else { return (None, from) };
    let found = buf[..end].split(|&b| b == b'\n').filter_map(human_prompt_in_line).last();
    (found, from + end as u64 + 1)
}

/// 파일 끝에서부터 거꾸로, 사람 요청이 나올 때까지 넓혀 가며 찾는다(최대 64MB)
fn scan_prompts_backward(path: &Path, len: u64) -> Option<(String, i64)> {
    for window in [1u64 << 20, 4 << 20, 16 << 20, 64 << 20] {
        let start = len.saturating_sub(window);
        let Ok(mut f) = File::open(path) else { return None };
        let mut buf = Vec::new();
        if f.seek(SeekFrom::Start(start)).is_err() || f.take(len - start).read_to_end(&mut buf).is_err() {
            return None;
        }
        let mut lines: Vec<&[u8]> = buf.split(|&b| b == b'\n').collect();
        if start > 0 && !lines.is_empty() {
            lines.remove(0); // 잘린 첫 줄
        }
        if let Some(found) = lines.into_iter().rev().find_map(human_prompt_in_line) {
            return Some(found);
        }
        if start == 0 {
            break;
        }
    }
    None
}

impl SessionIndex {
    pub fn claude_meta(&mut self, path: &Path) -> Option<SessionMeta> {
        let stamp = file_stamp(path)?;
        if let Some((s, m)) = self.claude.get(path)
            && *s == stamp {
                return m.clone();
            }
        let mut meta = parse_claude_session(path);
        if let Some(m) = meta.as_mut()
            && let Some(found) = self.latest_claude_prompt(path, stamp.0)
        {
            m.last_prompt = Some(found.0);
            m.last_prompt_at = found.1;
        }
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
        self.claude_prompt.retain(|k, _| keep.contains(k));
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
                                recent_cwds: Vec::new(),
                                last_prompt: None,
                                last_prompt_at: 0,
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
                    recent_cwds: Vec::new(),
                    last_prompt: None,
                    last_prompt_at: 0,
                },
            );
        }
        let mut out: Vec<SessionMeta> = by_id.into_values().filter(|m| m.cwd.is_some()).collect();
        for m in &mut out {
            if let Some((t, at)) = self.codex_last_prompt(Path::new(&m.source_path)) {
                m.last_prompt = Some(t);
                m.last_prompt_at = at;
            }
        }
        out
    }

    /// Claude 기록의 가장 최근 사람 요청. 도구 결과가 아주 많은 세션은 요청이 끝에서 수 MB 앞에 있을 수 있어
    /// 처음에는 거꾸로 넓혀 가며 찾고, 그 뒤로는 새로 붙은 부분만 읽는다(기록은 뒤에 덧붙기만 한다).
    fn latest_claude_prompt(&mut self, path: &Path, len: u64) -> Option<(String, i64)> {
        let (found, scanned) = match self.claude_prompt.get(path) {
            Some((done, prev)) if *done <= len => {
                let (new, upto) = scan_prompts_forward(path, *done, len);
                (new.or_else(|| prev.clone()), upto)
            }
            _ => {
                let found = scan_prompts_backward(path, len);
                // 끝의 완전한 줄까지 읽은 것으로 친다
                let (tail, upto) = scan_prompts_forward(path, len.saturating_sub(64 * 1024), len);
                (tail.or(found), upto)
            }
        };
        self.claude_prompt.insert(path.to_path_buf(), (scanned, found.clone()));
        found
    }

    /// Codex rollout 끝부분의 가장 최근 사용자 요청. 압축(.zst)된 옛 기록은 건너뛴다(새 요청이 생길 일이 없다).
    fn codex_last_prompt(&mut self, path: &Path) -> Option<(String, i64)> {
        if path.extension().is_none_or(|e| e != "jsonl") {
            return None;
        }
        let stamp = file_stamp(path)?;
        if let Some((s, v)) = self.codex_tail.get(path)
            && *s == stamp
        {
            return v.clone();
        }
        let mut found = None;
        for line in tail_lines(path, 512 * 1024) {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if let Some(t) = codex_user_text(&v) {
                let at = v.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms).unwrap_or(stamp.1);
                found = Some((one_line(&t, 300), at));
                break;
            }
        }
        self.codex_tail.insert(path.to_path_buf(), (stamp, found.clone()));
        found
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
            // 일하는 중에 대기열로 보낸 요청도 대화에 보인다
            Some("attachment") => {
                if let Some(t) = claude_queued_text(&v) {
                    c.push("user", t, None, ts, false);
                }
            }
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
                // 일하는 중에 보낸 요청(대기열) — 사람이 보낸 것만 센다
                serde_json::json!({"type":"attachment","timestamp":"2026-10-01T00:06:00Z","attachment":{"type":"queued_command","commandMode":"prompt","origin":{"kind":"human"},"prompt":"테두리도 둥글게 바꿔 줘"}}),
                serde_json::json!({"type":"attachment","timestamp":"2026-10-01T00:07:00Z","attachment":{"type":"queued_command","commandMode":"task-notification","origin":{"kind":"task-notification"},"prompt":"<task-notification>끝</task-notification>"}}),
                serde_json::json!({"type":"attachment","timestamp":"2026-10-01T00:08:00Z","attachment":{"type":"queued_command","commandMode":"prompt","origin":{"kind":"peer"},"prompt":"다른 에이전트가 보낸 말"}}),
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
        // 가장 최근 사람 요청(사이드체인·메타·작업 알림·다른 에이전트 말 제외, 대기열 요청 포함)과 시각
        assert_eq!(m.last_prompt.as_deref(), Some("테두리도 둥글게 바꿔 줘"));
        assert_eq!(m.last_prompt_at, parse_iso_ms("2026-10-01T00:06:00Z").unwrap());

        let t = claude_transcript(&p).unwrap();
        let kinds: Vec<_> = t.items.iter().map(|i| i.kind.as_str()).collect();
        assert_eq!(kinds, vec!["user", "assistant", "tool", "user", "user"], "대기열 요청도 대화에 보인다");
        assert_eq!(t.touched_files.len(), 1);
        assert_eq!(t.touched_files[0].path, "/repo/a.css");
    }

    #[test]
    fn latest_human_prompt_far_from_the_end_and_appended_later() {
        // 사람 요청 뒤로 큰 도구 결과가 3MB 넘게 쌓인 세션(긴 작업). 1MB 꼬리만 보면 못 찾던 경우
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("abcd-1234.jsonl");
        let big = "x".repeat(400 * 1024);
        let mut text = String::new();
        let line = |v: serde_json::Value| v.to_string() + "\n";
        text += &line(serde_json::json!({"type":"user","cwd":"/r","timestamp":"2026-10-01T00:00:00Z","message":{"content":"버튼 추가해 줘"}}));
        text += &line(serde_json::json!({"type":"user","isCompactSummary":true,"cwd":"/r","timestamp":"2026-10-01T00:00:01Z","message":{"content":"This session is being continued"}}));
        for _ in 0..8 {
            text += &line(serde_json::json!({"type":"user","cwd":"/r","timestamp":"2026-10-01T00:00:02Z","message":{"content":[{"type":"tool_result","content":big}]}}));
            text += &line(serde_json::json!({"type":"user","cwd":"/r","timestamp":"2026-10-01T00:00:03Z","message":{"content":"<task-notification>끝</task-notification>"}}));
        }
        std::fs::write(&p, &text).unwrap();
        let mut idx = SessionIndex::default();
        let m = idx.claude_meta(&p).unwrap();
        assert_eq!(m.last_prompt.as_deref(), Some("버튼 추가해 줘"), "요약·작업 알림은 사람 요청이 아니다");
        // 일하는 중에 대기열로 보낸 요청이 덧붙으면 새로 붙은 부분만 읽어 바로 안다
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        std::io::Write::write_all(&mut f, line(serde_json::json!({"type":"attachment","timestamp":"2026-10-01T00:09:00Z","attachment":{"type":"queued_command","commandMode":"prompt","origin":{"kind":"human"},"prompt":"색도 바꿔 줘"}})).as_bytes()).unwrap();
        drop(f);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let m = idx.claude_meta(&p).unwrap();
        assert_eq!(m.last_prompt.as_deref(), Some("색도 바꿔 줘"));
        assert_eq!(m.last_prompt_at, parse_iso_ms("2026-10-01T00:09:00Z").unwrap());
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
        // 최근 요청: 평문 rollout 끝에서 찾고(환경 정보는 빼고), 압축본은 건너뛴다
        let mut idx = SessionIndex::default();
        assert_eq!(idx.codex_last_prompt(&plain).map(|x| x.0).as_deref(), Some("README 정리해 줘"));
        assert_eq!(idx.codex_last_prompt(&zst), None);
        // rollout_path 가 .jsonl 로 적혀 있어도 .zst 를 찾는다
        std::fs::remove_file(&plain).unwrap();
        assert_eq!(resolve_rollout(plain.to_str().unwrap()), Some(zst));
    }
}
