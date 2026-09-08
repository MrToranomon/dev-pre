const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
module.exports = async ({ app, window, dataDirectory, getActivateCount }) => {
  const checks = [];
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  const waitFor = async (fn) => {
    for (let i = 0; i < 150; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); }
    throw new Error('Desktop check timed out');
  };
  await waitFor(() => evaluate('Boolean(state && document.querySelector(".home-summary"))'));
  assert.equal(await evaluate('typeof require'), 'undefined');
  assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
  checks.push('Dedicated window with sandbox and no Node access');
  assert.equal(await evaluate('typeof tigerGateDesktop.chooseFolders'), 'function');
  // Exercise the restricted IPC bridge without opening an interactive picker in a smoke test.
  const dialog = require('electron').dialog, originalPicker = dialog.showOpenDialog;
  try {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dataDirectory] });
    assert.deepEqual(await evaluate('tigerGateDesktop.chooseFolders()'), [dataDirectory]);
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    assert.deepEqual(await evaluate('tigerGateDesktop.chooseFolders()'), []);
  } finally { dialog.showOpenDialog = originalPicker; }
  checks.push('Restricted native folder picker supports selection and cancellation');
  await evaluate('mutate("/api/task/create", { title: "Desktop verification" })');
  assert.equal(await evaluate('state.tasks.some(t => t.title === "Desktop verification")'), true);
  checks.push('Bundled backend persists a task');
  window.close();
  assert.equal(window.isVisible(), false);
  assert.equal(window.isDestroyed(), false);
  checks.push('Close keeps the app available in the tray');
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), '--data-dir', dataDirectory, '--json-only'];
  spawn(process.execPath, args, { windowsHide: true, stdio: 'ignore' }).unref();
  await waitFor(() => getActivateCount() > 0 && window.isVisible());
  assert.equal(require('electron').BrowserWindow.getAllWindows().length, 1);
  checks.push('Second launch restores the existing window');
  await fs.writeFile(path.join(dataDirectory, 'desktop.png'), (await window.webContents.capturePage()).toPNG());
  await fs.writeFile(path.join(dataDirectory, 'desktop-results.json'), JSON.stringify({ checks, packaged: app.isPackaged, executable: process.execPath }, null, 2));
};
