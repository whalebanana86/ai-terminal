//! 화면에 나가는 메시지의 언어(한국어/영어). 화면이 켜질 때 `set_lang` 으로 알려 준다.
//!
//! ```ignore
//! bail!(tr!("폴더가 없습니다: {cwd}", "Folder not found: {cwd}"));
//! ```

use std::sync::atomic::{AtomicBool, Ordering};

static EN: AtomicBool = AtomicBool::new(false);

pub fn set_english(on: bool) {
    EN.store(on, Ordering::Relaxed);
}

pub fn is_en() -> bool {
    EN.load(Ordering::Relaxed)
}

/// 한국어·영어 두 문장 중 지금 언어의 것을 `format!` 으로 만든다(같은 이름의 값을 그대로 끼워 넣음).
#[macro_export]
macro_rules! tr {
    ($ko:literal, $en:literal $(,)?) => {
        if $crate::i18n::is_en() { format!($en) } else { format!($ko) }
    };
    ($ko:literal, $en:literal, $($arg:tt)+) => {
        if $crate::i18n::is_en() { format!($en, $($arg)+) } else { format!($ko, $($arg)+) }
    };
}

#[cfg(test)]
mod tests {
    #[test]
    fn picks_language() {
        let _g = crate::env::TEST_ENV_LOCK.lock();
        let name = "x";
        super::set_english(true);
        assert_eq!(tr!("폴더 {name}", "folder {name}"), "folder x");
        super::set_english(false);
        assert_eq!(tr!("폴더 {name}", "folder {name}"), "폴더 x");
        assert_eq!(tr!("{}개", "{} items", 3), "3개");
    }
}
