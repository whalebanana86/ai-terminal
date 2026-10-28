// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 업데이트하는 동안 에이전트의 터미널을 잠깐 맡아 두는 프로세스로 띄워진 경우(창 없음)
    if let Some(code) = ai_terminal_lib::handoff::keeper_from_args() {
        std::process::exit(code);
    }
    // 작업 기억의 임베딩 도우미로 띄워진 경우(창 없음)
    if let Some(code) = ai_terminal_lib::memory_worker::worker_from_args() {
        std::process::exit(code);
    }
    ai_terminal_lib::run()
}
