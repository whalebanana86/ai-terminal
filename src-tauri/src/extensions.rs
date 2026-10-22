//! 설정에서 켜고 끄는 확장 기능(파일 편집·스틱맨·구독 한도). 상태는 kv 의 `ext.<id>` 에 둔다.
//! 화면이 kv_set 으로 이 값을 바꾸지 못하게 막고(commands::kv_set), 파일 쓰기처럼 위험한 기능은
//! 켤 때 맥 확인창을 한 번 더 거친다 → 화면(웹뷰)만으로는 파일 쓰기를 켤 수 없다.

use anyhow::{bail, Result};
use serde::Serialize;

use crate::db::Db;

pub const EDITOR: &str = "editor";
pub const STICKMAN: &str = "stickman";
pub const USAGE: &str = "usage";

pub const KV_PREFIX: &str = "ext.";

struct Def {
    id: &'static str,
    default_on: bool,
    /// 켤 때 맥 확인창을 띄운다
    confirm: bool,
}

const DEFS: &[Def] = &[
    Def { id: EDITOR, default_on: false, confirm: true },
    Def { id: STICKMAN, default_on: true, confirm: false },
    Def { id: USAGE, default_on: true, confirm: false },
];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExtState {
    pub id: String,
    pub enabled: bool,
}

fn def(id: &str) -> Result<&'static Def> {
    match DEFS.iter().find(|d| d.id == id) {
        Some(d) => Ok(d),
        None => bail!(tr!("모르는 기능입니다: {id}", "Unknown feature: {id}")),
    }
}

pub fn enabled(db: &Db, id: &str) -> bool {
    let Ok(d) = def(id) else { return false };
    match db.kv_get(&format!("{KV_PREFIX}{id}")) {
        Ok(Some(v)) => v == "1",
        _ => d.default_on,
    }
}

pub fn list(db: &Db) -> Vec<ExtState> {
    DEFS.iter().map(|d| ExtState { id: d.id.to_string(), enabled: enabled(db, d.id) }).collect()
}

/// 켤 때 확인창이 필요한 기능인지
pub fn needs_confirm(id: &str, on: bool) -> Result<bool> {
    Ok(on && def(id)?.confirm)
}

pub fn set(db: &Db, id: &str, on: bool) -> Result<()> {
    def(id)?;
    db.kv_set(&format!("{KV_PREFIX}{id}"), if on { "1" } else { "0" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_toggle() {
        let db = Db::open_in_memory().unwrap();
        // 파일 편집은 꺼진 채로, 스틱맨·구독 한도는 켜진 채로 시작
        assert!(!enabled(&db, EDITOR));
        assert!(enabled(&db, STICKMAN));
        assert!(enabled(&db, USAGE));
        set(&db, EDITOR, true).unwrap();
        set(&db, STICKMAN, false).unwrap();
        assert!(enabled(&db, EDITOR));
        assert!(!enabled(&db, STICKMAN));
        assert_eq!(list(&db).len(), 3);
        assert!(set(&db, "nope", true).is_err());
        assert!(!enabled(&db, "nope"));
        assert!(needs_confirm(EDITOR, true).unwrap());
        assert!(!needs_confirm(EDITOR, false).unwrap());
        assert!(!needs_confirm(STICKMAN, true).unwrap());
    }
}
