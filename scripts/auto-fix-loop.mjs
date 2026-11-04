#!/usr/bin/env node
// 자동 검증·수정 루프(AGENTS.md 3번). 실행 입구는 scripts/auto-fix-loop.sh.
//
// 쓰는 법
//   ./scripts/auto-fix-loop.sh [TASK-ID] [--note "이번에 고친 것"]
//   ./scripts/auto-fix-loop.sh [TASK-ID] --reset "사유"   ← 사용자가 다시 시도를 허락했을 때만
//
// 실행 한 번 = 검증 한 번(시도 1회). 실패하면 에이전트가 고친 뒤 다시 실행한다. TASK-ID 를 안 주면
// .agent/PROGRESS.md 의 "현재 작업" 을 쓴다. 시도마다 .agent/attempts/<TASK-ID>.jsonl 에 한 줄씩 남기고,
// 전체 출력은 .agent/attempts/<TASK-ID>.last.log 에 둔다(git 에 안 들어감). 둘 다 토큰·비밀번호는 가린다.
//
// 루프는 마지막 통과 또는 --reset 뒤에 새로 시작하고, 다음일 때 멈춘다(설정: .agent/auto-fix.json).
//   - 최대 시도 횟수에 닿음  - 루프 첫 시도부터 시간 제한을 넘김  - 같은 오류가 연달아 나옴
// 멈춘 뒤에는 --reset 전까지 검증을 돌리지 않는다.
//
// 종료 코드: 0 통과 · 1 실패(시도 남음, 고친 뒤 다시) · 2 중단(더 시도하지 말고 보고) · 64 사용법·설정 오류

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULTS = { maxAttempts: 5, timeLimitMinutes: 60, stepTimeoutMinutes: 20, sameErrorLimit: 2, clippyMaxWarnings: 15 };
export const EXIT = { passed: 0, failed: 1, stopped: 2, usage: 64 };

export class UsageError extends Error {}

// ───────── 설정·TASK ─────────

export function loadConfig(root) {
  const file = join(root, ".agent", "auto-fix.json");
  let raw = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new UsageError(`설정 파일을 읽지 못했습니다(.agent/auto-fix.json): ${e.message}`);
    }
  }
  const cfg = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (raw[key] === undefined) continue;
    const v = raw[key];
    const min = key === "clippyMaxWarnings" ? 0 : 1;
    if (!Number.isInteger(v) || v < min) throw new UsageError(`설정 ${key} 는 ${min} 이상의 정수여야 합니다: ${JSON.stringify(v)}`);
    cfg[key] = v;
  }
  return cfg;
}

/** PROGRESS.md 의 "- 현재 작업: TASK-001" 에서 ID 를 꺼낸다. 없음·빈칸이면 null */
export function readTaskId(progressText) {
  const m = progressText.match(/^\s*[-*]?\s*현재 작업(?:\s*ID)?\s*[:：]\s*`?([^`\s]*)`?/m);
  if (!m || !m[1] || /^(없음|-|none)$/i.test(m[1])) return null;
  return m[1];
}

/** 파일 이름으로 쓰니 경로 문자가 없는 짧은 ID 만 */
export function validTaskId(id) {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);
}

export function attemptsFile(root, taskId) {
  return join(root, ".agent", "attempts", `${taskId}.jsonl`);
}

export function readRecords(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 깨진 줄은 건너뛴다(기록은 지우지 않는다) */
    }
  }
  return out;
}

// ───────── 출력 다루기 ─────────

const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|APIKEY|API_KEY|_KEY$|^KEY$)/i;

/** 로그에 남기기 전에 토큰·비밀번호·개인 키를 가린다 */
export function maskSecrets(text, env = process.env) {
  let t = String(text);
  for (const [k, v] of Object.entries(env)) {
    if (v && v.length >= 8 && SECRET_ENV.test(k)) t = t.split(v).join(`<${k} 가림>`);
  }
  return t
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<개인 키 가림>")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g, "<토큰 가림>")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 <가림>")
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1$2<가림>");
}

export function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

const ERROR_LINE = /\berror\b|\bfailed\b|\bpanicked\b|\bFAIL\b|AssertionError|^\s*[×✗]/i;
const NOT_ERROR = /\b0 failed\b|^\s*warning\b|: warning: /i;

/** 실패한 단계 출력에서 오류 줄만 뽑는다(panicked 뒤 두 줄은 이유라 같이). 없으면 끝 15줄 */
export function extractErrors(out, max = 40) {
  const lines = stripAnsi(out).split("\n");
  const picked = [];
  const seen = new Set();
  const add = (l) => {
    const s = l.trimEnd().slice(0, 300);
    if (s.trim() && !seen.has(s)) {
      seen.add(s);
      picked.push(s);
    }
  };
  lines.forEach((l, i) => {
    if (!ERROR_LINE.test(l) || NOT_ERROR.test(l)) return;
    add(l);
    if (/\bpanicked\b/.test(l)) lines.slice(i + 1, i + 3).forEach(add);
  });
  if (picked.length === 0) lines.filter((l) => l.trim()).slice(-15).forEach(add);
  return picked.slice(0, max);
}

/** 같은 오류인지 비교할 때 시간·임시 경로·주소처럼 매번 바뀌는 부분은 뺀다 */
export function normalize(line) {
  return stripAnsi(line)
    .replace(/\b\d+(\.\d+)?(ms|s)\b/g, "#t")
    .replace(/0x[0-9a-f]+/gi, "0x#")
    .replace(/(\/private)?\/(var\/folders|tmp)\/\S+/g, "<tmp>")
    .replace(/\s+/g, " ")
    .trim();
}

/** 실패한 단계 id 와 오류 줄로 만든 오류 지문 */
export function makeSignature(steps) {
  const failed = steps.filter((s) => !s.ok && !s.skipped);
  const text = failed.map((s) => `${s.id}\n${(s.errors ?? []).map(normalize).join("\n")}`).join("\n\n");
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** clippy --message-format=short 출력의 경고(파일:줄:칸 기준, lib 와 lib test 중복은 하나로) */
export function clippyWarnings(out) {
  return [...new Set(stripAnsi(out).split("\n").filter((l) => /^\S+:\d+:\d+: warning: /.test(l)))];
}

// ───────── 루프 판단 ─────────

/** 지금 루프(마지막 통과·초기화 뒤)의 시도들과 중단 여부 */
export function loopState(records) {
  let from = 0;
  records.forEach((r, i) => {
    if (r.result === "passed" || r.result === "reset") from = i + 1;
  });
  const loop = records.slice(from);
  const attempts = loop.filter((r) => Array.isArray(r.steps));
  const started = loop.length ? Date.parse(loop[0].time) : NaN;
  return {
    attempts,
    stopped: loop.find((r) => r.result === "stopped") ?? null,
    startedAt: Number.isNaN(started) ? null : started,
  };
}

/** 이번 실패 지문이 앞 시도들과 몇 번 연달아 같은지(이번 포함) */
export function sameErrorCount(attempts, signature) {
  let n = 1;
  for (let i = attempts.length - 1; i >= 0 && attempts[i].signature === signature; i--) n++;
  return n;
}

export function verdict({ ok, timeUp, sameCount, attempt }, cfg) {
  if (ok) return { result: "passed" };
  if (timeUp) return { result: "stopped", reason: `시간 제한(${cfg.timeLimitMinutes}분)을 넘김` };
  if (sameCount >= cfg.sameErrorLimit) return { result: "stopped", reason: `같은 오류가 ${sameCount}번 연달아 남` };
  if (attempt >= cfg.maxAttempts) return { result: "stopped", reason: `최대 시도 횟수(${cfg.maxAttempts}번)에 닿음` };
  return { result: "failed" };
}

// ───────── 실행 ─────────

/** 이 저장소의 검증 단계. needs 가 실패하면 그 단계는 건너뛴다(같은 컴파일 오류가 되풀이되지 않게). */
export function projectSteps(root, cfg) {
  const tauri = join(root, "src-tauri");
  return [
    { id: "build-web", name: "빌드 (화면)", cmd: "pnpm", args: ["exec", "vite", "build"], cwd: root },
    { id: "build-rust", name: "빌드 (Rust)", cmd: "cargo", args: ["build", "--all-targets", "--message-format=short"], cwd: tauri },
    { id: "typecheck", name: "타입 검사", cmd: "pnpm", args: ["exec", "tsc", "--noEmit", "-p", "."], cwd: root },
    {
      id: "lint",
      name: "Lint (clippy)",
      cmd: "cargo",
      args: ["clippy", "--all-targets", "--message-format=short"],
      cwd: tauri,
      needs: "build-rust",
      check: (out) => {
        const w = clippyWarnings(out);
        const note = `경고 ${w.length}개 / 허용 ${cfg.clippyMaxWarnings}개`;
        return w.length > cfg.clippyMaxWarnings ? { ok: false, note, errors: [`clippy ${note}`, ...w.slice(0, 30)] } : { ok: true, note };
      },
    },
    { id: "test-web", name: "테스트 (화면)", cmd: "pnpm", args: ["exec", "vitest", "run"], cwd: root },
    { id: "test-rust", name: "테스트 (Rust)", cmd: "cargo", args: ["test", "--message-format=short"], cwd: tauri, needs: "build-rust" },
  ];
}

let current = null; // 지금 돌고 있는 단계(중단 신호 때 프로세스 묶음째 끈다)

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* 이미 끝남 */
  }
}

const OUTPUT_CAP = 4_000_000;

/** 명령 하나를 돌려 출력(뒤쪽 4MB까지)과 종료 코드를 받는다. 시간이 넘으면 프로세스 묶음째 끈다. */
export function runCommand(cmd, args, { cwd, timeoutMs }) {
  return new Promise((done) => {
    const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CARGO_TERM_COLOR: "never", AITERM_SKIP_APP: "1" };
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      done({ code: 127, out: String(e.message), timedOut: false });
      return;
    }
    current = child;
    let out = "";
    const onData = (d) => {
      out += d.toString("utf8");
      if (out.length > OUTPUT_CAP) out = out.slice(-OUTPUT_CAP);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 5000).unref();
    }, Math.max(1, timeoutMs));
    const finish = (code, extra = "") => {
      clearTimeout(timer);
      current = null;
      done({ code, out: out + extra, timedOut });
    };
    child.on("error", (e) => finish(127, `\n${e.message}`));
    child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1)));
  });
}

/** 바뀐 파일 목록(무엇을 고쳤는지 시도끼리 비교용). git 이 아니면 null */
export function gitInfo(root) {
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  const head = git("rev-parse", "--short", "HEAD");
  if (head.status !== 0) return null;
  const branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  const entries = (git("status", "--porcelain=v1", "-z", "-uall").stdout ?? "").split("\0");
  const changed = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    const path = e.slice(3);
    if (e[0] === "R" || e[0] === "C") i++; // 이름 바꾸기는 옛 경로가 한 칸 더 온다
    if (!path.startsWith(".agent/attempts/")) changed.push(path);
  }
  return { branch, head: head.stdout.trim(), changedCount: changed.length, changed: changed.slice(0, 50) };
}

const minutesLeft = (ms) => Math.max(0, Math.ceil(ms / 60_000));

/**
 * 시도 한 번. steps 는 projectSteps 모양({id,name,cmd,args,cwd,needs?,check?}).
 * 돌려주는 값: { exitCode, record } — record 는 jsonl 에 쓴 줄(안 썼으면 null)
 */
export async function runAttempt({ root, taskId, note, cfg, steps, log = (s) => console.log(s), now = () => Date.now() }) {
  const file = attemptsFile(root, taskId);
  const state = loopState(readRecords(file));
  const rel = (p) => p.slice(root.length + 1);

  if (state.stopped) {
    log(`자동 수정 루프가 이미 중단됐습니다: ${state.stopped.reason}`);
    log("더 시도하지 말고 TASK 파일에 중단 기록을 남긴 뒤 원인과 현재 상태를 보고하세요.");
    log(`사용자가 다시 시도를 허락했을 때만: ./scripts/auto-fix-loop.sh ${taskId} --reset "사유"`);
    return { exitCode: EXIT.stopped, record: null };
  }

  mkdirSync(dirname(file), { recursive: true });
  const write = (record) => appendFileSync(file, JSON.stringify(record) + "\n");
  const start = now();
  const deadline = (state.startedAt ?? start) + cfg.timeLimitMinutes * 60_000;
  const attempt = state.attempts.length + 1;
  const base = { time: new Date(start).toISOString(), task: taskId, attempt, ...(note ? { note: maskSecrets(note) } : {}) };

  const stopBefore = (reason) => {
    const record = { ...base, result: "stopped", reason };
    write(record);
    log(`자동 수정 루프 중단: ${reason}. 검증을 돌리지 않았습니다.`);
    log("더 시도하지 말고 TASK 파일에 중단 기록을 남긴 뒤 원인과 현재 상태를 보고하세요.");
    return { exitCode: EXIT.stopped, record };
  };
  if (attempt > cfg.maxAttempts) return stopBefore(`최대 시도 횟수(${cfg.maxAttempts}번)에 닿음`);
  if (start >= deadline) return stopBefore(`시간 제한(${cfg.timeLimitMinutes}분)을 넘김`);

  log(`${taskId} 검증 시도 ${attempt}/${cfg.maxAttempts} · 루프 남은 시간 ${minutesLeft(deadline - start)}분`);
  const stepLimit = cfg.stepTimeoutMinutes * 60_000;
  const results = [];
  const fullLog = [];
  let timeUp = false;

  for (const step of steps) {
    const head = { id: step.id, name: step.name };
    const need = step.needs && results.find((r) => r.id === step.needs);
    if (need && !need.ok) {
      results.push({ ...head, ok: false, skipped: true, note: `${need.name} 실패로 건너뜀` });
      log(`  건너뜀 ${step.name} (${need.name} 실패)`);
      continue;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      timeUp = true;
      results.push({ ...head, ok: false, skipped: true, note: "시간 제한으로 건너뜀" });
      log(`  건너뜀 ${step.name} (시간 제한)`);
      continue;
    }
    const limit = Math.min(stepLimit, remaining);
    const t0 = now();
    const r = await runCommand(step.cmd, step.args, { cwd: step.cwd, timeoutMs: limit });
    const out = maskSecrets(stripAnsi(r.out));
    fullLog.push(maskSecrets(`===== ${step.name}: ${step.cmd} ${step.args.join(" ")} (종료 코드 ${r.code}${r.timedOut ? ", 시간 초과" : ""}) =====`) + `\n${out}`);
    let ok = r.code === 0 && !r.timedOut;
    let stepNote;
    const errors = [];
    if (r.timedOut) {
      if (limit < stepLimit) timeUp = true;
      errors.push(limit < stepLimit ? `루프 시간 제한(${cfg.timeLimitMinutes}분)에 걸려 멈춤` : `단계 시간 제한(${cfg.stepTimeoutMinutes}분)을 넘겨 멈춤`);
    }
    if (!ok) errors.push(...extractErrors(out));
    else if (step.check) {
      const c = step.check(out);
      ok = c.ok;
      stepNote = c.note;
      if (!c.ok) errors.push(...(c.errors ?? []));
    }
    const sec = Math.round((now() - t0) / 1000);
    results.push({ ...head, ok, exitCode: r.code, sec, ...(r.timedOut ? { timedOut: true } : {}), ...(stepNote ? { note: stepNote } : {}), ...(errors.length ? { errors } : {}) });
    log(`  ${ok ? "통과" : "실패"} ${step.name} (${sec}초)${stepNote ? ` · ${stepNote}` : ""}`);
  }

  const ok = results.every((r) => r.ok);
  const signature = ok ? undefined : makeSignature(results);
  const v = verdict({ ok, timeUp, sameCount: ok ? 0 : sameErrorCount(state.attempts, signature), attempt }, cfg);
  const record = {
    ...base,
    result: v.result,
    ...(v.reason ? { reason: v.reason } : {}),
    durationSec: Math.round((now() - start) / 1000),
    ...(signature ? { signature } : {}),
    failedSteps: results.filter((r) => !r.ok).map((r) => r.id),
    steps: results,
    git: gitInfo(root),
  };
  write(record);
  const logFile = join(dirname(file), `${taskId}.last.log`);
  writeFileSync(logFile, fullLog.join("\n\n") + "\n");

  if (v.result === "passed") {
    log("검증 통과. TASK 파일의 완료 조건을 모두 확인한 뒤에만 COMPLETED 로 바꾸고 .agent/archive/ 로 옮기세요.");
    return { exitCode: EXIT.passed, record };
  }
  for (const s of results.filter((r) => !r.ok && !r.skipped)) {
    log(`\n[${s.name}]`);
    (s.errors ?? []).slice(0, 15).forEach((e) => log(`  ${e}`));
  }
  log(`\n전체 출력: ${rel(logFile)} · 시도 기록: ${rel(file)}`);
  if (v.result === "stopped") {
    log(`자동 수정 루프 중단: ${v.reason}.`);
    log("더 시도하지 말고 TASK 파일에 현재 상태·완료한 작업·실패 원인·이미 시도한 방법·다음 행동을 적은 뒤 보고하세요.");
    return { exitCode: EXIT.stopped, record };
  }
  log(`검증 실패. 고친 뒤 다시 실행하세요(남은 시도 ${cfg.maxAttempts - attempt}번, 남은 시간 ${minutesLeft(deadline - now())}분). 무엇을 고쳤는지는 --note 로 남길 수 있습니다.`);
  return { exitCode: EXIT.failed, record };
}

/** --reset: 사용자가 허락했을 때 새 루프를 연다 */
export function resetLoop({ root, taskId, reason, now = () => Date.now() }) {
  const file = attemptsFile(root, taskId);
  mkdirSync(dirname(file), { recursive: true });
  const record = { time: new Date(now()).toISOString(), task: taskId, result: "reset", reason: maskSecrets(reason) };
  appendFileSync(file, JSON.stringify(record) + "\n");
  return record;
}

export function parseArgs(argv) {
  const opts = { task: null, note: null, reset: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--note" || a === "--reset") {
      const v = argv[++i];
      if (!v || !v.trim()) throw new UsageError(`${a} 뒤에 내용을 적어 주세요`);
      opts[a.slice(2)] = v;
    } else if (a.startsWith("-")) throw new UsageError(`모르는 옵션입니다: ${a}`);
    else if (opts.task) throw new UsageError(`TASK-ID 는 하나만 줄 수 있습니다: ${a}`);
    else opts.task = a;
  }
  return opts;
}

const USAGE = `쓰는 법: ./scripts/auto-fix-loop.sh [TASK-ID] [--note "이번에 고친 것"]
        ./scripts/auto-fix-loop.sh [TASK-ID] --reset "사유"   (사용자가 다시 시도를 허락했을 때만)
TASK-ID 를 안 주면 .agent/PROGRESS.md 의 "현재 작업" 을 쓴다. 설정: .agent/auto-fix.json
종료 코드: 0 통과 · 1 실패(고친 뒤 다시) · 2 중단(더 시도하지 말고 보고) · 64 사용법·설정 오류`;

async function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      console.log(USAGE);
      return EXIT.passed;
    }
    const cfg = loadConfig(root);
    const progress = join(root, ".agent", "PROGRESS.md");
    const taskId = opts.task ?? (existsSync(progress) ? readTaskId(readFileSync(progress, "utf8")) : null);
    if (!taskId) throw new UsageError('현재 작업 ID 가 없습니다. .agent/PROGRESS.md 의 "현재 작업" 을 채우거나 TASK-ID 를 인자로 주세요.');
    if (!validTaskId(taskId)) throw new UsageError(`TASK-ID 가 올바르지 않습니다: ${taskId}`);
    if (!existsSync(join(root, ".agent", "tasks", `${taskId}.md`))) throw new UsageError(`TASK 파일이 없습니다: .agent/tasks/${taskId}.md`);
    if (opts.reset) {
      resetLoop({ root, taskId, reason: opts.reset });
      console.log(`${taskId} 자동 수정 루프를 새로 엽니다(사유: ${maskSecrets(opts.reset)}). 사용자가 허락한 경우에만 쓰는 명령입니다.`);
      return EXIT.passed;
    }
    const { exitCode } = await runAttempt({ root, taskId, note: opts.note, cfg, steps: projectSteps(root, cfg) });
    return exitCode;
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(e.message);
    console.error(USAGE);
    return EXIT.usage;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      if (current) killGroup(current, "SIGTERM");
      console.error("\n검증을 멈췄습니다(이번 시도는 기록하지 않음).");
      process.exit(130);
    });
  }
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
