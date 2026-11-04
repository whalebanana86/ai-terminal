import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULTS,
  UsageError,
  attemptsFile,
  clippyWarnings,
  extractErrors,
  loadConfig,
  loopState,
  makeSignature,
  maskSecrets,
  normalize,
  parseArgs,
  readRecords,
  readTaskId,
  resetLoop,
  runAttempt,
  validTaskId,
  verdict,
} from "./auto-fix-loop.mjs";

const node = process.execPath;
const step = (id, code, { stderr = "", needs, wait } = {}) => ({
  id,
  name: id,
  cmd: node,
  args: ["-e", `${stderr ? `console.error(${JSON.stringify(stderr)});` : ""}${wait ? `setTimeout(() => process.exit(${code}), ${wait});` : `process.exit(${code});`}`],
  cwd: tmpdir(),
  ...(needs ? { needs } : {}),
});

const dirs = [];
function repo() {
  const root = mkdtempSync(join(tmpdir(), "autofix-"));
  dirs.push(root);
  mkdirSync(join(root, ".agent", "tasks"), { recursive: true });
  writeFileSync(join(root, ".agent", "tasks", "T-1.md"), "# T-1\n");
  return root;
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const quiet = () => {};

describe("PROGRESS·설정", () => {
  it("현재 작업 ID 를 읽는다", () => {
    expect(readTaskId("# 진행\n\n- 현재 작업: TASK-007\n- 상태: IN_PROGRESS\n")).toBe("TASK-007");
    expect(readTaskId("- 현재 작업: `TASK-008`")).toBe("TASK-008");
    expect(readTaskId("- 현재 작업: 없음")).toBeNull();
    expect(readTaskId("- 현재 작업:")).toBeNull();
    expect(readTaskId("아무것도 없음")).toBeNull();
  });

  it("경로가 되는 ID 는 받지 않는다", () => {
    expect(validTaskId("TASK-001")).toBe(true);
    for (const bad of ["../x", "a/b", ".hidden", "", "a b"]) expect(validTaskId(bad)).toBe(false);
  });

  it("설정이 없으면 기본값, 잘못된 값은 거절", () => {
    const root = repo();
    expect(loadConfig(root)).toEqual(DEFAULTS);
    writeFileSync(join(root, ".agent", "auto-fix.json"), JSON.stringify({ maxAttempts: 2, 설명: {} }));
    expect(loadConfig(root).maxAttempts).toBe(2);
    writeFileSync(join(root, ".agent", "auto-fix.json"), JSON.stringify({ maxAttempts: 0 }));
    expect(() => loadConfig(root)).toThrow(UsageError);
    writeFileSync(join(root, ".agent", "auto-fix.json"), "{ 깨짐");
    expect(() => loadConfig(root)).toThrow(UsageError);
  });

  it("인자: TASK-ID 하나, --note·--reset 은 내용 필수", () => {
    expect(parseArgs(["T-1", "--note", "타입 고침"])).toMatchObject({ task: "T-1", note: "타입 고침" });
    expect(() => parseArgs(["--reset"])).toThrow(UsageError);
    expect(() => parseArgs(["a", "b"])).toThrow(UsageError);
    expect(() => parseArgs(["--force"])).toThrow(UsageError);
  });
});

describe("출력 다루기", () => {
  it("토큰·비밀번호·개인 키·환경 변수 비밀값을 가린다", () => {
    const text = [
      "push ghp_abcdefghijklmnopqrstuvwxyz0123 failed",
      "key sk-ant-api03-abcdefghijklmnopqrstu",
      "Authorization: Bearer abc.def.ghijklmnop",
      'password="hunter2hunter2"',
      "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
      "env value s3cr3t-value-123",
    ].join("\n");
    const out = maskSecrets(text, { MY_API_TOKEN: "s3cr3t-value-123", HOME: "/Users/someone" });
    for (const leak of ["ghp_abc", "sk-ant-api03", "abc.def.ghijklmnop", "hunter2", "AAAA", "s3cr3t-value-123"]) expect(out).not.toContain(leak);
    expect(out).toContain("<MY_API_TOKEN 가림>");
    expect(out).toContain("failed"); // 나머지 글은 그대로
  });

  it("오류 줄만 뽑고 '0 failed'·경고는 뺀다", () => {
    const out = [
      "compiling…",
      "warning: unused variable",
      "src/a.ts(3,1): error TS2322: Type 'x' is not assignable",
      "test result: ok. 12 passed; 0 failed",
      "thread 'tests::sum' panicked at src/lib.rs:10:5:",
      "assertion `left == right` failed",
      "  left: 1",
      " right: 2",
    ].join("\n");
    expect(extractErrors(out)).toEqual([
      "src/a.ts(3,1): error TS2322: Type 'x' is not assignable",
      "thread 'tests::sum' panicked at src/lib.rs:10:5:",
      "assertion `left == right` failed",
      "  left: 1",
    ]);
    // 오류 줄이 없으면 끝 줄들
    expect(extractErrors("a\nb\nexit 1\n")).toEqual(["a", "b", "exit 1"]);
  });

  it("시간·임시 경로만 다른 오류는 같은 지문", () => {
    expect(normalize("FAIL a.test.ts (12ms) /var/folders/x/y")).toBe(normalize("FAIL  a.test.ts (340ms) /var/folders/q/z"));
    const a = makeSignature([{ id: "test", ok: false, errors: ["FAIL x (3ms)"] }, { id: "lint", ok: true }]);
    const b = makeSignature([{ id: "test", ok: false, errors: ["FAIL x (9ms)"] }, { id: "lint", ok: true }]);
    const c = makeSignature([{ id: "test", ok: false, errors: ["FAIL y"] }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("clippy 경고는 위치 기준으로 한 번씩 센다", () => {
    const out = "src/a.rs:1:2: warning: x\nsrc/a.rs:1:2: warning: x\nsrc/b.rs:3:4: warning: y\nwarning: `ai-terminal` (lib) generated 2 warnings\n";
    expect(clippyWarnings(out)).toHaveLength(2);
  });
});

describe("루프 판단", () => {
  const cfg = { ...DEFAULTS, maxAttempts: 3, sameErrorLimit: 2 };

  it("통과·초기화 뒤에는 새 루프", () => {
    const recs = [
      { time: "2026-11-04T00:00:00Z", result: "failed", steps: [], signature: "a" },
      { time: "2026-11-04T00:01:00Z", result: "passed", steps: [] },
      { time: "2026-11-04T00:02:00Z", result: "failed", steps: [], signature: "b" },
      { time: "2026-11-04T00:03:00Z", result: "stopped", reason: "x", steps: [] },
      { time: "2026-11-04T00:04:00Z", result: "reset", reason: "허락" },
    ];
    expect(loopState(recs.slice(0, 3))).toMatchObject({ stopped: null, startedAt: Date.parse("2026-11-04T00:02:00Z") });
    expect(loopState(recs.slice(0, 3)).attempts).toHaveLength(1);
    expect(loopState(recs.slice(0, 4)).stopped?.reason).toBe("x");
    expect(loopState(recs)).toMatchObject({ attempts: [], stopped: null, startedAt: null });
  });

  it("통과 > 시간 > 같은 오류 > 최대 횟수 순으로 판단", () => {
    expect(verdict({ ok: true, timeUp: true, sameCount: 9, attempt: 9 }, cfg).result).toBe("passed");
    expect(verdict({ ok: false, timeUp: true, sameCount: 1, attempt: 1 }, cfg).reason).toMatch(/시간 제한/);
    expect(verdict({ ok: false, timeUp: false, sameCount: 2, attempt: 2 }, cfg).reason).toMatch(/같은 오류/);
    expect(verdict({ ok: false, timeUp: false, sameCount: 1, attempt: 3 }, cfg).reason).toMatch(/최대 시도/);
    expect(verdict({ ok: false, timeUp: false, sameCount: 1, attempt: 2 }, cfg).result).toBe("failed");
  });
});

describe("시도 기록(실제 명령으로)", () => {
  const cfg = { ...DEFAULTS, maxAttempts: 3, sameErrorLimit: 2 };

  it("실패 기록 → 같은 오류 반복이면 중단 → 중단 뒤엔 돌지 않음 → 초기화 뒤 통과", async () => {
    const root = repo();
    const file = attemptsFile(root, "T-1");
    const failing = [step("ok", 0), step("bad", 1, { stderr: "error: 같은 오류 password=hunter2hunter2" })];

    const first = await runAttempt({ root, taskId: "T-1", note: "처음", cfg, steps: failing, log: quiet });
    expect(first.exitCode).toBe(1);
    expect(first.record).toMatchObject({ attempt: 1, result: "failed", failedSteps: ["bad"], note: "처음" });
    expect(first.record.steps[1].errors[0]).toContain("error: 같은 오류");

    const second = await runAttempt({ root, taskId: "T-1", cfg, steps: failing, log: quiet });
    expect(second.exitCode).toBe(2);
    expect(second.record).toMatchObject({ attempt: 2, result: "stopped" });
    expect(second.record.reason).toMatch(/같은 오류가 2번/);

    const third = await runAttempt({ root, taskId: "T-1", cfg, steps: [step("ok", 0)], log: quiet });
    expect(third).toEqual({ exitCode: 2, record: null });
    expect(readRecords(file)).toHaveLength(2);

    // 기록·전체 출력에 비밀번호가 남지 않는다
    expect(readFileSync(file, "utf8")).not.toContain("hunter2");
    expect(readFileSync(join(root, ".agent", "attempts", "T-1.last.log"), "utf8")).not.toContain("hunter2");

    resetLoop({ root, taskId: "T-1", reason: "사용자 허락" });
    const fourth = await runAttempt({ root, taskId: "T-1", cfg, steps: [step("ok", 0)], log: quiet });
    expect(fourth.exitCode).toBe(0);
    expect(fourth.record).toMatchObject({ attempt: 1, result: "passed", failedSteps: [] });
    expect(readRecords(file).map((r) => r.result)).toEqual(["failed", "stopped", "reset", "passed"]);
  });

  it("오류가 바뀌면 계속하다가 최대 시도 횟수에서 중단", async () => {
    const root = repo();
    const codes = [];
    for (let i = 1; i <= 3; i++) {
      const r = await runAttempt({ root, taskId: "T-1", cfg, steps: [step("bad", 1, { stderr: `error: 오류 ${"abc"[i - 1]}` })], log: quiet });
      codes.push(r.exitCode);
      if (i === 3) expect(r.record.reason).toMatch(/최대 시도 횟수\(3번\)/);
    }
    expect(codes).toEqual([1, 1, 2]);
  });

  it("앞 단계가 실패하면 그 단계에 기대는 단계는 건너뛴다", async () => {
    const root = repo();
    const r = await runAttempt({ root, taskId: "T-1", cfg, steps: [step("build", 1, { stderr: "error: 컴파일" }), step("test", 0, { needs: "build" })], log: quiet });
    expect(r.record.steps[1]).toMatchObject({ id: "test", ok: false, skipped: true });
    expect(r.record.failedSteps).toEqual(["build", "test"]);
  });

  it("루프 시간 제한을 넘기면 검증 없이 중단", async () => {
    const root = repo();
    const t0 = Date.parse("2026-11-04T00:00:00Z");
    await runAttempt({ root, taskId: "T-1", cfg, steps: [step("bad", 1, { stderr: "error: 하나" })], log: quiet, now: () => t0 });
    const later = await runAttempt({ root, taskId: "T-1", cfg, steps: [step("ok", 0)], log: quiet, now: () => t0 + 61 * 60_000 });
    expect(later.exitCode).toBe(2);
    expect(later.record).toMatchObject({ result: "stopped" });
    expect(later.record.reason).toMatch(/시간 제한\(60분\)/);
    expect(later.record.steps).toBeUndefined(); // 돌리지 않았다
  });

  it("단계 시간 제한을 넘기면 그 단계를 끄고 실패로 남긴다", async () => {
    const root = repo();
    const r = await runAttempt({ root, taskId: "T-1", cfg: { ...cfg, stepTimeoutMinutes: 0.005 }, steps: [step("slow", 0, { wait: 20_000 })], log: quiet });
    expect(r.exitCode).toBe(1);
    expect(r.record.steps[0]).toMatchObject({ ok: false, timedOut: true });
    expect(r.record.steps[0].errors[0]).toMatch(/단계 시간 제한/);
  }, 15_000);
});
