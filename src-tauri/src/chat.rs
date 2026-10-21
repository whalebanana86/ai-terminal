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

/// 채팅 하나에 보관하는 이벤트 수(다시 붙을 때 재생). 넘치면 오래된 것부터 버린다.
const MAX_EVENTS: usize = 3000;
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
    #[serde(rename_all = "camelCase")]
    Permission { request_id: String, tool: String, summary: String, input: Value },
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
    sinks: Vec<(u64, Sink)>,
    busy: bool,
    session_id: Option<String>,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    pid: Option<u32>,
}

pub struct Chat {
    pub id: String,
    pub agent: String,
    pub cwd: String,
    pub mode: String,
    state: Mutex<State>,
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

fn base_command(program: &str, cwd: &str) -> Result<Command> {
    #[cfg(debug_assertions)]
    let program = std::env::var(format!("AITERM_{}_BIN", program.to_uppercase())).unwrap_or_else(|_| program.to_string());
    let path = crate::env::which(&program).ok_or_else(|| anyhow!("'{program}' 명령을 찾을 수 없습니다"))?;
    let mut cmd = Command::new(path);
    cmd.current_dir(cwd).env_clear().envs(shell_env()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // 자식이 새 프로세스 그룹을 갖게 해 중지 때 그룹 전체를 정리한다.
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
    Ok(cmd)
}

impl Chat {
    fn push(&self, ev: ChatEvent) {
        let mut st = self.state.lock();
        if let ChatEvent::Session { session_id } = &ev {
            st.session_id = Some(session_id.clone());
        }
        match &ev {
            ChatEvent::TurnEnd { .. } | ChatEvent::Exit { .. } => st.busy = false,
            _ => {}
        }
        st.sinks.retain(|(_, s)| s(&ev));
        st.events.push_back(ev);
        while st.events.len() > MAX_EVENTS {
            st.events.pop_front();
        }
    }

    pub fn info(&self) -> ChatInfo {
        let st = self.state.lock();
        let alive = match self.agent.as_str() {
            "claude" => st.child.is_some(),
            _ => true, // Codex 는 메시지마다 프로세스를 띄우므로 채팅 자체는 항상 열려 있다
        };
        ChatInfo {
            id: self.id.clone(),
            agent: self.agent.clone(),
            session_id: st.session_id.clone(),
            cwd: self.cwd.clone(),
            busy: st.busy,
            mode: self.mode.clone(),
            alive,
            pid: st.pid,
        }
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
            out.push(ChatEvent::Permission {
                request_id: v.get("request_id").and_then(Value::as_str).unwrap_or("").to_string(),
                tool: v.pointer("/request/tool_name").and_then(Value::as_str).unwrap_or("tool").to_string(),
                summary: v.pointer("/request/description").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| summary_of(&input)),
                input,
            });
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

    /// 이 세션을 이미 채팅으로 열어 둔 것이 있으면 그 채팅
    pub fn find_by_session(&self, session_id: &str) -> Option<Arc<Chat>> {
        self.chats.lock().values().find(|c| c.state.lock().session_id.as_deref() == Some(session_id)).cloned()
    }

    pub fn start(&self, req: StartChat, on_change: Arc<dyn Fn(&ChatInfo) + Send + Sync>) -> Result<ChatInfo> {
        if !std::path::Path::new(&req.cwd).is_dir() {
            bail!("작업 폴더가 없습니다: {}", req.cwd);
        }
        if let Some(r) = &req.resume_id {
            if !crate::sessions::is_safe_session_id(r) {
                bail!("세션 id 형식이 올바르지 않습니다");
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let session_id = match (req.agent.as_str(), &req.resume_id) {
            ("claude", Some(r)) => Some(format!("claude:{r}")),
            ("claude", None) => None, // 아래에서 --session-id 로 정한다
            ("codex", Some(r)) => Some(format!("codex:{r}")),
            ("codex", None) => None,
            _ => bail!("지원하지 않는 에이전트입니다"),
        };
        let chat = Arc::new(Chat {
            id: id.clone(),
            agent: req.agent.clone(),
            cwd: req.cwd.clone(),
            mode: req.mode.clone(),
            state: Mutex::new(State { events: VecDeque::new(), sinks: Vec::new(), busy: false, session_id, child: None, stdin: None, pid: None }),
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
            let mut child = cmd.spawn().context("claude 를 실행하지 못했습니다")?;
            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take().unwrap();
            let mut stdin = child.stdin.take().unwrap();
            // 승인 요청을 앱이 받도록 제어 프로토콜을 연다.
            writeln!(stdin, "{}", json!({"type":"control_request","request_id":"aiterm-init","request":{"subtype":"initialize","hooks":null}}))?;
            stdin.flush()?;
            {
                let mut st = chat.state.lock();
                st.pid = Some(child.id());
                st.child = Some(child);
                st.stdin = Some(stdin);
            }
            spawn_reader(chat.clone(), stdout, stderr, true, on_change);
        }
        self.chats.lock().insert(id.clone(), chat.clone());
        Ok(chat.info())
    }

    /// 지금까지의 이벤트를 먼저 보내고 이후 이벤트를 계속 보낸다.
    pub fn attach(&self, id: &str, sink: Sink) -> Result<u64> {
        let chat = self.get(id).ok_or_else(|| anyhow!("채팅을 찾을 수 없습니다"))?;
        let sid = self.next_sink.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut st = chat.state.lock();
        for ev in &st.events {
            if !sink(ev) {
                return Err(anyhow!("화면에 연결하지 못했습니다"));
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
        let chat = self.get(id).ok_or_else(|| anyhow!("채팅을 찾을 수 없습니다"))?;
        if text.trim().is_empty() {
            bail!("보낼 내용을 입력하세요");
        }
        if chat.state.lock().busy {
            bail!("에이전트가 아직 답하는 중입니다");
        }
        chat.push(ChatEvent::User { text: clip(text) });
        chat.state.lock().busy = true;
        on_change(&chat.info());
        if chat.agent == "claude" {
            let mut st = chat.state.lock();
            let stdin = st.stdin.as_mut().ok_or_else(|| anyhow!("Claude 프로세스가 끝났습니다. 채팅을 다시 여세요."))?;
            writeln!(stdin, "{}", json!({"type":"user","message":{"role":"user","content":text}}))?;
            stdin.flush()?;
            return Ok(());
        }
        // Codex: 메시지마다 exec 를 띄운다. 프롬프트는 표준입력으로(인자 길이·따옴표 문제 없음).
        let sandbox = if chat.mode == "workspace-write" { "workspace-write" } else { "read-only" };
        let mut cmd = base_command("codex", &chat.cwd)?;
        let resume = chat.state.lock().session_id.clone().and_then(|s| s.strip_prefix("codex:").map(str::to_string));
        match resume {
            Some(r) => {
                cmd.args(["exec", "resume", "--json", "--skip-git-repo-check", "-c"]).arg(format!("sandbox_mode=\"{sandbox}\"")).args([r.as_str(), "-"]);
            }
            None => {
                cmd.args(["exec", "--json", "--skip-git-repo-check", "-s", sandbox, "-C", &chat.cwd, "-"]);
            }
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                chat.state.lock().busy = false;
                return Err(anyhow!("codex 를 실행하지 못했습니다: {e}"));
            }
        };
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(text.as_bytes())?;
        drop(stdin); // EOF → 프롬프트 끝
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        {
            let mut st = chat.state.lock();
            st.pid = Some(child.id());
            st.child = Some(child);
        }
        spawn_reader(chat.clone(), stdout, stderr, false, on_change);
        Ok(())
    }

    /// Claude 도구 승인 요청에 답한다.
    pub fn respond_permission(&self, id: &str, request_id: &str, allow: bool, input: Option<Value>) -> Result<()> {
        let chat = self.get(id).ok_or_else(|| anyhow!("채팅을 찾을 수 없습니다"))?;
        let response = if allow {
            json!({"behavior":"allow","updatedInput": input.unwrap_or(json!({}))})
        } else {
            json!({"behavior":"deny","message":"사용자가 AI Terminal 에서 거부했습니다"})
        };
        {
            let mut st = chat.state.lock();
            let stdin = st.stdin.as_mut().ok_or_else(|| anyhow!("Claude 프로세스가 끝났습니다"))?;
            writeln!(stdin, "{}", json!({"type":"control_response","response":{"subtype":"success","request_id":request_id,"response":response}}))?;
            stdin.flush()?;
        }
        chat.push(ChatEvent::PermissionResolved { request_id: request_id.to_string(), allowed: allow });
        Ok(())
    }

    /// 지금 답하는 중인 턴만 멈춘다(채팅은 유지).
    pub fn interrupt(&self, id: &str) -> Result<()> {
        let chat = self.get(id).ok_or_else(|| anyhow!("채팅을 찾을 수 없습니다"))?;
        if chat.agent == "claude" {
            let mut st = chat.state.lock();
            if let Some(stdin) = st.stdin.as_mut() {
                writeln!(stdin, "{}", json!({"type":"control_request","request_id":uuid::Uuid::new_v4().to_string(),"request":{"subtype":"interrupt"}}))?;
                stdin.flush()?;
            }
        } else {
            kill_group(chat.state.lock().pid, libc::SIGINT);
        }
        Ok(())
    }

    /// 채팅을 닫는다(프로세스 그룹 종료). 대화 기록은 CLI 쪽에 남아 다시 이어갈 수 있다.
    pub fn close(&self, id: &str) {
        let Some(chat) = self.chats.lock().remove(id) else { return };
        let mut st = chat.state.lock();
        st.stdin.take();
        let pid = st.pid;
        if let Some(mut child) = st.child.take() {
            kill_group(pid, libc::SIGTERM);
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(800));
                if matches!(child.try_wait(), Ok(None)) {
                    kill_group(pid, libc::SIGKILL);
                }
                let _ = child.wait();
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

fn spawn_reader(
    chat: Arc<Chat>,
    stdout: std::process::ChildStdout,
    stderr: std::process::ChildStderr,
    claude: bool,
    on_change: Arc<dyn Fn(&ChatInfo) + Send + Sync>,
) {
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
                chat.push(ev);
                if changed {
                    on_change(&chat.info());
                }
            }
        }
        // 출력이 끝났다 = 프로세스 종료
        let code = {
            let mut st = chat.state.lock();
            st.stdin.take();
            st.child.take().and_then(|mut c| c.wait().ok()).and_then(|s| s.code())
        };
        let was_busy = chat.state.lock().busy;
        if code.is_some_and(|c| c != 0) || (claude && code.is_none()) {
            let err = tail.lock().iter().cloned().collect::<Vec<_>>().join("\n");
            if !err.trim().is_empty() {
                chat.push(ChatEvent::Error { text: clip(&err) });
            }
        }
        if claude {
            chat.push(ChatEvent::Exit { code });
        } else if was_busy {
            // Codex exec 는 턴마다 끝난다. turn.completed 없이 끝났으면 턴을 닫는다.
            chat.push(ChatEvent::TurnEnd { cost_usd: None, is_error: code != Some(0), text: None });
        }
        chat.state.lock().busy = false;
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
        assert!(matches!(&claude_line_to_events(&p)[0], ChatEvent::Permission { request_id, tool, summary, .. } if request_id == "r9" && tool == "Bash" && summary == "목록"));
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
        m.respond_permission(&info.id, "p1", true, None).unwrap();
        assert!(wait_for(&got, |e| e.iter().any(|x| matches!(x, ChatEvent::TurnEnd { .. }))));
        assert!(!m.get(&info.id).unwrap().info().busy);
        m.close(&info.id);
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
