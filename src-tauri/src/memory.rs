//! 작업 기억: 지난 대화·오류·수정 내역을 이 맥 안의 DB 에 원문으로 보관하고(Claude 는 30일 지난 원본을 지운다)
//! 임베딩으로 의미가 가까운 기록을 찾는다. 새 세션에 '최근 대화 + 고른 기억'만 넣어 지난 대화 전체를 다시 보내지 않게 한다.
//! 임베딩은 도우미 프로세스(memory_worker)에서 돈다. Apple Silicon + macOS 14 이상에서만 켠다. 설계: docs/WORK_MEMORY.md

use anyhow::{Context, Result, anyhow};
use parking_lot::{Condvar, Mutex};
use regex::Regex;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use crate::core::EventSink;
use crate::memory_fetch;
use crate::memory_worker::{DIM, WorkerClient};
use crate::sessions;

/// 기록 파일이 이만큼 조용하면 마지막 턴도 끝난 것으로 본다(일하는 중인 턴을 여러 번 다시 임베딩하지 않게)
const IDLE_MS: i64 = 120_000;
/// 도우미 프로세스를 이만큼 안 쓰면 끝낸다(모델 메모리를 돌려준다)
const WORKER_IDLE: Duration = Duration::from_secs(120);
/// 조각 길이(글자)
const PIECE: usize = 400;
const BATCH: usize = 4;

// ───────────── 지원 여부 ─────────────

/// 기억 기능을 쓸 수 있는 맥인지: Apple Silicon + macOS 14 이상(ONNX Runtime 배포판의 조건)
pub fn supported() -> bool {
    #[cfg(debug_assertions)]
    if let Ok(v) = std::env::var("AITERM_MEMORY_SUPPORTED") {
        return v == "1";
    }
    cfg!(target_arch = "aarch64") && macos_major() >= 14
}

fn macos_major() -> u32 {
    let mut buf = [0u8; 64];
    let mut len = buf.len();
    let r = unsafe { libc::sysctlbyname(c"kern.osproductversion".as_ptr(), buf.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) };
    if r != 0 {
        return 0;
    }
    let s = String::from_utf8_lossy(&buf[..len.min(buf.len())]);
    s.trim_end_matches('\0').split('.').next().and_then(|m| m.trim().parse().ok()).unwrap_or(0)
}

// ───────────── 비밀값 가리기 ─────────────

const REDACTED: &str = "[REDACTED]";

static SECRETS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)",
        r"\bsk-[A-Za-z0-9_\-]{20,}",
        r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
        r"\bgh[pousr]_[A-Za-z0-9]{30,}",
        r"\bgithub_pat_[A-Za-z0-9_]{40,}",
        r"\bxox[baprs]-[A-Za-z0-9\-]{10,}",
        r"\bAIza[0-9A-Za-z_\-]{35}",
        r"\bnpg_[A-Za-z0-9]{8,}",
        r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}",
        r"(?i)\bbearer\s+[A-Za-z0-9_\-.=]{20,}",
    ]
    .iter()
    .map(|p| Regex::new(p).expect("비밀값 패턴"))
    .collect()
});
/// 접속 주소에 섞인 `사용자:비밀번호@`
static URL_CRED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([A-Za-z][A-Za-z0-9+.\-]*://[^:/\s@]+:)[^@\s/]+@").unwrap());
/// `password = …`, `api_key: …` 같은 대입(값이 토큰처럼 생겼고 뒤에 공백·따옴표·끝이 올 때만 — `token = getToken()` 은 그대로)
static ASSIGN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b((?:[a-z0-9]+[_\-])*(?:password|passwd|pwd|secret|token|api[_\-]?key|access[_\-]?key|private[_\-]?key)\b["']?\s*[:=]\s*["']?)[A-Za-z0-9_\-+/=.]{8,}(["'\s,;]|$)"#).unwrap()
});

/// 저장·임베딩하기 전에 비밀값으로 보이는 것을 가린다(임베딩으로도 원문을 되살릴 수 있다)
pub fn redact(s: &str) -> String {
    let mut out = std::borrow::Cow::Borrowed(s);
    for re in SECRETS.iter() {
        if re.is_match(&out) {
            out = std::borrow::Cow::Owned(re.replace_all(&out, REDACTED).into_owned());
        }
    }
    let out = URL_CRED.replace_all(&out, format!("${{1}}{REDACTED}@").as_str()).into_owned();
    ASSIGN.replace_all(&out, format!("${{1}}{REDACTED}${{2}}").as_str()).into_owned()
}

static PASTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<pasted_content[^>]*>(.*?)</pasted_content[^>]*>").unwrap());
static REMINDER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<system-reminder>.*?</system-reminder>").unwrap());

/// 검색용 글: 붙여넣은 긴 글은 앞부분만, 시스템 알림은 빼고, 공백을 줄인다
fn for_search(s: &str) -> String {
    let s = REMINDER.replace_all(s, "");
    let s = PASTED.replace_all(&s, |c: &regex::Captures| {
        let body = c.get(1).map_or("", |m| m.as_str()).trim();
        format!("[pasted] {}", sessions::truncate_chars(body, 300))
    });
    s.lines().map(|l| l.split_whitespace().collect::<Vec<_>>().join(" ")).collect::<Vec<_>>().join("\n").trim().to_string()
}

// ───────────── 기록 → 턴 ─────────────

/// 사람 요청 하나와 그에 대한 AI 의 일
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Turn {
    /// 요청 줄이 시작하는 바이트 위치
    #[serde(skip)]
    pub start: u64,
    pub ts: i64,
    #[serde(skip)]
    pub cwd: Option<String>,
    pub user: String,
    pub assistant: Vec<String>,
    pub errors: Vec<String>,
    pub files: Vec<String>,
}

/// 줄 하나가 너무 크면(파일 읽기 결과 등) 오류 표시가 없는 한 해석하지 않는다
const BIG_LINE: usize = 256 * 1024;

fn claude_turns(lines: impl Iterator<Item = (u64, Vec<u8>)>) -> Vec<Turn> {
    let mut out: Vec<Turn> = Vec::new();
    let mut cwd: Option<String> = None;
    for (off, line) in lines {
        if line.len() > BIG_LINE && !contains(&line, b"\"is_error\":true") {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(&line) else { continue };
        if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if let Some(c) = v.get("cwd").and_then(Value::as_str) {
            cwd = Some(c.to_string());
        }
        let ts = v.get("timestamp").and_then(Value::as_str).and_then(sessions::parse_iso_ms).unwrap_or(0);
        if let Some(text) = sessions::claude_human_text(&v) {
            out.push(Turn { start: off, ts, cwd: cwd.clone(), user: text, ..Default::default() });
            continue;
        }
        let Some(cur) = out.last_mut() else { continue };
        let items = v.pointer("/message/content").and_then(Value::as_array);
        match v.get("type").and_then(Value::as_str) {
            Some("user") => {
                for it in items.into_iter().flatten() {
                    if it.get("type").and_then(Value::as_str) == Some("tool_result") && it.get("is_error").and_then(Value::as_bool) == Some(true) {
                        let text = match it.get("content") {
                            Some(Value::String(s)) => s.clone(),
                            Some(other) => other.to_string(),
                            None => String::new(),
                        };
                        cur.errors.push(sessions::truncate_chars(text.trim(), 300));
                    }
                }
            }
            Some("assistant") => {
                for it in items.into_iter().flatten() {
                    match it.get("type").and_then(Value::as_str) {
                        Some("text") => cur.assistant.push(it.get("text").and_then(Value::as_str).unwrap_or("").to_string()),
                        Some("tool_use") => {
                            let name = it.get("name").and_then(Value::as_str).unwrap_or("");
                            if matches!(name, "Edit" | "Write" | "MultiEdit" | "NotebookEdit")
                                && let Some(p) = it.pointer("/input/file_path").or_else(|| it.pointer("/input/notebook_path")).and_then(Value::as_str)
                                && !cur.files.iter().any(|f| f == p)
                            {
                                cur.files.push(p.to_string());
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Codex: 새 형식(item_completed)이 있으면 그것만, 없으면 옛 형식(user_message/agent_message)을 쓴다
fn codex_turns(lines: impl Iterator<Item = (u64, Vec<u8>)>, new_format: bool) -> Vec<Turn> {
    let mut out: Vec<Turn> = Vec::new();
    for (off, line) in lines {
        if line.len() > BIG_LINE {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(&line) else { continue };
        if v.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }
        let ts = v.get("timestamp").and_then(Value::as_str).and_then(sessions::parse_iso_ms).unwrap_or(0);
        let p = &v["payload"];
        let texts = |item: &Value| {
            item.get("content")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|x| x.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"))
                .unwrap_or_default()
        };
        let push_user = |t: String, out: &mut Vec<Turn>| {
            if !sessions::is_codex_noise(&t) {
                out.push(Turn { start: off, ts, user: t, ..Default::default() });
            }
        };
        match (p.get("type").and_then(Value::as_str).unwrap_or(""), new_format) {
            ("item_completed", true) => {
                let item = &p["item"];
                match item.get("type").and_then(Value::as_str).unwrap_or("") {
                    "UserMessage" => push_user(texts(item), &mut out),
                    "AgentMessage" => {
                        if let Some(cur) = out.last_mut() {
                            cur.assistant.push(texts(item));
                        }
                    }
                    "CommandExecution" => {
                        if let Some(cur) = out.last_mut()
                            && item.get("exit_code").and_then(Value::as_i64).is_some_and(|c| c != 0)
                        {
                            let cmd = item.get("command").and_then(Value::as_array).and_then(|a| a.last()).and_then(Value::as_str).unwrap_or("");
                            let output = item.get("aggregated_output").and_then(Value::as_str).unwrap_or("");
                            cur.errors.push(sessions::truncate_chars(format!("{cmd}\n{}", output.trim()).trim(), 300));
                        }
                    }
                    "FileChange" => {
                        if let (Some(cur), Some(ch)) = (out.last_mut(), item.get("changes").and_then(Value::as_object)) {
                            for path in ch.keys() {
                                if !cur.files.contains(path) {
                                    cur.files.push(path.clone());
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            ("user_message", false) => push_user(p.get("message").and_then(Value::as_str).unwrap_or("").to_string(), &mut out),
            ("agent_message", false) => {
                if let Some(cur) = out.last_mut() {
                    cur.assistant.push(p.get("message").and_then(Value::as_str).unwrap_or("").to_string());
                }
            }
            ("exec_command_end", false) => {
                if let Some(cur) = out.last_mut()
                    && p.get("exit_code").and_then(Value::as_i64).is_some_and(|c| c != 0)
                {
                    let cmd = p.get("command").and_then(Value::as_array).and_then(|a| a.last()).and_then(Value::as_str).unwrap_or("");
                    cur.errors.push(sessions::truncate_chars(cmd, 300));
                }
            }
            ("patch_apply_end", false) => {
                if let (Some(cur), Some(ch)) = (out.last_mut(), p.get("changes").and_then(Value::as_object)) {
                    for path in ch.keys() {
                        if !cur.files.contains(path) {
                            cur.files.push(path.clone());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// 기록 파일을 끝난 줄만 하나씩 읽는다(마지막 줄은 쓰이는 중일 수 있다). 파일 전체를 메모리에 올리지 않는다.
struct Lines {
    r: Box<dyn BufRead>,
    /// 다 읽은 곳(바이트)
    pos: u64,
}

impl Lines {
    fn open(path: &Path, offset: u64, zst: bool) -> Result<Self> {
        let r: Box<dyn BufRead> = if zst {
            sessions::open_lines(path)?
        } else {
            let mut f = std::fs::File::open(path)?;
            f.seek(SeekFrom::Start(offset))?;
            Box::new(std::io::BufReader::with_capacity(256 * 1024, f))
        };
        Ok(Self { r, pos: offset })
    }
}

impl Iterator for Lines {
    type Item = (u64, Vec<u8>);
    fn next(&mut self) -> Option<Self::Item> {
        loop {
            let mut buf = Vec::new();
            let n = self.r.read_until(b'\n', &mut buf).ok()?;
            if n == 0 || buf.last() != Some(&b'\n') {
                return None;
            }
            let at = self.pos;
            self.pos += n as u64;
            buf.pop();
            if !buf.is_empty() {
                return Some((at, buf));
            }
        }
    }
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

// ───────────── 턴 → 검색 조각 ─────────────

/// 문단을 PIECE 글자 안쪽으로 묶는다. from_end 면 뒤에서 n 개(마지막 보고 문단이 가장 쓸모 있다)
fn pieces(text: &str, n: usize, from_end: bool) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for para in text.split("\n\n").map(str::trim).filter(|p| !p.is_empty()) {
        let mut rest: Vec<char> = para.chars().collect();
        while rest.len() > PIECE {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            out.push(rest.drain(..PIECE).collect());
        }
        let p: String = rest.into_iter().collect();
        if !cur.is_empty() && cur.chars().count() + p.chars().count() + 1 > PIECE {
            out.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push('\n');
        }
        cur.push_str(&p);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    if from_end {
        let skip = out.len().saturating_sub(n);
        out.split_off(skip)
    } else {
        out.truncate(n);
        out
    }
}

fn base_name(p: &str) -> &str {
    Path::new(p).file_name().and_then(|s| s.to_str()).unwrap_or(p)
}

/// (종류, 글) 목록. 글 앞에 `[프로젝트 날짜]` 머리말을 붙인다.
fn chunks_of(t: &Turn, project: &str) -> Vec<(&'static str, String)> {
    let head = format!("[{project} {}] ", day(t.ts));
    let mut out = Vec::new();
    for p in pieces(&for_search(&t.user), 3, false) {
        out.push(("user", format!("{head}{p}")));
    }
    for p in pieces(&for_search(&t.assistant.join("\n\n")), 6, true) {
        out.push(("assistant", format!("{head}{p}")));
    }
    let mut seen = Vec::new();
    for e in t.errors.iter().take(3) {
        let e = for_search(e);
        if !e.is_empty() && !seen.contains(&e) {
            out.push(("error", format!("{head}error: {e}")));
            seen.push(e);
        }
    }
    if !t.files.is_empty() {
        let names: Vec<&str> = t.files.iter().take(12).map(|f| base_name(f)).collect();
        out.push(("edit", format!("{head}edited: {}", names.join(", "))));
    }
    out
}

/// 밀리초 → YYYY-MM-DD (UTC)
fn day(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    // 1970-01-01 부터 날짜 계산(Howard Hinnant 의 civil_from_days)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

/// 저장소 id → 보여 줄 이름(`/x/app/.git` → `app`)
fn project_name(repo: Option<&str>, cwd: Option<&str>) -> String {
    if let Some(r) = repo {
        let p = Path::new(r);
        let name = if p.file_name().is_some_and(|n| n == ".git") { p.parent().and_then(|x| x.file_name()) } else { p.file_name() };
        if let Some(n) = name {
            return n.to_string_lossy().trim_end_matches(".git").to_string();
        }
    }
    cwd.map(|c| base_name(c).to_string()).unwrap_or_else(|| "?".into())
}

// ───────────── 벡터 ─────────────

/// int8 DIM 개 + f32 배율
fn pack(v: &[f32]) -> Vec<u8> {
    let max = v.iter().fold(0f32, |m, x| m.max(x.abs())).max(1e-9);
    let scale = max / 127.0;
    let mut out: Vec<u8> = v.iter().map(|x| (x / scale).round().clamp(-127.0, 127.0) as i8 as u8).collect();
    out.extend(scale.to_le_bytes());
    out
}

fn unpack(b: &[u8]) -> Option<([i8; DIM], f32)> {
    if b.len() != DIM + 4 {
        return None;
    }
    let mut q = [0i8; DIM];
    for (d, s) in q.iter_mut().zip(b) {
        *d = *s as i8;
    }
    Some((q, f32::from_le_bytes(b[DIM..].try_into().ok()?)))
}

fn score(query: &[f32], q: &[i8; DIM], scale: f32) -> f32 {
    query.iter().zip(q).map(|(a, &b)| a * b as f32).sum::<f32>() * scale
}

// ───────────── 저장 ─────────────

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY,
    session TEXT NOT NULL,
    idx INTEGER NOT NULL,
    agent TEXT NOT NULL,
    ts INTEGER NOT NULL,
    cwd TEXT,
    repo TEXT,
    project TEXT NOT NULL,
    body BLOB NOT NULL,
    UNIQUE(session, idx)
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session, ts);
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    turn INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    vec BLOB
);
CREATE INDEX IF NOT EXISTS idx_chunks_turn ON chunks(turn);
CREATE INDEX IF NOT EXISTS idx_chunks_pending ON chunks(id) WHERE vec IS NULL;
CREATE TABLE IF NOT EXISTS sources (
    path TEXT PRIMARY KEY,
    session TEXT NOT NULL,
    agent TEXT NOT NULL,
    cwd TEXT,
    offset INTEGER NOT NULL,
    next_idx INTEGER NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    new_format INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"#;

struct Source {
    session: String,
    cwd: Option<String>,
    offset: u64,
    next_idx: i64,
    size: u64,
    mtime: i64,
    new_format: bool,
}

pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d)?;
        }
        let conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        let s = Self { conn };
        // 모델이 바뀌었으면 벡터를 다시 만든다
        let model: Option<String> = s.conn.query_row("SELECT value FROM meta WHERE key = 'model'", [], |r| r.get(0)).optional()?;
        if model.as_deref() != Some(memory_fetch::MODEL_ID) {
            s.conn.execute("UPDATE chunks SET vec = NULL", [])?;
            s.conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('model', ?1)", [memory_fetch::MODEL_ID])?;
        }
        Ok(s)
    }

    fn source(&self, path: &str) -> Result<Option<Source>> {
        Ok(self
            .conn
            .query_row("SELECT session, cwd, offset, next_idx, size, mtime, new_format FROM sources WHERE path = ?1", [path], |r| {
                Ok(Source {
                    session: r.get(0)?,
                    cwd: r.get(1)?,
                    offset: r.get::<_, i64>(2)? as u64,
                    next_idx: r.get(3)?,
                    size: r.get::<_, i64>(4)? as u64,
                    mtime: r.get(5)?,
                    new_format: r.get::<_, i64>(6)? != 0,
                })
            })
            .optional()?)
    }

    /// 파일 하나에서 새로 끝난 턴을 넣는다. 넣은 턴 수.
    fn ingest_file(&mut self, agent: &str, path: &Path, now: i64) -> Result<usize> {
        let meta = std::fs::metadata(path)?;
        let size = meta.len();
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64);
        let key = path.to_string_lossy().into_owned();
        let prev = self.source(&key)?;
        if prev.as_ref().is_some_and(|s| s.size == size && s.mtime == mtime) {
            return Ok(0);
        }
        let zst = path.extension().is_some_and(|e| e == "zst");
        if zst && prev.is_some() {
            // 보관된(압축) 기록은 더 바뀌지 않는다
            self.conn.execute("UPDATE sources SET size = ?2, mtime = ?3 WHERE path = ?1", params![key, size as i64, mtime])?;
            return Ok(0);
        }
        let (session, mut cwd) = match &prev {
            Some(s) => (s.session.clone(), s.cwd.clone()),
            None if agent == "claude" => (format!("claude:{}", path.file_stem().and_then(|s| s.to_str()).unwrap_or_default()), None),
            None => match sessions::parse_rollout_header(path) {
                Some(h) => (format!("codex:{}", h.id.unwrap_or_default()), h.cwd),
                None => return Ok(0),
            },
        };
        let offset = if zst { 0 } else { prev.as_ref().map_or(0, |s| s.offset.min(size)) };
        // Codex 는 새 형식(item_completed)이 있는지 먼저 본다(기록이 작다)
        let new_format = prev.as_ref().is_some_and(|s| s.new_format)
            || (agent == "codex" && Lines::open(path, offset, zst)?.any(|(_, l)| contains(&l, b"\"item_completed\"")));
        let mut lines = Lines::open(path, offset, zst)?;
        let turns = if agent == "claude" { claude_turns(&mut lines) } else { codex_turns(&mut lines, new_format) };
        let region_end = lines.pos;
        let idle = zst || now - mtime > IDLE_MS;
        let closed = if idle { turns.len() } else { turns.len().saturating_sub(1) };
        let next_offset = if closed < turns.len() { turns[closed].start } else { region_end };
        let mut next_idx = prev.as_ref().map_or(0, |s| s.next_idx);
        let tx = self.conn.transaction()?;
        for t in &turns[..closed] {
            if cwd.is_none() || agent == "claude" {
                cwd = t.cwd.clone().or(cwd);
            }
            let repo = cwd.as_deref().and_then(|c| crate::trust::repo_id(Path::new(c)));
            let project = project_name(repo.as_deref(), cwd.as_deref());
            let stored = Turn {
                user: redact(&t.user),
                assistant: t.assistant.iter().map(|a| redact(a)).collect(),
                errors: t.errors.iter().map(|e| redact(e)).collect(),
                ..t.clone()
            };
            let body = zstd::encode_all(serde_json::to_vec(&stored)?.as_slice(), 3)?;
            let ts = if t.ts > 0 { t.ts } else { mtime };
            tx.execute(
                "INSERT OR REPLACE INTO turns (session, idx, agent, ts, cwd, repo, project, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![session, next_idx, agent, ts, cwd, repo, project, body],
            )?;
            let id = tx.last_insert_rowid();
            for (kind, text) in chunks_of(&Turn { ts, ..stored }, &project) {
                tx.execute("INSERT INTO chunks (turn, kind, text) VALUES (?1, ?2, ?3)", params![id, kind, text])?;
            }
            next_idx += 1;
        }
        tx.execute(
            "INSERT OR REPLACE INTO sources (path, session, agent, cwd, offset, next_idx, size, mtime, new_format) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![key, session, agent, cwd, next_offset as i64, next_idx, size as i64, mtime, new_format as i64],
        )?;
        tx.commit()?;
        Ok(closed)
    }

    fn pending(&self, limit: usize) -> Result<Vec<(i64, String)>> {
        let mut st = self.conn.prepare("SELECT id, text FROM chunks WHERE vec IS NULL ORDER BY length(text) LIMIT ?1")?;
        let rows = st.query_map([limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    fn save_vectors(&mut self, items: &[(i64, Vec<f32>)]) -> Result<()> {
        let tx = self.conn.transaction()?;
        for (id, v) in items {
            tx.execute("UPDATE chunks SET vec = ?2 WHERE id = ?1", params![id, pack(v)])?;
        }
        tx.commit()?;
        Ok(())
    }

    fn counts(&self) -> Result<(u64, u64, u64)> {
        Ok(self.conn.query_row(
            "SELECT (SELECT count(*) FROM turns), (SELECT count(*) FROM chunks), (SELECT count(*) FROM chunks WHERE vec IS NOT NULL)",
            [],
            |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)? as u64)),
        )?)
    }

    fn load_index(&self) -> Result<Index> {
        let mut turns = HashMap::new();
        let mut st = self.conn.prepare("SELECT id, session, ts, repo FROM turns")?;
        for r in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, Option<String>>(3)?)))? {
            let (id, session, ts, repo) = r?;
            turns.insert(id, TurnMeta { session, ts, repo });
        }
        let mut rows = Vec::new();
        let mut st = self.conn.prepare("SELECT turn, vec FROM chunks WHERE vec IS NOT NULL")?;
        for r in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))? {
            let (turn, b) = r?;
            if let Some((q, s)) = unpack(&b) {
                rows.push((turn, q, s));
            }
        }
        Ok(Index { rows, turns })
    }

    fn hit(&self, id: i64, score: f32) -> Result<MemoryHit> {
        let (session, agent, ts, project, body): (String, String, i64, String, Vec<u8>) =
            self.conn.query_row("SELECT session, agent, ts, project, body FROM turns WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?;
        let t: Turn = serde_json::from_slice(&zstd::decode_all(body.as_slice())?)?;
        let assistant = t.assistant.join("\n\n");
        Ok(MemoryHit {
            id,
            session,
            agent,
            ts,
            project,
            user: sessions::truncate_chars(for_search(&t.user).trim(), 600),
            assistant: tail_chars(for_search(&assistant).trim(), 1200),
            files: t.files,
            score,
        })
    }
}

fn tail_chars(s: &str, n: usize) -> String {
    let count = s.chars().count();
    if count <= n {
        s.to_string()
    } else {
        format!("…{}", s.chars().skip(count - n).collect::<String>())
    }
}

/// 요청과 답 끝부분이 같은 턴은 처음(점수가 높은) 것만 남긴다
fn dedupe(hits: Vec<MemoryHit>, limit: usize) -> Vec<MemoryHit> {
    let mut seen = std::collections::HashSet::new();
    hits.into_iter()
        .filter(|h| {
            let norm = |x: &str| x.split_whitespace().collect::<Vec<_>>().join(" ");
            seen.insert((norm(&h.user), tail_chars(&norm(&h.assistant), 200)))
        })
        .take(limit)
        .collect()
}

struct TurnMeta {
    session: String,
    ts: i64,
    repo: Option<String>,
}

/// 검색용으로 메모리에 올린 벡터(10만 조각이어도 약 26MB)
struct Index {
    rows: Vec<(i64, [i8; DIM], f32)>,
    turns: HashMap<i64, TurnMeta>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHit {
    pub id: i64,
    pub session: String,
    pub agent: String,
    pub ts: i64,
    pub project: String,
    pub user: String,
    pub assistant: String,
    pub files: Vec<String>,
    pub score: f32,
}

pub struct SearchScope<'a> {
    /// 이 저장소의 기록만(None 이면 믿는 저장소와 저장소 밖 폴더 전체)
    pub repo: Option<&'a str>,
    /// 이 세션에서 이 시각 이후의 턴은 뺀다(최근 대화로 따로 넣으니까)
    pub exclude: Option<(&'a str, i64)>,
    pub now: i64,
    pub limit: usize,
}

/// 턴 점수 = 그 턴 조각 중 가장 가까운 것 + 최근 기록 가산점. 믿지 않는 저장소 기록은 빼고, 같은 턴은 한 번만.
fn rank(index: &Index, query: &[f32], scope: &SearchScope, trusted: impl Fn(&str) -> bool) -> Vec<(i64, f32)> {
    let mut best: HashMap<i64, f32> = HashMap::new();
    for (turn, q, s) in &index.rows {
        let Some(m) = index.turns.get(turn) else { continue };
        if let Some(r) = &m.repo
            && !trusted(r)
        {
            continue;
        }
        if scope.repo.is_some() && m.repo.as_deref() != scope.repo {
            continue;
        }
        if let Some((sess, after)) = scope.exclude
            && m.session == sess
            && m.ts >= after
        {
            continue;
        }
        let v = score(query, q, *s);
        let e = best.entry(*turn).or_insert(f32::MIN);
        if v > *e {
            *e = v;
        }
    }
    let mut out: Vec<(i64, f32)> = best
        .into_iter()
        .map(|(t, s)| {
            let age_days = (scope.now - index.turns[&t].ts).max(0) as f32 / 86_400_000.0;
            (t, s + 0.02 * (-age_days / 30.0).exp())
        })
        .collect();
    out.sort_by(|a, b| b.1.total_cmp(&a.1));
    out.truncate(scope.limit);
    out
}

// ───────────── 기능 전체 ─────────────

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStatus {
    pub supported: bool,
    pub enabled: bool,
    /// unsupported | off | download | downloading | indexing | ready
    pub state: String,
    pub downloaded: u64,
    pub download_total: u64,
    pub turns: u64,
    pub chunks: u64,
    pub embedded: u64,
    pub db_bytes: u64,
    pub model_bytes: u64,
    pub error: Option<String>,
}

pub struct Memory {
    dir: PathBuf,
    events: EventSink,
    enabled: AtomicBool,
    downloading: AtomicBool,
    downloaded: AtomicU64,
    store: Mutex<Option<Store>>,
    worker: Mutex<Option<WorkerClient>>,
    /// 도우미를 못 띄웠으면 잠시 다시 띄우지 않는다
    worker_failed_at: Mutex<Option<Instant>>,
    index: Mutex<Option<Arc<Index>>>,
    error: Mutex<Option<String>>,
    /// 켠 뒤 기록을 한 번 다 읽었는지(그 전에는 '정리 중'으로 보인다)
    scanned: AtomicBool,
    /// 깨우기: 0 없음, 1 기록이 바뀜(몰아서 처리), 2 지금 바로
    wake: (Mutex<u8>, Condvar),
}

impl Memory {
    pub fn new(dir: PathBuf, events: EventSink) -> Arc<Self> {
        let enabled = supported() && dir.join("enabled").exists();
        // 새 세션에 넣고 남은 기억 파일 정리(하루 지난 것)
        if let Ok(rd) = std::fs::read_dir(dir.join("inject")) {
            for e in rd.flatten() {
                if e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().unwrap_or_default() > Duration::from_secs(86_400)) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        Arc::new(Self {
            dir,
            events,
            enabled: AtomicBool::new(enabled),
            downloading: AtomicBool::new(false),
            downloaded: AtomicU64::new(0),
            store: Mutex::new(None),
            worker: Mutex::new(None),
            worker_failed_at: Mutex::new(None),
            index: Mutex::new(None),
            error: Mutex::new(None),
            scanned: AtomicBool::new(false),
            wake: (Mutex::new(0), Condvar::new()),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// 기록 감시 스레드를 띄운다(쓸 수 있는 맥에서만)
    pub fn start(self: &Arc<Self>) {
        if !supported() {
            return;
        }
        let me = self.clone();
        let _ = std::thread::Builder::new().name("memory".into()).spawn(move || me.run());
    }

    /// 기록이 바뀌었다(세션 감시에서 부른다). 일하는 동안 계속 바뀌니 몰아서 처리한다.
    pub fn poke(&self) {
        let mut w = self.wake.0.lock();
        *w = (*w).max(1);
        self.wake.1.notify_one();
    }

    /// 켰을 때·내려받기가 끝났을 때: 바로 처리한다
    fn poke_now(&self) {
        *self.wake.0.lock() = 2;
        self.wake.1.notify_one();
    }

    fn run(self: Arc<Self>) {
        // 앱을 켜면 한 번 바로 읽는다
        self.poke_now();
        loop {
            {
                let mut woke = self.wake.0.lock();
                if *woke == 0 {
                    self.wake.1.wait_for(&mut woke, Duration::from_secs(60));
                }
                let why = std::mem::take(&mut *woke);
                drop(woke);
                if why == 1 {
                    std::thread::sleep(Duration::from_secs(10));
                }
            }
            if self.enabled() && memory_fetch::ready(&self.dir) {
                let r = self.ingest_all();
                if r.is_ok() && !self.scanned.swap(true, Ordering::Relaxed) {
                    self.emit_status();
                }
                if let Err(e) = r.and_then(|_| self.embed_pending()) {
                    eprintln!("[memory] {e:#}");
                    *self.error.lock() = Some(format!("{e:#}"));
                    self.emit_status();
                }
            }
            let idle = self.worker.lock().as_ref().is_some_and(|w| w.last_used.elapsed() > WORKER_IDLE);
            if idle || !self.enabled() {
                self.worker.lock().take();
            }
        }
    }

    fn with_store<T>(&self, f: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
        let mut g = self.store.lock();
        if g.is_none() {
            *g = Some(Store::open(&self.dir.join("memory.sqlite3"))?);
        }
        f(g.as_mut().expect("방금 열었다"))
    }

    fn ingest_all(&self) -> Result<usize> {
        let mut files: Vec<(&str, PathBuf)> = sessions::claude_session_files().into_iter().map(|p| ("claude", p)).collect();
        files.extend(sessions::codex_rollout_files().into_iter().map(|p| ("codex", p)));
        let now = crate::db::now_ms();
        let mut n = 0;
        for (agent, p) in files {
            if !self.enabled() {
                break;
            }
            match self.with_store(|s| s.ingest_file(agent, &p, now)) {
                Ok(k) => n += k,
                Err(e) => eprintln!("[memory] {} 읽기 실패: {e:#}", p.display()),
            }
        }
        if n > 0 {
            self.emit_status();
        }
        Ok(n)
    }

    fn worker_do<T>(&self, f: impl FnOnce(&mut WorkerClient) -> Result<T>) -> Result<T> {
        let mut g = self.worker.lock();
        if g.is_none() {
            if self.worker_failed_at.lock().is_some_and(|t| t.elapsed() < Duration::from_secs(600)) {
                return Err(anyhow!(self.error.lock().clone().unwrap_or_else(|| tr!("임베딩 도우미를 띄우지 못했습니다", "Couldn't start the embedding helper"))));
            }
            let spawned = WorkerClient::spawn(&memory_fetch::runtime_path(&self.dir), &memory_fetch::model_dir(&self.dir), &self.dir.join("worker.log"));
            match spawned {
                Ok(w) => *g = Some(w),
                Err(e) => {
                    *self.worker_failed_at.lock() = Some(Instant::now());
                    return Err(e);
                }
            }
        }
        let r = f(g.as_mut().expect("방금 띄웠다"));
        if r.is_err() {
            // 도우미가 죽었을 수 있다: 다음에 새로 띄운다
            g.take();
        }
        r
    }

    fn embed_pending(&self) -> Result<usize> {
        let mut done = 0;
        loop {
            if !self.enabled() {
                return Ok(done);
            }
            let batch = self.with_store(|s| s.pending(64))?;
            if batch.is_empty() {
                break;
            }
            for part in batch.chunks(BATCH) {
                if !self.enabled() {
                    return Ok(done);
                }
                let texts: Vec<String> = part.iter().map(|(_, t)| t.clone()).collect();
                let vecs = self.worker_do(|w| w.embed(&texts, false))?;
                let items: Vec<(i64, Vec<f32>)> = part.iter().map(|(id, _)| *id).zip(vecs).collect();
                self.with_store(|s| s.save_vectors(&items))?;
                done += part.len();
            }
            self.index.lock().take();
            *self.error.lock() = None;
            self.emit_status();
        }
        Ok(done)
    }

    pub fn search(&self, query: &str, cwd: Option<&str>, all: bool, exclude: Option<(&str, i64)>, limit: usize) -> Result<Vec<MemoryHit>> {
        if !self.enabled() || !memory_fetch::ready(&self.dir) {
            return Ok(Vec::new());
        }
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let qv = self.worker_do(|w| w.embed(&[redact(q)], true))?.pop().ok_or_else(|| anyhow!("질의 임베딩 없음"))?;
        let index = {
            let mut g = self.index.lock();
            if g.is_none() {
                *g = Some(Arc::new(self.with_store(|s| s.load_index())?));
            }
            g.clone().expect("방금 읽었다")
        };
        let repo = if all { None } else { cwd.and_then(|c| crate::trust::repo_id(Path::new(c))) };
        // 같은 내용의 턴(갈라 낸 세션 등)은 한 번만 보이게 넉넉히 뽑아 거른다
        let scope = SearchScope { repo: repo.as_deref(), exclude, now: crate::db::now_ms(), limit: limit * 3 };
        let ranked = rank(&index, &qv, &scope, crate::trust::is_trusted_id);
        let hits: Vec<MemoryHit> = self.with_store(|s| ranked.iter().map(|(id, sc)| s.hit(*id, *sc)).collect::<Result<_>>())?;
        Ok(dedupe(hits, limit))
    }

    /// 새 세션에 넣을 기억을 파일로 쓴다(Claude SessionStart 훅이 이 파일을 출력한다)
    pub fn write_inject(&self, text: &str) -> Result<PathBuf> {
        let dir = self.dir.join("inject");
        std::fs::create_dir_all(&dir)?;
        let p = dir.join(format!("{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&p, text)?;
        Ok(p)
    }

    pub fn status(&self) -> MemoryStatus {
        let sup = supported();
        let enabled = self.enabled();
        let ready = sup && memory_fetch::ready(&self.dir);
        let (turns, chunks, embedded) = if sup && self.dir.join("memory.sqlite3").exists() {
            self.with_store(|s| s.counts()).unwrap_or_default()
        } else {
            (0, 0, 0)
        };
        let db_bytes = ["memory.sqlite3", "memory.sqlite3-wal"].iter().filter_map(|f| std::fs::metadata(self.dir.join(f)).ok()).map(|m| m.len()).sum();
        let downloading = self.downloading.load(Ordering::Relaxed);
        let state = if !sup {
            "unsupported"
        } else if !enabled {
            "off"
        } else if downloading {
            "downloading"
        } else if !ready {
            "download"
        } else if embedded < chunks || !self.scanned.load(Ordering::Relaxed) {
            "indexing"
        } else {
            "ready"
        };
        MemoryStatus {
            supported: sup,
            enabled,
            state: state.into(),
            downloaded: self.downloaded.load(Ordering::Relaxed),
            download_total: memory_fetch::total_bytes(),
            turns,
            chunks,
            embedded,
            db_bytes,
            model_bytes: if sup { memory_fetch::bytes_on_disk(&self.dir) } else { 0 },
            error: self.error.lock().clone(),
        }
    }

    pub fn emit_status(&self) {
        (self.events)("memory-status", json!(self.status()));
    }

    pub fn set_enabled(&self, on: bool) -> Result<()> {
        if on && !supported() {
            return Err(anyhow!(tr!("이 맥에서는 작업 기억을 쓸 수 없습니다(Apple Silicon, macOS 14 이상 필요)", "Work memory isn't available on this Mac (needs Apple Silicon and macOS 14 or later)")));
        }
        std::fs::create_dir_all(&self.dir)?;
        let flag = self.dir.join("enabled");
        if on {
            std::fs::write(&flag, "")?;
        } else {
            let _ = std::fs::remove_file(&flag);
            self.worker.lock().take();
        }
        self.enabled.store(on, Ordering::Relaxed);
        self.scanned.store(false, Ordering::Relaxed);
        *self.error.lock() = None;
        *self.worker_failed_at.lock() = None;
        self.poke_now();
        self.emit_status();
        Ok(())
    }

    /// 내려받기 시작을 표시한다. 이미 받는 중이면 false.
    pub fn begin_download(&self) -> bool {
        if self.downloading.swap(true, Ordering::SeqCst) {
            return false;
        }
        *self.error.lock() = None;
        self.downloaded.store(0, Ordering::Relaxed);
        self.emit_status();
        true
    }

    pub fn download_progress(&self, done: u64) {
        self.downloaded.store(done, Ordering::Relaxed);
        self.emit_status();
    }

    pub fn end_download(&self, r: Result<()>) {
        self.downloading.store(false, Ordering::SeqCst);
        if let Err(e) = r {
            *self.error.lock() = Some(format!("{e:#}"));
        }
        self.poke_now();
        self.emit_status();
    }

    /// 보관한 기억을 모두 지운다(기록 원본에서 다시 읽는다 — Claude 가 이미 지운 원본은 돌아오지 않는다)
    pub fn clear(&self) -> Result<()> {
        self.store.lock().take();
        self.index.lock().take();
        for f in ["memory.sqlite3", "memory.sqlite3-wal", "memory.sqlite3-shm"] {
            match std::fs::remove_file(self.dir.join(f)) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e).context("기억 DB 지우기"),
                _ => {}
            }
        }
        self.scanned.store(false, Ordering::Relaxed);
        self.poke_now();
        self.emit_status();
        Ok(())
    }

    /// 내려받은 모델·라이브러리를 지우고 끈다
    pub fn remove_model(&self) -> Result<()> {
        self.set_enabled(false)?;
        memory_fetch::remove(&self.dir)?;
        self.emit_status();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn redacts_common_secrets() {
        let s = redact(
            "DATABASE_URL=postgresql://owner:abcDEF123@db.example.com/app?ssl=1\n\
             key sk-ant-api03-abcdefghijklmnopqrstuvwxyz\n\
             aws AKIAABCDEFGHIJKLMNOP and ghp_abcdefghijklmnopqrstuvwxyz0123456789\n\
             password = hunter2hunter2\n\
             let token = getToken();\n\
             Authorization: Bearer abcdefghijklmnopqrstuvwxyz.0123",
        );
        for leaked in ["abcDEF123", "sk-ant-api03", "AKIAABCDEFGHIJKLMNOP", "ghp_abcdef", "hunter2", "abcdefghijklmnopqrstuvwxyz.0123"] {
            assert!(!s.contains(leaked), "{leaked} 가 남음: {s}");
        }
        // 주소의 나머지와 코드 모양은 남는다(검색에 쓸모 있다)
        assert!(s.contains("postgresql://owner:[REDACTED]@db.example.com/app"), "{s}");
        assert!(s.contains("let token = getToken();"), "{s}");
    }

    #[test]
    fn days_are_utc_dates() {
        assert_eq!(day(0), "1970-01-01");
        assert_eq!(day(1_792_537_928_217), "2026-10-20");
        assert_eq!(day(951_782_400_000), "2000-02-29");
    }

    #[test]
    fn pieces_keep_paragraphs_and_cut_long_ones() {
        let long = "가".repeat(900);
        let p = pieces(&format!("첫 문단\n\n둘째 문단\n\n{long}"), 10, false);
        assert_eq!(p[0], "첫 문단\n둘째 문단");
        assert_eq!(p[1].chars().count(), PIECE);
        assert!(p.iter().all(|x| x.chars().count() <= PIECE));
        // 뒤에서 고르면 마지막 문단이 남는다
        assert_eq!(pieces("a\n\nb\n\nc", 1, true).len(), 1);
        assert_eq!(project_name(Some("/x/my-app/.git"), None), "my-app");
        assert_eq!(project_name(None, Some("/x/notes")), "notes");
    }

    #[test]
    fn packed_vectors_keep_order() {
        let a = crate::memory_worker::normalize(&(0..DIM).map(|i| (i as f32).sin()).collect::<Vec<_>>());
        let b = crate::memory_worker::normalize(&(0..DIM).map(|i| (i as f32).cos()).collect::<Vec<_>>());
        let (qa, sa) = unpack(&pack(&a)).unwrap();
        let (qb, sb) = unpack(&pack(&b)).unwrap();
        let exact = |x: &[f32], y: &[f32]| x.iter().zip(y).map(|(p, q)| p * q).sum::<f32>();
        assert!((score(&a, &qa, sa) - 1.0).abs() < 0.02);
        assert!((score(&a, &qb, sb) - exact(&a, &b)).abs() < 0.02);
    }

    fn jsonl(dir: &Path, name: &str, lines: &[Value]) -> PathBuf {
        let p = dir.join(name);
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&p).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        p
    }

    fn user(text: &str, ts: &str, cwd: &str) -> Value {
        json!({"type":"user","timestamp":ts,"cwd":cwd,"message":{"role":"user","content":text}})
    }
    fn reply(text: &str) -> Value {
        json!({"type":"assistant","message":{"content":[{"type":"text","text":text},{"type":"tool_use","name":"Edit","input":{"file_path":"/w/src/auth.rs"}}]}})
    }

    #[test]
    fn ingests_finished_turns_and_keeps_the_open_one_for_later() {
        let tmp = tempfile::tempdir().unwrap();
        let mut store = Store::open(&tmp.path().join("m.sqlite3")).unwrap();
        let p = jsonl(
            tmp.path(),
            "s1.jsonl",
            &[
                user("로그인 토큰이 만료되면 401 이 아니라 500 이 나와", "2026-10-01T00:00:00Z", "/w"),
                reply("refresh 처리에서 만료를 잡도록 고쳤습니다. 비밀번호는 password=supersecret1 이었어요"),
                json!({"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"error[E0425]: cannot find value"}]}}),
                user("고마워 이제 테스트도 추가해", "2026-10-01T00:05:00Z", "/w"),
            ],
        );
        let mtime = std::fs::metadata(&p).unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        // 방금 쓴 파일: 마지막 턴은 아직 일하는 중으로 본다
        assert_eq!(store.ingest_file("claude", &p, mtime + 1000).unwrap(), 1);
        let (turns, chunks, _) = store.counts().unwrap();
        assert_eq!(turns, 1);
        assert!(chunks >= 3);
        let texts: Vec<String> = store.pending(100).unwrap().into_iter().map(|x| x.1).collect();
        assert!(texts.iter().any(|t| t.contains("error: error[E0425]")), "{texts:?}");
        assert!(texts.iter().any(|t| t.contains("edited: auth.rs")), "{texts:?}");
        assert!(texts.iter().all(|t| !t.contains("supersecret1")), "{texts:?}");
        assert!(texts.iter().all(|t| t.starts_with("[w 2026-10-01] ")), "{texts:?}");
        // 바뀐 게 없으면 다시 읽지 않는다
        assert_eq!(store.ingest_file("claude", &p, mtime + 1000).unwrap(), 0);
        // 다음 요청이 오면 열려 있던 턴이 끝난다
        jsonl(tmp.path(), "s1.jsonl", &[reply("테스트를 추가했습니다"), user("커밋해", "2026-10-01T00:09:00Z", "/w")]);
        let mtime = std::fs::metadata(&p).unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64 + 1;
        assert_eq!(store.ingest_file("claude", &p, mtime).unwrap(), 1);
        // 오래 조용하면 마지막 턴도 넣는다
        assert_eq!(store.ingest_file("claude", &p, mtime + IDLE_MS + 1).unwrap(), 0, "크기·시각이 같으면 건너뛴다");
        store.conn.execute("UPDATE sources SET mtime = 0", []).unwrap();
        assert_eq!(store.ingest_file("claude", &p, mtime + IDLE_MS + 1).unwrap(), 1);
        assert_eq!(store.counts().unwrap().0, 3);
        let idx: Vec<i64> = store.conn.prepare("SELECT idx FROM turns ORDER BY idx").unwrap().query_map([], |r| r.get(0)).unwrap().map(|x| x.unwrap()).collect();
        assert_eq!(idx, vec![0, 1, 2]);
        // 원문은 압축해 보관하고, 비밀값은 가린다
        let hit = store.hit(1, 0.5).unwrap();
        assert!(hit.user.contains("401"));
        assert!(hit.assistant.contains("[REDACTED]") && !hit.assistant.contains("supersecret1"), "{}", hit.assistant);
        assert_eq!(hit.files, vec!["/w/src/auth.rs".to_string()]);
    }

    #[test]
    fn codex_new_format_only_when_present() {
        let ev = |t: &str, item: Value| json!({"timestamp":"2026-10-02T00:00:00Z","type":"event_msg","payload":{"type":t,"item":item}});
        let lines_new = [
            json!({"type":"event_msg","payload":{"type":"user_message","message":"옛 형식 요청"}}),
            ev("item_completed", json!({"type":"UserMessage","content":[{"type":"text","text":"차트 색 바꿔"}]})),
            ev("item_completed", json!({"type":"AgentMessage","content":[{"type":"text","text":"바꿨습니다"}]})),
            ev("item_completed", json!({"type":"CommandExecution","command":["bash","-lc","pnpm test"],"exit_code":1,"aggregated_output":"FAIL chart.test.ts"})),
            ev("item_completed", json!({"type":"FileChange","changes":{"/w/chart.ts":{"type":"update"}}})),
        ];
        let lines: Vec<(u64, Vec<u8>)> = lines_new.iter().enumerate().map(|(i, v)| (i as u64, v.to_string().into_bytes())).collect();
        let t = codex_turns(lines.clone().into_iter(), true);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].user, "차트 색 바꿔");
        assert_eq!(t[0].assistant, vec!["바꿨습니다".to_string()]);
        assert!(t[0].errors[0].contains("FAIL chart.test.ts"));
        assert_eq!(t[0].files, vec!["/w/chart.ts".to_string()]);
        let old = codex_turns(lines.into_iter(), false);
        assert_eq!(old.len(), 1);
        assert_eq!(old[0].user, "옛 형식 요청");
    }

    #[test]
    fn ranking_scopes_to_repo_skips_untrusted_and_recent_turns() {
        let v = |x: f32| {
            let mut a = vec![0f32; DIM];
            a[0] = x;
            a[1] = (1.0 - x * x).sqrt();
            a
        };
        let row = |turn: i64, x: f32| {
            let (q, s) = unpack(&pack(&v(x))).unwrap();
            (turn, q, s)
        };
        let meta = |session: &str, ts: i64, repo: Option<&str>| TurnMeta { session: session.into(), ts, repo: repo.map(String::from) };
        let index = Index {
            rows: vec![row(1, 0.9), row(1, 0.2), row(2, 0.95), row(3, 0.99), row(4, 0.8), row(5, 0.97)],
            turns: HashMap::from([
                (1, meta("a", 0, Some("/r/app/.git"))),
                (2, meta("b", 0, Some("/r/other/.git"))),
                (3, meta("c", 0, Some("/r/evil/.git"))),
                (4, meta("d", 0, None)),
                (5, meta("cur", 1000, Some("/r/app/.git"))),
            ]),
        };
        let trusted = |r: &str| r != "/r/evil/.git";
        let q = v(1.0);
        let all = rank(&index, &q, &SearchScope { repo: None, exclude: Some(("cur", 500)), now: 0, limit: 10 }, trusted);
        let ids: Vec<i64> = all.iter().map(|x| x.0).collect();
        // 믿지 않는 저장소(3)와 지금 세션의 최근 턴(5)은 빠지고, 같은 턴은 한 번만
        assert_eq!(ids, vec![2, 1, 4]);
        let mine = rank(&index, &q, &SearchScope { repo: Some("/r/app/.git"), exclude: None, now: 0, limit: 10 }, trusted);
        assert_eq!(mine.iter().map(|x| x.0).collect::<Vec<_>>(), vec![5, 1]);
    }

    /// 이 맥의 실제 기록을 임시 DB 로 한 번 읽어 시간·최대 메모리를 잰다(임베딩 없음). 평소엔 건너뛴다.
    /// `AITERM_MEMORY_BENCH_DB=<폴더> cargo test --release memory::tests::bench_real_logs -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_real_logs() {
        let Ok(dir) = std::env::var("AITERM_MEMORY_BENCH_DB") else { return };
        let mut store = Store::open(&Path::new(&dir).join("bench.sqlite3")).unwrap();
        let mut files: Vec<(&str, PathBuf)> = sessions::claude_session_files().into_iter().map(|p| ("claude", p)).collect();
        files.extend(sessions::codex_rollout_files().into_iter().map(|p| ("codex", p)));
        let bytes: u64 = files.iter().filter_map(|(_, p)| std::fs::metadata(p).ok()).map(|m| m.len()).sum();
        let t = Instant::now();
        let now = crate::db::now_ms();
        for (a, p) in &files {
            store.ingest_file(a, p, now).unwrap();
        }
        let first = t.elapsed();
        let t = Instant::now();
        for (a, p) in &files {
            store.ingest_file(a, p, now).unwrap();
        }
        let again = t.elapsed();
        let (turns, chunks, _) = store.counts().unwrap();
        let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
        unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };
        println!(
            "파일 {}개 {:.0}MB → 턴 {turns} 조각 {chunks}, 처음 {:.1}초, 다시(바뀐 것 없음) {} ms, 최대 메모리 {:.0}MB, DB {:.1}MB",
            files.len(),
            bytes as f64 / 1e6,
            first.as_secs_f64(),
            again.as_millis(),
            ru.ru_maxrss as f64 / 1_048_576.0,
            std::fs::metadata(Path::new(&dir).join("bench.sqlite3")).map(|m| m.len()).unwrap_or(0) as f64 / 1e6
                + std::fs::metadata(Path::new(&dir).join("bench.sqlite3-wal")).map(|m| m.len()).unwrap_or(0) as f64 / 1e6
        );
    }

    #[test]
    fn identical_turns_show_once() {
        let h = |id: i64, user: &str| MemoryHit { id, session: format!("s{id}"), agent: "claude".into(), ts: 0, project: "p".into(), user: user.into(), assistant: "같은 답".into(), files: vec![], score: 1.0 - id as f32 / 10.0 };
        let out = dedupe(vec![h(1, "로그인 고쳐"), h(2, "로그인  고쳐"), h(3, "정렬 고쳐"), h(4, "태그")], 2);
        assert_eq!(out.iter().map(|x| x.id).collect::<Vec<_>>(), vec![1, 3]);
    }
}
