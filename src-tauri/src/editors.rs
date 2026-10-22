//! 외부 편집기로 열기. 이 맥에 설치된 이름난 편집기만 고를 수 있다(화면이 임의의 앱을 띄우지 못하게).

use anyhow::{bail, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// (id, 앱 이름). "자동" 은 이 순서대로 처음 찾은 편집기를 쓴다.
const KNOWN: &[(&str, &str)] = &[
    ("vscode", "Visual Studio Code"),
    ("cursor", "Cursor"),
    ("zed", "Zed"),
    ("windsurf", "Windsurf"),
    ("sublime", "Sublime Text"),
    ("nova", "Nova"),
    ("bbedit", "BBEdit"),
    ("xcode", "Xcode"),
    ("textedit", "TextEdit"),
];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorApp {
    pub id: String,
    pub name: String,
}

fn app_path(name: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let dirs = [Some(PathBuf::from("/Applications")), home.map(|h| h.join("Applications")), Some(PathBuf::from("/System/Applications"))];
    dirs.into_iter().flatten().map(|d| d.join(format!("{name}.app"))).find(|p| p.is_dir())
}

pub fn installed() -> Vec<EditorApp> {
    KNOWN
        .iter()
        .filter(|(_, name)| app_path(name).is_some())
        .map(|(id, name)| EditorApp { id: id.to_string(), name: name.to_string() })
        .collect()
}

/// 실행할 `open` 인자. id 가 "auto" 면 설치된 첫 편집기, 없으면 맥 기본 글 편집기(`open -t`).
fn open_args(id: &str, file: &Path) -> Result<Vec<std::ffi::OsString>> {
    let app = match id {
        "auto" => KNOWN.iter().filter(|(k, _)| *k != "textedit" && *k != "xcode").find_map(|(_, n)| app_path(n)),
        _ => match KNOWN.iter().find(|(k, _)| *k == id) {
            Some((_, n)) => Some(app_path(n).ok_or_else(|| anyhow::anyhow!(tr!("{n} 이(가) 설치되어 있지 않습니다", "{n} isn't installed")))?),
            None => bail!(tr!("모르는 편집기입니다: {id}", "Unknown editor: {id}")),
        },
    };
    let mut args: Vec<std::ffi::OsString> = match app {
        Some(a) => vec!["-a".into(), a.into_os_string()],
        None => vec!["-t".into()],
    };
    args.push(file.as_os_str().to_owned());
    Ok(args)
}

pub fn open_file(worktree: &Path, rel: &str, id: &str) -> Result<()> {
    let p = crate::files::resolve_inside(worktree, rel)?;
    if !p.is_file() {
        bail!(tr!("일반 파일이 아니라 열 수 없습니다", "Not a regular file, so it can't be opened"));
    }
    std::process::Command::new("/usr/bin/open").args(open_args(id, &p)?).spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_unknown_editor_and_falls_back_to_text_editor() {
        let f = Path::new("/tmp/x.txt");
        assert!(open_args("../../bin/sh", f).is_err());
        let auto = open_args("auto", f).unwrap();
        assert!(auto.first().is_some_and(|a| a == "-a" || a == "-t"));
        assert_eq!(auto.last().unwrap(), "/tmp/x.txt");
        // 설치 목록은 아는 편집기만
        assert!(installed().iter().all(|e| KNOWN.iter().any(|(k, _)| *k == e.id)));
    }
}
