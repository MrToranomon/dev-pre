const { app, BrowserWindow, Menu, Tray, nativeImage, screen, dialog, shell, utilityProcess, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const dataArg = process.argv.indexOf('--data-dir');
const dataDirectory = dataArg >= 0 ? path.resolve(process.argv[dataArg + 1]) : process.env.PERFECTWORK_DATA_DIR || path.join(process.env.LOCALAPPDATA, 'PerfectWork');
const smoke = process.argv.includes('--smoke-test');
if (smoke && (dataArg < 0 || !path.basename(dataDirectory).startsWith('perfectwork-desktop-'))) throw new Error('Smoke tests require an isolated test directory.');
app.setName('TigerGate');
app.setAppUserModelId('local.perfectwork.desktop');
app.setPath('userData', path.join(dataDirectory, 'desktop'));
const instanceKey = crypto.createHash('sha256').update(dataDirectory.toLowerCase()).digest('hex').slice(0, 12);
app.setPath('sessionData', path.join(dataDirectory, 'desktop', 'session'));
let window, tray, backend, backendOwned = false, quitting = false, appUrl;
let activateCount = 0;
const geometryFile = path.join(app.getPath('userData'), 'window.json');
const hasLock = app.requestSingleInstanceLock({ instanceKey });
if (!hasLock) app.quit();
else {
  app.on('second-instance', () => { activateCount++; showWindow(); });
  app.on('activate', showWindow);
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    saveGeometry();
    if (backendOwned && backend?.pid) {
      backend.once('exit', () => app.quit());
      backend.postMessage({ type: 'shutdown' });
    } else app.quit();
  });
  app.whenReady().then(start).catch((error) => {
    if (smoke) { fs.writeFileSync(path.join(dataDirectory, 'desktop-error.txt'), String(error.stack)); app.exit(1); }
    else { dialog.showErrorBox('TigerGate', `起動できませんでした。\n${error.message}`); app.quit(); }
  });
}

function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  writeStatus();
}
function writeStatus() {
  try {
    fs.mkdirSync(dataDirectory, { recursive: true });
    const file = path.join(dataDirectory, 'desktop-status.json');
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid, executable: process.execPath, packaged: app.isPackaged, visible: Boolean(window && !window.isDestroyed() && window.isVisible()), activations: activateCount, updatedAt: new Date().toISOString() }));
    fs.renameSync(temporary, file);
  } catch {}
}
function saveGeometry() {
  if (!window || window.isDestroyed()) return;
  try {
    fs.mkdirSync(path.dirname(geometryFile), { recursive: true });
    fs.writeFileSync(geometryFile, JSON.stringify({ ...window.getNormalBounds(), maximized: window.isMaximized() }));
  } catch {}
}
async function connectBackend() {
  return new Promise((resolve, reject) => {
    const args = ['--no-open', '--data-dir', dataDirectory];
    if (process.argv.includes('--json-only')) args.push('--json-only');
    const launcher = app.isPackaged ? path.join(path.dirname(process.execPath), 'launch-perfectwork.vbs') : path.join(root, 'launch-perfectwork.vbs');
    backend = utilityProcess.fork(path.join(root, 'work.mjs'), args, {
      cwd: root, stdio: 'pipe', serviceName: 'TigerGate Data',
      env: { ...process.env, PERFECTWORK_LAUNCHER: launcher },
    });
    let output = '', errors = '', settled = false;
    const timer = setTimeout(() => { if (!settled) reject(new Error('データ接続がタイムアウトしました。')); }, 30000);
    backend.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-2000); });
    backend.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\w+/);
      if (match && !settled) {
        settled = true; clearTimeout(timer);
        backendOwned = !output.includes('already open');
        resolve(match[0]);
      }
    });
    backend.on('exit', (code) => {
      clearTimeout(timer);
      if (!settled) reject(new Error(errors || `データ処理を開始できませんでした (${code})。`));
      else if (backendOwned && !quitting) {
        backendOwned = false;
        dialog.showErrorBox('TigerGate', 'データ接続が終了しました。アプリを終了して開き直してください。');
      }
    });
  });
}
function openLink(url) {
  try { if (['https:', 'http:'].includes(new URL(url).protocol)) shell.openExternal(url); } catch {}
}
async function start() {
  appUrl = await connectBackend();
  let geometry = {};
  try { geometry = JSON.parse(fs.readFileSync(geometryFile, 'utf8')); } catch {}
  const bounds = { width: Math.max(800, Math.min(1800, geometry.width || 1280)), height: Math.max(600, Math.min(1400, geometry.height || 900)) };
  if (Number.isFinite(geometry.x) && Number.isFinite(geometry.y) && screen.getAllDisplays().some(({ workArea: a }) => geometry.x >= a.x && geometry.x < a.x + a.width - 80 && geometry.y >= a.y && geometry.y < a.y + a.height - 80)) Object.assign(bounds, { x: geometry.x, y: geometry.y });
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  window = new BrowserWindow({ ...bounds, title: 'TigerGate', icon, show: false, minWidth: 760, minHeight: 560, backgroundColor: '#f7f8fa', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: false },
  });
  ipcMain.handle('choose-health-folders', async event => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== new URL(appUrl).origin) throw new Error('Untrusted caller');
    const result = await dialog.showOpenDialog(window, { title: '診断するフォルダを選択', properties: ['openDirectory', 'multiSelections'] });
    return result.canceled ? [] : result.filePaths;
  });
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(({ url }) => { openLink(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== new URL(appUrl).origin) { event.preventDefault(); openLink(url); }
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.on('close', (event) => { saveGeometry(); if (!quitting) { event.preventDefault(); window.hide(); writeStatus(); } });
  window.on('closed', () => { window = null; });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'TigerGate', submenu: [ { label: '表示', click: showWindow }, { label: '終了', accelerator: 'Ctrl+Q', click: () => app.quit() } ] },
    { label: '編集', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '表示', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'reload' }, { role: 'togglefullscreen' }] },
  ]));
  tray = new Tray(icon.resize({ width: 20, height: 20 }));
  tray.setToolTip('TigerGate');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'TigerGateを開く', click: showWindow }, { type: 'separator' }, { label: '終了', click: () => app.quit() }]));
  tray.on('click', showWindow);
  await window.loadURL(appUrl);
  if (geometry.maximized) window.maximize();
  showWindow();
  if (smoke) {
    await require('./smoke.cjs')({ app, window, dataDirectory, appUrl, getActivateCount: () => activateCount });
    app.quit();
  }
}
