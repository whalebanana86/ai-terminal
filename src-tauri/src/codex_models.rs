//! Local request routing. No classification requests and no changes to the user's Codex config.
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRoute {
    pub task: &'static str,
    pub model: &'static str,
    pub effort: &'static str,
}
impl ModelRoute {
    pub fn cli_args(&self) -> Vec<String> {
        vec![
            "--model".into(),
            self.model.into(),
            "-c".into(),
            format!("model_reasoning_effort=\"{}\"", self.effort),
        ]
    }
}
fn preset(task: &str) -> ModelRoute {
    match task {
        "simple" => ModelRoute {
            task: "simple",
            model: "gpt-6-luna",
            effort: "low",
        },
        "complex" => ModelRoute {
            task: "complex",
            model: "gpt-6.1-sol",
            effort: "medium",
        },
        _ => ModelRoute {
            task: "general",
            model: "gpt-6.1-sol",
            effort: "low",
        },
    }
}
fn contains(text: &str, words: &[&str]) -> bool {
    words.iter().any(|word| text.contains(word))
}

pub fn route(
    text: &str,
    mode: Option<&str>,
    previous: Option<&str>,
) -> Result<Option<ModelRoute>, String> {
    match mode.unwrap_or("auto") {
        "inherit" => return Ok(None),
        "simple" => return Ok(Some(preset("simple"))),
        "general" => return Ok(Some(preset("general"))),
        "complex" => return Ok(Some(preset("complex"))),
        "auto" => {}
        _ => return Err("Invalid Codex model selection".into()),
    }
    let text = text.trim().to_lowercase();
    // Short continuations belong to the ongoing task; do not downgrade a complex task to Luna.
    let followup = [
        "응",
        "네",
        "어",
        "계속",
        "계속해",
        "계속해줘",
        "진행해",
        "진행해줘",
        "이어서 해",
        "이어서 진행해",
        "구현해",
        "구현해줘",
        "이어서 작업해",
        "해줘",
        "고쳐줘",
        "continue",
        "go ahead",
        "yes",
        "do it",
    ];
    let continuation = text.trim_end_matches(['.', '!', '?']);
    let continuation = ["응 ", "네 ", "어 ", "응, ", "네, ", "어, ", "yes, "]
        .iter()
        .find_map(|prefix| continuation.strip_prefix(prefix))
        .unwrap_or(continuation);
    if followup.contains(&continuation) {
        return Ok(Some(preset(previous.unwrap_or("general"))));
    }
    let complex = contains(
        &text,
        &[
            "동시성",
            "데드락",
            "교착",
            "경쟁 상태",
            "경쟁상태",
            "렌더링",
            "렌더러",
            "글자 깨",
            "글자들이 이상",
            "아키텍처",
            "구조 변경",
            "구조변경",
            "설계",
            "마이그레이션",
            "대규모",
            "전체 리팩",
            "전반적인 리팩",
            "다중 모듈",
            "보안 취약",
            "인증 구조",
            "머지 충돌",
            "병합 충돌",
            "분산",
            "메모리 누수",
            "race condition",
            "concurrency",
            "concurrent",
            "deadlock",
            "rendering",
            "renderer",
            "architecture",
            "migration",
            "redesign",
            "security vulnerability",
            "merge conflict",
            "memory leak",
            "distributed",
        ],
    ) || text.chars().count() > 1600;
    if complex {
        return Ok(Some(preset("complex")));
    }
    // Development intent wins over embedded maintenance commands, e.g. "fix git pull errors".
    let development = contains(
        &text,
        &[
            "버그",
            "오류",
            "에러",
            "안돼",
            "안 돼",
            "안되",
            "안 되",
            "깨져",
            "깨짐",
            "기능",
            "구현",
            "로그인",
            "리팩",
            "개발",
            "파서",
            "테스트 추가",
            "테스트를 추가",
            "api",
            "bug",
            "error",
            "fix ",
            "implement",
            "feature",
            "refactor",
            "parser",
            "add test",
            "write test",
        ],
    );
    let simple = contains(
        &text,
        &[
            "git pull",
            "git status",
            "git log",
            "git diff",
            "커밋",
            "푸시",
            "릴리즈",
            "메인머지",
            "메인 머지",
            "문구",
            "오타",
            "띄어쓰기",
            "색상",
            "글씨 색",
            "파일명",
            "이름 변경",
            "번역",
            "요약",
            "commit",
            "push",
            "release",
            "typo",
            "wording",
            "spelling",
            "rename file",
            "translate",
            "summarize",
        ],
    );
    Ok(Some(preset(if simple && !development {
        "simple"
    } else {
        "general"
    })))
}

#[tauri::command]
pub fn codex_model_route(
    text: String,
    mode: Option<String>,
    previous: Option<String>,
) -> Result<Option<ModelRoute>, String> {
    route(&text, mode.as_deref(), previous.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uses_exact_requested_presets() {
        for (text, task, model, effort) in [
            ("git pull", "simple", "gpt-6-luna", "low"),
            ("커밋하고 메인머지 푸시해", "simple", "gpt-6-luna", "low"),
            ("문구를 자연스럽게 바꿔줘", "simple", "gpt-6-luna", "low"),
            (
                "로그인 버튼 기능을 추가해줘",
                "general",
                "gpt-6.1-sol",
                "low",
            ),
            ("Fix git pull errors", "general", "gpt-6.1-sol", "low"),
            (
                "동시성 버그 고치고 커밋해",
                "complex",
                "gpt-6.1-sol",
                "medium",
            ),
            (
                "Investigate a renderer race condition",
                "complex",
                "gpt-6.1-sol",
                "medium",
            ),
            ("", "general", "gpt-6.1-sol", "low"),
        ] {
            let r = route(text, None, None).unwrap().unwrap();
            assert_eq!((r.task, r.model, r.effort), (task, model, effort), "{text}");
        }
    }
    #[test]
    fn continuations_keep_the_ongoing_task() {
        assert_eq!(
            route("어", None, Some("complex")).unwrap().unwrap().task,
            "complex"
        );
        assert_eq!(
            route("어 구현해", None, Some("complex"))
                .unwrap()
                .unwrap()
                .task,
            "complex"
        );
        assert_eq!(
            route("네, 이어서 작업해", None, Some("complex"))
                .unwrap()
                .unwrap()
                .task,
            "complex"
        );
        assert_eq!(
            route("git pull", None, Some("complex"))
                .unwrap()
                .unwrap()
                .task,
            "simple"
        );
    }
    #[test]
    fn manual_overrides_and_cli_default() {
        assert_eq!(
            route("동시성", Some("simple"), None)
                .unwrap()
                .unwrap()
                .model,
            "gpt-6-luna"
        );
        assert_eq!(
            route("git pull", Some("complex"), None)
                .unwrap()
                .unwrap()
                .effort,
            "medium"
        );
        assert!(route("test", Some("inherit"), None).unwrap().is_none());
        assert!(route("test", Some("unknown"), None).is_err());
        assert_eq!(
            preset("complex").cli_args(),
            vec![
                "--model",
                "gpt-6.1-sol",
                "-c",
                "model_reasoning_effort=\"medium\""
            ]
        );
    }
}
