//! md 를 브라우저로 열기. 크롬은 인코딩 표시가 없는 md(UTF-8)를 한국어 설정에서 EUC-KR 로 읽어 한글이 깨진다 →
//! 화면이 그린(걸러진) 본문을 우리 틀(`<meta charset="utf-8">`·CSP)에 넣어
//! 캐시 폴더에 HTML 로 쓰고 설정에서 고른 브라우저(처음엔 맥 기본 브라우저)로 연다. 원본 md 는 건드리지 않는다.

use anyhow::{bail, Result};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// 화면이 넘기는 본문 크기 상한(md 원문은 1MB 까지만 읽으니 넉넉하다)
pub const MAX_BODY_BYTES: usize = 20 * 1024 * 1024;

pub fn is_markdown(rel: &str) -> bool {
    Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| ["md", "markdown", "mdown", "mkd"].contains(&e.to_ascii_lowercase().as_str()))
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// 브라우저로 열 문서. 본문은 화면에서 이미 걸렀지만 CSP 로 스크립트를 한 번 더 막는다(그림은 파일·data·https 만).
/// 저장소 안 그림·링크는 화면이 원래 파일의 file:// 주소로 바꿔 넘긴다(`<base>` 는 "#제목" 링크를 망가뜨려 안 씀).
pub fn page(md_path: &Path, body: &str) -> String {
    let title = escape_html(&md_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
    format!(
        "<!doctype html>\n<html><head><meta charset=\"utf-8\">\n\
         <meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src file: data: https:; style-src 'unsafe-inline'\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{title}</title>\n<style>{CSS}</style>\n</head>\n\
         <body><main class=\"md\">\n{body}\n</main></body></html>\n"
    )
}

/// 워크트리 안 md 의 브라우저용 HTML 을 cache_root/md-preview/ 에 쓰고 그 경로를 돌려준다. 같은 md 는 같은 파일을 덮어쓴다.
pub fn write_page(cache_root: &Path, worktree: &Path, rel: &str, body: &str) -> Result<PathBuf> {
    if !is_markdown(rel) {
        bail!(tr!("md 파일이 아닙니다: {rel}", "Not a Markdown file: {rel}"));
    }
    if body.len() > MAX_BODY_BYTES {
        bail!(tr!("문서가 너무 큽니다", "The document is too large"));
    }
    let p = crate::files::resolve_inside(worktree, rel)?;
    if !p.is_file() {
        bail!(tr!("일반 파일이 아니라 열 수 없습니다", "Not a regular file, so it can't be opened"));
    }
    let dir = cache_root.join("md-preview");
    std::fs::create_dir_all(&dir)?;
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let stem: String = stem.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).take(60).collect();
    let hash = Sha256::digest(p.as_os_str().as_encoded_bytes());
    let out = dir.join(format!("{stem}-{:02x}{:02x}{:02x}{:02x}.html", hash[0], hash[1], hash[2], hash[3]));
    std::fs::write(&out, page(&p, body))?;
    Ok(out)
}

/// 고를 수 있는 브라우저 (id, 앱 이름). 화면은 이 안에서만 고른다(임의의 앱을 띄우지 못하게).
const KNOWN: &[(&str, &str)] = &[
    ("chrome", "Google Chrome"),
    ("safari", "Safari"),
    ("whale", "Naver Whale"),
    ("edge", "Microsoft Edge"),
    ("arc", "Arc"),
    ("brave", "Brave Browser"),
    ("firefox", "Firefox"),
];

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Browsers {
    /// 맥의 기본 브라우저 이름(https 를 여는 앱). 못 찾으면 None
    pub default_name: Option<String>,
    pub installed: Vec<crate::editors::EditorApp>,
}

pub fn browsers() -> Browsers {
    let default_name = default_browser().and_then(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()));
    let installed = KNOWN
        .iter()
        .filter(|(_, n)| crate::editors::app_path(n).is_some())
        .map(|(id, n)| crate::editors::EditorApp { id: id.to_string(), name: n.to_string() })
        .collect();
    Browsers { default_name, installed }
}

/// https 주소를 여는 앱(기본 브라우저). .html 의 기본 앱은 편집기일 수 있어 브라우저를 따로 찾는다.
fn default_browser() -> Option<PathBuf> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};
    let probe = NSURL::URLWithString(&NSString::from_str("https://example.com/"))?;
    let app = NSWorkspace::sharedWorkspace().URLForApplicationToOpenURL(&probe)?;
    app.path().map(|p| PathBuf::from(p.to_string()))
}

/// `open` 앞쪽 인자: id = "default"(기본 브라우저) 또는 KNOWN 의 id. 기본 브라우저를 못 찾으면 맥이 고른다(빈 인자).
fn browser_args(id: &str) -> Result<Vec<std::ffi::OsString>> {
    let app = match id {
        "default" => default_browser(),
        _ => match KNOWN.iter().find(|(k, _)| *k == id) {
            Some((_, n)) => Some(crate::editors::app_path(n).ok_or_else(|| anyhow::anyhow!(tr!("{n} 이(가) 설치되어 있지 않습니다", "{n} isn't installed")))?),
            None => bail!(tr!("모르는 브라우저입니다: {id}", "Unknown browser: {id}")),
        },
    };
    Ok(match app {
        Some(a) => vec!["-a".into(), a.into_os_string()],
        None => vec![],
    })
}

/// md 의 브라우저용 HTML 을 쓰고 고른 브라우저로 연다. 고른 브라우저부터 확인한다(모르는 것이면 아무것도 쓰지 않음).
pub fn open_markdown(cache_root: &Path, worktree: &Path, rel: &str, body: &str, browser: &str) -> Result<PathBuf> {
    let mut args = browser_args(browser)?;
    let html = write_page(cache_root, worktree, rel, body)?;
    args.push(html.as_os_str().to_owned());
    crate::env::spawn_reaped(std::process::Command::new("/usr/bin/open").args(args))?;
    Ok(html)
}

/// md 미리보기의 바깥 링크를 연다: http·https 는 고른 브라우저로, mailto 는 맥 기본 메일 앱으로. 다른 주소는 거부.
pub fn open_url(url: &str, browser: &str) -> Result<()> {
    let u = tauri::Url::parse(url).map_err(|_| anyhow::anyhow!(tr!("주소가 올바르지 않습니다", "Invalid address")))?;
    let mut args = match u.scheme() {
        "http" | "https" => browser_args(browser)?,
        "mailto" => vec![],
        other => bail!(tr!("열 수 없는 주소입니다: {other}", "Can't open this address: {other}")),
    };
    args.push(u.as_str().into());
    crate::env::spawn_reaped(std::process::Command::new("/usr/bin/open").args(args))?;
    Ok(())
}

const CSS: &str = r#"
:root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --bg: #ffffff; --code: #f6f8fa; --link: #0969da; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --bg: #0d1117; --code: #151b23; --link: #4493f8; } }
html { background: var(--bg); }
body { margin: 0; color: var(--fg); background: var(--bg); font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Segoe UI", sans-serif; }
.md { max-width: 880px; margin: 0 auto; padding: 32px 24px 64px; word-wrap: break-word; }
.md h1, .md h2 { padding-bottom: .3em; border-bottom: 1px solid var(--line); }
.md h1, .md h2, .md h3, .md h4 { margin: 1.5em 0 .6em; line-height: 1.25; }
.md a[href] { color: var(--link); text-decoration: none; } .md a[href]:hover { text-decoration: underline; }
.md code { font: 85%/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); padding: .2em .4em; border-radius: 6px; }
.md pre { background: var(--code); padding: 14px 16px; border-radius: 6px; overflow: auto; }
.md pre code { background: none; padding: 0; font-size: 13px; }
.md blockquote { margin: 0; padding: 0 1em; color: var(--muted); border-left: .25em solid var(--line); }
.md table { border-collapse: collapse; display: block; overflow: auto; }
.md th, .md td { border: 1px solid var(--line); padding: 6px 13px; }
.md tr:nth-child(2n) { background: var(--code); }
.md img { max-width: 100%; }
.md hr { border: 0; border-top: 1px solid var(--line); margin: 24px 0; }
.md li > input[type=checkbox] { margin-right: .4em; }
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_has_utf8_and_csp() {
        let html = page(Path::new("/tmp/저장소 a/docs/설명 \"서\".md"), "<h1>한글</h1>");
        assert!(html.contains("<meta charset=\"utf-8\">"));
        assert!(html.contains("default-src 'none'"), "스크립트는 CSP 로 막는다");
        assert!(!html.contains("<base"), "#제목 링크가 폴더로 가지 않게 base 는 안 쓴다");
        assert!(html.contains("<title>설명 &quot;서&quot;.md</title>"));
        assert!(html.contains("<h1>한글</h1>"));
        // charset 이 맨 앞(첫 1024바이트 안)
        assert!(html.find("charset").unwrap() < 100);
    }

    #[test]
    fn writes_only_markdown_inside_the_worktree() {
        let w = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        std::fs::create_dir(w.path().join("docs")).unwrap();
        std::fs::write(w.path().join("docs/안내.md"), "# 안내").unwrap();
        std::fs::write(w.path().join("a.txt"), "x").unwrap();
        let out = write_page(cache.path(), w.path(), "docs/안내.md", "<h1>안내</h1>").unwrap();
        assert!(out.starts_with(cache.path().join("md-preview")));
        assert!(out.file_name().unwrap().to_string_lossy().starts_with("안내-"));
        assert!(std::fs::read_to_string(&out).unwrap().contains("<h1>안내</h1>"));
        // 같은 md 는 같은 파일을 덮어쓴다
        assert_eq!(write_page(cache.path(), w.path(), "docs/안내.md", "<p>2</p>").unwrap(), out);
        assert!(write_page(cache.path(), w.path(), "a.txt", "").is_err(), "md 가 아니면 거부");
        assert!(write_page(cache.path(), w.path(), "../x.md", "").is_err(), "워크트리 밖 거부");
        assert!(write_page(cache.path(), w.path(), "none.md", "").is_err(), "없는 파일 거부");
        assert!(write_page(cache.path(), w.path(), "docs/안내.md", &"x".repeat(MAX_BODY_BYTES + 1)).is_err());
    }

    /// 이 맥의 기본 브라우저(https 를 여는 앱)를 찾는다. CI·다른 맥마다 다르므로 손으로만: cargo test -- --ignored default_browser
    #[test]
    #[ignore]
    fn finds_default_browser() {
        let app = default_browser().expect("기본 브라우저");
        eprintln!("기본 브라우저: {}", app.display());
        assert!(app.extension().is_some_and(|e| e == "app"));
    }

    #[test]
    fn opens_only_web_and_mail_links() {
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "x-apple.systempreferences:", "tauri://localhost", "not a url"] {
            assert!(open_url(bad, "default").is_err(), "{bad}");
        }
        assert!(open_url("https://example.com", "../../bin/sh").is_err(), "모르는 브라우저 거부");
    }

    /// 시험용: 화면이 만든 본문(MD_BODY 파일)을 틀에 넣어 MD_OUT 에 쓴다(헤드리스 크롬 확인용). MD_PATH = 원래 md 경로
    #[test]
    #[ignore]
    fn writes_page_for_manual_check() {
        let (Ok(md), Ok(body), Ok(out)) = (std::env::var("MD_PATH"), std::env::var("MD_BODY"), std::env::var("MD_OUT")) else { return };
        std::fs::write(out, page(Path::new(&md), &std::fs::read_to_string(body).unwrap())).unwrap();
    }

    #[test]
    fn unknown_browser_writes_nothing() {
        let w = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        std::fs::write(w.path().join("a.md"), "# a").unwrap();
        assert!(open_markdown(cache.path(), w.path(), "a.md", "<p>a</p>", "nope").is_err());
        assert!(!cache.path().join("md-preview").exists(), "고른 브라우저가 틀리면 파일도 안 쓴다");
    }

    #[test]
    fn browser_choice_is_limited_to_known_apps() {
        assert!(browser_args("/Applications/Calculator.app").is_err());
        assert!(browser_args("textedit").is_err(), "편집기 목록과 섞이지 않는다");
        assert!(browsers().installed.iter().all(|b| KNOWN.iter().any(|(k, _)| *k == b.id)));
    }
}
