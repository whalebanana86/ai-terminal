//! 지금 실행 중인 에이전트 세션을 출력한다: cargo run --example live
fn main() {
    for r in ai_terminal_lib::procs::scan(&Default::default()) {
        println!("{:<50} pid={:<6} client={:<10} status={:?} cwd={:?}", r.session_id, r.pid, r.client, r.status, r.cwd);
    }
}
