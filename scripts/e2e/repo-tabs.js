// Run against an automation build: scripts/aiterm-eval.py -f scripts/e2e/repo-tabs.js
// Uses existing registered repositories and restores selection/preferences afterward.
const store = window.__aitermStore;
const invoke = window.__TAURI_INTERNALS__.invoke;
const original = store.getState();
const saved = { repos: original.repos, focus: original.focus, selectedSessionId: original.selectedSessionId, viewer: original.viewer };
const preferences = await Promise.all(['focus', 'selectedSession'].map((key) => invoke('kv_get', { key })));
const remembered = localStorage.getItem('aiterm.repoWorktrees');
const available = original.repos.filter((r) => r.worktrees.some((w) => w.exists && !w.bare));
if (available.length < 3) throw 'This smoke test needs three registered repositories';
const tabs = () => [...document.querySelectorAll('.repo-tabs [role="tab"]')];
const delay = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (ok, message) => { if (!ok) throw message; };
try {
  const start = available[0].worktrees.find((w) => w.exists && !w.bare).path;
  store.setState({ repos: available.slice(0, 2), focus: { worktreePath: start, source: 'manual' }, selectedSessionId: null, viewer: null });
  await delay();
  assert(tabs().length === 2, 'Two repository tabs should be visible');
  tabs()[1].click();
  await delay();
  assert(tabs()[1].getAttribute('aria-selected') === 'true', 'Click selects the second repository');
  assert(available[1].worktrees.some((w) => w.path === store.getState().focus.worktreePath), 'Focus follows the selected repository');
  tabs()[0].click();
  await delay();
  assert(store.getState().focus.worktreePath === start, 'Returning to a repository restores its worktree');
  tabs()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  await delay();
  assert(tabs()[1].getAttribute('aria-selected') === 'true', 'Keyboard navigation selects the last tab');
  store.setState({ repos: available.slice(0, 3) });
  await delay();
  assert(tabs().length === 3, 'An added repository produces another tab');
  return { tabSwitch: true, worktreeRestore: true, keyboardNavigation: true, newTab: true };
} finally {
  store.setState(saved);
  await delay(300);
  await Promise.all(['focus', 'selectedSession'].map((key, index) => invoke('kv_set', { key, value: preferences[index] ?? 'null' })));
  if (remembered === null) localStorage.removeItem('aiterm.repoWorktrees'); else localStorage.setItem('aiterm.repoWorktrees', remembered);
}
