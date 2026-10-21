//! 세션 목록 갱신 비용: cargo run --release --example listcost
use ai_terminal_lib::{core::AppCore, db::Db};
use std::sync::Arc;
fn main() {
    let core = AppCore::new(Db::open_in_memory().unwrap(), Arc::new(|_, _| {}));
    let t = std::time::Instant::now();
    let n = core.list_sessions().unwrap().len();
    println!("첫 목록: {n}개 {:?}", t.elapsed());
    let t = std::time::Instant::now();
    for _ in 0..10 { core.list_sessions().unwrap(); }
    println!("캐시 후 1회 평균: {:?}", t.elapsed() / 10);
    let t = std::time::Instant::now();
    for _ in 0..10 { core.scan_sessions(); }
    println!("  그중 기록 스캔: {:?}", t.elapsed() / 10);
}
