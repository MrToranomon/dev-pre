import fs from 'node:fs/promises';
import path from 'node:path';
import { within } from './safety.mjs';

const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
export const storageRoots = settings => [...new Map((settings.healthRoots ?? settings.searchRoots).map(root => [key(path.resolve(root)), path.resolve(root)])).values()];
export const storageKey = settings => JSON.stringify(storageRoots(settings).sort());

// Metadata only: no hashing, content reads, junction traversal or file changes.
export async function storageOverview(settings, { maxFiles = 200_000, maxDirectories = 20_000, maxMs = 20_000 } = {}) {
  const roots = storageRoots(settings).sort((a, b) => b.length - a.length);
  const folders = roots.map(root => ({ root, bytes: 0, files: 0, volumeId: null }));
  const volumes = new Map(), errors = [], ranking = new Map();
  for (const folder of folders) {
    try {
      const probe = await fs.stat(folder.root).then(() => folder.root, () => path.parse(folder.root).root);
      const [stat, disk] = await Promise.all([fs.stat(probe), fs.statfs(probe)]);
      const id = String(stat.dev);
      folder.volumeId = id;
      if (!volumes.has(id)) {
        const total = disk.blocks * disk.bsize, free = disk.bfree * disk.bsize;
        volumes.set(id, { id, root: path.parse(probe).root, total, free, used: Math.max(0, total - free), usedPercent: total ? (total - free) / total * 100 : 0 });
      }
    } catch (error) { errors.push({ path: folder.root, error: error.message }); }
  }
  const queue = [...roots], visited = new Set(), started = Date.now();
  let files = 0, directories = 0, limited = false;
  while (queue.length) {
    if (files >= maxFiles || directories >= maxDirectories || Date.now() - started >= maxMs) { limited = true; break; }
    const directory = queue.shift();
    if (visited.has(key(directory))) continue;
    visited.add(key(directory)); directories++;
    try {
      const info = await fs.lstat(directory);
      if (info.isSymbolicLink()) continue;
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (files >= maxFiles || Date.now() - started >= maxMs) { limited = true; break; }
        if (entry.isSymbolicLink()) continue;
        const location = path.join(directory, entry.name);
        if (entry.isDirectory()) { queue.push(location); continue; }
        if (!entry.isFile()) continue;
        try {
          const stat = await fs.lstat(location);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          const folder = folders.find(item => within(item.root, location));
          if (!folder) continue;
          folder.files++; folder.bytes += stat.size; files++;
          const relative = path.relative(folder.root, location).split(path.sep);
          const direct = relative.length === 1;
          const groupRoot = direct ? folder.root : path.join(folder.root, relative[0]);
          const groupKey = key(groupRoot) + (direct ? ':direct' : ':children');
          const group = ranking.get(groupKey) ?? { root: groupRoot, direct, bytes: 0, files: 0, volumeId: folder.volumeId };
          group.bytes += stat.size; group.files++; ranking.set(groupKey, group);
        } catch (error) { if (errors.length < 100) errors.push({ path: location, error: error.message }); }
      }
    } catch (error) { if (errors.length < 100) errors.push({ path: directory, error: error.message }); }
  }
  const decorate = items => items.sort((a, b) => b.bytes - a.bytes).map(item => ({ ...item, percent: volumes.get(item.volumeId)?.total ? item.bytes / volumes.get(item.volumeId).total * 100 : null }));
  return { key: storageKey(settings), scannedAt: new Date().toISOString(), volumes: [...volumes.values()], folders: decorate(folders), ranking: decorate([...ranking.values()]), files, limited, errors, maxFiles, maxDirectories, maxMs };
}
