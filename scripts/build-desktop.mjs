import { packager } from '@electron/packager';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'dist', 'releases', '2.6.0');
const destination = path.join(output, 'TigerGate-win32-x64');
if (await fs.stat(destination).catch(() => null)) throw new Error('Existing TigerGate build: close the app and move this exact folder to a backup before rebuilding.');
const targets = await packager({
  dir: root, out: output, name: 'TigerGate',
  platform: 'win32', arch: 'x64', overwrite: false, asar: false,
  icon: path.join(root, 'desktop', 'icon.ico'),
  appVersion: '2.6.0', executableName: 'TigerGate',
  win32metadata: { CompanyName: 'TigerGate', FileDescription: 'TigerGate', ProductName: 'TigerGate' },
  ignore: [/^\/dist(?:\/|$)/, /^\/\.git(?:\/|$)/, /^\/test(?:\/|$)/, /^\/docs(?:\/|$)/, /^\/scripts\/perfectwork-ui\.mjs$/],
});
for (const target of targets) {
  await fs.copyFile(path.join(root, 'desktop', 'launcher.vbs'), path.join(target, 'launch-perfectwork.vbs'));
  console.log(path.join(target, 'TigerGate.exe'));
}
