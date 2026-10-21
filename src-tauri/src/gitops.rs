//! 브랜치·워크트리·스테이징·병합 같은 Git 쓰기 작업. 모두 UI 에서 사용자가 확인한 뒤에만 호출된다.
//! --force 류 옵션은 사용자가 따로 확인한 경우(force 인자)에만 쓴다.

use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use std::path::Path;

use crate::git::{self, check, fingerprint, run, run_raw, safe_rel_path, validate_rev, COMMIT_TIMEOUT, READ_TIMEOUT};

// ───────────────────────────── 브랜치 ─────────────────────────────

/// `git check-ref-format --branch` 로 브랜치 이름이 올바른지 확인한다.
pub fn validate_branch_name(repo: &Path, name: &str) -> Result<()> {
    if name.is_empty() || name.starts_with('-') || name.contains(char::is_whitespace) {
        bail!("올바르지 않은 브랜치 이름: {name:?}");
    }
    let out = run_raw(repo, &["check-ref-format", "--branch", name], None, READ_TIMEOUT)?;
    if out.code != 0 {
        bail!("올바르지 않은 브랜치 이름: {name}");
    }
    Ok(())
}

/// 새 브랜치를 만든다. checkout 이면 이 워크트리를 그 브랜치로 옮긴다(`switch -c`).
pub fn create_branch(worktree: &Path, name: &str, start: Option<&str>, checkout: bool) -> Result<String> {
    validate_branch_name(worktree, name)?;
    if let Some(s) = start {
        validate_rev(s)?;
    }
    let start = start.unwrap_or("HEAD");
    if checkout {
        run(worktree, &["switch", "-c", name, start])
    } else {
        run(worktree, &["branch", name, start])
    }
}

/// 브랜치 삭제. force=false 면 병합된 브랜치만 지운다(`-d`).
pub fn delete_branch(repo: &Path, name: &str, force: bool) -> Result<String> {
    validate_branch_name(repo, name)?;
    // 워크트리에서 쓰는 중인 브랜치는 git 도 막지만, 메시지를 알기 쉽게 먼저 확인한다.
    if let Some(w) = git::worktrees(repo)?.into_iter().find(|w| w.branch.as_deref() == Some(name)) {
        bail!("'{name}' 은(는) 워크트리 {} 에서 사용 중이라 지울 수 없습니다", w.path);
    }
    run(repo, &["branch", if force { "-D" } else { "-d" }, "--", name])
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Compare {
    /// a 에만 있는 커밋 수
    pub ahead: u32,
    /// b 에만 있는 커밋 수
    pub behind: u32,
    pub merge_base: Option<String>,
    /// a 가 b 의 조상이면 b 로 fast-forward 가능
    pub fast_forward: bool,
}

/// `a...b` 비교 (병합·rebase 전 요약)
pub fn compare(repo: &Path, a: &str, b: &str) -> Result<Compare> {
    validate_rev(a)?;
    validate_rev(b)?;
    let counts = run(repo, &["rev-list", "--left-right", "--count", &format!("{a}...{b}"), "--"])?;
    let mut it = counts.split_whitespace().map(|x| x.parse::<u32>().unwrap_or(0));
    let (ahead, behind) = (it.next().unwrap_or(0), it.next().unwrap_or(0));
    let mb = run_raw(repo, &["merge-base", a, b], None, READ_TIMEOUT)?;
    let merge_base = (mb.code == 0).then(|| String::from_utf8_lossy(&mb.stdout).trim().to_string());
    Ok(Compare { ahead, behind, merge_base, fast_forward: ahead == 0 })
}

// ───────────────────────────── 워크트리 ─────────────────────────────

/// 워크트리 추가. new_branch 가 있으면 base 에서 새 브랜치를 만들고, 없으면 base(기존 브랜치/커밋)를 연다.
pub fn worktree_add(repo: &Path, path: &str, new_branch: Option<&str>, base: Option<&str>) -> Result<String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        bail!("워크트리 경로는 절대 경로여야 합니다");
    }
    if p.exists() && std::fs::read_dir(p).map(|mut d| d.next().is_some()).unwrap_or(true) {
        bail!("이미 있는 폴더입니다(비어 있지 않음): {path}");
    }
    if let Some(b) = base {
        validate_rev(b)?;
    }
    let mut args: Vec<&str> = vec!["worktree", "add"];
    if let Some(nb) = new_branch {
        validate_branch_name(repo, nb)?;
        args.extend(["-b", nb]);
    }
    args.push("--");
    args.push(path);
    if let Some(b) = base {
        args.push(b);
    }
    let out = run_raw(repo, &args, None, COMMIT_TIMEOUT)?;
    let stderr = out.stderr.clone();
    check(&args, out)?;
    Ok(stderr)
}

/// 워크트리 삭제. force=false 면 변경 사항이 있을 때 git 이 거부한다.
pub fn worktree_remove(repo: &Path, path: &str, force: bool) -> Result<String> {
    let list = git::worktrees(repo)?;
    let canon = std::fs::canonicalize(path).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| path.to_string());
    let w = list.iter().find(|w| w.path == canon || w.path == path).ok_or_else(|| anyhow!("이 저장소의 워크트리가 아닙니다: {path}"))?;
    if w.is_main {
        bail!("메인 워크트리는 지울 수 없습니다");
    }
    let target = w.path.clone();
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push("--");
    args.push(&target);
    run(repo, &args)
}

pub fn worktree_prune(repo: &Path) -> Result<String> {
    run(repo, &["worktree", "prune", "-v"])
}

// ───────────────────────────── 스테이징 ─────────────────────────────

/// 한 파일 diff 원문을 (헤더, hunk 원문들) 로 나눈다. hunk 원문의 지문은 parse_unified_diff 의 id 와 같다.
pub fn split_patch(raw: &str) -> Option<(String, Vec<String>)> {
    let mut header = String::new();
    let mut hunks: Vec<String> = Vec::new();
    for line in raw.split_inclusive('\n') {
        let l = line.trim_end_matches('\n');
        if l.starts_with("@@") {
            hunks.push(format!("{l}\n"));
        } else if let Some(h) = hunks.last_mut() {
            if matches!(l.chars().next(), Some(' ' | '+' | '-' | '\\')) {
                h.push_str(l);
                h.push('\n');
            } else if l.starts_with("diff --git ") {
                return None; // 여러 파일이 섞이면 안 된다
            }
        } else {
            header.push_str(l);
            header.push('\n');
        }
    }
    (!header.is_empty()).then_some((header, hunks))
}

fn file_diff_raw(worktree: &Path, rel: &str, staged: bool) -> Result<String> {
    let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--", rel]);
    run(worktree, &args)
}

/// hunk 를 다시 적용하려면 diff 바이트가 손실 없이 문자열이어야 한다(UTF-8 아니면 거부).
fn file_diff_exact(worktree: &Path, rel: &str, staged: bool) -> Result<String> {
    let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--", rel]);
    let bytes = git::run_bytes(worktree, &args)?;
    let text = String::from_utf8(bytes).map_err(|_| anyhow!("UTF-8 이 아닌 파일은 hunk 단위로 다룰 수 없습니다. 파일 단위(+ / −)로 스테이지하세요."))?;
    if text.starts_with("diff --cc") || text.contains("\n@@@ ") {
        bail!("충돌 중인 파일은 hunk 단위로 다룰 수 없습니다. 위쪽 진행 배너에서 해결하세요.");
    }
    Ok(text)
}

/// 스테이지된/안 된 변경을 따로 본다(hunk 스테이징 화면용).
pub fn diff_split(worktree: &Path, rel: &str) -> Result<(Vec<git::FileDiff>, Vec<git::FileDiff>)> {
    safe_rel_path(rel)?;
    let unstaged = git::parse_unified_diff(&file_diff_raw(worktree, rel, false)?);
    let staged = git::parse_unified_diff(&file_diff_raw(worktree, rel, true)?);
    Ok((unstaged, staged))
}

/// hunk 하나를 스테이지 / 스테이지 취소 / 버리기.
/// expected_id 는 화면에 보였던 hunk 의 지문이다. 그 사이 파일이 바뀌었으면 거부한다.
pub fn apply_hunk(worktree: &Path, rel: &str, action: &str, index: usize, expected_id: &str) -> Result<()> {
    safe_rel_path(rel)?;
    let staged_source = action == "unstage";
    let raw = file_diff_exact(worktree, rel, staged_source)?;
    let (header, hunks) = split_patch(&raw).ok_or_else(|| anyhow!("변경을 찾을 수 없습니다. 다시 읽어 주세요."))?;
    let hunk = hunks.get(index).ok_or_else(|| anyhow!("변경 조각이 바뀌었습니다. 다시 읽어 주세요."))?;
    if fingerprint(hunk) != expected_id {
        bail!("그 사이 파일이 바뀌었습니다. 화면을 다시 읽은 뒤 시도하세요.");
    }
    let patch = format!("{header}{hunk}");
    let args: Vec<&str> = match action {
        "stage" => vec!["apply", "--cached", "--whitespace=nowarn", "-"],
        "unstage" => vec!["apply", "--cached", "-R", "--whitespace=nowarn", "-"],
        "discard" => vec!["apply", "-R", "--whitespace=nowarn", "-"],
        _ => bail!("알 수 없는 작업: {action}"),
    };
    let out = run_raw(worktree, &args, Some(patch.as_bytes()), READ_TIMEOUT)?;
    check(&args, out)?;
    Ok(())
}

pub fn stage_paths(worktree: &Path, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    for p in paths {
        safe_rel_path(p)?;
    }
    let mut args = vec!["add", "-A", "--"];
    args.extend(paths.iter().map(String::as_str));
    run(worktree, &args).map(|_| ())
}

pub fn unstage_paths(worktree: &Path, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    for p in paths {
        safe_rel_path(p)?;
    }
    let has_head = run_raw(worktree, &["rev-parse", "--verify", "-q", "HEAD"], None, READ_TIMEOUT)?.code == 0;
    let mut args: Vec<&str> = if has_head { vec!["restore", "--staged", "--"] } else { vec!["rm", "--cached", "-r", "-q", "--"] };
    args.extend(paths.iter().map(String::as_str));
    run(worktree, &args).map(|_| ())
}

/// 추적 중인 파일의 미스테이지 변경을 버린다(워크트리를 index 상태로). 새 파일(untracked)은 건드리지 않는다.
pub fn discard_paths(worktree: &Path, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    for p in paths {
        safe_rel_path(p)?;
    }
    let mut args = vec!["restore", "--worktree", "--"];
    args.extend(paths.iter().map(String::as_str));
    run(worktree, &args).map(|_| ())
}

/// 스테이지된 것만 커밋
pub fn commit_staged(worktree: &Path, message: &str, amend: bool) -> Result<String> {
    if message.trim().is_empty() {
        bail!("커밋 메시지를 입력하세요");
    }
    let staged = run(worktree, &["diff", "--cached", "--name-only", "-z"])?;
    if staged.trim_matches('\0').is_empty() && !amend {
        bail!("스테이지된 변경이 없습니다");
    }
    let mut args = vec!["commit", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    let out = run_raw(worktree, &args, Some(message.as_bytes()), COMMIT_TIMEOUT)?;
    let stdout = check(&args, out)?;
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

// ───────────────────────────── 병합 / rebase ─────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    /// 충돌로 멈춤(사용자가 해결 후 계속/중단해야 함)
    pub conflict: bool,
    pub output: String,
}

fn git_dir(worktree: &Path) -> Result<std::path::PathBuf> {
    let loc = git::locate(worktree)?.ok_or_else(|| anyhow!("Git 저장소가 아닙니다"))?;
    Ok(std::path::PathBuf::from(loc.git_dir))
}

fn conflicted(worktree: &Path) -> Result<bool> {
    Ok(git::status(worktree)?.entries.iter().any(|e| e.kind == "conflicted"))
}

/// mode: "ff" (기본: 가능하면 fast-forward), "no-ff" (항상 병합 커밋), "ff-only"
pub fn merge(worktree: &Path, target: &str, mode: &str) -> Result<OpResult> {
    validate_rev(target)?;
    let mut args = vec!["merge", "--no-edit"];
    match mode {
        "no-ff" => args.push("--no-ff"),
        "ff-only" => args.push("--ff-only"),
        _ => {}
    }
    args.push(target);
    let out = run_raw(worktree, &args, None, COMMIT_TIMEOUT)?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), out.stderr);
    if out.code == 0 {
        return Ok(OpResult { conflict: false, output: text });
    }
    if git_dir(worktree)?.join("MERGE_HEAD").exists() && conflicted(worktree)? {
        return Ok(OpResult { conflict: true, output: text });
    }
    Err(git::GitError { args: args.join(" "), stderr: text, code: out.code }.into())
}

pub fn rebase(worktree: &Path, onto: &str) -> Result<OpResult> {
    validate_rev(onto)?;
    let args = ["rebase", onto];
    let out = run_raw(worktree, &args, None, COMMIT_TIMEOUT)?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), out.stderr);
    if out.code == 0 {
        return Ok(OpResult { conflict: false, output: text });
    }
    let gd = git_dir(worktree)?;
    if gd.join("rebase-merge").exists() || gd.join("rebase-apply").exists() {
        return Ok(OpResult { conflict: true, output: text });
    }
    Err(git::GitError { args: args.join(" "), stderr: text, code: out.code }.into())
}

/// 진행 중인 merge/rebase/cherry-pick/revert 에 대해 continue | abort | skip
pub fn op_control(worktree: &Path, action: &str) -> Result<OpResult> {
    let gd = git_dir(worktree)?;
    let op = git::operation_in_progress(&gd).ok_or_else(|| anyhow!("진행 중인 병합/rebase 가 없습니다"))?;
    let args: Vec<&str> = match (op.as_str(), action) {
        ("merge", "continue") => {
            if conflicted(worktree)? {
                bail!("아직 해결하지 않은 충돌 파일이 있습니다");
            }
            vec!["commit", "--no-edit"]
        }
        ("merge", "abort") => vec!["merge", "--abort"],
        ("rebase", "continue") => vec!["rebase", "--continue"],
        ("rebase", "abort") => vec!["rebase", "--abort"],
        ("rebase", "skip") => vec!["rebase", "--skip"],
        ("cherry-pick", a @ ("continue" | "abort" | "skip")) => vec!["cherry-pick", if a == "continue" { "--continue" } else if a == "abort" { "--abort" } else { "--skip" }],
        ("revert", a @ ("continue" | "abort" | "skip")) => vec!["revert", if a == "continue" { "--continue" } else if a == "abort" { "--abort" } else { "--skip" }],
        ("am", a @ ("continue" | "abort" | "skip")) => vec!["am", if a == "continue" { "--continue" } else if a == "abort" { "--abort" } else { "--skip" }],
        ("bisect", "abort") => vec!["bisect", "reset"],
        (op, a) => bail!("{op} 에서는 {a} 를 할 수 없습니다"),
    };
    let out = run_raw(worktree, &args, None, COMMIT_TIMEOUT)?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), out.stderr);
    if out.code == 0 {
        return Ok(OpResult { conflict: false, output: text });
    }
    // rebase --continue 가 다음 커밋에서 다시 충돌한 경우
    if git::operation_in_progress(&gd).is_some() && conflicted(worktree)? {
        return Ok(OpResult { conflict: true, output: text });
    }
    Err(git::GitError { args: args.join(" "), stderr: text, code: out.code }.into())
}

/// 충돌 파일 해결: "ours" | "theirs" 로 한쪽을 고르거나, "mark" 로 (직접 고친 뒤) 해결 표시만 한다.
pub fn resolve(worktree: &Path, rel: &str, side: &str) -> Result<()> {
    safe_rel_path(rel)?;
    match side {
        "ours" | "theirs" => {
            let flag = format!("--{side}");
            run(worktree, &["checkout", &flag, "--", rel])?;
        }
        "mark" => {
            let text = std::fs::read_to_string(worktree.join(rel)).unwrap_or_default();
            if text.lines().any(|l| l.starts_with("<<<<<<< ") || l.starts_with(">>>>>>> ")) {
                bail!("파일에 아직 충돌 표시(<<<<<<< / >>>>>>>)가 남아 있습니다");
            }
        }
        _ => bail!("알 수 없는 해결 방법: {side}"),
    }
    run(worktree, &["add", "--", rel]).map(|_| ())
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpState {
    /// merge | rebase | cherry-pick | revert | bisect
    pub operation: Option<String>,
    /// rebase 진행도 (현재, 전체)
    pub step: Option<(u32, u32)>,
    /// 병합/rebase 대상 이름(가능하면)
    pub onto: Option<String>,
    pub conflicted: Vec<String>,
}

pub fn op_state(worktree: &Path) -> Result<OpState> {
    let gd = git_dir(worktree)?;
    let operation = git::operation_in_progress(&gd);
    let read = |p: &str| std::fs::read_to_string(gd.join(p)).ok().map(|s| s.trim().to_string());
    let step = if gd.join("rebase-merge").exists() {
        match (read("rebase-merge/msgnum"), read("rebase-merge/end")) {
            (Some(a), Some(b)) => Some((a.parse().unwrap_or(0), b.parse().unwrap_or(0))),
            _ => None,
        }
    } else if gd.join("rebase-apply").exists() {
        match (read("rebase-apply/next"), read("rebase-apply/last")) {
            (Some(a), Some(b)) => Some((a.parse().unwrap_or(0), b.parse().unwrap_or(0))),
            _ => None,
        }
    } else {
        None
    };
    // rebase: "topic → main(abc1234)" 형태, merge: MERGE_MSG 첫 줄
    let onto = if gd.join("rebase-merge").exists() || gd.join("rebase-apply").exists() {
        let dir = if gd.join("rebase-merge").exists() { "rebase-merge" } else { "rebase-apply" };
        let head = read(&format!("{dir}/head-name")).map(|h| h.trim_start_matches("refs/heads/").to_string());
        let onto_sha = read(&format!("{dir}/onto"));
        let onto_name = onto_sha.as_deref().and_then(|sha| {
            git::refs(worktree).ok()?.into_iter().find(|r| r.kind == "branch" && r.target == sha).map(|r| r.short)
        });
        let target = onto_name.or_else(|| onto_sha.map(|s| s.chars().take(7).collect()));
        match (head, target) {
            (Some(h), Some(t)) => Some(format!("{h} → {t}")),
            (None, Some(t)) => Some(format!("→ {t}")),
            _ => None,
        }
    } else {
        read("MERGE_MSG").and_then(|m| m.lines().next().map(str::to_string))
    };
    let conflicted = git::status(worktree)?.entries.into_iter().filter(|e| e.kind == "conflicted").map(|e| e.path).collect();
    Ok(OpState { operation, step, onto, conflicted })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn repo() -> (tempfile::TempDir, std::path::PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let r = std::fs::canonicalize(t.path()).unwrap().join("r");
        std::fs::create_dir(&r).unwrap();
        sh(&r, &["init", "-q", "-b", "main"]);
        sh(&r, &["config", "user.name", "t"]);
        sh(&r, &["config", "user.email", "t@t"]);
        let lines: String = (1..=30).map(|i| format!("line {i}\n")).collect();
        std::fs::write(r.join("f.txt"), lines).unwrap();
        sh(&r, &["add", "."]);
        sh(&r, &["commit", "-qm", "base"]);
        (t, r)
    }

    #[test]
    fn hunk_stage_unstage_discard() {
        let (_t, r) = repo();
        // 멀리 떨어진 두 곳을 고쳐 hunk 2개를 만든다
        let text = std::fs::read_to_string(r.join("f.txt")).unwrap().replace("line 2\n", "line 2 changed\n").replace("line 28\n", "line 28 changed\n");
        std::fs::write(r.join("f.txt"), text).unwrap();
        let (unstaged, staged) = diff_split(&r, "f.txt").unwrap();
        assert_eq!(unstaged[0].hunks.len(), 2);
        assert!(staged.is_empty());
        // 두 번째 hunk 만 스테이지
        apply_hunk(&r, "f.txt", "stage", 1, &unstaged[0].hunks[1].id).unwrap();
        let cached = sh(&r, &["diff", "--cached"]);
        assert!(cached.contains("line 28 changed") && !cached.contains("line 2 changed"));
        // 화면이 오래되었으면(지문 불일치) 거부
        assert!(apply_hunk(&r, "f.txt", "stage", 0, "deadbeef").is_err());
        // 스테이지 취소
        let (_, staged) = diff_split(&r, "f.txt").unwrap();
        apply_hunk(&r, "f.txt", "unstage", 0, &staged[0].hunks[0].id).unwrap();
        assert_eq!(sh(&r, &["diff", "--cached"]), "");
        // 첫 hunk 버리기 → 워크트리에서 사라짐
        let (unstaged, _) = diff_split(&r, "f.txt").unwrap();
        apply_hunk(&r, "f.txt", "discard", 0, &unstaged[0].hunks[0].id).unwrap();
        let now = std::fs::read_to_string(r.join("f.txt")).unwrap();
        assert!(!now.contains("line 2 changed") && now.contains("line 28 changed"));
    }

    #[test]
    fn staged_only_commit_and_file_level_ops() {
        let (_t, r) = repo();
        std::fs::write(r.join("a.txt"), "a").unwrap();
        std::fs::write(r.join("b.txt"), "b").unwrap();
        stage_paths(&r, &["a.txt".into(), "b.txt".into()]).unwrap();
        unstage_paths(&r, &["b.txt".into()]).unwrap();
        commit_staged(&r, "a only", false).unwrap();
        assert_eq!(sh(&r, &["show", "--name-only", "--format=", "HEAD"]), "a.txt");
        assert!(commit_staged(&r, "nothing", false).is_err());
        std::fs::write(r.join("f.txt"), "zzz").unwrap();
        discard_paths(&r, &["f.txt".into()]).unwrap();
        assert!(std::fs::read_to_string(r.join("f.txt")).unwrap().starts_with("line 1"));
    }

    #[test]
    fn branch_and_worktree_lifecycle() {
        let (t, r) = repo();
        assert!(validate_branch_name(&r, "bad..name").is_err());
        assert!(validate_branch_name(&r, "-x").is_err());
        create_branch(&r, "feat/x", None, false).unwrap();
        let wt = t.path().join("wt-x");
        let wt_s = wt.to_string_lossy().to_string();
        worktree_add(&r, &wt_s, None, Some("feat/x")).unwrap();
        assert_eq!(sh(&wt, &["rev-parse", "--abbrev-ref", "HEAD"]), "feat/x");
        // 사용 중인 브랜치는 지울 수 없다
        assert!(delete_branch(&r, "feat/x", false).is_err());
        // 변경이 있으면 force 없이 삭제 거부
        std::fs::write(wt.join("dirty.txt"), "d").unwrap();
        assert!(worktree_remove(&r, &wt_s, false).is_err());
        worktree_remove(&r, &wt_s, true).unwrap();
        assert!(!wt.exists());
        delete_branch(&r, "feat/x", false).unwrap();
        // 새 브랜치와 함께 워크트리 만들기
        let wt2 = t.path().join("wt-y").to_string_lossy().to_string();
        worktree_add(&r, &wt2, Some("feat/y"), Some("main")).unwrap();
        assert!(worktree_remove(&r, r.to_str().unwrap(), true).is_err(), "main worktree must be protected");
        // 비어 있지 않은 폴더에는 만들지 않는다
        assert!(worktree_add(&r, r.to_str().unwrap(), Some("z"), None).is_err());
    }

    #[test]
    fn merge_conflict_resolve_and_continue() {
        let (_t, r) = repo();
        sh(&r, &["switch", "-q", "-c", "other"]);
        std::fs::write(r.join("f.txt"), "other side\n").unwrap();
        sh(&r, &["commit", "-qam", "other"]);
        sh(&r, &["switch", "-q", "main"]);
        std::fs::write(r.join("f.txt"), "main side\n").unwrap();
        sh(&r, &["commit", "-qam", "main"]);
        let res = merge(&r, "other", "ff").unwrap();
        assert!(res.conflict);
        let st = op_state(&r).unwrap();
        assert_eq!(st.operation.as_deref(), Some("merge"));
        assert_eq!(st.conflicted, vec!["f.txt"]);
        assert!(op_control(&r, "continue").is_err(), "cannot continue with conflicts");
        assert!(resolve(&r, "f.txt", "mark").is_err(), "markers still present");
        resolve(&r, "f.txt", "theirs").unwrap();
        op_control(&r, "continue").unwrap();
        assert_eq!(std::fs::read_to_string(r.join("f.txt")).unwrap(), "other side\n");
        assert_eq!(sh(&r, &["rev-list", "--parents", "-n1", "HEAD"]).split_whitespace().count(), 3, "merge commit");
        assert!(op_state(&r).unwrap().operation.is_none());
    }

    #[test]
    fn rebase_with_conflict_then_abort_and_clean_rebase() {
        let (_t, r) = repo();
        sh(&r, &["switch", "-q", "-c", "topic"]);
        std::fs::write(r.join("f.txt"), "topic\n").unwrap();
        sh(&r, &["commit", "-qam", "topic"]);
        sh(&r, &["switch", "-q", "main"]);
        std::fs::write(r.join("f.txt"), "main\n").unwrap();
        sh(&r, &["commit", "-qam", "main2"]);
        sh(&r, &["switch", "-q", "topic"]);
        let before = sh(&r, &["rev-parse", "HEAD"]);
        let res = rebase(&r, "main").unwrap();
        assert!(res.conflict);
        assert_eq!(op_state(&r).unwrap().operation.as_deref(), Some("rebase"));
        op_control(&r, "abort").unwrap();
        assert_eq!(sh(&r, &["rev-parse", "HEAD"]), before, "abort restores HEAD");
        // 충돌 없는 rebase
        sh(&r, &["reset", "-q", "--hard", "main~1"]);
        std::fs::write(r.join("new.txt"), "n").unwrap();
        sh(&r, &["add", "."]);
        sh(&r, &["commit", "-qm", "new file"]);
        let res = rebase(&r, "main").unwrap();
        assert!(!res.conflict);
        let c = compare(&r, "topic", "main").unwrap();
        assert_eq!((c.ahead, c.behind), (1, 0));
    }

    #[test]
    fn non_utf8_and_conflicted_files_refuse_hunk_ops() {
        let (_t, r) = repo();
        // EUC-KR "한" = c7 d1
        std::fs::write(r.join("euc.txt"), b"a\n").unwrap();
        sh(&r, &["add", "."]);
        sh(&r, &["commit", "-qm", "euc"]);
        std::fs::write(r.join("euc.txt"), b"a\n\xc7\xd1\n").unwrap();
        let (unstaged, _) = diff_split(&r, "euc.txt").unwrap();
        let err = apply_hunk(&r, "euc.txt", "stage", 0, &unstaged[0].hunks[0].id).unwrap_err();
        assert!(err.to_string().contains("UTF-8"), "{err}");
        assert_eq!(sh(&r, &["diff", "--cached"]), "", "index untouched");
        assert!(discard_paths(&r, &[".".into()]).is_err(), "'.' must be refused");
    }

    #[test]
    fn rebase_state_shows_branch_and_target() {
        let (_t, r) = repo();
        sh(&r, &["switch", "-q", "-c", "topic"]);
        std::fs::write(r.join("f.txt"), "topic\n").unwrap();
        sh(&r, &["commit", "-qam", "topic"]);
        sh(&r, &["switch", "-q", "main"]);
        std::fs::write(r.join("f.txt"), "main\n").unwrap();
        sh(&r, &["commit", "-qam", "main2"]);
        sh(&r, &["switch", "-q", "topic"]);
        assert!(rebase(&r, "main").unwrap().conflict);
        let st = op_state(&r).unwrap();
        assert_eq!(st.onto.as_deref(), Some("topic → main"));
        let (unstaged, _) = diff_split(&r, "f.txt").unwrap_or_default();
        if let Some(h) = unstaged.first().and_then(|f| f.hunks.first()) {
            assert!(apply_hunk(&r, "f.txt", "stage", 0, &h.id).is_err(), "conflicted file refuses hunk staging");
        }
        op_control(&r, "abort").unwrap();
    }

    #[test]
    fn split_patch_matches_parser_ids() {
        let raw = "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -10,1 +10,1 @@\n-x\n+y\n";
        let (h, hunks) = split_patch(raw).unwrap();
        assert!(h.starts_with("diff --git") && h.ends_with("+++ b/f\n"));
        assert_eq!(hunks.len(), 2);
        let parsed = git::parse_unified_diff(raw);
        assert_eq!(parsed[0].hunks[0].id, fingerprint(&hunks[0]));
        assert_eq!(parsed[0].hunks[1].id, fingerprint(&hunks[1]));
    }
}
