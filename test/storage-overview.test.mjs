import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { storageOverview } from '../src/storage-overview.mjs';
import { WorkspaceStore } from '../src/workspace-store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tigergate-storage-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  return root;
}
test('storage deduplicates drives and nested roots, ranks all file types including build folders', async t => {
  const root = await fixture(t), child = path.join(root,'child'), build = path.join(root,'build');
  await fs.mkdir(child); await fs.mkdir(build);
  await fs.writeFile(path.join(child,'big.bin'), Buffer.alloc(1000));
  await fs.writeFile(path.join(build,'output.bin'), Buffer.alloc(500));
  await fs.writeFile(path.join(root,'small.txt'), 'small');
  const result = await storageOverview({ healthRoots:[root,child,root], searchRoots:[] });
  assert.equal(result.volumes.length,1);
  assert.ok(result.volumes[0].total > 0);
  assert.equal(result.volumes[0].total, result.volumes[0].used + result.volumes[0].free);
  assert.equal(result.files,3);
  assert.equal(result.folders.length,2);
  assert.equal(result.folders[0].root,child);
  assert.equal(result.folders.reduce((sum,item)=>sum+item.bytes,0),1505);
  assert.equal(result.ranking.reduce((sum,item)=>sum+item.bytes,0),1505);
  assert.ok(result.ranking.some(item=>item.root===build));
  assert.equal(result.folders[0].percent,1000/result.volumes[0].total*100);
  assert.equal(result.limited,false);
});
test('storage marks partial scans, reports missing folders, and does not follow junctions', async t => {
  const root = await fixture(t), target = await fixture(t);
  await fs.writeFile(path.join(target,'private.bin'), Buffer.alloc(100));
  await fs.symlink(target,path.join(root,'linked'),process.platform==='win32'?'junction':'dir');
  await fs.writeFile(path.join(root,'a'),'a'); await fs.writeFile(path.join(root,'b'),'bb');
  const result = await storageOverview({searchRoots:[root,path.join(root,'missing')]});
  assert.equal(result.files,2);
  assert.ok(result.errors.length > 0);
  assert.equal(result.folders.reduce((sum,item)=>sum+item.bytes,0),3);
  const partial = await storageOverview({searchRoots:[root]},{maxFiles:1});
  assert.equal(partial.limited,true); assert.equal(partial.files,1);
});
test('diagnostic folder choices persist independently, invalid settings are atomic', async t => {
  const root = await fixture(t), store = await new WorkspaceStore(root).init();
  const search = store.data.settings.searchRoots;
  const before = store.snapshot();
  for (const healthRoots of [[], ['relative'], Array(21).fill(root)]) {
    await assert.rejects(store.updateSettings({healthRoots}));
    assert.deepEqual(store.snapshot(),before);
  }
  await store.updateSettings({healthRoots:[root,root]});
  const reload = await new WorkspaceStore(root).init();
  assert.deepEqual(reload.data.settings.healthRoots,[root]);
  assert.deepEqual(reload.data.settings.searchRoots,search);
});
test('focus accepts arbitrary whole minutes and rejects fractional and out of range values', async t => {
  const root = await fixture(t), store = await new WorkspaceStore(root).init();
  for (const plannedMinutes of [0,1.5,181]) await assert.rejects(store.startFocus({plannedMinutes}));
  for (const plannedMinutes of [1,37,180]) {
    await store.startFocus({plannedMinutes});
    assert.equal(store.summary().computed.activeSession.plannedMinutes, plannedMinutes);
    await store.stopFocus({});
  }
});
