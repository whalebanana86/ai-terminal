//! 앱 자체 상태 저장소 (SQLite). Claude/Codex 원본 기록은 여기 복사하지 않는다.

use anyhow::Result;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;

pub struct Db {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoRow {
    /// 저장소 정체성 = git common dir
    pub id: String,
    /// 메인 워크트리 경로 (bare 면 common dir)
    pub path: String,
    pub name: String,
    /// 사용자가 직접 추가한 저장소인지 (false = 세션에서 발견)
    pub pinned: bool,
    pub added_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionLink {
    pub session_id: String,
    pub repo_id: Option<String>,
    pub worktree_path: Option<String>,
    pub cwd: String,
    pub start_branch: Option<String>,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionRow {
    pub id: String,
    pub session_id: Option<String>,
    pub agent: String,
    /// new | resume
    pub kind: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub worktree_path: Option<String>,
    pub branch_at_start: Option<String>,
    pub head_at_start: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub exit_code: Option<i32>,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_links (
    session_id TEXT PRIMARY KEY,
    repo_id TEXT,
    worktree_path TEXT,
    cwd TEXT NOT NULL,
    start_branch TEXT,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS executions (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    agent TEXT NOT NULL,
    kind TEXT NOT NULL,
    argv TEXT NOT NULL,
    cwd TEXT NOT NULL,
    worktree_path TEXT,
    branch_at_start TEXT,
    head_at_start TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    exit_code INTEGER
);
CREATE INDEX IF NOT EXISTS idx_exec_session ON executions(session_id);
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(SCHEMA)?;
        // 앱이 비정상 종료되어 끝나지 않은 채 남은 실행 기록 정리
        conn.execute("UPDATE executions SET ended_at = started_at WHERE ended_at IS NULL", [])?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    // ── 저장소 ──

    pub fn upsert_repo(&self, id: &str, path: &str, name: &str, pinned: bool) -> Result<()> {
        // 한 번 직접 추가(pinned)된 저장소는 발견으로 덮어써도 pinned 를 유지한다.
        self.conn.lock().execute(
            "INSERT INTO repositories(id, path, name, pinned, added_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET path = excluded.path, name = excluded.name,
                 pinned = MAX(repositories.pinned, excluded.pinned)",
            params![id, path, name, pinned as i64, now_ms()],
        )?;
        Ok(())
    }

    pub fn set_repo_pinned(&self, id: &str, pinned: bool) -> Result<()> {
        self.conn.lock().execute("UPDATE repositories SET pinned = ?2 WHERE id = ?1", params![id, pinned as i64])?;
        Ok(())
    }

    pub fn repos(&self) -> Result<Vec<RepoRow>> {
        let conn = self.conn.lock();
        let mut st = conn.prepare("SELECT id, path, name, pinned, added_at FROM repositories ORDER BY pinned DESC, name COLLATE NOCASE")?;
        let rows = st
            .query_map([], |r| {
                Ok(RepoRow { id: r.get(0)?, path: r.get(1)?, name: r.get(2)?, pinned: r.get::<_, i64>(3)? != 0, added_at: r.get(4)? })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    // ── 세션 연결 ──

    pub fn upsert_link(&self, l: &SessionLink) -> Result<()> {
        // 처음 본 시각과 처음 기록된 시작 브랜치는 바꾸지 않는다. 워크트리 경로는 해석 가능할 때만 갱신.
        self.conn.lock().execute(
            "INSERT INTO session_links(session_id, repo_id, worktree_path, cwd, start_branch, first_seen_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(session_id) DO UPDATE SET
                 repo_id = COALESCE(excluded.repo_id, session_links.repo_id),
                 worktree_path = COALESCE(excluded.worktree_path, session_links.worktree_path),
                 cwd = excluded.cwd,
                 start_branch = COALESCE(session_links.start_branch, excluded.start_branch),
                 last_seen_at = excluded.last_seen_at",
            params![l.session_id, l.repo_id, l.worktree_path, l.cwd, l.start_branch, l.first_seen_at, l.last_seen_at],
        )?;
        Ok(())
    }

    /// 여러 연결을 한 트랜잭션으로 저장한다(세션 목록 갱신마다 수백 번 fsync 하지 않게).
    pub fn upsert_links(&self, links: &[SessionLink]) -> Result<()> {
        if links.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        {
            let mut st = tx.prepare(
                "INSERT INTO session_links(session_id, repo_id, worktree_path, cwd, start_branch, first_seen_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(session_id) DO UPDATE SET
                     repo_id = COALESCE(excluded.repo_id, session_links.repo_id),
                     worktree_path = COALESCE(excluded.worktree_path, session_links.worktree_path),
                     cwd = excluded.cwd,
                     start_branch = COALESCE(session_links.start_branch, excluded.start_branch),
                     last_seen_at = excluded.last_seen_at",
            )?;
            for l in links {
                st.execute(params![l.session_id, l.repo_id, l.worktree_path, l.cwd, l.start_branch, l.first_seen_at, l.last_seen_at])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn links(&self) -> Result<Vec<SessionLink>> {
        let conn = self.conn.lock();
        let mut st = conn.prepare(
            "SELECT session_id, repo_id, worktree_path, cwd, start_branch, first_seen_at, last_seen_at FROM session_links",
        )?;
        let rows = st
            .query_map([], |r| {
                Ok(SessionLink {
                    session_id: r.get(0)?,
                    repo_id: r.get(1)?,
                    worktree_path: r.get(2)?,
                    cwd: r.get(3)?,
                    start_branch: r.get(4)?,
                    first_seen_at: r.get(5)?,
                    last_seen_at: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    // ── 실행 ──

    pub fn insert_execution(&self, e: &ExecutionRow) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO executions(id, session_id, agent, kind, argv, cwd, worktree_path, branch_at_start, head_at_start, started_at, ended_at, exit_code)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                e.id,
                e.session_id,
                e.agent,
                e.kind,
                serde_json::to_string(&e.argv)?,
                e.cwd,
                e.worktree_path,
                e.branch_at_start,
                e.head_at_start,
                e.started_at,
                e.ended_at,
                e.exit_code
            ],
        )?;
        Ok(())
    }

    pub fn finish_execution(&self, id: &str, exit_code: Option<i32>) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE executions SET ended_at = ?2, exit_code = ?3 WHERE id = ?1 AND ended_at IS NULL",
            params![id, now_ms(), exit_code],
        )?;
        Ok(())
    }

    pub fn set_execution_session(&self, id: &str, session_id: &str) -> Result<()> {
        self.conn.lock().execute("UPDATE executions SET session_id = ?2 WHERE id = ?1", params![id, session_id])?;
        Ok(())
    }

    pub fn executions(&self, limit: usize) -> Result<Vec<ExecutionRow>> {
        let conn = self.conn.lock();
        let mut st = conn.prepare(
            "SELECT id, session_id, agent, kind, argv, cwd, worktree_path, branch_at_start, head_at_start, started_at, ended_at, exit_code
             FROM executions ORDER BY started_at DESC LIMIT ?1",
        )?;
        let rows = st
            .query_map([limit as i64], |r| {
                let argv: String = r.get(4)?;
                Ok(ExecutionRow {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    agent: r.get(2)?,
                    kind: r.get(3)?,
                    argv: serde_json::from_str(&argv).unwrap_or_default(),
                    cwd: r.get(5)?,
                    worktree_path: r.get(6)?,
                    branch_at_start: r.get(7)?,
                    head_at_start: r.get(8)?,
                    started_at: r.get(9)?,
                    ended_at: r.get(10)?,
                    exit_code: r.get(11)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    // ── 키-값 (화면 상태) ──

    pub fn kv_get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.conn.lock().query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0)).optional()?)
    }

    pub fn kv_set(&self, key: &str, value: &str) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO kv(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_survives_discovery_and_link_keeps_first_branch() {
        let db = Db::open_in_memory().unwrap();
        db.upsert_repo("/r/.git", "/r", "r", true).unwrap();
        db.upsert_repo("/r/.git", "/r", "r", false).unwrap();
        assert!(db.repos().unwrap()[0].pinned);

        let mut l = SessionLink {
            session_id: "claude:1".into(),
            repo_id: Some("/r/.git".into()),
            worktree_path: Some("/r".into()),
            cwd: "/r".into(),
            start_branch: Some("feat".into()),
            first_seen_at: 1,
            last_seen_at: 1,
        };
        db.upsert_link(&l).unwrap();
        l.start_branch = Some("main".into());
        l.worktree_path = None; // 워크트리가 지워져 해석 실패
        l.last_seen_at = 2;
        db.upsert_link(&l).unwrap();
        let got = &db.links().unwrap()[0];
        assert_eq!(got.start_branch.as_deref(), Some("feat"));
        assert_eq!(got.worktree_path.as_deref(), Some("/r"));
        assert_eq!(got.last_seen_at, 2);
    }

    #[test]
    fn executions_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        let e = ExecutionRow {
            id: "e1".into(),
            session_id: None,
            agent: "codex".into(),
            kind: "new".into(),
            argv: vec!["codex".into()],
            cwd: "/w".into(),
            worktree_path: Some("/w".into()),
            branch_at_start: Some("main".into()),
            head_at_start: Some("abc".into()),
            started_at: 5,
            ended_at: None,
            exit_code: None,
        };
        db.insert_execution(&e).unwrap();
        db.set_execution_session("e1", "codex:x").unwrap();
        db.finish_execution("e1", Some(0)).unwrap();
        let got = &db.executions(10).unwrap()[0];
        assert_eq!(got.session_id.as_deref(), Some("codex:x"));
        assert_eq!(got.exit_code, Some(0));
        assert!(got.ended_at.is_some());
    }
}
