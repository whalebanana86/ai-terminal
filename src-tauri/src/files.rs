//! 파일 탐색기: 워크트리 안의 실제 파일만 다룬다(읽기 전용).

use anyhow::{bail, Result};
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_PREVIEW_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// 워크트리 기준 상대 경로 (/ 구분)
    pub rel: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub ignored: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub rel: String,
    pub size: u64,
    pub binary: bool,
    pub truncated: bool,
    pub text: Option<String>,
}

/// rel 을 워크트리 안의 절대 경로로 바꾼다. 워크트리 밖(.. 또는 바깥을 가리키는 심볼릭 링크)은 거부.
pub fn resolve_inside(worktree: &Path, rel: &str) -> Result<PathBuf> {
    let root = std::fs::canonicalize(worktree)?;
    if rel.is_empty() || rel == "." {
        return Ok(root);
    }
    crate::git::safe_rel_path(rel)?;
    let p = root.join(rel);
    let real = std::fs::canonicalize(&p).unwrap_or_else(|_| p.clone());
    if !real.starts_with(&root) {
        bail!(tr!("워크트리 밖의 경로는 열 수 없습니다: {rel}", "Can't open a path outside the worktree: {rel}"));
    }
    // 검사한 실제 경로를 그대로 돌려줘 검사와 사용 사이에 링크를 바꿔치기할 틈을 없앤다.
    Ok(real)
}

pub fn list_dir(worktree: &Path, rel: &str) -> Result<Vec<DirEntry>> {
    let dir = resolve_inside(worktree, rel)?;
    let mut out = Vec::new();
    for e in std::fs::read_dir(&dir)?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name == ".git" || name == ".DS_Store" {
            continue;
        }
        let Ok(ft) = e.file_type() else { continue };
        let is_symlink = ft.is_symlink();
        let meta = std::fs::metadata(e.path()).ok();
        let is_dir = meta.as_ref().is_some_and(|m| m.is_dir());
        let child_rel = if rel.is_empty() || rel == "." { name.clone() } else { format!("{}/{}", rel.trim_end_matches('/'), name) };
        out.push(DirEntry {
            name,
            rel: child_rel,
            is_dir,
            is_symlink,
            size: meta.map(|m| m.len()).unwrap_or(0),
            ignored: false,
        });
    }
    let rels: Vec<String> = out.iter().map(|e| if e.is_dir { format!("{}/", e.rel) } else { e.rel.clone() }).collect();
    let ignored: std::collections::HashSet<String> =
        crate::git::check_ignored(worktree, &rels).unwrap_or_default().into_iter().map(|s| s.trim_end_matches('/').to_string()).collect();
    for e in &mut out {
        e.ignored = ignored.contains(&e.rel);
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

pub fn read_file(worktree: &Path, rel: &str) -> Result<FileContent> {
    let p = resolve_inside(worktree, rel)?;
    let meta = std::fs::metadata(&p)?;
    if meta.is_dir() {
        bail!(tr!("폴더는 미리 볼 수 없습니다", "Folders can't be previewed"));
    }
    if !meta.is_file() {
        // named pipe·소켓·장치 파일은 열면 멈출 수 있다.
        bail!(tr!("일반 파일이 아니라 미리 볼 수 없습니다", "Not a regular file, so it can't be previewed"));
    }
    let size = meta.len();
    let mut buf = Vec::new();
    std::fs::File::open(&p)?.take(MAX_PREVIEW_BYTES).read_to_end(&mut buf)?;
    let truncated = size > MAX_PREVIEW_BYTES;
    let sniff = &buf[..buf.len().min(8000)];
    let binary = sniff.contains(&0);
    let text = if binary {
        None
    } else {
        // 잘린 끝에서 UTF-8 이 끊기면 lossy 로 처리
        Some(String::from_utf8_lossy(&buf).into_owned())
    };
    Ok(FileContent { rel: rel.to_string(), size, binary, truncated, text })
}

/// 그림으로 보여 줄 수 있는 확장자(WebKit 이 그릴 수 있는 것)
pub const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tif", "tiff", "avif", "heic"];
/// 그림 미리보기 크기 상한
pub const MAX_IMAGE_BYTES: u64 = 40 * 1024 * 1024;

pub fn is_image(rel: &str) -> bool {
    Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
}

/// 그림 파일 바이트(워크트리 안, 그림 확장자, 크기 상한). rev 가 있으면 그 커밋의 내용(예: HEAD)을 git 에서 읽는다.
pub fn read_image(worktree: &Path, rel: &str, rev: Option<&str>) -> Result<Vec<u8>> {
    if !is_image(rel) {
        bail!(tr!("그림 파일이 아닙니다: {rel}", "Not an image file: {rel}"));
    }
    if let Some(rev) = rev {
        crate::git::safe_rel_path(rel)?;
        if rev != "HEAD" && !(rev.len() >= 7 && rev.len() <= 64 && rev.chars().all(|c| c.is_ascii_hexdigit())) {
            bail!(tr!("알 수 없는 커밋: {rev}", "Unknown commit: {rev}"));
        }
        let spec = format!("{rev}:{rel}");
        let size: u64 = crate::git::run(worktree, &["cat-file", "-s", &spec])?.trim().parse().unwrap_or(u64::MAX);
        if size > MAX_IMAGE_BYTES {
            bail!(tr!("그림이 너무 큽니다 ({} MB)", "Image is too large ({} MB)", size / 1024 / 1024));
        }
        return crate::git::run_bytes(worktree, &["cat-file", "blob", &spec]);
    }
    let p = resolve_inside(worktree, rel)?;
    let meta = std::fs::metadata(&p)?;
    if !meta.is_file() {
        bail!(tr!("일반 파일이 아니라 볼 수 없습니다", "Not a regular file, so it can't be shown"));
    }
    if meta.len() > MAX_IMAGE_BYTES {
        bail!(tr!("그림이 너무 큽니다 ({} MB)", "Image is too large ({} MB)", meta.len() / 1024 / 1024));
    }
    Ok(std::fs::read(&p)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_images_only_inside_and_from_head() {
        let d = tempfile::tempdir().unwrap();
        let w = d.path();
        let g = |args: &[&str]| assert!(std::process::Command::new("git").arg("-C").arg(w).args(args).output().unwrap().status.success());
        g(&["init", "-q"]);
        std::fs::write(w.join("a.png"), [0x89, b'P', b'N', b'G', 0, 1]).unwrap();
        std::fs::write(w.join("note.txt"), "x").unwrap();
        g(&["add", "-A"]);
        g(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
        std::fs::write(w.join("a.png"), [0x89, b'P', b'N', b'G', 0, 2]).unwrap();
        assert_eq!(read_image(w, "a.png", None).unwrap(), vec![0x89, b'P', b'N', b'G', 0, 2]);
        assert_eq!(read_image(w, "a.png", Some("HEAD")).unwrap(), vec![0x89, b'P', b'N', b'G', 0, 1], "마지막 커밋의 그림");
        assert!(read_image(w, "note.txt", None).is_err(), "그림이 아닌 파일은 거부");
        assert!(read_image(w, "../x.png", None).is_err(), "워크트리 밖 거부");
        assert!(read_image(w, "a.png", Some("--output=/tmp/x")).is_err(), "이상한 rev 거부");
    }

    #[test]
    fn refuses_escape_and_reads_text() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "안녕").unwrap();
        std::fs::write(d.path().join("b.bin"), [0u8, 1, 2]).unwrap();
        std::os::unix::fs::symlink("/etc", d.path().join("out")).unwrap();
        assert_eq!(read_file(d.path(), "a.txt").unwrap().text.as_deref(), Some("안녕"));
        assert!(read_file(d.path(), "b.bin").unwrap().binary);
        assert!(read_file(d.path(), "../x").is_err());
        assert!(list_dir(d.path(), "out").is_err(), "symlink escaping worktree must be refused");
        let fifo = d.path().join("pipe");
        assert!(std::process::Command::new("mkfifo").arg(&fifo).status().unwrap().success());
        assert!(read_file(d.path(), "pipe").is_err(), "FIFO must not block");
    }
}
