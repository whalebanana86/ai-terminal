//! 자체 채팅 UI 백엔드. 원본 CLI 를 비대화형(JSON) 모드로 실행하고, 출력을 공통 이벤트로 바꾼다.
//!
//! - Claude Code: `claude -p --input-format stream-json --output-format stream-json` 상주 프로세스.
//!   `--permission-prompt-tool stdio` 로 도구 승인 요청(control_request can_use_tool)을 앱이 받아 답한다.
//! - Codex: 메시지마다 `codex exec --json` (이어서는 `codex exec resume <id>`). 승인 대신 샌드박스 수준을 고른다.

use anyhow::{anyhow, bail, Context, Result};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;

use crate::env::shell_env;

/// 채팅 하나에 보관하는 이벤트 양(다시 붙을 때 재생). 넘치면 오래된 것부터 버린다.
const MAX_EVENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_TEXT: usize = 20_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatEvent {
    /// 세션 id 확정(새 Codex 대화 등)
    #[serde(rename_all = "camelCase")]
    Session { session_id: String },
    User { text: String },
    Assistant { text: String },
    #[serde(rename_all = "camelCase")]
    Tool { id: String, name: String, summary: String, status: String, output: Option<String> },
    /// summary 는 실제 입력(명령·경로·내용 미리보기), description 은 모델이 쓴 설명(참고용)
    #[serde(rename_all = "camelCase")]
    Permission { request_id: String, tool: String, summary: String, description: Option<String>, input: Value },
    #[serde(rename_all = "camelCase")]
    PermissionResolved { request_id: String, allowed: bool },
    #[serde(rename_all = "camelCase")]
    FileChange { paths: Vec<String> },
    #[serde(rename_all = "camelCase")]
    TurnEnd { cost_usd: Option<f64>, is_error: bool, text: Option<String> },
    Error { text: String },
    #[serde(rename_all = "camelCase")]
    Exit { code: Option<i32> },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatInfo {
    pub id: String,
    pub agent: String,
    pub session_id: Option<String>,
    pub cwd: String,
    /// 답을 기다리는 중
    pub busy: bool,
    /// Claude: 권한 모드, Codex: 샌드박스
    pub mode: String,
    pub alive: bool,
    pub pid: Option<u32>,
}

pub type Sink = Box<dyn Fn(&ChatEvent) -> bool + Send>;

struct State {
    events: VecDeque<ChatEvent>,
    event_bytes: usize,
    sinks: Vec<(u64, Sink)>,
    busy: bool,
    /// 턴 번호. 이전 턴의 프로세스가 늦게 끝나도 새 턴 상태를 건드리지 않게 한다.
    turn: u64,
    session_id: Option<String>,
    /// 지금 돌고 있는 프로세스(그룹 리더) pid. 프로세스 자체는 리더 스레드가 갖는다.
    pid: Option<u32>,
    /// Claude 상주 프로세스가 살아 있는지 (Codex 는 항상 true)
    alive: bool,
    /// 답을 기다리는 승인 요청: request_id → 도구 원본 입력. 허용할 때 이 값만 돌려준다(화면이 바꿔치기 못 함).
    pending: HashMap<String, Value>,
}

pub struct Chat {
    pub id: String,
    pub agent: String,
    pub cwd: String,
    pub mode: String,
    state: Mutex<State>,
    /// Claude 표준입력. 상태 잠금과 따로 둬서 쓰는 동안 다른 작업을 막지 않는다.
    stdin: Mutex<Option<ChildStdin>>,
}

pub struct StartChat {
    pub agent: String,
    /// 이어갈 세션의 CLI id (없으면 새 대화)
    pub resume_id: Option<String>,
    pub cwd: String,
    /// Claude: default | acceptEdits | plan | bypassPermissions, Codex: read-only | workspace-write
    pub mode: String,
}

#[derive(Default)]
pub struct ChatManager {
    chats: Mutex<HashMap<String, Arc<Chat>>>,
    next_sink: std::sync::atomic::AtomicU64,
    /// 닫는 중인 채팅 프로세스. 완전히 끝날 때까지 "앱이 띄운 것"으로 본다(외부 실행으로 오인 방지).
    closing: Arc<Mutex<HashMap<u32, std::time::Instant>>>,
}

fn clip(s: &str) -> String {
    if s.len() <= MAX_TEXT {
        s.to_string()
    } else {
        let mut cut = MAX_TEXT;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}…", &s[..cut])
    }
}

fn summary_of(input: &Value) -> String {
    for k in ["command", "file_path", "notebook_path", "pattern", "url", "query", "description", "path", "prompt"] {
        if let Some(s) = input.get(k).and_then(Value::as_str) {
            return s.chars().take(300).collect();
        }
    }
    input.to_string().chars().take(300).collect()
}

fn lines_preview(text: &str, max_lines: usize) -> String {
    let mut out: Vec<&str> = text.lines().take(max_lines).collect();
    let total = text.lines().count();
    let mut s = out.join("\n");
    if total > max_lines {
        out.clear();
        s.push_str(&tr!("\n… ({}줄 더)", "\n… ({} more lines)", total - max_lines));
    }
    s
}

/// 승인 카드에 보여 줄 실제 입력. 모델이 쓴 설명이 아니라 실행될 명령·경로·내용을 보여 준다.
pub fn permission_summary(tool: &str, input: &Value) -> String {
    let get = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
    let s = match tool {
        "Bash" => get("command").to_string(),
        "Write" => format!("{}\n{}", get("file_path"), lines_preview(get("content"), 30)),
        "Edit" => format!("{}\n- {}\n+ {}", get("file_path"), lines_preview(get("old_string"), 12), lines_preview(get("new_string"), 12)),
        "MultiEdit" => tr!("{} (편집 {}곳)", "{} ({} edits)", get("file_path"), input.get("edits").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0)),
        "NotebookEdit" => format!("{}\n{}", get("notebook_path"), lines_preview(get("new_source"), 20)),
        "WebFetch" => get("url").to_string(),
        _ => serde_json::to_string_pretty(input).unwrap_or_default(),
    };
    s.chars().take(4000).collect()
}

/// 화면에 보낼 입력: 아주 긴 문자열(Write 내용 등)은 잘라 낸다. 원본은 pending 에만 둔다.
fn trim_value(v: &Value) -> Value {
    match v {
        Value::String(s) if s.len() > 4000 => Value::String(clip_to(s, 4000)),
        Value::Array(a) => Value::Array(a.iter().take(200).map(trim_value).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), trim_value(v))).collect()),
        other => other.clone(),
    }
}

fn clip_to(s: &str, max: usize) -> String {
    let mut cut = max.min(s.len());
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    if cut < s.len() {
        format!("{}…", &s[..cut])
    } else {
        s.to_string()
    }
}

fn ev_size(ev: &ChatEvent) -> usize {
    match ev {
        ChatEvent::User { text } | ChatEvent::Assistant { text } | ChatEvent::Error { text } => text.len() + 32,
        ChatEvent::Tool { summary, output, .. } => summary.len() + output.as_ref().map_or(0, |o| o.len()) + 64,
        ChatEvent::Permission { summary, input, .. } => summary.len() + input.to_string().len() + 64,
        ChatEvent::FileChange { paths } => paths.iter().map(|p| p.len()).sum::<usize>() + 32,
        _ => 64,
    }
}

fn base_command(program: &str, cwd: &str) -> Result<Command> {
    #[cfg(debug_assertions)]
    let program = std::env::var(format!("AITERM_{}_BIN", program.to_uppercase())).unwrap_or_else(|_| program.to_string());
    let path = crate::env::which(&program).ok_or_else(|| anyhow!(tr!("'{program}' 명령을 찾을 수 없습니다", "Command '{program}' not found")))?;
    let mut cmd = Command::new(path);
    cmd.current_dir(cwd).env_clear().envs(shell_env()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // 자식이 새 프로세스 그룹을 갖게 해 중지 때 그룹 전체를 정리한다.
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
    Ok(cmd)
}

impl Chat {
    /// 이벤트를 보관하고 화면에 보낸다. turn 이 주어지면 그 턴이 지금 턴일 때만 busy 를 내린다.
    fn push_turn(&self, ev: ChatEvent, turn: Option<u64>) {
        let mut st = self.state.lock();
        Self::push_locked(&mut st, ev, turn);
    }

    fn push(&self, ev: ChatEvent) {
        self.push_turn(ev, None);
    }

    fn push_locked(st: &mut State, ev: ChatEvent, turn: Option<u64>) {
        let mut ev = ev;
        match &mut ev {
            ChatEvent::Session { session_id } => st.session_id = Some(session_id.clone()),
            ChatEvent::Permission { request_id, input, .. } => {
                st.pending.insert(request_id.clone(), input.clone());
                *input = trim_value(input);
            }
            ChatEvent::PermissionResolved { request_id, .. } => {
                st.pending.remove(request_id);
            }
            ChatEvent::TurnEnd { .. } | ChatEvent::Exit { .. } => {
                if turn.is_none_or(|t| t == st.turn) {
                    st.busy = false;
                }
            }
            _ => {}
        }
        st.sinks.retain(|(_, s)| s(&ev));
        st.event_bytes += ev_size(&ev);
        st.events.push_back(ev);
        while st.event_bytes > MAX_EVENT_BYTES && st.events.len() > 1 {
            if let Some(old) = st.events.pop_front() {
                st.event_bytes = st.event_bytes.saturating_sub(ev_size(&old));
            }
        }
    }

    pub fn info(&self) -> ChatInfo {
        let st = self.state.lock();
        ChatInfo {
            id: self.id.clone(),
            agent: self.agent.clone(),
            session_id: st.session_id.clone(),
            cwd: self.cwd.clone(),
            busy: st.busy,
            mode: self.mode.clone(),
            alive: st.alive,
            pid: st.pid,
        }
    }

    pub fn alive(&self) -> bool {
        self.state.lock().alive
    }

    fn write_line(&self, v: &Value) -> Result<()> {
        let mut g = self.stdin.lock();
        let stdin = g.as_mut().ok_or_else(|| anyhow!(tr!("Claude 프로세스가 끝났습니다. 채팅을 닫고 다시 여세요.", "The Claude process has ended. Close the chat and open it again.")))?;
        writeln!(stdin, "{v}")?;
        stdin.flush()?;
        Ok(())
    }
}

// ───────────── Claude stream-json → 이벤트 ─────────────

/// Claude stream-json 한 줄을 이벤트로 바꾼다(테스트용 순수 함수). 승인 요청은 Permission 으로.
pub fn claude_line_to_events(v: &Value) -> Vec<ChatEvent> {
    let mut out = Vec::new();
    match v.get("type").and_then(Value::as_str) {
        Some("system") if v.get("subtype").and_then(Value::as_str) == Some("init") => {
            if let Some(sid) = v.get("session_id").and_then(Value::as_str) {
                out.push(ChatEvent::Session { session_id: format!("claude:{sid}") });
            }
        }
        Some("assistant") => {
            for c in v.pointer("/message/content").and_then(Value::as_array).into_iter().flatten() {
                match c.get("type").and_then(Value::as_str) {
                    Some("text") => out.push(ChatEvent::Assistant { text: clip(c.get("text").and_then(Value::as_str).unwrap_or("")) }),
                    Some("tool_use") => {
                        let input = c.get("input").cloned().unwrap_or(Value::Null);
                        let name = c.get("name").and_then(Value::as_str).unwrap_or("tool").to_string();
                        if matches!(name.as_str(), "Edit" | "Write" | "MultiEdit" | "NotebookEdit") {
                            if let Some(p) = input.get("file_path").or_else(|| input.get("notebook_path")).and_then(Value::as_str) {
                                out.push(ChatEvent::FileChange { paths: vec![p.to_string()] });
                            }
                        }
                        out.push(ChatEvent::Tool {
                            id: c.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                            summary: summary_of(&input),
                            name,
                            status: "running".into(),
                            output: None,
                        });
                    }
                    _ => {}
                }
            }
        }
        Some("user") => {
            // 도구 결과
            for c in v.pointer("/message/content").and_then(Value::as_array).into_iter().flatten() {
                if c.get("type").and_then(Value::as_str) == Some("tool_result") {
                    let text = match c.get("content") {
                        Some(Value::String(s)) => s.clone(),
                        Some(Value::Array(a)) => a.iter().filter_map(|x| x.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"),
                        _ => String::new(),
                    };
                    let err = c.get("is_error").and_then(Value::as_bool) == Some(true);
                    out.push(ChatEvent::Tool {
                        id: c.get("tool_use_id").and_then(Value::as_str).unwrap_or("").to_string(),
                        name: String::new(),
                        summary: String::new(),
                        status: if err { "error".into() } else { "ok".into() },
                        output: Some(clip(&text)),
                    });
                }
            }
        }
        Some("result") => out.push(ChatEvent::TurnEnd {
            cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
            is_error: v.get("is_error").and_then(Value::as_bool) == Some(true),
            text: v.get("result").and_then(Value::as_str).filter(|_| v.get("is_error").and_then(Value::as_bool) == Some(true)).map(str::to_string),
        }),
        Some("control_request") if v.pointer("/request/subtype").and_then(Value::as_str) == Some("can_use_tool") => {
            let input = v.pointer("/request/input").cloned().unwrap_or(Value::Null);
            let tool = v.pointer("/request/tool_name").and_then(Value::as_str).unwrap_or("tool").to_string();
            out.push(ChatEvent::Permission {
                request_id: v.get("request_id").and_then(Value::as_str).unwrap_or("").to_string(),
                summary: permission_summary(&tool, &input),
                description: v.pointer("/request/description").and_then(Value::as_str).map(str::to_string),
                tool,
                input,
            });
        }
        // CLI 가 승인 요청을 거둬들임(턴 중단 등)
        Some("control_cancel_request") => {
            if let Some(id) = v.get("request_id").and_then(Value::as_str) {
                out.push(ChatEvent::PermissionResolved { request_id: id.to_string(), allowed: false });
            }
        }
        _ => {}
    }
    out
}

/// Codex `exec --json` 한 줄을 이벤트로 바꾼다(테스트용 순수 함수).
pub fn codex_line_to_events(v: &Value) -> Vec<ChatEvent> {
    let mut out = Vec::new();
    let item = v.get("item");
    match v.get("type").and_then(Value::as_str) {
        Some("thread.started") => {
            if let Some(t) = v.get("thread_id").and_then(Value::as_str) {
                out.push(ChatEvent::Session { session_id: format!("codex:{t}") });
            }
        }
        Some(t @ ("item.started" | "item.completed")) => {
            let Some(item) = item else { return out };
            let id = item.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let done = t == "item.completed";
            match item.get("type").and_then(Value::as_str) {
                Some("agent_message") if done => out.push(ChatEvent::Assistant { text: clip(item.get("text").and_then(Value::as_str).unwrap_or("")) }),
                Some("command_execution") => {
                    let code = item.get("exit_code").and_then(Value::as_i64);
                    out.push(ChatEvent::Tool {
                        id,
                        name: "shell".into(),
                        summary: item.get("command").and_then(Value::as_str).unwrap_or("").chars().take(300).collect(),
                        status: if !done { "running".into() } else if code.is_some_and(|c| c != 0) { "error".into() } else { "ok".into() },
                        output: done.then(|| clip(item.get("aggregated_output").and_then(Value::as_str).unwrap_or(""))),
                    });
                }
                Some("file_change") => {
                    let paths: Vec<String> = item
                        .get("changes")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter_map(|c| c.get("path").and_then(Value::as_str).map(str::to_string)).collect())
                        .unwrap_or_default();
                    out.push(ChatEvent::Tool { id, name: "apply_patch".into(), summary: paths.join(", "), status: if done { "ok".into() } else { "running".into() }, output: None });
                    if done {
                        out.push(ChatEvent::FileChange { paths });
                    }
                }
                Some("mcp_tool_call") | Some("web_search") => {
                    let name = item.get("type").and_then(Value::as_str).unwrap_or("tool").to_string();
                    let summary = item.get("query").or_else(|| item.get("tool")).and_then(Value::as_str).unwrap_or("").to_string();
                    out.push(ChatEvent::Tool { id, name, summary, status: if done { "ok".into() } else { "running".into() }, output: None });
                }
                Some("error") if done => out.push(ChatEvent::Error { text: item.get("message").and_then(Value::as_str).unwrap_or("").to_string() }),
                _ => {}
            }
        }
        Some("turn.completed") => out.push(ChatEvent::TurnEnd { cost_usd: None, is_error: false, text: None }),
        Some("turn.failed") => out.push(ChatEvent::TurnEnd {
            cost_usd: None,
            is_error: true,
            text: v.pointer("/error/message").and_then(Value::as_str).map(str::to_string),
        }),
        Some("error") => out.push(ChatEvent::Error { text: v.get("message").and_then(Value::as_str).unwrap_or("").to_string() }),
        _ => {}
    }
    out
}

fn kill_group(pid: Option<u32>, sig: libc::c_int) {
    if let Some(pid) = pid {
        // SAFETY: 단순 시스템 호출. 실패(이미 종료)는 무시.
        unsafe {
            libc::killpg(pid as libc::pid_t, sig);
        }
    }
}

impl ChatManager {
    pub fn get(&self, id: &str) -> Option<Arc<Chat>> {
        self.chats.lock().get(id).cloned()
    }

    pub fn list(&self) -> Vec<ChatInfo> {
        self.chats.lock().values().map(|c| c.info()).collect()
    }

    /// 닫는 중이라 아직 살아 있는 채팅 프로세스 pid
    pub fn closing_pids(&self) -> Vec<u32> {
        let mut m = self.closing.lock();
        // 끝났거나(신호 0 실패) 오래된 항목은 지운다.
        m.retain(|pid, at| at.elapsed() < std::time::Duration::from_secs(30) && unsafe { libc::kill(*pid as libc::pid_t, 0) } == 0);
        m.keys().copied().collect()
    }

    /// 이 세션을 살아 있는 채팅으로 열어 둔 것이 있으면 그 채팅
    pub fn find_by_session(&self, session_id: &str) -> Option<Arc<Chat>> {
        self.chats.lock().values().find(|c| c.alive() && c.state.lock().session_id.as_deref() == Some(session_id)).cloned()
    }

    /// 프로세스가 끝난 채로 남은 같은 세션의 채팅(다시 열 때 정리용)
    pub fn dead_for_session(&self, session_id: &str) -> Vec<String> {
        self.chats
            .lock()
            .values()
            .filter(|c| !c.alive() && c.state.lock().session_id.as_deref() == Some(session_id))
            .map(|c| c.id.clone())
            .collect()
    }

    pub fn start(&self, req: StartChat, on_change: Arc<dyn Fn(&ChatInfo) + Send + Sync>) -> Result<ChatInfo> {
        if !std::path::Path::new(&req.cwd).is_dir() {
            bail!(tr!("작업 폴더가 없습니다: {}", "Working folder not found: {}", req.cwd));
        }
        if let Some(r) = &req.resume_id {
            if !crate::sessions::is_safe_session_id(r) {
                bail!(tr!("세션 id 형식이 올바르지 않습니다", "Invalid session ID format"));
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let session_id = match (req.agent.as_str(), &req.resume_id) {
            ("claude", Some(r)) => Some(format!("claude:{r}")),
            ("claude", None) => None, // 아래에서 --session-id 로 정한다
            ("codex", Some(r)) => Some(format!("codex:{r}")),
            ("codex", None) => None,
            _ => bail!(tr!("지원하지 않는 에이전트입니다", "Unsupported agent")),
        };
        let chat = Arc::new(Chat {
            id: id.clone(),
            agent: req.agent.clone(),
            cwd: req.cwd.clone(),
            mode: req.mode.clone(),
            state: Mutex::new(State {
                events: VecDeque::new(),
                event_bytes: 0,
                sinks: Vec::new(),
                busy: false,
                turn: 0,
                session_id,
                pid: None,
                alive: true,
                pending: HashMap::new(),
            }),
            stdin: Mutex::new(None),
        });
        if req.agent == "claude" {
            let mode = match req.mode.as_str() {
                m @ ("default" | "acceptEdits" | "plan" | "bypassPermissions") => m,
                _ => "default",
            };
            let mut cmd = base_command("claude", &req.cwd)?;
            cmd.args([
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--permission-prompts",
                "host",
                "--permission-prompt-tool",
                "stdio",
                "--permission-mode",
                mode,
            ]);
            match &req.resume_id {
                Some(r) => {
                    cmd.args(["--resume", r]);
                }
                None => {
                    let sid = uuid::Uuid::new_v4().to_string();
                    cmd.args(["--session-id", &sid]);
                    chat.state.lock().session_id = Some(format!("claude:{sid}"));
                }
            }
            let mut child = cmd.spawn().with_context(|| tr!("claude 를 실행하지 못했습니다", "Failed to start claude"))?;
            let stdin = child.stdin.take().unwrap();
            chat.state.lock().pid = Some(child.id());
            *chat.stdin.lock() = Some(stdin);
            // 승인 요청을 앱이 받도록 제어 프로토콜을 연다.
            chat.write_line(&json!({"type":"control_request","request_id":"aiterm-init","request":{"subtype":"initialize","hooks":null}}))?;
            spawn_reader(chat.clone(), child, true, 0, on_change);
        }
        self.chats.lock().insert(id.clone(), chat.clone());
        Ok(chat.info())
    }

    /// 지금까지의 이벤트를 먼저 보내고 이후 이벤트를 계속 보낸다.
    pub fn attach(&self, id: &str, sink: Sink) -> Result<u64> {
        let chat = self.get(id).ok_or_else(|| anyhow!(tr!("채팅을 찾을 수 없습니다", "Chat not found")))?;
        let sid = self.next_sink.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut st = chat.state.lock();
        for ev in &st.events {
            if !sink(ev) {
                return Err(anyhow!(tr!("화면에 연결하지 못했습니다", "Failed to connect to the view")));
            }
        }
        st.sinks.push((sid, sink));
        Ok(sid)
    }

    pub fn detach(&self, id: &str, sink_id: u64) {
        if let Some(c) = self.get(id) {
            c.state.lock().sinks.retain(|(s, _)| *s != sink_id);
        }
    }

    pub fn send(&self, id: &str, text: &str, on_change: Arc<dyn Fn(&ChatInfo) + Send + Sync>) -> Result<()> {
        let chat = self.get(id).ok_or_else(|| anyhow!(tr!("채팅을 찾을 수 없습니다", "Chat not found")))?;
        if text.trim().is_empty() {
            bail!(tr!("보낼 내용을 입력하세요", "Enter a message to send"));
        }
        // busy 확인과 설정을 한 잠금 안에서: 두 번 눌러도 턴이 하나만 시작된다.
        let turn = {
            let mut st = chat.state.lock();
            if !st.alive {
                bail!(tr!("에이전트 프로세스가 끝났습니다. 채팅을 닫고 다시 여세요.", "The agent process has ended. Close the chat and open it again."));
            }
            if st.busy {
                bail!(tr!("에이전트가 아직 답하는 중입니다", "The agent is still responding"));
            }
            st.busy = true;
            st.turn += 1;
            Chat::push_locked(&mut st, ChatEvent::User { text: clip(text) }, None);
            st.turn
        };
        on_change(&chat.info());
        let fail = |e: anyhow::Error| {
            chat.push_turn(ChatEvent::TurnEnd { cost_usd: None, is_error: true, text: Some(e.to_string()) }, Some(turn));
            on_change(&chat.info());
            e
        };
        if chat.agent == "claude" {
            return chat.write_line(&json!({"type":"user","message":{"role":"user","content":text}})).map_err(fail);
        }
        // Codex: 메시지마다 exec 를 띄운다. 프롬프트는 표준입력으로(인자 길이·따옴표 문제 없음).
        let sandbox = if chat.mode == "workspace-write" { "workspace-write" } else { "read-only" };
        let mut cmd = base_command("codex", &chat.cwd).map_err(fail)?;
        let resume = chat.state.lock().session_id.clone().and_then(|s| s.strip_prefix("codex:").map(str::to_string));
        match resume {
            Some(r) => {
                cmd.args(["exec", "resume", "--json", "--skip-git-repo-check", "-c"]).arg(format!("sandbox_mode=\"{sandbox}\"")).args([r.as_str(), "-"]);
            }
            None => {
                cmd.args(["exec", "--json", "--skip-git-repo-check", "-s", sandbox, "-C", &chat.cwd, "-"]);
            }
        }
        let mut child = cmd.spawn().map_err(|e| fail(anyhow!(tr!("codex 를 실행하지 못했습니다: {e}", "Failed to start codex: {e}"))))?;
        let mut stdin = child.stdin.take().unwrap();
        chat.state.lock().pid = Some(child.id());
        // 프롬프트를 쓰고 닫는다(EOF = 프롬프트 끝). 쓰기는 잠금 밖에서 한다.
        let write = stdin.write_all(text.as_bytes());
        drop(stdin);
        spawn_reader(chat.clone(), child, false, turn, on_change);
        write.map_err(|e| anyhow!(tr!("codex 에 메시지를 보내지 못했습니다: {e}", "Failed to send the message to codex: {e}")))
    }

    /// Claude 도구 승인 요청에 답한다. 허용 시 도구 입력은 요청 때 받은 원본을 그대로 돌려준다.
    pub fn respond_permission(&self, id: &str, request_id: &str, allow: bool) -> Result<()> {
        let chat = self.get(id).ok_or_else(|| anyhow!(tr!("채팅을 찾을 수 없습니다", "Chat not found")))?;
        let original = chat.state.lock().pending.remove(request_id).ok_or_else(|| anyhow!(tr!("이미 답했거나 없는 승인 요청입니다", "This permission request was already answered or does not exist")))?;
        let response = if allow {
            json!({"behavior":"allow","updatedInput": original})
        } else {
            json!({"behavior":"deny","message": tr!("사용자가 코드행방에서 거부했습니다", "Denied by the user in Code Whereabouts")})
        };
        chat.write_line(&json!({"type":"control_response","response":{"subtype":"success","request_id":request_id,"response":response}}))?;
        chat.push(ChatEvent::PermissionResolved { request_id: request_id.to_string(), allowed: allow });
        Ok(())
    }

    /// 지금 답하는 중인 턴만 멈춘다(채팅은 유지).
    pub fn interrupt(&self, id: &str) -> Result<()> {
        let chat = self.get(id).ok_or_else(|| anyhow!(tr!("채팅을 찾을 수 없습니다", "Chat not found")))?;
        if !chat.state.lock().busy {
            return Ok(());
        }
        if chat.agent == "claude" {
            chat.write_line(&json!({"type":"control_request","request_id":uuid::Uuid::new_v4().to_string(),"request":{"subtype":"interrupt"}}))?;
        } else {
            kill_group(chat.state.lock().pid, libc::SIGINT);
        }
        Ok(())
    }

    /// 채팅을 닫는다(프로세스 그룹 종료). 대화 기록은 CLI 쪽에 남아 다시 이어갈 수 있다.
    pub fn close(&self, id: &str) {
        let Some(chat) = self.chats.lock().remove(id) else { return };
        chat.stdin.lock().take(); // EOF → Claude 가 스스로 끝난다
        let pid = chat.state.lock().pid;
        if let Some(p) = pid {
            self.closing.lock().insert(p, std::time::Instant::now());
        }
        if pid.is_some() {
            kill_group(pid, libc::SIGTERM);
            let c = chat.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(800));
                // 리더 스레드가 프로세스를 회수했으면 pid 가 지워진다.
                let still = c.state.lock().pid;
                if still.is_some() {
                    kill_group(still, libc::SIGKILL);
                }
            });
        }
    }

    pub fn close_all(&self) {
        let ids: Vec<String> = self.chats.lock().keys().cloned().collect();
        for id in ids {
            self.close(&id);
        }
    }
}

/// 프로세스 출력을 읽어 이벤트로 바꾼다. 프로세스(Child)는 이 스레드가 갖고, 끝나면 잠금 밖에서 회수한다.
fn spawn_reader(chat: Arc<Chat>, mut child: Child, claude: bool, turn: u64, on_change: Arc<dyn Fn(&ChatInfo) + Send + Sync>) {
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let pid = child.id();
    // stderr 는 마지막 몇 줄만 모아 두었다가 비정상 종료 때 보여 준다.
    let tail: Arc<Mutex<VecDeque<String>>> = Arc::default();
    let t2 = tail.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut t = t2.lock();
            t.push_back(line);
            if t.len() > 20 {
                t.pop_front();
            }
        }
    });
    std::thread::spawn(move || {
        let mut session_known = chat.state.lock().session_id.clone();
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let evs = if claude { claude_line_to_events(&v) } else { codex_line_to_events(&v) };
            for ev in evs {
                if let ChatEvent::Session { session_id } = &ev {
                    if session_known.as_deref() == Some(session_id.as_str()) {
                        continue; // 이미 아는 세션이면 다시 알리지 않는다
                    }
                    session_known = Some(session_id.clone());
                }
                let changed = matches!(ev, ChatEvent::Session { .. } | ChatEvent::TurnEnd { .. });
                chat.push_turn(ev, if claude { None } else { Some(turn) });
                if changed {
                    on_change(&chat.info());
                }
            }
        }
        // 출력이 끝났다 = 프로세스 종료. 잠금 없이 회수한다.
        let code = child.wait().ok().and_then(|s| s.code());
        if code.is_some_and(|c| c != 0) || (claude && code.is_none()) {
            let err = tail.lock().iter().cloned().collect::<Vec<_>>().join("\n");
            if !err.trim().is_empty() {
                chat.push(ChatEvent::Error { text: clip(&err) });
            }
        }
        {
            let mut st = chat.state.lock();
            if st.pid == Some(pid) {
                st.pid = None;
            }
            if claude {
                st.alive = false;
                st.pending.clear();
            }
        }
        if claude {
            chat.stdin.lock().take();
            chat.push(ChatEvent::Exit { code });
        } else {
            // Codex exec 는 턴마다 끝난다. 이 턴이 아직 열려 있으면(turn.completed 없이 끝남) 닫는다.
            let open = {
                let st = chat.state.lock();
                st.busy && st.turn == turn
            };
            if open {
                chat.push_turn(ChatEvent::TurnEnd { cost_usd: None, is_error: code != Some(0), text: None }, Some(turn));
            }
        }
        on_change(&chat.info());
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_events_including_permission() {
        let init = json!({"type":"system","subtype":"init","session_id":"abc"});
        assert_eq!(claude_line_to_events(&init), vec![ChatEvent::Session { session_id: "claude:abc".into() }]);
        let a = json!({"type":"assistant","message":{"content":[{"type":"text","text":"좋아요"},{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"/r/a.txt","content":"x"}}]}});
        let ev = claude_line_to_events(&a);
        assert_eq!(ev[0], ChatEvent::Assistant { text: "좋아요".into() });
        assert_eq!(ev[1], ChatEvent::FileChange { paths: vec!["/r/a.txt".into()] });
        assert!(matches!(&ev[2], ChatEvent::Tool { id, name, status, .. } if id == "t1" && name == "Write" && status == "running"));
        let p = json!({"type":"control_request","request_id":"r9","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"description":"목록"}});
        // 카드에는 모델이 쓴 설명("목록")이 아니라 실제 명령이 나온다
        assert!(matches!(&claude_line_to_events(&p)[0], ChatEvent::Permission { request_id, tool, summary, description, .. } if request_id == "r9" && tool == "Bash" && summary == "ls" && description.as_deref() == Some("목록")));
        let cancel = json!({"type":"control_cancel_request","request_id":"r9"});
        assert_eq!(claude_line_to_events(&cancel), vec![ChatEvent::PermissionResolved { request_id: "r9".into(), allowed: false }]);
        let r = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok","is_error":false}]}});
        assert!(matches!(&claude_line_to_events(&r)[0], ChatEvent::Tool { status, output, .. } if status == "ok" && output.as_deref() == Some("ok")));
        let end = json!({"type":"result","total_cost_usd":0.12,"is_error":false});
        assert!(matches!(claude_line_to_events(&end)[0], ChatEvent::TurnEnd { cost_usd: Some(c), is_error: false, .. } if (c - 0.12).abs() < 1e-9));
    }

    #[test]
    fn codex_events() {
        let ev = codex_line_to_events(&json!({"type":"thread.started","thread_id":"01a1"}));
        assert_eq!(ev, vec![ChatEvent::Session { session_id: "codex:01a1".into() }]);
        let ev = codex_line_to_events(&json!({"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls","aggregated_output":"a\n","exit_code":2}}));
        assert!(matches!(&ev[0], ChatEvent::Tool { status, .. } if status == "error"));
        let ev = codex_line_to_events(&json!({"type":"item.completed","item":{"id":"i2","type":"file_change","changes":[{"path":"/w/p.txt","kind":"add"}]}}));
        assert_eq!(ev[1], ChatEvent::FileChange { paths: vec!["/w/p.txt".into()] });
        let ev = codex_line_to_events(&json!({"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"완료"}}));
        assert_eq!(ev, vec![ChatEvent::Assistant { text: "완료".into() }]);
        assert!(matches!(codex_line_to_events(&json!({"type":"turn.completed"}))[0], ChatEvent::TurnEnd { is_error: false, .. }));
    }

    fn fake(dir: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        p
    }

    fn collect(m: &ChatManager, id: &str) -> Arc<Mutex<Vec<ChatEvent>>> {
        let got: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
        let g = got.clone();
        m.attach(id, Box::new(move |e| {
            g.lock().push(e.clone());
            true
        }))
        .unwrap();
        got
    }

    fn wait_for(got: &Arc<Mutex<Vec<ChatEvent>>>, f: impl Fn(&[ChatEvent]) -> bool) -> bool {
        for _ in 0..100 {
            if f(&got.lock()) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        false
    }

    use crate::env::TEST_ENV_LOCK as BIN_LOCK;

    #[test]
    fn claude_chat_roundtrip_with_fake_cli() {
        let _g = BIN_LOCK.lock();
        let d = tempfile::tempdir().unwrap();
        // 가짜 claude: initialize 를 읽고, 사용자 메시지 한 줄마다 승인 요청 → 응답을 받으면 답과 result 를 낸다.
        let bin = fake(
            d.path(),
            "claude",
            r#"read init
echo '{"type":"system","subtype":"init","session_id":"s1"}'
while read line; do
  case "$line" in
    *control_response*) echo '{"type":"assistant","message":{"content":[{"type":"text","text":"허용 받음"}]}}'; echo '{"type":"result","total_cost_usd":0.01,"is_error":false}';;
    *'"type":"user"'*) echo '{"type":"control_request","request_id":"p1","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"/x"}}}';;
  esac
done"#,
        );
        unsafe { std::env::set_var("AITERM_CLAUDE_BIN", &bin) };
        let m = ChatManager::default();
        let info = m
            .start(StartChat { agent: "claude".into(), resume_id: Some("s1".into()), cwd: d.path().to_string_lossy().into(), mode: "default".into() }, Arc::new(|_| {}))
            .unwrap();
        assert_eq!(info.session_id.as_deref(), Some("claude:s1"));
        let got = collect(&m, &info.id);
        m.send(&info.id, "파일 만들어 줘", Arc::new(|_| {})).unwrap();
        assert!(wait_for(&got, |e| e.iter().any(|x| matches!(x, ChatEvent::Permission { .. }))));
        assert!(m.send(&info.id, "또", Arc::new(|_| {})).is_err(), "busy until turn ends");
        m.respond_permission(&info.id, "p1", true).unwrap();
        assert!(m.respond_permission(&info.id, "p1", true).is_err(), "cannot answer twice");
        assert!(wait_for(&got, |e| e.iter().any(|x| matches!(x, ChatEvent::TurnEnd { .. }))));
        assert!(!m.get(&info.id).unwrap().info().busy);
        m.close(&info.id);
        unsafe { std::env::remove_var("AITERM_CLAUDE_BIN") };
    }

    #[test]
    fn codex_next_turn_while_previous_process_still_exiting_does_not_deadlock() {
        let _g = BIN_LOCK.lock();
        let d = tempfile::tempdir().unwrap();
        // turn.completed 를 낸 뒤에도 잠시 살아 있다가 끝나는 codex (실제 codex 처럼)
        let bin = fake(
            d.path(),
            "codex",
            r#"p=$(cat)
echo '{"type":"thread.started","thread_id":"t-9"}'
echo '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"'"$p"'"}}'
echo '{"type":"turn.completed"}'
sleep 1"#,
        );
        unsafe { std::env::set_var("AITERM_CODEX_BIN", &bin) };
        let m = ChatManager::default();
        let info = m
            .start(StartChat { agent: "codex".into(), resume_id: None, cwd: d.path().to_string_lossy().into(), mode: "read-only".into() }, Arc::new(|_| {}))
            .unwrap();
        let got = collect(&m, &info.id);
        m.send(&info.id, "하나", Arc::new(|_| {})).unwrap();
        assert!(wait_for(&got, |e| e.iter().any(|x| matches!(x, ChatEvent::TurnEnd { .. }))));
        // 첫 프로세스가 아직 끝나지 않은 사이 바로 다음 턴
        m.send(&info.id, "둘", Arc::new(|_| {})).unwrap();
        let t = std::time::Instant::now();
        let _ = m.list();
        assert!(t.elapsed() < std::time::Duration::from_millis(300), "list must not block");
        // 첫 프로세스가 끝나도 둘째 턴의 busy 를 내리지 않는다
        std::thread::sleep(std::time::Duration::from_millis(1300));
        let ends = got.lock().iter().filter(|x| matches!(x, ChatEvent::TurnEnd { .. })).count();
        if ends < 2 {
            assert!(m.get(&info.id).unwrap().info().busy, "turn 2 still running");
        }
        assert!(wait_for(&got, |e| e.iter().filter(|x| matches!(x, ChatEvent::TurnEnd { .. })).count() == 2));
        assert!(wait_for(&got, |e| e.iter().any(|x| *x == ChatEvent::Assistant { text: "둘".into() })));
        unsafe { std::env::remove_var("AITERM_CODEX_BIN") };
    }

    #[test]
    fn claude_dead_process_blocks_send_without_sticking_busy() {
        let _g = BIN_LOCK.lock();
        let d = tempfile::tempdir().unwrap();
        let bin = fake(d.path(), "claude", "read init\nexit 3");
        unsafe { std::env::set_var("AITERM_CLAUDE_BIN", &bin) };
        let m = ChatManager::default();
        let info = m
            .start(StartChat { agent: "claude".into(), resume_id: Some("s2".into()), cwd: d.path().to_string_lossy().into(), mode: "default".into() }, Arc::new(|_| {}))
            .unwrap();
        let got = collect(&m, &info.id);
        assert!(wait_for(&got, |e| e.iter().any(|x| matches!(x, ChatEvent::Exit { .. }))));
        assert!(m.send(&info.id, "안녕", Arc::new(|_| {})).is_err());
        assert!(!m.get(&info.id).unwrap().info().busy);
        assert!(m.find_by_session("claude:s2").is_none(), "dead chat must not occupy the session");
        assert_eq!(m.dead_for_session("claude:s2"), vec![info.id.clone()]);
        unsafe { std::env::remove_var("AITERM_CLAUDE_BIN") };
    }

    #[test]
    fn codex_chat_turns_with_fake_cli() {
        let _g = BIN_LOCK.lock();
        let d = tempfile::tempdir().unwrap();
        // 가짜 codex: 인자를 기록하고, 프롬프트(표준입력)를 그대로 답한다.
        let log = d.path().join("args.log");
        let bin = fake(
            d.path(),
            "codex",
            &format!(
                r#"echo "$*" >> {log}
p=$(cat)
echo '{{"type":"thread.started","thread_id":"t-1"}}'
echo '{{"type":"item.completed","item":{{"id":"i","type":"agent_message","text":"'"$p"'"}}}}'
echo '{{"type":"turn.completed"}}'"#,
                log = log.display()
            ),
        );
        unsafe { std::env::set_var("AITERM_CODEX_BIN", &bin) };
        let m = ChatManager::default();
        let info = m
            .start(StartChat { agent: "codex".into(), resume_id: None, cwd: d.path().to_string_lossy().into(), mode: "workspace-write".into() }, Arc::new(|_| {}))
            .unwrap();
        let got = collect(&m, &info.id);
        m.send(&info.id, "첫 질문", Arc::new(|_| {})).unwrap();
        assert!(wait_for(&got, |e| e.iter().filter(|x| matches!(x, ChatEvent::TurnEnd { .. })).count() == 1));
        assert_eq!(m.get(&info.id).unwrap().info().session_id.as_deref(), Some("codex:t-1"));
        m.send(&info.id, "둘째", Arc::new(|_| {})).unwrap();
        assert!(wait_for(&got, |e| e.iter().filter(|x| matches!(x, ChatEvent::TurnEnd { .. })).count() == 2));
        let args = std::fs::read_to_string(&log).unwrap();
        let lines: Vec<&str> = args.lines().collect();
        assert!(lines[0].starts_with("exec --json") && lines[0].contains("-s workspace-write"), "{args}");
        assert!(lines[1].starts_with("exec resume --json") && lines[1].contains("t-1"), "second turn resumes: {args}");
        assert!(got.lock().iter().any(|e| *e == ChatEvent::Assistant { text: "둘째".into() }));
        unsafe { std::env::remove_var("AITERM_CODEX_BIN") };
    }
}
