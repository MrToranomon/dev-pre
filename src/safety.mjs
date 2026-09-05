import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const heldLocks = new AsyncLocalStorage();
export function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function assertSafeName(value, label = "Name") {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()
    || value === "." || value === ".." || /[\\/:*?"<>|\x00-\x1f]/.test(value)
    || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value)
    || ["__proto__", "constructor", "prototype", ".file-organizer"].includes(value.toLowerCase())) {
    throw new Error(`${label}: 安全な名前を入力してください（予約名・末尾のドット・パス記号は使用できません）。`);
  }
}

export async function exists(target) {
  try { await fs.lstat(target); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export async function assertNoLinks(target) {
  for (let candidate = path.resolve(target); ; candidate = path.dirname(candidate)) {
    const stats = await fs.lstat(candidate).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (stats?.isSymbolicLink()) throw new Error(`リンクを経由する操作は保留しました: ${candidate}`);
    if (path.dirname(candidate) === candidate) break;
  }
}

export async function atomicJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  try { await fs.rename(temporary, file); }
  finally { await fs.unlink(temporary).catch(() => {}); }
}

export async function withOperationLock(config, action) {
  const lock = path.join(config.stateDirectory, "apply.lock");
  if (heldLocks.getStore() === lock) return action();
  await assertNoLinks(config.stateDirectory);
  await fs.mkdir(config.stateDirectory, { recursive: true });
  try { await fs.writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another operation may be running. 他の整理・設定変更・Undoの終了を待ってください。停止後も続く場合は診断を確認してください: ${lock}`);
    throw error;
  }
  try { return await heldLocks.run(lock, action); }
  finally { await fs.unlink(lock).catch(() => {}); }
}

// Both paths are validated at the point of use. File targets are created exclusively.
export async function moveEntrySafely(source, target, type = "file") {
  await assertNoLinks(source);
  await assertNoLinks(target);
  if (await exists(target)) throw Object.assign(new Error(`移動先がすでに存在します: ${target}`), { code: "EEXIST" });
  if (type === "directory" || type === "folder") {
    // Windows rename refuses existing destinations. Cross-volume directory deletion
    // cannot be rolled back reliably, so keep the complete source in place.
    if (process.platform !== "win32") throw new Error("フォルダ移動は現在Windowsのみ対応しています。");
    try { await fs.rename(source, target); }
    catch (error) {
      if (error.code === "EXDEV") throw new Error("別ドライブへのフォルダ移動は保留しました。元フォルダはそのまま残っています。");
      throw error;
    }
    return;
  }
  try {
    await fs.link(source, target);
    try { await fs.unlink(source); }
    catch (error) { await fs.unlink(target).catch(() => {}); throw error; }
  } catch (error) {
    if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) throw error;
    const before = await fs.lstat(source);
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    const after = await fs.lstat(source);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
      await fs.unlink(target).catch(() => {});
      throw new Error("コピー中にファイルが更新されたため移動を中止しました。");
    }
    try { await fs.utimes(target, before.atime, before.mtime); await fs.unlink(source); }
    catch (error) { await fs.unlink(target).catch(() => {}); throw error; }
  }
}
