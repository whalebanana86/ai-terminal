// Run in an isolated DEV automation app with two running test terminals in different worktrees.
// Checks renderer transitions frame by frame; never starts or stops an agent.
const store = window.__aitermStore;
const original = store.getState();
const runs = original.execs.filter(e => !e.exited && e.worktreePath);
const first = runs[0], second = runs.find(e => e.worktreePath !== first?.worktreePath);
if (!first || !second) throw 'Need two running test terminals in different worktrees';
const selected = [first, second];
const invoke = window.__TAURI_INTERNALS__.invoke;
const keys = ['focus', 'selectedSession', 'repoTabs'];
const preferences = await Promise.all(keys.map(key => invoke('kv_get', {key})));
const {api} = await import('/src/api.ts');
const originalResize = api.execResize, originalAttach = api.execAttach;
const resizes = [], attaches = [], baseline = new Map();
const wait = ms => new Promise(r => setTimeout(r, ms));
const hostFor = e => document.querySelector(`[data-exec="${e.id}"]`);
const assert = (condition, message) => { if (!condition) throw message; };
const open = e => {
  const repo = store.getState().repos.find(r => r.worktrees.some(w => w.path === e.worktreePath));
  assert(repo, 'Missing test repository');
  store.getState().openRepoTab(repo.id);
  store.getState().selectSession(e.sessionId ?? `exec:${e.id}`);
};
let checkedFrames = 0, settlingFrames = 0;
try {
  for (const e of selected) {
    open(e); await wait(500);
    const host = hostFor(e), screen = host?.querySelector('.xterm-screen');
    const size = window.__aiterm.terminalCursor(e.id), rect = screen?.getBoundingClientRect();
    assert(host && rect && size && getComputedStyle(host).visibility === 'visible', 'Terminal did not become visible');
    baseline.set(e.id, {host, cellWidth:rect.width/size.cols, cellHeight:rect.height/size.rows});
  }
  api.execResize = (...args) => { resizes.push(args); return originalResize(...args); };
  api.execAttach = (...args) => { attaches.push(args[0]); return originalAttach(...args); };
  for (let i = 0; i < 20; i++) {
    const e = selected[i % 2]; open(e);
    for (let frame = 0; frame < 4; frame++) {
      await new Promise(requestAnimationFrame);
      const host = hostFor(e), expected = baseline.get(e.id);
      assert(host === expected.host, 'Tab switch recreated terminal DOM');
      if (getComputedStyle(host).visibility !== 'visible') { settlingFrames++; continue; }
      const rect = host.querySelector('.xterm-screen').getBoundingClientRect();
      const size = window.__aiterm.terminalCursor(e.id);
      assert(Math.abs(rect.width/size.cols - expected.cellWidth) < .05, 'Visible frame had stale column geometry');
      assert(Math.abs(rect.height/size.rows - expected.cellHeight) < .05, 'Visible frame had stale row geometry');
      checkedFrames++;
    }
  }
  assert(checkedFrames > 0, 'No rendered frames were checked');
  assert(attaches.length === 0, 'Switching tabs reattached the PTY');
  assert(resizes.length === 0, `Unchanged terminal geometry sent ${resizes.length} PTY resize requests`);
  return {switches:20,checkedFrames,settlingFrames,recreatedTerminals:0,reattaches:0,redundantResizes:0};
} finally {
  api.execResize = originalResize; api.execAttach = originalAttach;
  store.setState(original); await wait(300);
  await Promise.all(keys.map((key,i) => invoke('kv_set', {key,value:preferences[i] ?? 'null'})));
}
