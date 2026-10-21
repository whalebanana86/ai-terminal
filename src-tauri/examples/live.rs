//! 지금 실행 중인 에이전트 세션을 출력하고 스캔 비용을 잰다: cargo run --release --example live
fn main() {
    let t = std::time::Instant::now();
    let n = 20;
    let mut runs = Vec::new();
    for _ in 0..n {
        runs = ai_terminal_lib::procs::scan(&Default::default());
    }
    let per = t.elapsed() / n;
    for r in &runs {
        println!("{:<50} pid={:<6} client={:<10} status={:?}", r.session_id, r.pid, r.client, r.status);
    }
    println!("스캔 1회 평균: {per:?} ({}개 감지)", runs.len());
}
