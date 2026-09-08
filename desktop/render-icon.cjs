// Rasterize the single vector source for Windows at each native icon size.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const svg = await fs.readFile(path.join(__dirname, '..', 'workbench', 'icon.svg'), 'utf8');
  const window = new BrowserWindow({ width: 256, height: 256, show: false, transparent: true, frame: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}svg{width:100%;height:100%}</style>${svg}`));
  const pngs = [];
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    window.setContentSize(size, size);
    await new Promise(resolve => setTimeout(resolve, 50));
    const png = (await window.webContents.capturePage()).resize({ width: size, height: size }).toPNG();
    pngs.push({ size, png });
  }
  await fs.writeFile(path.join(__dirname, 'icon.png'), pngs.at(-1).png);
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  for (const [index, { size, png }] of pngs.entries()) {
    const pos = 6 + index * 16;
    header[pos] = header[pos + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, pos + 4); header.writeUInt16LE(32, pos + 6);
    header.writeUInt32LE(png.length, pos + 8); header.writeUInt32LE(offset, pos + 12);
    offset += png.length;
  }
  await fs.writeFile(path.join(__dirname, 'icon.ico'), Buffer.concat([header, ...pngs.map(item => item.png)]));
  window.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
