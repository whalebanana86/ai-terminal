// Run against an automation build: scripts/aiterm-eval.py -f scripts/e2e/repo-tabs.js
// Uses registered repositories and restores selection/preferences afterward.
const store = window.__aitermStore;
const invoke = window.__TAURI_INTERNALS__.invoke;
const original = store.getState();
const saved = Object.fromEntries(['repos','focus','selectedSessionId','viewer','openRepoIds','repoTabPaths','repoTabSessions'].map(k => [k,original[k]]));
const keys = ['focus','selectedSession','repoTabs'];
const preferences = await Promise.all(keys.map(key => invoke('kv_get', {key})));
const available = original.repos.filter(r => r.worktrees.some(w => w.exists && !w.bare)).slice(0,3);
if (available.length < 3) throw 'This smoke test needs three registered repositories';
const tabs = () => [...document.querySelectorAll('.repo-tabs [role="tab"]')];
const delay = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));
const assert = (ok, message) => { if (!ok) throw message; };
try {
  store.setState({repos:available,openRepoIds:[],repoTabPaths:{},repoTabSessions:{},focus:null,selectedSessionId:null,viewer:null});
  await delay();
  assert(tabs().length===0 && document.querySelector('.repo-tab-add'), 'Empty tabs still offer add');
  store.getState().openRepoTab(available[0].id);
  store.getState().openRepoTab(available[1].id);
  await delay();
  assert(tabs().length===2,'Explicit opening adds tabs');
  tabs()[0].click(); await delay();
  const firstPath=store.getState().focus.worktreePath;
  tabs()[0].dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true})); await delay();
  assert(tabs()[1].getAttribute('aria-selected')==='true','Keyboard selects last tab');
  document.querySelectorAll('.repo-tab-close')[0].click(); await delay();
  assert(tabs().length===1 && tabs()[0].getAttribute('aria-selected')==='true','Inactive close preserves active tab');
  store.getState().openRepoTab(available[0].id); await delay();
  assert(store.getState().focus.worktreePath===firstPath,'Reopen remembers worktree');
  store.getState().openRepoTab(available[0].id); await delay();
  assert(tabs().length===2,'Reopening deduplicates');
  store.setState({repos:[...available]}); await delay();
  assert(tabs().length===2,'Discovery does not add tabs');
  tabs()[1].dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true})); await delay();
  assert(tabs().length===1,'Delete closes a tab');
  document.querySelector('.repo-tab-close').click(); await delay();
  assert(tabs().length===0 && !store.getState().focus,'Last close clears focus');
  const persisted=JSON.parse(await invoke('kv_get',{key:'repoTabs'}));
  assert(persisted.ids.length===0,'Empty state persisted');
  await store.getState().boot(); await delay();
  assert(tabs().length===0 && !store.getState().focus,'Empty state survives boot');
  const priorSession = store.getState().sessions.find(s => s.cwdExists && available[0].worktrees.some(w => w.path === s.worktreePath));
  assert(priorSession, 'Need a recorded session in the first repository');
  store.getState().setFocusWorktree(priorSession.worktreePath);
  store.getState().selectSession(priorSession.id);
  store.getState().openRepoTab(available[1].id); await delay();
  store.getState().openRepoTab(available[0].id); await delay(400);
  assert(store.getState().selectedSessionId === priorSession.id, 'Returning restores selected session');
  assert(document.querySelector('.session.on')?.dataset.session === priorSession.id, 'Restored session is selected in the UI');
  return {add:true,close:true,reopen:true,noDuplicates:true,keyboard:true,noDiscoveryTabs:true,emptyPersistence:true,sessionRestore:true};
} finally {
  store.setState(saved); await delay(300);
  await Promise.all(keys.map((key,i)=>invoke('kv_set',{key,value:preferences[i]??'null'})));
}
