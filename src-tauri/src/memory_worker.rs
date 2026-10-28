//! 작업 기억의 임베딩 도우미 프로세스. 앱 실행 파일을 `--memory-worker <ONNX Runtime> <모델 폴더>` 로 다시 띄운다.
//! 모델을 불러오면 메모리를 수백 MB 쓰므로 앱 본체가 아니라 여기서 돌리고, 일이 없으면 앱이 끝낸다(메모리를 돌려준다).
//! 주고받기: 표준 입력으로 `{"texts":[…],"query":bool}` 한 줄, 표준 출력으로 `{"vectors":[[…]]}` 또는 `{"error":…}` 한 줄.

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

const WORKER_ARG: &str = "--memory-worker";
/// 저장하는 차원(MRL 로 앞부분만 남기고 다시 정규화)
pub const DIM: usize = 256;
const QUERY_PREFIX: &str = "task: search result | query: ";
const DOC_PREFIX: &str = "title: none | text: ";
const MAX_TOKENS: usize = 512;
/// 백그라운드에서 천천히: 사용자 작업을 방해하지 않게 스레드를 줄인다
const THREADS: usize = 2;

#[derive(Serialize, Deserialize)]
struct Request {
    texts: Vec<String>,
    query: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct Response {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ready: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    vectors: Vec<Vec<f32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ───────────── 도우미 프로세스 쪽 ─────────────

/// `--memory-worker` 로 실행됐으면 도우미로 돌고 종료 코드를 돌려준다.
pub fn worker_from_args() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next()? != WORKER_ARG {
        return None;
    }
    let runtime = PathBuf::from(args.next()?);
    // 앱의 화면 언어를 따라 오류를 쓴다
    crate::i18n::set_english(std::env::var("AITERM_LANG").as_deref() == Ok("en"));
    let model = PathBuf::from(args.next()?);
    let mut out = std::io::stdout().lock();
    let mut send = |r: &Response| {
        let _ = serde_json::to_writer(&mut out, r);
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    };
    let mut emb = match Embedder::load(&runtime, &model) {
        Ok(e) => e,
        Err(e) => {
            send(&Response { error: Some(format!("{e:#}")), ..Default::default() });
            return Some(1);
        }
    };
    send(&Response { ready: Some(true), ..Default::default() });
    // 앱이 입력을 닫으면(끝낼 때) 끝난다
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let r = match serde_json::from_str::<Request>(&line) {
            Ok(req) => match emb.embed(&req.texts, req.query) {
                Ok(vectors) => Response { vectors, ..Default::default() },
                Err(e) => Response { error: Some(format!("{e:#}")), ..Default::default() },
            },
            Err(e) => Response { error: Some(e.to_string()), ..Default::default() },
        };
        send(&r);
    }
    Some(0)
}

struct Embedder {
    session: ort::session::Session,
    tok: tokenizers::Tokenizer,
    pad_id: i64,
    /// 텍스트만 쓸 때도 빈 값으로 채워야 하는 이미지·영상·소리 입력(멀티모달 모델)
    extra: Vec<String>,
    _env: ort::environment::Environment,
}

impl Embedder {
    fn load(runtime: &Path, model: &Path) -> Result<Self> {
        let env = ort::init_from(runtime)
            .map_err(|e| anyhow!(tr!("ONNX Runtime 을 불러오지 못했습니다: {e}", "Couldn't load ONNX Runtime: {e}")))?
            .with_name("aiterm-memory")
            .build()?;
        let mut builder = ort::session::Session::builder(&env)?
            // ort 는 기본으로 '전력 효율 우선' 장치를 고른다(Apple 칩에선 Core ML). 양자화 모델은 CPU 가 훨씬 빠르다.
            .with_auto_device(ort::session::builder::AutoDevicePolicy::PreferCPU)
            .map_err(|e| anyhow!("{e}"))?
            .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
            .map_err(|e| anyhow!("{e}"))?
            .with_intra_threads(THREADS)
            .map_err(|e| anyhow!("{e}"))?;
        let session = builder.commit_from_file(model.join(crate::memory_fetch::MODEL_FILE)).with_context(|| tr!("임베딩 모델을 열지 못했습니다", "Couldn't open the embedding model"))?;
        if !session.outputs().iter().any(|o| o.name() == "sentence_embedding") {
            bail!("임베딩 모델에 sentence_embedding 출력이 없습니다");
        }
        let mut tok = tokenizers::Tokenizer::from_file(model.join(crate::memory_fetch::TOKENIZER_FILE)).map_err(|e| anyhow!("{e}"))?;
        tok.with_truncation(Some(tokenizers::TruncationParams { max_length: MAX_TOKENS, ..Default::default() }))
            .map_err(|e| anyhow!("{e}"))?;
        let pad_id = tok.token_to_id("<pad>").unwrap_or(0) as i64;
        let extra = session.inputs().iter().map(|i| i.name().to_string()).filter(|n| n.ends_with("_features")).collect();
        Ok(Self { session, tok, pad_id, extra, _env: env })
    }

    fn embed(&mut self, texts: &[String], query: bool) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let prefix = if query { QUERY_PREFIX } else { DOC_PREFIX };
        let inputs: Vec<String> = texts.iter().map(|t| format!("{prefix}{t}")).collect();
        let enc = self.tok.encode_batch(inputs, true).map_err(|e| anyhow!("{e}"))?;
        let len = enc.iter().map(|e| e.get_ids().len()).max().unwrap_or(1).max(1);
        let mut ids = Vec::with_capacity(texts.len() * len);
        let mut mask = Vec::with_capacity(texts.len() * len);
        for e in &enc {
            let n = e.get_ids().len();
            ids.extend(e.get_ids().iter().map(|&x| x as i64));
            ids.extend(std::iter::repeat_n(self.pad_id, len - n));
            mask.extend(std::iter::repeat_n(1i64, n));
            mask.extend(std::iter::repeat_n(0i64, len - n));
        }
        let shape = [texts.len(), len];
        let mut feed: Vec<(std::borrow::Cow<str>, ort::session::SessionInputValue)> = ort::inputs![
            "input_ids" => ort::value::Tensor::from_array((shape, ids))?,
            "attention_mask" => ort::value::Tensor::from_array((shape, mask))?,
        ];
        for name in &self.extra {
            feed.push((name.clone().into(), ort::value::Tensor::from_array(([0usize, 512], Vec::<f32>::new()))?.into()));
        }
        let out = self.session.run(feed)?;
        let (shape, data) = out["sentence_embedding"].try_extract_tensor::<f32>()?;
        let dim = shape[1] as usize;
        if dim < DIM {
            bail!("임베딩 차원이 너무 작습니다: {dim}");
        }
        Ok(data.chunks(dim).map(|v| normalize(&v[..DIM])).collect())
    }
}

pub fn normalize(v: &[f32]) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
    v.iter().map(|x| x / n).collect()
}

// ───────────── 앱 쪽 ─────────────

/// 앱이 띄운 도우미 프로세스. 버리면(drop) 프로세스를 끝낸다.
pub struct WorkerClient {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    pub last_used: std::time::Instant,
}

impl WorkerClient {
    pub fn spawn(runtime: &Path, model: &Path, log: &Path) -> Result<Self> {
        let exe = std::env::current_exe().context("앱 실행 파일 위치")?;
        let log = std::fs::File::create(log).context("도우미 로그 파일")?;
        let mut child = Command::new(exe)
            .arg(WORKER_ARG)
            .arg(runtime)
            .arg(model)
            .env("AITERM_LANG", if crate::i18n::is_en() { "en" } else { "ko" })
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(log))
            .spawn()
            .with_context(|| tr!("임베딩 도우미를 띄우지 못했습니다", "Couldn't start the embedding helper"))?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("도우미 입력 없음"))?;
        let stdout = BufReader::new(child.stdout.take().ok_or_else(|| anyhow!("도우미 출력 없음"))?);
        let mut w = Self { child, stdin, stdout, last_used: std::time::Instant::now() };
        let r = w.read()?;
        if r.ready != Some(true) {
            bail!(r.error.unwrap_or_else(|| "도우미가 준비되지 않았습니다".into()));
        }
        Ok(w)
    }

    fn read(&mut self) -> Result<Response> {
        let mut line = String::new();
        if self.stdout.read_line(&mut line)? == 0 {
            bail!(tr!("임베딩 도우미가 끝났습니다", "The embedding helper exited"));
        }
        Ok(serde_json::from_str(&line)?)
    }

    /// 정규화된 DIM 차원 벡터들
    pub fn embed(&mut self, texts: &[String], query: bool) -> Result<Vec<Vec<f32>>> {
        self.last_used = std::time::Instant::now();
        serde_json::to_writer(&mut self.stdin, &Request { texts: texts.to_vec(), query })?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()?;
        let r = self.read()?;
        if let Some(e) = r.error {
            bail!(e);
        }
        if r.vectors.len() != texts.len() {
            bail!("임베딩 개수가 맞지 않습니다");
        }
        Ok(r.vectors)
    }
}

impl Drop for WorkerClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
