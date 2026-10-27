//! 저장소 설정에 적힌 실행 명령: 사용자가 믿는다고 한 저장소가 아니면 끈다.
//!
//! `.git/config` 는 clone 으로는 받지 않지만, `.git` 까지 든 압축을 받거나 공유 폴더를 열면 남이 적은 설정이 그대로 온다.
//! 그 안의 변환 필터(clean/process)는 git status 가 파일을 다시 읽을 때 실행되어, 앱이 화면을 그리기만 해도 명령이 돈다.
//! 훅·ssh 명령·서명 프로그램 등은 커밋·받기 같은 버튼에서 돈다. 믿기 전에는 이런 항목을 `-c` 로 덮어 끈다.
//! 판단은 저장소 자체 설정(local·worktree 범위)과 `.git/hooks` 만 본다. 사용자 전역 설정(git-lfs 등)은 그대로 쓴다.

use parking_lot::{Mutex, RwLock};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::SystemTime;

/// 믿는 저장소(공유 git 폴더의 실제 경로 = 저장소 id)
static TRUSTED: LazyLock<RwLock<HashSet<String>>> = LazyLock::new(Default::default);
/// git 폴더(워크트리마다)별로 읽어 둔 결과. 설정 파일·훅 폴더의 수정 시각이 같으면 다시 읽지 않는다.
static SCANNED: LazyLock<Mutex<HashMap<PathBuf, Scanned>>> = LazyLock::new(Default::default);

type Stamp = [Option<SystemTime>; 4];
type Scanned = (Stamp, Arc<Risk>);

#[derive(Default)]
struct Risk {
    /// 화면에 보여 줄 항목(`키 = 값`, `hooks/이름`)
    items: Vec<String>,
    /// 끄는 `-c` 설정
    overrides: Vec<String>,
    /// 다른 파일을 끌어오는 설정(include)이 있다: 그 파일이 바뀌어도 알 수 없어 매번 다시 읽는다
    volatile: bool,
}

pub fn set_trusted(ids: Vec<String>) {
    *TRUSTED.write() = ids.into_iter().collect();
}

pub fn trusted_ids() -> Vec<String> {
    let mut v: Vec<String> = TRUSTED.read().iter().cloned().collect();
    v.sort();
    v
}

/// 경로가 속한 저장소를 믿는다. 저장소 id 를 돌려준다.
pub fn trust(cwd: &Path) -> Option<String> {
    let (_, common) = git_dirs(cwd)?;
    let id = common.to_string_lossy().into_owned();
    TRUSTED.write().insert(id.clone());
    Some(id)
}

/// 믿지 않은 저장소에서 꺼 둔 항목. 믿었거나 없으면 빈 목록.
pub fn untrusted_items(cwd: &Path) -> Vec<String> {
    match untrusted_risk(cwd) {
        Some(r) => r.items.clone(),
        None => Vec::new(),
    }
}

/// git 실행에 붙일 `-c` 인자(믿지 않은 저장소에서 실행 명령을 끈다)
pub(crate) fn overrides(cwd: &Path) -> Vec<String> {
    match untrusted_risk(cwd) {
        Some(r) => r.overrides.iter().flat_map(|o| ["-c".to_string(), o.clone()]).collect(),
        None => Vec::new(),
    }
}

fn untrusted_risk(cwd: &Path) -> Option<Arc<Risk>> {
    let (git_dir, common) = git_dirs(cwd)?;
    if TRUSTED.read().contains(common.to_string_lossy().as_ref()) {
        return None;
    }
    let stamp = stamp(&git_dir, &common);
    if let Some((s, r)) = SCANNED.lock().get(&git_dir)
        && *s == stamp
    {
        return Some(r.clone());
    }
    let risk = Arc::new(scan(cwd, &common));
    if !risk.volatile {
        SCANNED.lock().insert(git_dir, (stamp, risk.clone()));
    }
    Some(risk)
}

/// 경로가 속한 저장소의 (git 폴더, 공유 git 폴더) 실제 경로. git 을 부르지 않고 `.git` 을 찾아 올라간다(git 호출마다 불린다).
fn git_dirs(start: &Path) -> Option<(PathBuf, PathBuf)> {
    for dir in start.ancestors() {
        let dot = dir.join(".git");
        let Ok(meta) = std::fs::metadata(&dot) else { continue };
        let git_dir = if meta.is_dir() {
            dot
        } else {
            // 링크 워크트리·서브모듈: "gitdir: <경로>"
            let text = std::fs::read_to_string(&dot).ok()?;
            dir.join(text.trim().strip_prefix("gitdir:")?.trim())
        };
        let common = match std::fs::read_to_string(git_dir.join("commondir")) {
            Ok(c) => git_dir.join(c.trim()),
            Err(_) => git_dir.clone(),
        };
        return Some((std::fs::canonicalize(&git_dir).ok()?, std::fs::canonicalize(&common).ok()?));
    }
    None
}

fn stamp(git_dir: &Path, common: &Path) -> Stamp {
    let m = |p: PathBuf| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    [m(common.join("config")), m(git_dir.join("config.worktree")), m(common.join("config.worktree")), m(common.join("hooks"))]
}

fn scan(cwd: &Path, common: &Path) -> Risk {
    let mut risk = Risk::default();
    let mut hooks_off = false;
    // `git config --list` 자체는 아무것도 실행하지 않는다. -z: "범위\0키\n값\0"
    if let Ok(out) = crate::git::run_cmd(crate::git::base_command(cwd), &["config", "--list", "--show-scope", "-z"], None, crate::git::READ_TIMEOUT)
        && out.code == 0
    {
        let parts: Vec<&[u8]> = out.stdout.split(|b| *b == 0).collect();
        for pair in parts.chunks(2) {
            let [scope, kv] = pair else { continue };
            if !matches!(*scope, b"local" | b"worktree") {
                continue;
            }
            let kv = String::from_utf8_lossy(kv);
            let (key, value) = kv.split_once('\n').unwrap_or((&kv, ""));
            let Some(off) = neutralize(key) else { continue };
            if key.starts_with("include") {
                risk.volatile = true;
            }
            hooks_off |= key == "core.hookspath";
            risk.items.push(format!("{key} = {}", shorten(value)));
            for o in off {
                if !risk.overrides.contains(&o) {
                    risk.overrides.push(o);
                }
            }
        }
    }
    // 설정 없이 .git/hooks 에 넣어 둔 훅
    if let Ok(entries) = std::fs::read_dir(common.join("hooks")) {
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|e| {
                use std::os::unix::fs::PermissionsExt;
                let name = e.file_name().to_string_lossy().into_owned();
                !name.ends_with(".sample") && e.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            })
            .map(|e| format!("hooks/{}", e.file_name().to_string_lossy()))
            .collect();
        names.sort();
        if !names.is_empty() && !hooks_off {
            risk.overrides.push("core.hooksPath=/dev/null".into());
        }
        risk.items.extend(names);
    }
    risk
}

/// git 이 프로그램을 실행하게 하는 설정이면 그것을 끄는 `-c` 값들. 키는 git 이 소문자로 준다(서브섹션만 그대로).
fn neutralize(key: &str) -> Option<Vec<String>> {
    let (section, rest) = key.split_once('.')?;
    let (sub, var) = match rest.rsplit_once('.') {
        Some((s, v)) => (Some(s), v),
        None => (None, rest),
    };
    let set = |v: &str| vec![format!("{key}={v}")];
    Some(match (section, sub, var) {
        ("filter", Some(name), "clean" | "smudge" | "process") => vec![format!("{key}="), format!("filter.{name}.required=false")],
        ("core", None, "hookspath") => set("/dev/null"),
        ("core", None, "sshcommand") => set("ssh"),
        ("core", None, "askpass") => set(""),
        ("gpg", None | Some("openpgp"), "program") => set("gpg"),
        ("gpg", Some("x509"), "program") => set("gpgsm"),
        ("gpg", Some("ssh"), "program") => set("ssh-keygen"),
        ("credential", _, "helper") => set(""),
        ("diff", Some(_), "command" | "textconv") => set(""),
        ("merge", Some(_), "driver") => set("false"),
        ("remote", Some(_), "uploadpack") => set("git-upload-pack"),
        ("remote", Some(_), "receivepack") => set("git-receive-pack"),
        // ext:: 주소는 명령을 실행한다. protocol.allow 로 열어 두었어도 ext 만은 닫는다.
        ("protocol", _, "allow") => vec!["protocol.ext.allow=never".into()],
        // 끌어오는 파일의 항목은 위에서 함께 걸러진다(범위가 local 로 나온다)
        ("include", None, "path") | ("includeif", Some(_), "path") => Vec::new(),
        _ => return None,
    })
}

fn shorten(v: &str) -> String {
    let v = v.replace('\n', " ");
    if v.chars().count() > 120 { format!("{}…", v.chars().take(120).collect::<String>()) } else { v }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).current_dir(dir).status().unwrap();
        assert!(ok.success(), "{args:?}");
    }

    #[test]
    fn filters_and_hooks_of_untrusted_repos_do_not_run() {
        let _g = crate::env::TEST_ENV_LOCK.lock();
        let d = tempfile::tempdir().unwrap();
        let repo = d.path().join("r");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        std::fs::write(repo.join("a.txt"), "hi\n").unwrap();
        std::fs::write(repo.join(".gitattributes"), "* filter=x\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "a"]);
        let pwned = d.path().join("PWNED");
        git(&repo, &["config", "filter.x.clean", &format!("touch {}; cat", pwned.display())]);
        git(&repo, &["config", "filter.x.required", "true"]);
        // 끌어오는 설정 파일 속 항목도 잡는다
        std::fs::write(repo.join(".git/extra.cfg"), "[core]\n\tsshCommand = evil-ssh\n").unwrap();
        git(&repo, &["config", "include.path", "extra.cfg"]);
        let hook = repo.join(".git/hooks/post-checkout");
        std::fs::write(&hook, format!("#!/bin/sh\ntouch {}\n", pwned.display())).unwrap();
        std::fs::set_permissions(&hook, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let sub = repo.join("sub");
        std::fs::create_dir(&sub).unwrap();

        set_trusted(Vec::new());
        let items = untrusted_items(&sub);
        assert!(items.iter().any(|i| i.starts_with("filter.x.clean = touch")), "{items:?}");
        assert!(items.iter().any(|i| i == "core.sshcommand = evil-ssh"), "{items:?}");
        assert!(items.iter().any(|i| i == "hooks/post-checkout"), "{items:?}");
        assert!(!items.iter().any(|i| i.contains(".sample")), "{items:?}");

        // 디스크 정보가 바뀐 파일을 status 가 다시 읽어도(clean 필터) 실행되지 않고, 브랜치를 바꿔도 훅이 돌지 않는다
        let bump = || std::fs::write(repo.join("a.txt"), "hi\n").unwrap();
        bump();
        let out = crate::git::run_raw(&repo, &["status", "--porcelain"], None, crate::git::READ_TIMEOUT).unwrap();
        assert_eq!(out.code, 0, "{}", out.stderr);
        crate::git::run_raw(&repo, &["checkout", "-q", "-b", "other"], None, crate::git::READ_TIMEOUT).unwrap();
        assert!(!pwned.exists(), "믿기 전에는 실행되지 않는다");

        // 믿으면 원래대로
        assert_eq!(trust(&sub).as_deref(), Some(std::fs::canonicalize(repo.join(".git")).unwrap().to_str().unwrap()));
        assert!(untrusted_items(&repo).is_empty());
        std::thread::sleep(std::time::Duration::from_millis(1100));
        bump();
        crate::git::run_raw(&repo, &["status", "--porcelain"], None, crate::git::READ_TIMEOUT).unwrap();
        assert!(pwned.exists(), "믿은 저장소는 설정대로");
        set_trusted(Vec::new());
    }

    #[test]
    fn plain_repos_have_nothing_to_turn_off() {
        let _g = crate::env::TEST_ENV_LOCK.lock();
        let d = tempfile::tempdir().unwrap();
        git(d.path(), &["init", "-q"]);
        git(d.path(), &["config", "user.name", "someone"]);
        set_trusted(Vec::new());
        assert!(untrusted_items(d.path()).is_empty());
        assert!(overrides(d.path()).is_empty());
        assert!(untrusted_items(Path::new("/")).is_empty());
    }
}
