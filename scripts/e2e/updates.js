// Run against an automation build: scripts/aiterm-eval.py -f scripts/e2e/updates.js
// Read-only live smoke test: checks GitHub and opens/closes the update dialog.
// Never clicks an install action or restarts the app.
const invoke = window.__TAURI_INTERNALS__.invoke;
const info = await invoke('check_update');
if (!info.currentVersion || !info.version || typeof info.available !== 'boolean') throw 'Invalid update metadata';
await invoke('plugin:event|emit', { event: 'check-updates', payload: null });
let dialog;
for (let i = 0; i < 200; i++) {
  dialog = document.querySelector('[data-testid="update-dialog"]');
  if (dialog && dialog.querySelector('.modal-actions button:not(:disabled)') &&
      !/확인하는 중|Checking for a new version/i.test(dialog.textContent)) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!dialog || !dialog.textContent.includes(info.available ? info.version : info.currentVersion)) {
  throw 'The dialog did not show the checked version';
}
const text = dialog.textContent;
if (dialog.querySelector('[role="alert"]')) throw text;
dialog.querySelector('.modal-actions button').click();
return { currentVersion: info.currentVersion, latestVersion: info.version, available: info.available, text };
