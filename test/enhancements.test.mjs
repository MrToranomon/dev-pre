import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { loadConfig, createPlan, applyPlan, undoLatest, diagnose } from "../src/file-organizer.mjs";
import { createCategory, dashboardState, updateOptions, updateRule, reassignItems, readConfigDocument, renameCategory } from "../src/config-manager.mjs";
import { moveEntrySafely } from "../src/safety.mjs";

async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-v3-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "inbox");
  const destination = path.join(root, "outbox");
  await fs.mkdir(source); await fs.mkdir(destination);
  const file = path.join(root, "config.json");
  await fs.writeFile(file, JSON.stringify({ source, destination, categories: { Text: [".txt"], Archives: [".tar.gz"] }, options: { minimumAgeMinutes: 0, stateDirectory: path.join(root, "state") }, ...extra }));
  return { root, source, destination, file, config: await loadConfig(file) };
}

test("unknown types have a validated destination and appear in inventory", async t => {
  const f = await fixture(t);
  await updateOptions(f.file, { includeUnknown: true });
  await fs.writeFile(path.join(f.source, "notes.xyz"), "unknown");
  const config = await loadConfig(f.file);
  const plan = await createPlan(config);
  assert.equal(plan.planned[0].target, path.join(f.destination, "Other", "notes.xyz"));
  await applyPlan(plan, config);
  assert.equal((await dashboardState(f.file)).categories.find(item => item.name === "Other").items.length, 1);
});

test("compound extensions match the longest suffix while executable protection remains", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, "backup.tar.gz"), "archive");
  await updateRule(f.file, "addExtension", "Text", ".txt.exe");
  await fs.writeFile(path.join(f.source, "payload.txt.exe"), "exe");
  const plan = await createPlan(await loadConfig(f.file));
  assert.equal(plan.planned[0].category, "Archives");
  assert.equal(plan.skipped.find(item => item.name.endsWith("exe")).reason, "protected");
});

test("rejects reserved category names without changing configuration", async t => {
  const f = await fixture(t);
  const before = await fs.readFile(f.file, "utf8");
  for (const name of ["CON", "nul.txt", "A.", "__proto__", "constructor", ".file-organizer"]) await assert.rejects(createCategory(f.file, name));
  assert.equal(await fs.readFile(f.file, "utf8"), before);
});

test("settings are validated before replacement and previous settings are backed up", async t => {
  const f = await fixture(t);
  const before = await readConfigDocument(f.file);
  await assert.rejects(updateOptions(f.file, { dateFolders: "day" }));
  assert.deepEqual(await readConfigDocument(f.file), before);
  await updateOptions(f.file, { dateFolders: "month", minimumAgeMinutes: 2 });
  assert.deepEqual(JSON.parse(await fs.readFile(`${f.file}.backup.json`, "utf8")), before);
  assert.equal((await loadConfig(f.file)).options.dateFolders, "month");
});

test("organize and reassignment undo share one operation lock", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.config.stateDirectory);
  await fs.writeFile(path.join(f.config.stateDirectory, "apply.lock"), "busy");
  await assert.rejects(undoLatest(f.config), /Another operation/);
  await assert.rejects(reassignItems(f.config, await readConfigDocument(f.file), "Text", "Archives", ["test.txt"]), /Another operation/);
});

test("safe moves refuse existing targets and preserve both contents", async t => {
  const f = await fixture(t);
  const from = path.join(f.source, "a.txt"); const to = path.join(f.destination, "a.txt");
  await fs.writeFile(from, "original"); await fs.writeFile(to, "existing");
  await assert.rejects(moveEntrySafely(from, to), { code: "EEXIST" });
  assert.equal(await fs.readFile(from, "utf8"), "original");
  assert.equal(await fs.readFile(to, "utf8"), "existing");
});

test("a folder whose child changed after preview is left in place", async t => {
  const f = await fixture(t, { folderCategories: { Apps: ["Portable"] } });
  const folder = path.join(f.source, "Portable"); await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "data.bin"), "initial");
  const plan = await createPlan(f.config);
  await fs.writeFile(path.join(folder, "data.bin"), "changed contents");
  const record = await applyPlan(plan, f.config);
  assert.equal(record.moves.length, 0);
  assert.equal(record.notMoved[0].reason, "changed since preview");
});

test("junction destinations cannot redirect moves", async t => {
  const f = await fixture(t);
  const elsewhere = path.join(f.root, "elsewhere"); await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, path.join(f.destination, "Text"), process.platform === "win32" ? "junction" : "dir");
  await fs.writeFile(path.join(f.source, "a.txt"), "safe");
  const record = await applyPlan(await createPlan(f.config), f.config);
  assert.equal(record.moves.length, 0);
  assert.equal(await fs.readFile(path.join(f.source, "a.txt"), "utf8"), "safe");
});

test("doctor reports malformed history", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.config.stateDirectory, "history"), { recursive: true });
  await fs.writeFile(path.join(f.config.stateDirectory, "history", "broken.json"), "{");
  assert.equal((await diagnose(f.config)).find(check => check.label === "History files are readable").ok, false);
});

test("settings cannot change while another operation holds the lock", async t => {
  const f = await fixture(t);
  const before = await readConfigDocument(f.file);
  await fs.mkdir(f.config.stateDirectory);
  await fs.writeFile(path.join(f.config.stateDirectory, "apply.lock"), "busy");
  await assert.rejects(updateOptions(f.file, { minimumAgeMinutes: 3 }), /Another operation/);
  assert.deepEqual(await readConfigDocument(f.file), before);
});

test("implicit unknown category can be renamed with its items", async t => {
  const f = await fixture(t);
  await updateOptions(f.file, { includeUnknown: true });
  await fs.writeFile(path.join(f.source, "one.xyz"), "one");
  const config = await loadConfig(f.file);
  await applyPlan(await createPlan(config), config);
  await renameCategory(f.file, "Other", "未分類");
  assert.equal((await loadConfig(f.file)).options.unknownCategory, "未分類");
  assert.equal(await fs.readFile(path.join(f.destination, "未分類", "one.xyz"), "utf8"), "one");
});

test("partial undo retries do not move a replacement at an already restored path", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, "a.txt"), "a");
  await fs.writeFile(path.join(f.source, "b.txt"), "b");
  const record = await applyPlan(await createPlan(f.config), f.config);
  const b = record.moves.find(move => move.from.endsWith("b.txt"));
  await fs.rename(b.to, path.join(f.root, "saved-b.txt"));
  const firstUndo = await undoLatest(f.config);
  assert.equal(firstUndo.status, "partially-undone");
  const a = record.moves.find(move => move.from.endsWith("a.txt"));
  await fs.writeFile(a.to, "new unrelated data");
  await fs.rename(path.join(f.root, "saved-b.txt"), b.to);
  assert.equal((await undoLatest(f.config)).status, "undone");
  assert.equal(await fs.readFile(a.to, "utf8"), "new unrelated data");
  assert.equal(await fs.readFile(b.from, "utf8"), "b");
});

test("HTTP preview selection, stale config rejection, authentication and undo", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, "one.txt"), "one"); await fs.writeFile(path.join(f.source, "two.txt"), "two");
  const child = spawn(process.execPath, ["manage.mjs", "--no-open", "--config", f.file], { cwd: path.resolve(import.meta.dirname, ".."), windowsHide: true });
  t.after(async () => { child.kill(); await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); }); });
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server did not start")), 10000);
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\w+/); if (match) { clearTimeout(timeout); resolve(new URL(match[0])); } });
    child.once("error", reject);
  });
  const headers = { "X-Orbit-Token": url.searchParams.get("token"), "Content-Type": "application/json" };
  const page = await fetch(url);
  assert.equal(page.status, 200);
  const cookie = page.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(new URL("/", url), { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(new URL("/", url))).status, 403);
  const request = async (route, body) => { const response = await fetch(new URL(route, url), { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() }; };
  assert.equal((await fetch(new URL("/api/state", url))).status, 403);
  assert.equal((await fetch(new URL("/api/state", url), { headers: { ...headers, Origin: "https://example.invalid" } })).status, 403);
  let preview = (await request("/api/preview")).data;
  await request("/api/options", { minimumAgeMinutes: 0.1 });
  assert.equal((await request("/api/organize", { previewId: preview.id, names: ["one.txt"] })).status, 409);
  await request("/api/options", { minimumAgeMinutes: 0 });
  preview = (await request("/api/preview")).data;
  const applied = await request("/api/organize", { previewId: preview.id, names: ["one.txt"] });
  assert.equal(applied.status, 200); assert.equal(applied.data.result.moved, 1);
  assert.equal(await fs.readFile(path.join(f.source, "two.txt"), "utf8"), "two");
  assert.equal((await request("/api/organize", { previewId: preview.id, names: ["one.txt"] })).status, 409);
  assert.equal((await request("/api/history")).data.records[0].items, 1);
  assert.equal((await request("/api/undo-organize", {})).data.record.status, "undone");
  assert.equal(await fs.readFile(path.join(f.source, "one.txt"), "utf8"), "one");
});
