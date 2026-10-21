// 최종 완료 조건 검증: 외부에서 만든 세션을 찾아 재개하고, 이전 맥락(암호 단어)과 세 패널을 확인한다.
// 사용: scripts/aiterm-eval.py -f scripts/e2e/resume-check.js  (아래 TARGET 을 바꿔 Claude/Codex 각각 실행)
const TARGET = window.__resumeTarget ?? { agent: "claude", cwdPart: "aiterm-e2e/demo-claude", word: "파란고래-42" };
delete window.__resumeTarget; // 다음 실행에 남지 않게
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const S = window.__aitermStore;
const st = () => S.getState();
const inv = window.__TAURI_INTERNALS__.invoke;

await st().refreshSessions();
// 첫 메시지에 그 암호 단어가 들어 있는 세션(외부에서 만든 것)을 고른다.
const s = st().sessions.find((x) => x.agent === TARGET.agent && x.cwd?.includes(TARGET.cwdPart) && (x.firstPrompt ?? "").includes(TARGET.word));
if (!s) return { ok: false, reason: "세션을 찾지 못함" };
if (s.runningExecId) await inv("exec_kill", { id: s.runningExecId }), await wait(1500), await st().refreshExecs();

st().selectSession(s.id);
await wait(1500);
const panels = {
  focus: st().focus?.worktreePath,
  gitBranch: document.querySelector("[data-testid=git-current-branch]")?.innerText,
  treeRoot: document.querySelector(".tree-wrap .filters .path-text")?.innerText,
  header: document.querySelector("[data-testid=session-branches]")?.innerText,
};

const before = st().execs.length;
document.querySelector("[data-testid=resume]").click();
let e;
const txt = () => (e && window.__aiterm.terminalText(e.id)) || "";
// 화면이 준비될 때까지 기다리며, 입력 전에 반드시 화면을 확인한다.
for (let i = 0; i < 80; i++) {
  await wait(500);
  if (st().execs.length > before) e = st().execs.at(-1);
  const t = txt();
  if (/Update now/.test(t)) {
    // 업데이트 안내: 설치하지 않고 "Skip" 선택(커서가 Skip 에 있는지 확인 후 Enter)
    await inv("exec_write", { id: e.id, data: "\x1b[B" });
    await wait(400);
    if (!/›\s*2\. Skip/.test(txt())) return { ok: false, reason: "Skip 선택 실패", screen: txt().slice(-400) };
    await inv("exec_write", { id: e.id, data: "\r" });
    continue;
  }
  if (/trust/i.test(t) && /Yes|No, exit/.test(t)) return { ok: false, reason: "신뢰 질문이 나옴(수동 확인 필요)" };
  if (t.includes(TARGET.word) && /(auto mode|Ask Codex|❯ *$|›)/m.test(t.split("\n").slice(-6).join("\n"))) break;
}
await wait(1500);
// 판정은 "이번에 보낸" 질문 뒤의 화면만 본다(이전 대화의 같은 질문·답에 속지 않게).
const asked = (txt().match(/그대로 말해줘/g) ?? []).length;
await inv("exec_write", { id: e.id, data: "아까 내가 알려준 암호 단어를 그대로 말해줘. 다른 말은 하지 마." });
await wait(700);
await inv("exec_write", { id: e.id, data: "\r" });
let answered = false;
let blocked = false;
let finalCount = asked;
for (let i = 0; i < 90; i++) {
  await wait(1000);
  const parts = txt().split("그대로 말해줘");
  finalCount = parts.length - 1;
  if (finalCount <= asked) continue;
  const after = parts.at(-1) ?? "";
  if (/open in another app|active writer/.test(txt().split("\n").slice(-8).join("\n"))) {
    blocked = true;
    break;
  }
  if (new RegExp(`(⏺|•)\\s*${TARGET.word}`).test(after)) {
    answered = true;
    break;
  }
}
const env = await inv("exec_list");
return {
  ok: answered && !blocked,
  blockedByOtherApp: blocked,
  evidence: { agent: TARGET.agent, questionsBefore: asked, questionsAfter: finalCount, newExec: e?.id !== s.runningExecId },
  session: { id: s.id, cwd: s.cwd, worktree: s.worktreePath, repo: s.repoName, start: s.startBranch, current: s.currentBranch },
  panels,
  exec: env.find((x) => x.id === e.id),
  transcriptSavingOff: /Transcript saving is off/.test(txt()),
  tail: txt().split("\n").filter((l) => l.trim()).slice(-6),
};
