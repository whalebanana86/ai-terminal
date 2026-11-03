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

pub(crate) fn app_path(name: &str) -> Option<PathBuf> {
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
/// "default" 는 그 파일 종류의 맥 기본 앱(미리보기 등). PDF 만 받는다: 아무 파일이나 기본 앱으로 열면
/// 저장소에 든 `.command`·`.app` 같은 것을 실행하게 된다. file 은 링크를 푼 실제 경로여야 한다.
fn open_args(id: &str, file: &Path) -> Result<Vec<std::ffi::OsString>> {
    if id == "default" {
        if !crate::files::is_pdf(&file.to_string_lossy()) {
            bail!(tr!("기본 앱으로는 PDF 만 열 수 있습니다", "Only PDFs can be opened in the default app"));
        }
        return Ok(vec![file.as_os_str().to_owned()]);
    }
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
    crate::env::spawn_reaped(std::process::Command::new("/usr/bin/open").args(open_args(id, &p)?))?;
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

    #[test]
    fn default_app_only_for_pdf() {
        assert_eq!(open_args("default", Path::new("/tmp/a.PDF")).unwrap(), vec![std::ffi::OsString::from("/tmp/a.PDF")]);
        for f in ["/tmp/run.command", "/tmp/x.app", "/tmp/a.pdf.sh", "/tmp/note.txt"] {
            assert!(open_args("default", Path::new(f)).is_err(), "{f} 는 기본 앱으로 열지 않는다");
        }
    }

    #[test]
    fn default_app_checks_link_target() {
        // 저장소 안 x.pdf 가 실행 파일을 가리키는 링크여도 실제 대상의 종류로 판단한다
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("run.command"), "#!/bin/sh\n").unwrap();
        std::os::unix::fs::symlink("run.command", d.path().join("x.pdf")).unwrap();
        let real = crate::files::resolve_inside(d.path(), "x.pdf").unwrap();
        assert!(open_args("default", &real).is_err());
    }
}
