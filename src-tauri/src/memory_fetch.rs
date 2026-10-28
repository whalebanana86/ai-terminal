//! 작업 기억에 쓰는 모델과 ONNX Runtime 내려받기. 주소와 SHA-256 을 고정하고, 맞을 때만 쓴다.
//! 받은 파일: `<기억 폴더>/runtime/libonnxruntime.dylib`, `<기억 폴더>/model/*`.

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const MODEL_FILE: &str = "model_quantized.onnx";
pub const TOKENIZER_FILE: &str = "tokenizer.json";
pub const RUNTIME_FILE: &str = "libonnxruntime.dylib";
/// 모델이 바뀌면 저장한 벡터를 버리고 다시 만든다
pub const MODEL_ID: &str = "embeddinggemma-2-int8@daa72c5-256";

const HF: &str = "https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0";
const ORT_URL: &str = "https://github.com/microsoft/onnxruntime/releases/download/v1.31.1/onnxruntime-osx-arm64-1.31.1.tgz";
const ORT_MEMBER: &str = "onnxruntime-osx-arm64-1.31.1/lib/libonnxruntime.1.31.1.dylib";

struct Asset {
    url: &'static str,
    /// 기억 폴더 안 경로
    dest: &'static str,
    sha256: &'static str,
    size: u64,
}

const MODEL_ASSETS: [Asset; 3] = [
    Asset { url: "onnx/model_quantized.onnx", dest: "model/model_quantized.onnx", sha256: "d06edd601f851c633a2519304cbeb8dc6170d7ceb61b436625c17fb9b6e74953", size: 495_165 },
    Asset { url: "onnx/model_quantized.onnx_data", dest: "model/model_quantized.onnx_data", sha256: "278a7ff1248c3618e4bd11a607fc54f7bdc7778854230f3956d3f86bd9db4f3b", size: 313_724_928 },
    Asset { url: "tokenizer.json", dest: "model/tokenizer.json", sha256: "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4", size: 32_170_510 },
];
const ORT_TGZ: Asset = Asset { url: ORT_URL, dest: "runtime/onnxruntime.tgz", sha256: "2e1344a1926ee50eb25b38153cb6992c3567515aef0e677a1a520a1798896d6f", size: 36_936_435 };
const ORT_DYLIB_SHA256: &str = "17500d6b1e37e70f43a2c57d94233a1bc29fbcb297be0a5f8c7c13184f3307ba";
const ORT_DYLIB_SIZE: u64 = 44_797_256;

/// 모두 받으면 쓰는 표시 파일(내용 = MODEL_ID)
const READY: &str = "assets.ready";

pub fn runtime_path(dir: &Path) -> PathBuf {
    dir.join("runtime").join(RUNTIME_FILE)
}

pub fn model_dir(dir: &Path) -> PathBuf {
    dir.join("model")
}

/// 내려받을 전체 크기(바이트)
pub fn total_bytes() -> u64 {
    MODEL_ASSETS.iter().map(|a| a.size).sum::<u64>() + ORT_TGZ.size
}

/// 다 받아서 확인을 마쳤는지(크기까지만 다시 본다 — 해시는 받을 때 확인했다)
pub fn ready(dir: &Path) -> bool {
    let size_ok = |p: PathBuf, n: u64| std::fs::metadata(p).is_ok_and(|m| m.len() == n);
    std::fs::read_to_string(dir.join(READY)).is_ok_and(|s| s.trim() == MODEL_ID)
        && MODEL_ASSETS.iter().all(|a| size_ok(dir.join(a.dest), a.size))
        && size_ok(runtime_path(dir), ORT_DYLIB_SIZE)
}

/// 받은 모델·라이브러리를 지운다
pub fn remove(dir: &Path) -> Result<()> {
    let _ = std::fs::remove_file(dir.join(READY));
    for d in ["model", "runtime"] {
        match std::fs::remove_dir_all(dir.join(d)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
    }
    Ok(())
}

fn sha256_file(p: &Path) -> Result<String> {
    let mut f = std::fs::File::open(p)?;
    let mut h = Sha256::new();
    std::io::copy(&mut f, &mut h)?;
    Ok(format!("{:x}", h.finalize()))
}

/// 모두 받는다. progress(받은 바이트, 전체 바이트). 이미 받은 파일은 건너뛰고, 끊긴 파일은 이어받는다.
pub async fn fetch_all(dir: &Path, progress: impl Fn(u64, u64) + Send + Sync) -> Result<()> {
    if ready(dir) {
        return Ok(());
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .user_agent(concat!("Code-Whereabouts/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .build()?;
    let total = total_bytes();
    let mut done = 0u64;
    for a in &MODEL_ASSETS {
        let url = format!("{HF}/{}", a.url);
        fetch_one(&client, &url, a, dir, |n| progress(done + n, total)).await?;
        done += a.size;
    }
    if !std::fs::metadata(runtime_path(dir)).is_ok_and(|m| m.len() == ORT_DYLIB_SIZE) {
        fetch_one(&client, ORT_TGZ.url, &ORT_TGZ, dir, |n| progress(done + n, total)).await?;
        extract_runtime(dir)?;
    }
    progress(total, total);
    std::fs::write(dir.join(READY), MODEL_ID)?;
    Ok(())
}

async fn fetch_one(client: &reqwest::Client, url: &str, a: &Asset, dir: &Path, progress: impl Fn(u64)) -> Result<()> {
    let dest = dir.join(a.dest);
    if std::fs::metadata(&dest).is_ok_and(|m| m.len() == a.size) {
        return Ok(());
    }
    std::fs::create_dir_all(dest.parent().unwrap_or(dir))?;
    let part = dest.with_extension("part");
    let mut have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if have > a.size {
        std::fs::remove_file(&part)?;
        have = 0;
    }
    let mut req = client.get(url);
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let mut res = req.send().await.with_context(|| tr!("내려받기를 시작하지 못했습니다: {url}", "Couldn't start the download: {url}"))?;
    let status = res.status();
    let append = status == reqwest::StatusCode::PARTIAL_CONTENT && have > 0;
    if !status.is_success() {
        bail!(tr!("내려받기 실패 ({status}): {url}", "Download failed ({status}): {url}"));
    }
    if !append {
        have = 0;
    }
    let mut file = std::fs::OpenOptions::new().create(true).write(true).append(append).truncate(!append).open(&part)?;
    let mut got = have;
    let mut last = std::time::Instant::now();
    while let Some(chunk) = res.chunk().await.with_context(|| tr!("내려받는 중 끊겼습니다(다시 받으면 이어서 받아요): {url}", "The download was interrupted (downloading again resumes it): {url}"))? {
        file.write_all(&chunk)?;
        got += chunk.len() as u64;
        if got > a.size {
            bail!(tr!("받은 크기가 예상보다 큽니다: {url}", "The download is larger than expected: {url}"));
        }
        if last.elapsed() > Duration::from_millis(250) {
            progress(got);
            last = std::time::Instant::now();
        }
    }
    file.flush()?;
    drop(file);
    if got != a.size {
        bail!(tr!("다 받지 못했습니다({got}/{} 바이트): {url}", "The download is incomplete ({got}/{} bytes): {url}", a.size));
    }
    let sum = sha256_file(&part)?;
    if sum != a.sha256 {
        let _ = std::fs::remove_file(&part);
        bail!(tr!("받은 파일의 체크섬이 맞지 않아 버렸습니다: {url}", "The downloaded file failed the checksum and was discarded: {url}"));
    }
    std::fs::rename(&part, &dest)?;
    progress(a.size);
    Ok(())
}

/// tgz 에서 dylib 하나만 꺼내 확인한다
fn extract_runtime(dir: &Path) -> Result<()> {
    let tgz = dir.join(ORT_TGZ.dest);
    let tmp = dir.join("runtime").join("extract");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp)?;
    let st = std::process::Command::new("/usr/bin/tar")
        .arg("-xzf")
        .arg(&tgz)
        .arg("-C")
        .arg(&tmp)
        .arg(ORT_MEMBER)
        .status()
        .context("tar 실행")?;
    if !st.success() {
        bail!(tr!("ONNX Runtime 압축을 풀지 못했습니다", "Couldn't unpack ONNX Runtime"));
    }
    let lib = tmp.join(ORT_MEMBER);
    if sha256_file(&lib)? != ORT_DYLIB_SHA256 {
        bail!(tr!("ONNX Runtime 라이브러리의 체크섬이 맞지 않습니다", "The ONNX Runtime library failed the checksum"));
    }
    std::fs::rename(&lib, runtime_path(dir))?;
    let _ = std::fs::remove_dir_all(&tmp);
    let _ = std::fs::remove_file(&tgz);
    Ok(())
}

/// 모델·라이브러리가 차지하는 크기
pub fn bytes_on_disk(dir: &Path) -> u64 {
    fn walk(p: &Path) -> u64 {
        match std::fs::symlink_metadata(p) {
            Ok(m) if m.is_dir() => std::fs::read_dir(p).map(|rd| rd.flatten().map(|e| walk(&e.path())).sum()).unwrap_or(0),
            Ok(m) => m.len(),
            Err(_) => 0,
        }
    }
    walk(&dir.join("model")) + walk(&dir.join("runtime"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_ready_until_marker_and_sizes_match() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!ready(tmp.path()));
        std::fs::write(tmp.path().join(READY), MODEL_ID).unwrap();
        // 표시 파일만 있고 파일이 없으면 아니다
        assert!(!ready(tmp.path()));
        assert_eq!(total_bytes(), 495_165 + 313_724_928 + 32_170_510 + 36_936_435);
        remove(tmp.path()).unwrap();
        assert!(!tmp.path().join(READY).exists());
    }
}
