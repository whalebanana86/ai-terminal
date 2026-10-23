//! 파일 탐색기: 워크트리 안의 실제 파일만 다룬다. 쓰기는 '파일 편집' 기능을 켰을 때의 save_file 과
//! 트리에 끌어다 놓을 때의 복사·이동(copy_into·move_into)뿐이다.

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

/// Existing regular files printed by a terminal, resolved relative to its launch directory or root.
/// Return only canonical paths inside this worktree, including for absolute paths and symlinks.
pub fn terminal_paths(worktree: &Path, cwd: &Path, paths: &[String]) -> Result<Vec<Option<String>>> {
    let root = std::fs::canonicalize(worktree)?;
    let cwd = std::fs::canonicalize(cwd).ok().filter(|p| p.starts_with(&root)).unwrap_or_else(|| root.clone());
    Ok(paths.iter().take(64).map(|raw| {
        if raw.len() > 4096 || raw.contains('\0') { return None; }
        let path = Path::new(raw);
        let options = if path.is_absolute() { vec![path.to_path_buf()] } else { vec![cwd.join(path), root.join(path)] };
        options.into_iter().find_map(|p| {
            let real = std::fs::canonicalize(p).ok()?;
            if !real.starts_with(&root) || !real.is_file() { return None; }
            Some(real.strip_prefix(&root).ok()?.to_string_lossy().replace('\\', "/"))
        })
    }).collect())
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

// ───────────────────────── 편집(확장 기능 "파일 편집") ─────────────────────────

/// 앱 안에서 고칠 수 있는 파일 크기 상한
pub const MAX_EDIT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditableFile {
    pub rel: String,
    /// 줄바꿈은 \n 으로 맞춘 내용. 편집할 수 없으면 None
    pub text: Option<String>,
    /// 불러온 바이트의 지문. 저장할 때 그사이 밖에서 바뀌었는지 확인한다
    pub hash: String,
    pub crlf: bool,
    pub bom: bool,
    /// 편집할 수 없는 이유
    pub readonly: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    /// false 면 불러온 뒤 밖에서 바뀌어 저장하지 않았다
    pub saved: bool,
    /// 지금 디스크 내용의 지문
    pub hash: String,
}

const BOM: &[u8] = b"\xEF\xBB\xBF";

fn content_hash(bytes: &[u8]) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    format!("{:016x}-{}", h.finish(), bytes.len())
}

/// 파일이 없을 때의 지문(밖에서 지워진 경우)
const MISSING: &str = "missing";

fn disk_hash(p: &Path) -> Result<String> {
    match std::fs::read(p) {
        Ok(b) => Ok(content_hash(&b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(MISSING.into()),
        Err(e) => Err(e.into()),
    }
}

fn too_big() -> String {
    tr!("2MB 보다 큰 파일은 앱에서 고치지 않아요. 외부 편집기를 쓰세요.", "Files over 2 MB aren't edited in the app. Use an external editor.")
}

fn editable_from(rel: &str, bytes: &[u8]) -> EditableFile {
    let hash = content_hash(bytes);
    let ro = |reason: String| EditableFile { rel: rel.to_string(), text: None, hash: hash.clone(), crlf: false, bom: false, readonly: Some(reason) };
    if bytes.len() as u64 > MAX_EDIT_BYTES {
        return ro(too_big());
    }
    if bytes[..bytes.len().min(8000)].contains(&0) {
        return ro(tr!("바이너리 파일은 고칠 수 없어요", "Binary files can't be edited"));
    }
    let bom = bytes.starts_with(BOM);
    let body = if bom { &bytes[BOM.len()..] } else { bytes };
    let Ok(text) = std::str::from_utf8(body) else {
        return ro(tr!("UTF-8 이 아닌 글자(예: EUC-KR)가 있어 고치지 않아요. 외부 편집기를 쓰세요.", "This file isn't UTF-8 (e.g. EUC-KR), so it isn't edited here. Use an external editor."));
    };
    let crlf_count = text.matches("\r\n").count();
    let cr_count = text.matches('\r').count();
    let lf_count = text.matches('\n').count();
    // 홀로 쓴 \r 이 있거나 CRLF·LF 가 섞여 있으면 저장할 때 원래대로 되돌릴 수 없다
    if cr_count != crlf_count || (crlf_count > 0 && crlf_count != lf_count) {
        return ro(tr!("줄바꿈(CRLF·LF)이 섞여 있어 고치지 않아요. 외부 편집기를 쓰세요.", "Line endings (CRLF/LF) are mixed, so it isn't edited here. Use an external editor."));
    }
    let crlf = crlf_count > 0;
    let text = if crlf { text.replace("\r\n", "\n") } else { text.to_string() };
    EditableFile { rel: rel.to_string(), text: Some(text), hash, crlf, bom, readonly: None }
}

fn refuse_git_dir(rel: &str) -> Result<()> {
    if Path::new(rel).components().any(|c| c.as_os_str() == ".git") {
        bail!(tr!(".git 안의 파일은 고칠 수 없습니다", "Files inside .git can't be edited"));
    }
    Ok(())
}

pub fn read_for_edit(worktree: &Path, rel: &str) -> Result<EditableFile> {
    refuse_git_dir(rel)?;
    let p = resolve_inside(worktree, rel)?;
    let meta = std::fs::metadata(&p)?;
    if !meta.is_file() {
        bail!(tr!("일반 파일이 아니라 고칠 수 없습니다", "Not a regular file, so it can't be edited"));
    }
    if meta.len() > MAX_EDIT_BYTES {
        // 큰 파일은 지문을 만들려고 다 읽지 않는다(어차피 저장하지 않음)
        return Ok(EditableFile { rel: rel.to_string(), text: None, hash: String::new(), crlf: false, bom: false, readonly: Some(too_big()) });
    }
    Ok(editable_from(rel, &std::fs::read(&p)?))
}

/// 고친 내용을 저장한다. 불러올 때의 지문(expected)과 지금 디스크가 다르면 force 가 아닌 한 저장하지 않는다.
/// 같은 폴더의 임시 파일에 쓴 뒤 이름을 바꿔(원자적 저장) 중간에 깨진 파일이 보이지 않게 하고, 권한은 원래대로 둔다.
pub fn save_file(worktree: &Path, rel: &str, text: &str, crlf: bool, bom: bool, expected: &str, force: bool) -> Result<SaveOutcome> {
    use std::io::Write;
    refuse_git_dir(rel)?;
    let root = std::fs::canonicalize(worktree)?;
    let p = resolve_inside(worktree, rel)?;
    // 파일이 없어진 경우 resolve_inside 는 링크를 풀지 못하므로, 부모 폴더를 따로 확인한다
    let parent = p.parent().ok_or_else(|| anyhow::anyhow!(tr!("올바르지 않은 경로: {rel}", "Invalid path: {rel}")))?;
    let parent = std::fs::canonicalize(parent)?;
    if !parent.starts_with(&root) {
        bail!(tr!("워크트리 밖의 경로는 열 수 없습니다: {rel}", "Can't open a path outside the worktree: {rel}"));
    }
    let name = p.file_name().ok_or_else(|| anyhow::anyhow!(tr!("올바르지 않은 경로: {rel}", "Invalid path: {rel}")))?.to_owned();
    let target = parent.join(&name);
    let meta = std::fs::symlink_metadata(&target).ok();
    if meta.as_ref().is_some_and(|m| !m.is_file()) {
        bail!(tr!("일반 파일이 아니라 고칠 수 없습니다", "Not a regular file, so it can't be edited"));
    }
    let current = disk_hash(&target)?;
    if current != expected && !force {
        return Ok(SaveOutcome { saved: false, hash: current });
    }
    let body = text.replace("\r\n", "\n");
    let body = if crlf { body.replace('\n', "\r\n") } else { body };
    let mut bytes = Vec::with_capacity(body.len() + 3);
    if bom {
        bytes.extend_from_slice(BOM);
    }
    bytes.extend_from_slice(body.as_bytes());
    if bytes.len() as u64 > MAX_EDIT_BYTES {
        bail!(tr!("2MB 보다 큰 파일은 앱에서 저장하지 않아요", "Files over 2 MB aren't saved from the app"));
    }
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let tmp = parent.join(format!(".{}.codehaengbang-{}-{nanos}.tmp", name.to_string_lossy(), std::process::id()));
    let write = || -> Result<()> {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        if let Some(m) = &meta {
            std::fs::set_permissions(&tmp, m.permissions())?;
        }
        std::fs::rename(&tmp, &target)?;
        Ok(())
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(SaveOutcome { saved: true, hash: content_hash(&bytes) })
}

// ───────────────────────── 끌어다 놓기(복사·이동) ─────────────────────────
//
// Finder 에서 트리 폴더로 끌어오면 복사, 트리 안에서 다른 폴더로 끌면 이동한다.
// 놓는 폴더는 워크트리 안의 실제 폴더여야 하고(밖을 가리키는 링크 폴더 거부) .git 이나 그 안이면 안 된다.
// 같은 이름이 있으면 덮어쓰지 않는다: 복사는 Finder 의 '둘 다 유지' 처럼 "이름 2.확장자" 로 비켜 놓고,
// 이동은 거부한다(추적 중인 파일 이름이 몰래 바뀌면 더 헷갈리므로).

/// 한 번에 받는 항목 수 상한
const MAX_DROP_ITEMS: usize = 1000;

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TransferOutcome {
    /// 복사·이동한 항목의 새 위치(워크트리 기준 상대 경로)
    pub done: Vec<String>,
    /// 같은 이름이 있어 비켜 놓은 것
    pub renamed: Vec<Renamed>,
    /// 이미 그 폴더에 있어 그대로 둔 것
    pub unchanged: usize,
    /// 하지 못한 것과 이유
    pub failed: Vec<TransferFailure>,
    /// 폴더 안에서 건너뛴 특수 파일(소켓·파이프·장치) 수
    pub skipped: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Renamed {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransferFailure {
    pub name: String,
    pub reason: String,
}

fn has_git_component(p: &Path) -> bool {
    // 맥 기본 디스크는 대소문자를 가리지 않으므로 .GIT 도 같은 폴더다
    p.components().any(|c| c.as_os_str().eq_ignore_ascii_case(".git"))
}

/// 놓을 폴더(워크트리 안의 실제 폴더)와 워크트리 실제 경로
fn drop_dir(worktree: &Path, rel: &str) -> Result<(PathBuf, PathBuf)> {
    if has_git_component(Path::new(rel)) {
        bail!(tr!(".git 안에는 넣을 수 없습니다", "Can't put anything inside .git"));
    }
    let root = std::fs::canonicalize(worktree)?;
    let dir = resolve_inside(worktree, rel)?;
    // 링크 폴더가 .git 을 가리키는 경우까지 실제 경로로 한 번 더 본다
    if has_git_component(dir.strip_prefix(&root).unwrap_or(Path::new(""))) {
        bail!(tr!(".git 안에는 넣을 수 없습니다", "Can't put anything inside .git"));
    }
    match std::fs::metadata(&dir) {
        Ok(m) if m.is_dir() => Ok((root, dir)),
        Ok(_) => bail!(tr!("폴더가 아닙니다: {rel}", "Not a folder: {rel}")),
        Err(_) => bail!(tr!("폴더가 없습니다: {rel}", "Folder not found: {rel}")),
    }
}

fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

fn exists_no_follow(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

/// "이름 2.확장자" (폴더·확장자 없는 이름·점으로 시작하는 이름은 끝에 숫자)
pub fn numbered_name(name: &str, n: u32, is_dir: bool) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 && !is_dir => format!("{} {n}{}", &name[..i], &name[i..]),
        _ => format!("{name} {n}"),
    }
}

/// dir 안에서 name 을 쓸 수 있으면 그대로, 있으면 Finder 처럼 2, 3 … 을 붙인 빈 이름
fn free_target(dir: &Path, name: &str, is_dir: bool) -> Result<PathBuf> {
    let first = dir.join(name);
    if !exists_no_follow(&first) {
        return Ok(first);
    }
    for n in 2..10_000 {
        let p = dir.join(numbered_name(name, n, is_dir));
        if !exists_no_follow(&p) {
            return Ok(p);
        }
    }
    bail!(tr!("비어 있는 이름을 찾지 못했습니다: {name}", "Couldn't find a free name for {name}"))
}

/// 하나를 복사한다. 링크는 따라가지 않고 링크 그대로 만들고, 폴더는 안까지 복사한다.
/// created 는 dst 를 이번에 만들었는지(실패했을 때 치워도 되는지).
fn copy_entry(src: &Path, dst: &Path, skipped: &mut usize, created: &mut bool) -> Result<()> {
    let meta = std::fs::symlink_metadata(src)?;
    let ft = meta.file_type();
    if ft.is_symlink() {
        // 가리키는 곳은 바꾸지 않는다(밖을 가리켜도 링크일 뿐이고, 앱은 밖으로 따라가지 않는다)
        std::os::unix::fs::symlink(std::fs::read_link(src)?, dst)?;
        *created = true;
    } else if ft.is_dir() {
        // create_dir 은 이미 있으면 실패하므로 덮어쓰지 않는다
        std::fs::create_dir(dst)?;
        *created = true;
        for e in std::fs::read_dir(src)? {
            let e = e?;
            copy_entry(&e.path(), &dst.join(e.file_name()), skipped, &mut false)?;
        }
        // 읽기 전용 폴더도 안을 다 채운 뒤에 권한을 맞춘다
        let _ = std::fs::set_permissions(dst, meta.permissions());
    } else if ft.is_file() {
        if exists_no_follow(dst) {
            bail!(tr!("같은 이름이 이미 있습니다", "An item with the same name already exists"));
        }
        *created = true;
        // 내용·권한을 함께 복사(APFS 면 복제라 큰 파일도 빠르다)
        std::fs::copy(src, dst)?;
    } else {
        // 소켓·파이프·장치 파일은 열면 멈출 수 있어 건너뛴다
        *skipped += 1;
    }
    Ok(())
}

fn fail(out: &mut TransferOutcome, name: &str, reason: String) {
    out.failed.push(TransferFailure { name: name.to_string(), reason });
}

fn display_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string_lossy().into_owned())
}

/// Finder 등 밖에서 끌어온 파일·폴더(절대 경로)를 워크트리의 dest_rel 폴더로 복사한다.
pub fn copy_into(worktree: &Path, dest_rel: &str, sources: &[String]) -> Result<TransferOutcome> {
    let (root, dir) = drop_dir(worktree, dest_rel)?;
    let mut out = TransferOutcome::default();
    for raw in sources.iter().take(MAX_DROP_ITEMS) {
        let src = PathBuf::from(raw);
        let name = display_name(&src);
        if !src.is_absolute() || raw.contains('\0') || src.file_name().is_none() {
            fail(&mut out, &name, tr!("올바르지 않은 경로입니다", "Invalid path"));
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(&src) else {
            fail(&mut out, &name, tr!("원본이 없습니다", "The source no longer exists"));
            continue;
        };
        if name.eq_ignore_ascii_case(".git") {
            fail(&mut out, &name, tr!(".git 폴더는 넣지 않습니다", "A .git folder isn't copied in"));
            continue;
        }
        // 폴더를 자기 안으로 복사하면 끝없이 커진다
        if meta.is_dir() && std::fs::canonicalize(&src).is_ok_and(|real| dir.starts_with(&real)) {
            fail(&mut out, &name, tr!("폴더를 자기 안으로 복사할 수 없습니다", "Can't copy a folder into itself"));
            continue;
        }
        let target = match free_target(&dir, &name, meta.is_dir()) {
            Ok(t) => t,
            Err(e) => {
                fail(&mut out, &name, format!("{e:#}"));
                continue;
            }
        };
        let (mut skipped, mut created) = (0, false);
        match copy_entry(&src, &target, &mut skipped, &mut created) {
            Ok(()) => {
                out.skipped += skipped;
                let new_name = display_name(&target);
                if new_name != name {
                    out.renamed.push(Renamed { from: name.clone(), to: new_name });
                }
                out.done.push(rel_of(&root, &target));
            }
            Err(e) => {
                // 이번에 새로 만든 자리만 치운다(원래 있던 것은 건드리지 않는다)
                if created {
                    if std::fs::symlink_metadata(&target).is_ok_and(|m| m.is_dir()) {
                        let _ = std::fs::remove_dir_all(&target);
                    } else {
                        let _ = std::fs::remove_file(&target);
                    }
                }
                fail(&mut out, &name, format!("{e:#}"));
            }
        }
    }
    Ok(out)
}

/// 덮어쓰지 않는 이름 바꾸기. 맥은 RENAME_EXCL 로 확인과 바꾸기를 한 번에 한다.
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let a = std::ffi::CString::new(from.as_os_str().as_bytes())?;
        let b = std::ffi::CString::new(to.as_os_str().as_bytes())?;
        if unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_EXCL) } == 0 {
            return Ok(());
        }
        Err(std::io::Error::last_os_error())
    }
    #[cfg(not(target_os = "macos"))]
    {
        if exists_no_follow(to) {
            return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
        }
        std::fs::rename(from, to)
    }
}

/// 워크트리 안의 항목 하나를 dir 로 옮긴다. 옮겼으면 새 상대 경로, 이미 거기 있으면 None.
fn move_one(worktree: &Path, root: &Path, dir: &Path, rel: &str) -> Result<Option<String>> {
    let rel = rel.trim_end_matches('/');
    crate::git::safe_rel_path(rel)?;
    if has_git_component(Path::new(rel)) {
        bail!(tr!(".git 안의 파일은 옮길 수 없습니다", "Files inside .git can't be moved"));
    }
    let (parent_rel, name) = match rel.rfind('/') {
        Some(i) => (&rel[..i], &rel[i + 1..]),
        None => ("", rel),
    };
    // 부모 폴더만 실제 경로로 풀고 마지막 이름은 그대로 둔다: 링크면 가리키는 곳이 아니라 링크 자체를 옮긴다
    let parent = resolve_inside(worktree, parent_rel)?;
    let src = parent.join(name);
    let meta = std::fs::symlink_metadata(&src).map_err(|_| anyhow::anyhow!(tr!("원본이 없습니다", "The source no longer exists")))?;
    if parent == dir {
        return Ok(None);
    }
    if meta.is_dir() && dir.starts_with(&src) {
        bail!(tr!("폴더를 자기 안으로 옮길 수 없습니다", "Can't move a folder into itself"));
    }
    let target = dir.join(name);
    match rename_no_replace(&src, &target) {
        Ok(()) => Ok(Some(rel_of(root, &target))),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            bail!(tr!("그 폴더에 같은 이름이 이미 있습니다", "An item with the same name is already in that folder"))
        }
        Err(e) => Err(e.into()),
    }
}

/// 트리 안에서 끌어 옮기기: 워크트리 안의 rels 를 dest_rel 폴더로 이동(이름 바꾸기)한다.
pub fn move_into(worktree: &Path, dest_rel: &str, rels: &[String]) -> Result<TransferOutcome> {
    let (root, dir) = drop_dir(worktree, dest_rel)?;
    let mut out = TransferOutcome::default();
    for rel in rels.iter().take(MAX_DROP_ITEMS) {
        let name = rel.trim_end_matches('/').rsplit('/').next().unwrap_or(rel).to_string();
        match move_one(worktree, &root, &dir, rel) {
            Ok(Some(new_rel)) => out.done.push(new_rel),
            Ok(None) => out.unchanged += 1,
            Err(e) => fail(&mut out, &name, format!("{e:#}")),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_round_trip_keeps_line_endings_bom_and_mode() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let w = d.path();
        std::fs::write(w.join("win.txt"), b"\xEF\xBB\xBFa\r\nb\r\n").unwrap();
        std::fs::set_permissions(w.join("win.txt"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let f = read_for_edit(w, "win.txt").unwrap();
        assert_eq!(f.text.as_deref(), Some("a\nb\n"));
        assert!(f.crlf && f.bom && f.readonly.is_none());
        let out = save_file(w, "win.txt", "a\n한글\nb\n", f.crlf, f.bom, &f.hash, false).unwrap();
        assert!(out.saved);
        assert_eq!(std::fs::read(w.join("win.txt")).unwrap(), "\u{feff}a\r\n한글\r\nb\r\n".as_bytes());
        assert_eq!(std::fs::metadata(w.join("win.txt")).unwrap().permissions().mode() & 0o777, 0o755, "권한 유지");
        assert_eq!(read_for_edit(w, "win.txt").unwrap().hash, out.hash, "저장 후 지문이 디스크와 같다");
        let leftovers: Vec<_> = std::fs::read_dir(w).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
        assert!(leftovers.is_empty(), "임시 파일이 남지 않는다");
    }

    #[test]
    fn save_detects_outside_change_and_refuses_escape() {
        let d = tempfile::tempdir().unwrap();
        let w = d.path();
        std::fs::write(w.join("a.ts"), "one\n").unwrap();
        let f = read_for_edit(w, "a.ts").unwrap();
        // 그사이 에이전트가 고침
        std::fs::write(w.join("a.ts"), "agent\n").unwrap();
        let out = save_file(w, "a.ts", "mine\n", false, false, &f.hash, false).unwrap();
        assert!(!out.saved, "밖에서 바뀌면 덮어쓰지 않는다");
        assert_eq!(std::fs::read_to_string(w.join("a.ts")).unwrap(), "agent\n");
        assert!(save_file(w, "a.ts", "mine\n", false, false, &f.hash, true).unwrap().saved, "사용자가 고르면 덮어쓴다");
        assert_eq!(std::fs::read_to_string(w.join("a.ts")).unwrap(), "mine\n");
        // 밖에서 지워진 파일: 지문이 달라 묻고, 고르면 다시 만든다
        std::fs::remove_file(w.join("a.ts")).unwrap();
        assert!(!save_file(w, "a.ts", "x\n", false, false, &out.hash, false).unwrap().saved);
        assert!(save_file(w, "a.ts", "x\n", false, false, &out.hash, true).unwrap().saved);
        // 워크트리 밖·.git·밖을 가리키는 링크 폴더 거부
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), w.join("out")).unwrap();
        std::fs::create_dir(w.join(".git")).unwrap();
        assert!(save_file(w, "../x.txt", "x", false, false, MISSING, true).is_err());
        assert!(save_file(w, "out/new.txt", "x", false, false, MISSING, true).is_err(), "링크 폴더를 거쳐 밖으로 쓰지 않는다");
        assert!(!outside.path().join("new.txt").exists());
        assert!(save_file(w, ".git/config", "x", false, false, MISSING, true).is_err());
        assert!(read_for_edit(w, "../x").is_err());
    }

    #[test]
    fn readonly_reasons() {
        let d = tempfile::tempdir().unwrap();
        let w = d.path();
        std::fs::write(w.join("mixed.txt"), "a\r\nb\n").unwrap();
        std::fs::write(w.join("euckr.txt"), [0xC7u8, 0xD1, 0xB1, 0xDB]).unwrap();
        std::fs::write(w.join("bin"), [1u8, 0, 2]).unwrap();
        std::fs::write(w.join("big.txt"), vec![b'a'; (MAX_EDIT_BYTES + 1) as usize]).unwrap();
        for name in ["mixed.txt", "euckr.txt", "bin", "big.txt"] {
            let f = read_for_edit(w, name).unwrap();
            assert!(f.text.is_none() && f.readonly.is_some(), "{name} 은 읽기 전용");
        }
        assert!(read_for_edit(w, "").is_err(), "워크트리 자체는 파일이 아니다");
    }

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

#[cfg(test)]
mod terminal_link_tests {
    use super::*;
    #[test]
    fn terminal_files_are_existing_and_inside_the_worktree() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("src")).unwrap();
        std::fs::write(root.path().join("src/한글 file.ts"), "x").unwrap();
        std::fs::write(root.path().join("README.md"), "x").unwrap();
        std::fs::write(outside.path().join("secret.txt"), "x").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("out")).unwrap();
        let paths = vec!["한글 file.ts".into(), "src/한글 file.ts".into(), "../README.md".into(), root.path().join("README.md").to_string_lossy().into(), outside.path().join("secret.txt").to_string_lossy().into(), "out/secret.txt".into(), "missing.ts".into(), "src".into()];
        let actual = terminal_paths(root.path(), &root.path().join("src"), &paths).unwrap();
        assert_eq!(actual,vec![Some("src/한글 file.ts".into()),Some("src/한글 file.ts".into()),Some("README.md".into()),Some("README.md".into()),None,None,None,None]);
    }
    #[test]
    fn outside_cwd_is_not_used_to_read_another_repository() {
        let root=tempfile::tempdir().unwrap(); let outside=tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("other.txt"),"x").unwrap();
        assert_eq!(terminal_paths(root.path(),outside.path(), &["other.txt".into()]).unwrap(),vec![None]);
    }
}

#[cfg(test)]
mod transfer_tests {
    use super::*;

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn numbered_names_like_finder() {
        assert_eq!(numbered_name("a.txt", 2, false), "a 2.txt");
        assert_eq!(numbered_name("archive.tar.gz", 3, false), "archive.tar 3.gz");
        assert_eq!(numbered_name(".env", 2, false), ".env 2", "점으로 시작하는 이름은 끝에");
        assert_eq!(numbered_name("Makefile", 2, false), "Makefile 2");
        assert_eq!(numbered_name("my.pkg", 2, true), "my.pkg 2", "폴더는 끝에");
    }

    #[test]
    fn copies_in_from_outside_without_overwriting() {
        let w = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let (w, o) = (w.path(), out.path());
        std::fs::create_dir(w.join("src")).unwrap();
        std::fs::write(w.join("src/a.txt"), "원래").unwrap();
        std::fs::write(o.join("a.txt"), "새것").unwrap();
        std::fs::write(o.join("스크린샷 1.png"), [1u8, 2]).unwrap();
        // 폴더: 안의 파일, 링크(밖을 가리킴), 특수 파일
        std::fs::create_dir_all(o.join("pkg/inner")).unwrap();
        std::fs::write(o.join("pkg/inner/b.rs"), "fn b() {}").unwrap();
        std::os::unix::fs::symlink("/etc/hosts", o.join("pkg/link")).unwrap();
        assert!(std::process::Command::new("mkfifo").arg(o.join("pkg/pipe")).status().unwrap().success());

        let r = copy_into(w, "src", &[s(&o.join("a.txt")), s(&o.join("스크린샷 1.png")), s(&o.join("pkg"))]).unwrap();
        assert_eq!(r.done, vec!["src/a 2.txt", "src/스크린샷 1.png", "src/pkg"]);
        assert_eq!(r.renamed, vec![Renamed { from: "a.txt".into(), to: "a 2.txt".into() }]);
        assert!(r.failed.is_empty(), "{:?}", r.failed);
        assert_eq!(r.skipped, 1, "파이프는 건너뛴다");
        assert_eq!(std::fs::read_to_string(w.join("src/a.txt")).unwrap(), "원래", "있던 파일은 덮어쓰지 않는다");
        assert_eq!(std::fs::read_to_string(w.join("src/a 2.txt")).unwrap(), "새것");
        assert_eq!(std::fs::read_to_string(w.join("src/pkg/inner/b.rs")).unwrap(), "fn b() {}", "폴더는 안까지");
        let link = w.join("src/pkg/link");
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "링크는 따라가지 않고 링크로");
        assert_eq!(std::fs::read_link(&link).unwrap(), Path::new("/etc/hosts"));
        assert!(!w.join("src/pkg/pipe").exists());
        assert!(o.join("a.txt").exists(), "원본은 그대로(복사)");

        // 같은 폴더를 또 놓으면 "pkg 2", 워크트리 맨 위(빈 rel)도 된다
        let r = copy_into(w, "src", &[s(&o.join("pkg"))]).unwrap();
        assert_eq!(r.done, vec!["src/pkg 2"]);
        let r = copy_into(w, "", &[s(&o.join("a.txt"))]).unwrap();
        assert_eq!(r.done, vec!["a.txt"]);
    }

    #[test]
    fn copy_refuses_git_escapes_and_self() {
        let wd = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let w = wd.path();
        std::fs::create_dir_all(w.join(".git")).unwrap();
        std::fs::create_dir_all(w.join("sub/deep")).unwrap();
        std::fs::write(outside.path().join("x.txt"), "x").unwrap();
        std::os::unix::fs::symlink(outside.path(), w.join("out")).unwrap();
        std::os::unix::fs::symlink(w.join(".git"), w.join("gitlink")).unwrap();
        let x = vec![s(&outside.path().join("x.txt"))];
        assert!(copy_into(w, ".git", &x).is_err(), ".git 안 거부");
        assert!(copy_into(w, "sub/.GIT", &x).is_err(), "대소문자만 다른 .git 도 거부");
        assert!(copy_into(w, "gitlink", &x).is_err(), ".git 을 가리키는 링크 폴더 거부");
        assert!(copy_into(w, "out", &x).is_err(), "밖을 가리키는 링크 폴더 거부");
        assert!(!outside.path().join("x 2.txt").exists());
        assert!(copy_into(w, "../", &x).is_err());
        assert!(copy_into(w, "missing", &x).is_err());

        // 워크트리(또는 그 위 폴더)를 자기 하위로 복사, .git 폴더, 상대 경로, 없는 원본
        let r = copy_into(w, "sub/deep", &[s(w), s(&w.join("sub")), s(&w.join(".git")), "rel.txt".into(), s(&outside.path().join("none"))]).unwrap();
        assert!(r.done.is_empty(), "{:?}", r.done);
        assert_eq!(r.failed.len(), 5, "{:?}", r.failed);
        assert_eq!(std::fs::read_dir(w.join("sub/deep")).unwrap().count(), 0, "실패한 것은 남기지 않는다");
    }

    #[test]
    fn moves_inside_the_worktree() {
        let wd = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let w = wd.path();
        std::fs::create_dir_all(w.join("src/ui")).unwrap();
        std::fs::create_dir_all(w.join("docs")).unwrap();
        std::fs::create_dir_all(w.join(".git")).unwrap();
        std::fs::write(w.join(".git/config"), "x").unwrap();
        std::fs::write(w.join("a.ts"), "a").unwrap();
        std::fs::write(w.join("src/b.ts"), "b").unwrap();
        std::fs::write(w.join("docs/b.ts"), "다른 b").unwrap();
        std::fs::write(w.join("src/ui/c.ts"), "c").unwrap();
        std::fs::write(outside.path().join("o.txt"), "o").unwrap();
        // 안을 가리키는 링크: 링크 자체가 옮겨지고 가리키던 파일은 그대로
        std::os::unix::fs::symlink(w.join("a.ts"), w.join("alink")).unwrap();

        let r = move_into(w, "src", &["a.ts".into(), "alink".into(), "src/b.ts".into()]).unwrap();
        assert_eq!(r.done, vec!["src/a.ts", "src/alink"]);
        assert_eq!(r.unchanged, 1, "이미 그 폴더에 있으면 그대로");
        assert!(!w.join("a.ts").exists() && w.join("src/a.ts").exists());
        assert!(std::fs::symlink_metadata(w.join("src/alink")).unwrap().file_type().is_symlink());

        // 폴더 이동, 같은 이름 거부(둘 다 그대로)
        let r = move_into(w, "docs", &["src/ui".into(), "src/b.ts".into()]).unwrap();
        assert_eq!(r.done, vec!["docs/ui"]);
        assert_eq!(r.failed.len(), 1);
        assert_eq!(std::fs::read_to_string(w.join("src/b.ts")).unwrap(), "b");
        assert_eq!(std::fs::read_to_string(w.join("docs/b.ts")).unwrap(), "다른 b");
        assert_eq!(std::fs::read_to_string(w.join("docs/ui/c.ts")).unwrap(), "c");

        // 자기 자신·자기 하위로, .git 안, 워크트리 밖, 워크트리 자체, 없는 파일
        std::fs::create_dir_all(w.join("docs/ui/deep")).unwrap();
        let r = move_into(w, "docs/ui/deep", &["docs/ui".into(), "docs".into(), ".git/config".into(), "../x".into(), "".into(), "nope.ts".into()]).unwrap();
        assert!(r.done.is_empty(), "{:?}", r.done);
        assert_eq!(r.failed.len(), 6, "{:?}", r.failed);
        assert_eq!(move_into(w, "docs/ui", &["docs/ui".into()]).unwrap().failed.len(), 1, "폴더를 자기 안으로");
        assert!(move_into(w, ".git", &["docs/b.ts".into()]).is_err(), ".git 안으로 거부");
        std::os::unix::fs::symlink(outside.path(), w.join("out")).unwrap();
        assert!(move_into(w, "out", &["docs/b.ts".into()]).is_err(), "밖을 가리키는 링크 폴더로 거부");
        assert!(w.join("docs/b.ts").exists() && w.join(".git/config").exists());
        // 밖을 가리키는 링크를 거쳐 밖의 파일을 끌어오지 않는다
        let r = move_into(w, "docs", &["out/o.txt".into()]).unwrap();
        assert_eq!(r.failed.len(), 1);
        assert!(outside.path().join("o.txt").exists());
    }
}
