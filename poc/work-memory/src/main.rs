//! 작업 기억 PoC: EmbeddingGemma 2(ONNX) + ONNX Runtime(실행 중에 불러오기) + SQLite FTS5 trigram + 전수 내적 + RRF.
//! 앱과 떨어진 시험 프로그램이다. 사용법은 README.md.
use anyhow::{Context, Result, anyhow, bail};
use ort::{
    ep,
    session::{Session, builder::GraphOptimizationLevel},
    value::Tensor,
};
use rusqlite::{Connection, params};
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    time::Instant,
};
use tokenizers::Tokenizer;

const QUERY_PREFIX: &str = "task: search result | query: ";
const DOC_PREFIX: &str = "title: none | text: ";

struct Opts {
    cmd: String,
    ort: PathBuf,
    model: PathBuf,
    variant: String,
    ep: String,
    threads: usize,
    data: PathBuf,
    db: PathBuf,
    batch: usize,
    n: usize,
    /// 메모리 아끼기: CPU arena·메모리 패턴 끄기
    lean: bool,
    max_tokens: usize,
    queries: String,
}

fn opts() -> Result<Opts> {
    let mut a = std::env::args().skip(1);
    let cmd = a.next().ok_or_else(|| anyhow!("명령: info | bench | index | eval | scan"))?;
    let mut kv = HashMap::new();
    while let Some(k) = a.next() {
        let k = k.trim_start_matches("--").to_string();
        kv.insert(k, a.next().ok_or_else(|| anyhow!("값 없음"))?);
    }
    let get = |k: &str, d: &str| kv.get(k).cloned().unwrap_or_else(|| d.to_string());
    let base = std::env::var("WM_DIR").unwrap_or_else(|_| ".".into());
    Ok(Opts {
        cmd,
        ort: PathBuf::from(get("ort", &format!("{base}/ort/onnxruntime-osx-arm64-1.31.1/lib/libonnxruntime.dylib"))),
        model: PathBuf::from(get("model", &format!("{base}/models/eg2"))),
        variant: get("variant", "q4"),
        ep: get("ep", "cpu"),
        threads: get("threads", "0").parse()?,
        data: PathBuf::from(get("data", &format!("{base}/data"))),
        db: PathBuf::from(get("db", &format!("{base}/data/index-q4.sqlite3"))),
        batch: get("batch", "16").parse()?,
        n: get("n", "100000").parse()?,
        lean: get("lean", "0") == "1",
        max_tokens: get("maxtok", "512").parse()?,
        queries: get("queries", "queries.jsonl"),
    })
}

fn peak_rss_mb() -> f64 {
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };
    ru.ru_maxrss as f64 / 1_048_576.0 // macOS 는 바이트 단위
}

struct Embedder {
    session: Session,
    tok: Tokenizer,
    out_name: String,
    pad_id: u32,
    /// 텍스트만 쓸 때도 빈 값으로 채워야 하는 이미지·영상·소리 입력
    extra: Vec<String>,
}

impl Embedder {
    fn load(o: &Opts, env: &ort::environment::Environment) -> Result<Self> {
        let file = match o.variant.as_str() {
            "q4" => "model_q4.onnx",
            "int8" => "model_quantized.onnx",
            // 이미지·영상·소리 입력을 빈 상수로 바꾼 텍스트 전용 구조(가중치 파일은 같음). Core ML 시험용
            "int8t" => "model_quantized_text.onnx",
            "q4t" => "model_q4_text.onnx",
            v => bail!("모르는 variant: {v}"),
        };
        let mut b = Session::builder(env)?.with_optimization_level(GraphOptimizationLevel::Level3).map_err(|e| anyhow!("{e}"))?;
        if o.threads > 0 {
            b = b.with_intra_threads(o.threads).map_err(|e| anyhow!("{e}"))?;
        }
        // ort 는 기본으로 '전력 효율 우선' 장치 선택을 켠다(Apple 칩에선 Core ML). CPU 시험은 CPU 우선으로 못 박는다.
        if o.ep == "cpu" {
            b = b.with_auto_device(ort::session::builder::AutoDevicePolicy::PreferCPU).map_err(|e| anyhow!("{e}"))?;
            if o.lean {
                b = b
                    .with_execution_providers([ep::CPU::default().with_arena_allocator(false).build()])
                    .map_err(|e| anyhow!("{e}"))?
                    .with_memory_pattern(false)
                    .map_err(|e| anyhow!("{e}"))?;
            }
        } else if o.ep == "coreml" {
            b = b
                .with_execution_providers([ep::CoreML::default().with_compute_units(ep::coreml::ComputeUnits::All).build().error_on_failure()])
                .map_err(|e| anyhow!("{e}"))?;
        }
        let session = b.commit_from_file(o.model.join("onnx").join(file)).context("모델 열기")?;
        let out_name = session
            .outputs()
            .iter()
            .map(|x| x.name().to_string())
            .find(|n| n == "sentence_embedding")
            .ok_or_else(|| anyhow!("sentence_embedding 출력이 없음"))?;
        let mut tok = Tokenizer::from_file(o.model.join("tokenizer.json")).map_err(|e| anyhow!("{e}"))?;
        tok.with_truncation(Some(tokenizers::TruncationParams { max_length: o.max_tokens, ..Default::default() })).map_err(|e| anyhow!("{e}"))?;
        let pad_id = tok.token_to_id("<pad>").unwrap_or(0);
        let extra = session.inputs().iter().map(|i| i.name().to_string()).filter(|n| n.ends_with("_features")).collect();
        Ok(Self { session, tok, out_name, pad_id, extra })
    }

    /// 정규화된 768차원 벡터들
    fn embed(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let enc = self.tok.encode_batch(texts.to_vec(), true).map_err(|e| anyhow!("{e}"))?;
        let len = enc.iter().map(|e| e.get_ids().len()).max().unwrap_or(1);
        let mut ids = Vec::with_capacity(texts.len() * len);
        let mut mask = Vec::with_capacity(texts.len() * len);
        for e in &enc {
            let n = e.get_ids().len();
            ids.extend(e.get_ids().iter().map(|&x| x as i64));
            ids.extend(std::iter::repeat_n(self.pad_id as i64, len - n));
            mask.extend(std::iter::repeat_n(1i64, n));
            mask.extend(std::iter::repeat_n(0i64, len - n));
        }
        let shape = [texts.len(), len];
        let ids = Tensor::from_array((shape, ids))?;
        let mask = Tensor::from_array((shape, mask))?;
        let mut inputs: Vec<(std::borrow::Cow<str>, ort::session::SessionInputValue)> = ort::inputs!["input_ids" => ids, "attention_mask" => mask];
        for name in &self.extra {
            inputs.push((name.clone().into(), Tensor::from_array(([0usize, 512], Vec::<f32>::new()))?.into()));
        }
        let out = self.session.run(inputs)?;
        let (shape, data) = out[self.out_name.as_str()].try_extract_tensor::<f32>()?;
        let dim = shape[1] as usize;
        Ok(data.chunks(dim).map(normalize).collect())
    }
}

fn normalize(v: &[f32]) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
    v.iter().map(|x| x / n).collect()
}

/// MRL: 앞 d 개만 남기고 다시 정규화
fn truncate(v: &[f32], d: usize) -> Vec<f32> {
    normalize(&v[..d])
}

fn quantize(v: &[f32]) -> Vec<i8> {
    v.iter().map(|x| (x * 127.0).round().clamp(-127.0, 127.0) as i8).collect()
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn dot_i8(a: &[i8], b: &[i8]) -> i32 {
    a.iter().zip(b).map(|(&x, &y)| x as i32 * y as i32).sum()
}

#[derive(Deserialize)]
struct Chunk {
    id: i64,
    turn: String,
    kind: String,
    text: String,
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(p: &Path) -> Result<Vec<T>> {
    std::fs::read_to_string(p)
        .with_context(|| p.display().to_string())?
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).map_err(Into::into))
        .collect()
}

fn init_ort(o: &Opts) -> Result<ort::environment::Environment> {
    let t = Instant::now();
    let env = ort::init_from(&o.ort).map_err(|e| anyhow!("ONNX Runtime 불러오기: {e}"))?.with_name("wm").build()?;
    eprintln!("ONNX Runtime 불러옴 {:?} ({} ms)", o.ort, t.elapsed().as_millis());
    Ok(env)
}

fn cmd_info(o: &Opts) -> Result<()> {
    let env = init_ort(o)?;
    let t = Instant::now();
    let mut e = Embedder::load(o, &env)?;
    println!("모델 {} 불러옴 {} ms, 최대 메모리 {:.0} MB", o.variant, t.elapsed().as_millis(), peak_rss_mb());
    for i in e.session.inputs() {
        println!("입력  {} {:?}", i.name(), i.dtype());
    }
    for x in e.session.outputs() {
        println!("출력  {} {:?}", x.name(), x.dtype());
    }
    let q = format!("{QUERY_PREFIX}인증 API 버그");
    let docs = [
        "로그인 토큰이 만료돼도 /api/auth/refresh 가 401 을 돌려주지 않던 문제를 고쳤습니다.",
        "브랜치 탭의 이름표 색을 그래프 탭의 노선 색과 맞췄습니다.",
        "Fixed the auth middleware returning 500 when the JWT header is missing.",
        "릴리즈 0.10.3 을 게시하고 DMG 체크섬을 확인했습니다.",
    ];
    let mut texts = vec![q];
    texts.extend(docs.iter().map(|d| format!("{DOC_PREFIX}{d}")));
    let v = e.embed(&texts)?;
    println!("차원 {}", v[0].len());
    for (d, x) in docs.iter().zip(&v[1..]) {
        println!("{:.3}  (256차원 {:.3})  {d}", dot(&v[0], x), dot(&truncate(&v[0], 256), &truncate(x, 256)));
    }
    Ok(())
}

fn cmd_bench(o: &Opts) -> Result<()> {
    let env = init_ort(o)?;
    let t = Instant::now();
    let mut e = Embedder::load(o, &env)?;
    let load_ms = t.elapsed().as_millis();
    let chunks: Vec<Chunk> = read_jsonl(&o.data.join("chunks.jsonl"))?;
    let docs: Vec<String> = chunks.iter().take(256).map(|c| format!("{DOC_PREFIX}{}", c.text)).collect();
    e.embed(&docs[..1])?; // 첫 실행 준비
    let mut one = Vec::new();
    for d in docs.iter().take(20) {
        let t = Instant::now();
        e.embed(std::slice::from_ref(d))?;
        one.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    one.sort_by(f64::total_cmp);
    let q = format!("{QUERY_PREFIX}인증 API 버그");
    let t = Instant::now();
    for _ in 0..10 {
        e.embed(std::slice::from_ref(&q))?;
    }
    let q_ms = t.elapsed().as_secs_f64() * 100.0;
    let t = Instant::now();
    for b in docs[..100].chunks(o.batch) {
        e.embed(b)?;
    }
    let hundred = t.elapsed().as_secs_f64();
    println!(
        "{} {}{} 스레드{} 묶음{} 토큰≤{}: 불러오기 {load_ms} ms · 조각 1개 중앙값 {:.1} ms · 질의 1개 {:.1} ms · 조각 100개 {:.2} s ({:.0}개/s) · 최대 메모리 {:.0} MB",
        o.variant,
        o.ep,
        if o.lean { "(arena 끔)" } else { "" },
        if o.threads == 0 { "기본".into() } else { o.threads.to_string() },
        o.batch,
        o.max_tokens,
        one[one.len() / 2],
        q_ms,
        hundred,
        100.0 / hundred,
        peak_rss_mb()
    );
    Ok(())
}

fn open_db(p: &Path) -> Result<Connection> {
    let c = Connection::open(p)?;
    c.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, turn TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
         CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='trigram');
         CREATE TABLE IF NOT EXISTS vectors (id INTEGER PRIMARY KEY, v BLOB NOT NULL);",
    )?;
    Ok(c)
}

fn cmd_index(o: &Opts) -> Result<()> {
    let env = init_ort(o)?;
    let mut e = Embedder::load(o, &env)?;
    let chunks: Vec<Chunk> = read_jsonl(&o.data.join("chunks.jsonl"))?;
    let _ = std::fs::remove_file(&o.db);
    let mut db = open_db(&o.db)?;
    let t = Instant::now();
    let tx = db.transaction()?;
    for c in &chunks {
        tx.execute("INSERT INTO chunks (id, turn, kind, text) VALUES (?1, ?2, ?3, ?4)", params![c.id, c.turn, c.kind, c.text])?;
    }
    tx.execute("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')", [])?;
    tx.commit()?;
    println!("글 저장 + trigram 색인 {} 개: {} ms", chunks.len(), t.elapsed().as_millis());
    // 길이가 비슷한 것끼리 묶어 패딩 낭비를 줄인다
    let mut order: Vec<usize> = (0..chunks.len()).collect();
    order.sort_by_key(|&i| chunks[i].text.len());
    let t = Instant::now();
    let tx = db.transaction()?;
    for (n, b) in order.chunks(o.batch).enumerate() {
        let texts: Vec<String> = b.iter().map(|&i| format!("{DOC_PREFIX}{}", chunks[i].text)).collect();
        for (&i, v) in b.iter().zip(e.embed(&texts)?) {
            let bytes: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
            tx.execute("INSERT INTO vectors (id, v) VALUES (?1, ?2)", params![chunks[i].id, bytes])?;
        }
        if n % 50 == 0 {
            eprintln!("  {}/{} ({:.0} s)", (n + 1) * o.batch, chunks.len(), t.elapsed().as_secs_f64());
        }
    }
    tx.commit()?;
    let s = t.elapsed().as_secs_f64();
    println!(
        "임베딩 {} 개: {:.1} s ({:.1}개/s), 최대 메모리 {:.0} MB, DB {:.1} MB",
        chunks.len(),
        s,
        chunks.len() as f64 / s,
        peak_rss_mb(),
        std::fs::metadata(&o.db)?.len() as f64 / 1e6
    );
    Ok(())
}

#[derive(Deserialize)]
struct Query {
    q: String,
    /// 정답 턴(들)
    turns: Vec<String>,
    /// semantic | keyword
    kind: String,
}

/// FTS5 trigram 은 3글자 미만 낱말을 MATCH 로 못 찾는다 → 그런 낱말은 LIKE 로 보충한다.
fn keyword_rank(db: &Connection, q: &str, limit: usize) -> Result<Vec<i64>> {
    let words: Vec<String> = q
        .split(|c: char| c.is_whitespace() || ",.?!\"'()[]{}".contains(c))
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect();
    let long: Vec<&String> = words.iter().filter(|w| w.chars().count() >= 3).collect();
    let short: Vec<&String> = words.iter().filter(|w| w.chars().count() < 3).collect();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    if !long.is_empty() {
        let m = long.iter().map(|w| format!("\"{}\"", w.replace('"', "\"\""))).collect::<Vec<_>>().join(" OR ");
        let mut st = db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?1 ORDER BY bm25(chunks_fts) LIMIT ?2")?;
        for id in st.query_map(params![m, limit as i64], |r| r.get::<_, i64>(0))? {
            let id = id?;
            if seen.insert(id) {
                out.push(id);
            }
        }
    }
    if !short.is_empty() && out.len() < limit {
        // 짧은 낱말이 많이 들어 있는 것부터
        let score = short.iter().map(|_| "(instr(text, ?) > 0)").collect::<Vec<_>>().join(" + ");
        let sql = format!("SELECT id, {score} AS s FROM chunks WHERE s > 0 ORDER BY s DESC, id DESC LIMIT {}", limit * 2);
        let mut st = db.prepare(&sql)?;
        let ps: Vec<&dyn rusqlite::ToSql> = short.iter().map(|w| *w as &dyn rusqlite::ToSql).collect();
        for id in st.query_map(ps.as_slice(), |r| r.get::<_, i64>(0))? {
            let id = id?;
            if out.len() >= limit {
                break;
            }
            if seen.insert(id) {
                out.push(id);
            }
        }
    }
    Ok(out)
}

fn rrf(lists: &[(&[i64], f64)], k: f64) -> Vec<i64> {
    let mut s: HashMap<i64, f64> = HashMap::new();
    for (l, w) in lists {
        for (r, id) in l.iter().enumerate() {
            *s.entry(*id).or_default() += w / (k + r as f64 + 1.0);
        }
    }
    let mut v: Vec<(i64, f64)> = s.into_iter().collect();
    v.sort_by(|a, b| b.1.total_cmp(&a.1));
    v.into_iter().map(|x| x.0).collect()
}

/// 조각 순위를 턴 순위로 접는다(같은 턴은 처음 나온 것만). 정답 턴의 순위(1부터)를 돌려준다.
fn turn_rank(ranked: &[i64], turn_of: &HashMap<i64, String>, gold: &HashSet<&str>) -> Option<usize> {
    let mut seen = HashSet::new();
    for id in ranked {
        let t = turn_of[id].as_str();
        if seen.insert(t) && gold.contains(t) {
            return Some(seen.len());
        }
    }
    None
}

fn cmd_eval(o: &Opts) -> Result<()> {
    let env = init_ort(o)?;
    let mut e = Embedder::load(o, &env)?;
    let db = open_db(&o.db)?;
    let mut turn_of = HashMap::new();
    let mut st = db.prepare("SELECT c.id, c.turn, v.v FROM chunks c JOIN vectors v ON v.id = c.id")?;
    let mut ids = Vec::new();
    let mut full: Vec<Vec<f32>> = Vec::new();
    for r in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Vec<u8>>(2)?)))? {
        let (id, turn, b) = r?;
        turn_of.insert(id, turn);
        ids.push(id);
        full.push(b.chunks_exact(4).map(|x| f32::from_le_bytes(x.try_into().unwrap())).collect());
    }
    drop(st);
    let v256: Vec<Vec<f32>> = full.iter().map(|v| truncate(v, 256)).collect();
    let q8: Vec<Vec<i8>> = v256.iter().map(|v| quantize(v)).collect();
    let queries: Vec<Query> = read_jsonl(&o.data.join(&o.queries))?;
    let methods = ["키워드만", "벡터 768", "벡터 256", "벡터 256 int8", "RRF 같은 비중", "RRF 키워드 0.3", "RRF 식별자 있을 때만"];
    let mut ranks: Vec<Vec<Option<usize>>> = vec![Vec::new(); methods.len()];
    let mut detail = String::new();
    let mut q_ms = 0.0;
    for q in &queries {
        let gold: HashSet<&str> = q.turns.iter().map(String::as_str).collect();
        let t = Instant::now();
        let qv = e.embed(&[format!("{QUERY_PREFIX}{}", q.q)])?.remove(0);
        q_ms += t.elapsed().as_secs_f64() * 1000.0;
        let top = |scores: Vec<f32>| -> Vec<i64> {
            let mut idx: Vec<usize> = (0..scores.len()).collect();
            idx.sort_by(|&a, &b| scores[b].total_cmp(&scores[a]));
            idx.into_iter().take(50).map(|i| ids[i]).collect()
        };
        let kw = keyword_rank(&db, &q.q, 50)?;
        let r768 = top(full.iter().map(|v| dot(&qv, v)).collect());
        let qv256 = truncate(&qv, 256);
        let r256 = top(v256.iter().map(|v| dot(&qv256, v)).collect());
        let qq = quantize(&qv256);
        let r8 = top(q8.iter().map(|v| dot_i8(&qq, v) as f32).collect());
        let fused = rrf(&[(&kw, 1.0), (&r8, 1.0)], 60.0);
        let light = rrf(&[(&kw, 0.3), (&r8, 1.0)], 60.0);
        // 영문·숫자가 섞인 3글자 이상 낱말(함수명·오류 코드·파일명)이 있을 때만 키워드를 섞는다
        let has_ident = q.q.split_whitespace().any(|w| w.len() >= 3 && w.chars().all(|c| c.is_ascii_graphic()));
        let cond = if has_ident { fused.clone() } else { r8.clone() };
        let lists = [&kw, &r768, &r256, &r8, &fused, &light, &cond];
        let mut line = format!("{} [{}]", q.q, q.kind);
        for (m, l) in lists.iter().enumerate() {
            let r = turn_rank(l, &turn_of, &gold);
            ranks[m].push(r);
            line += &format!(" | {}", r.map_or("-".into(), |x| x.to_string()));
        }
        detail += &line;
        detail += "\n";
    }
    std::fs::write(o.data.join(format!("eval-{}-{}-{}.txt", o.variant, o.ep, o.queries.trim_end_matches(".jsonl"))), &detail)?;
    println!("질의 {} 개 (질의 임베딩 평균 {:.1} ms), 턴 단위 순위", queries.len(), q_ms / queries.len() as f64);
    println!("| 방법 | 종류 | 1위 안 | 3위 안 | 5위 안 | 10위 안 | MRR@10 |");
    println!("|---|---|---|---|---|---|---|");
    for kind in ["semantic", "keyword", "전체"] {
        for (m, name) in methods.iter().enumerate() {
            let rs: Vec<Option<usize>> =
                ranks[m].iter().zip(&queries).filter(|(_, q)| kind == "전체" || q.kind == kind).map(|(r, _)| *r).collect();
            let n = rs.len().max(1) as f64;
            let at = |k: usize| rs.iter().filter(|r| r.is_some_and(|x| x <= k)).count();
            let mrr = rs.iter().map(|r| r.filter(|&x| x <= 10).map_or(0.0, |x| 1.0 / x as f64)).sum::<f64>() / n;
            println!("| {name} | {kind}({}) | {} | {} | {} | {} | {:.2} |", rs.len(), at(1), at(3), at(5), at(10), mrr);
        }
    }
    Ok(())
}

fn cmd_scan(o: &Opts) -> Result<()> {
    // 실제 분포 대신 의사 난수 벡터로 n 개 × 256차원 전수 내적 시간만 잰다
    let d = 256;
    let mut x: u64 = 0x9E3779B97F4A7C15;
    let mut rnd = || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        ((x >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
    };
    let f: Vec<f32> = (0..o.n * d).map(|_| rnd()).collect();
    let q8: Vec<i8> = f.iter().map(|v| (v * 127.0) as i8).collect();
    let qf: Vec<f32> = (0..d).map(|_| rnd()).collect();
    let qq: Vec<i8> = qf.iter().map(|v| (v * 127.0) as i8).collect();
    let t = Instant::now();
    let mut best = f32::MIN;
    for row in f.chunks_exact(d) {
        best = best.max(dot(&qf, row));
    }
    let tf = t.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    let mut best8 = i32::MIN;
    for row in q8.chunks_exact(d) {
        best8 = best8.max(dot_i8(&qq, row));
    }
    let t8 = t.elapsed().as_secs_f64() * 1000.0;
    println!(
        "{} 개 × {d}차원 전수 내적: f32 {:.1} ms ({:.0} MB), int8 {:.1} ms ({:.0} MB) [{best:.2} {best8}]",
        o.n,
        tf,
        (o.n * d * 4) as f64 / 1e6,
        t8,
        (o.n * d) as f64 / 1e6
    );
    Ok(())
}

fn main() -> Result<()> {
    let o = opts()?;
    match o.cmd.as_str() {
        "info" => cmd_info(&o),
        "bench" => cmd_bench(&o),
        "index" => cmd_index(&o),
        "eval" => cmd_eval(&o),
        "scan" => cmd_scan(&o),
        c => bail!("모르는 명령: {c}"),
    }
}
