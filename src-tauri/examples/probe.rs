//! 실제 세션 기록을 읽기 전용으로 훑어 색인 결과와 소요 시간을 출력한다.
//! 사용: cargo run --example probe [세션id]
use ai_terminal_lib::{core::AppCore, db::Db};
use std::sync::Arc;
use std::time::Instant;

fn main() {
    let core = AppCore::new(Db::open_in_memory().unwrap(), Arc::new(|_, _| {}));
    let t = Instant::now();
    let list = core.list_sessions().unwrap();
    println!("1차 목록: {}개, {:?}", list.len(), t.elapsed());
    let t = Instant::now();
    let list = core.list_sessions().unwrap();
    println!("2차 목록(캐시): {}개, {:?}", list.len(), t.elapsed());
    let claude = list.iter().filter(|s| s.meta.agent == "claude").count();
    println!("claude {claude}, codex {}", list.len() - claude);
    println!("git 저장소에 연결: {}", list.iter().filter(|s| s.worktree_path.is_some()).count());
    for s in list.iter().take(8) {
        println!(
            "- {} [{}] cwd={} wt={:?} start={:?} last={:?} now={:?} title={}",
            s.meta.id, s.meta.origin.clone().unwrap_or_default(), s.meta.cwd.clone().unwrap_or_default(),
            s.worktree_path, s.meta.start_branch, s.meta.last_branch, s.current_branch,
            s.meta.title.chars().take(40).collect::<String>()
        );
    }
    if let Some(id) = std::env::args().nth(1) {
        let t = Instant::now();
        let tr = core.transcript(&id).unwrap();
        println!("기록 {id}: 항목 {}/{} 파일 {} ({:?})", tr.items.len(), tr.total, tr.touched_files.len(), t.elapsed());
    }
    println!("저장소: {:?}", core.list_repos().unwrap().iter().map(|r| r.row.name.clone()).collect::<Vec<_>>());
}
