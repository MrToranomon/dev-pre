import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import electron from 'electron';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'perfectwork-desktop-'));
const root = path.resolve(import.meta.dirname, '..');
const executable = process.env.PERFECTWORK_DESKTOP_EXE || electron;
const args = [...(process.env.PERFECTWORK_DESKTOP_EXE ? [] : [root]), '--smoke-test', '--data-dir', directory, '--json-only'];
const env = { ...process.env, PERFECTWORK_DEFAULT_ROOT: directory };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, args, { env, windowsHide: true, stdio: 'ignore' });
console.log(`Desktop test: ${directory}`);
const exit = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.kill(); reject(new Error('Desktop test timeout')); }, 60000);
  child.once('error', reject);
  child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
});
if (exit !== 0) {
  console.error(await fs.readFile(path.join(directory, 'desktop-error.txt'), 'utf8').catch(() => `Exit: ${exit}`));
  process.exitCode = 1;
} else {
  console.log(await fs.readFile(path.join(directory, 'desktop-results.json'), 'utf8'));
  try { await fs.access(path.join(directory, 'instance.json')); throw new Error('Backend lock still exists after quit'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log('Graceful quit released the workspace lock.');
}
