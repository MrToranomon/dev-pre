import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { WorkspaceStore } from "../src/workspace-store.mjs";
import { SearchEngine, fileHealth } from "../src/search-engine.mjs";
import { automationPreview, runAutomation, undoAutomationRun } from "../src/automation-engine.mjs";
import { markdownWorklog, productivityInsights } from "../src/workspace-insights.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "perfectwork-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, "data"), files = path.join(root, "files"), output = path.join(root, "output");
  await fs.mkdir(files); await fs.mkdir(output);
  const store = await new WorkspaceStore(data).init();
  await store.updateSettings({ searchRoots: [files], writeRoot: output, searchMaxFiles: 1000, searchMaxFileBytes: 5 * 1024 * 1024, healthLargeFileBytes: 1024 * 1024, healthStaleDays: 30 });
  return { root, data, files, output, store };
}

async function writePdf(file, contents) {
  const stream = `BT /F1 20 Tf 72 720 Td (${contents}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await fs.writeFile(file, pdf);
}

test("inbox, tasks, projects, focus and work logs form one workflow", async t => {
  const item = await fixture(t);
  await item.store.updateProfile({ name: "Tora", dailyFocus: "検索を完成させる" });
  const capture = await item.store.capture({ title: "検索UIのアイデア", body: "結果をすぐ開ける", kind: "idea", tags: ["product"] });
  const task = await item.store.convertInbox(capture.id, "task");
  const project = await item.store.createProject({ name: "PerfectWork", description: "最高の作業環境", folder: item.files });
  await item.store.updateTask(task.id, { projectId: project.id, status: "doing", dueDate: new Date().toISOString().slice(0, 10) });
  await item.store.startFocus({ title: task.title, projectId: project.id });
  const session = await item.store.stopFocus({ note: "検索画面を完成" });
  const state = item.store.summary();
  assert.equal(state.profile.name, "Tora");
  assert.equal(state.inbox[0].status, "archived");
  assert.equal(state.tasks[0].projectId, project.id);
  assert.equal(session.durationMinutes, 1);
  assert.equal(state.worklogs[0].source, "focus");
  assert.equal(state.computed.activeSession, null);
  assert.match(markdownWorklog(state), /検索画面を完成/);
  assert.equal(productivityInsights(state).days.at(-1).minutes, 1);
});

test("full-text search indexes source, Word and filename content safely", async t => {
  const item = await fixture(t);
  await fs.writeFile(path.join(item.files, "architecture.md"), "The north star is effortless flow.");
  await fs.copyFile(path.resolve("node_modules/mammoth/test/test-data/single-paragraph.docx"), path.join(item.files, "meeting.docx"));
  await writePdf(path.join(item.files, "research.pdf"), "Galaxy workflow knowledge");
  await fs.writeFile(path.join(item.files, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  const engine = await new SearchEngine(item.data).init();
  const status = await engine.build(item.store.data.settings);
  assert.equal(status.files, 4);
  assert.equal(engine.search("north star")[0].name, "architecture.md");
  assert.equal(engine.search("imported air")[0].name, "meeting.docx");
  assert.equal(engine.search("Galaxy workflow")[0]?.name, "research.pdf", JSON.stringify(engine.index.find(entry => entry.name === "research.pdf")));
  assert.equal(engine.search("binary")[0].name, "binary.bin");
  const cached = await new SearchEngine(item.data).init();
  assert.equal(cached.search("effortless").length, 1);
});

test("health finds content-identical duplicates without changing files", async t => {
  const item = await fixture(t);
  await fs.writeFile(path.join(item.files, "original.txt"), "same contents");
  await fs.writeFile(path.join(item.files, "copy.txt"), "same contents");
  await fs.writeFile(path.join(item.files, "different.txt"), "not the same!");
  const health = await fileHealth(item.store.data.settings);
  assert.equal(health.duplicateGroups.length, 1);
  assert.equal(health.duplicateGroups[0].files.length, 2);
  assert.equal(await fs.readFile(path.join(item.files, "copy.txt"), "utf8"), "same contents");
});

test("automation previews, avoids overwrites, and only undoes unchanged output", async t => {
  const item = await fixture(t);
  await item.store.capture({ title: "First thought", kind: "note" });
  const automation = item.store.data.automations.find(value => value.action === "inbox-digest");
  const preview = automationPreview(item.store.snapshot(), automation);
  assert.match(preview.operations[0].path, /Digests/);
  const first = await runAutomation(preview, item.output);
  const second = await runAutomation(preview, item.output);
  assert.notEqual(first[0].path, second[0].path);
  await fs.appendFile(first[0].path, "edited");
  const changed = await undoAutomationRun({ status: "completed", operations: first }, item.output);
  assert.equal(changed.skipped.length, 1);
  const removed = await undoAutomationRun({ status: "completed", operations: second }, item.output);
  assert.equal(removed.removed.length, 1);
  await assert.rejects(fs.access(second[0].path));
});

test("PerfectWork HTTP API authenticates and persists a complete workflow", async t => {
  const item = await fixture(t);
  const child = spawn(process.execPath, ["work.mjs", "--no-open", "--data-dir", item.data], { cwd: path.resolve(import.meta.dirname, ".."), windowsHide: true, env: { ...process.env, PERFECTWORK_DEFAULT_ROOT: item.files } });
  t.after(async () => { child.kill(); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once("exit", resolve)); });
  const appUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("PerfectWork did not start")), 10_000); let output = "";
    child.stdout.on("data", chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\w+/); if (match) { clearTimeout(timeout); resolve(new URL(match[0])); } }); child.once("error", reject);
  });
  const headers = { "X-PerfectWork-Token": appUrl.searchParams.get("token"), "Content-Type": "application/json" };
  const call = async (route, value) => { const response = await fetch(new URL(route, appUrl), { headers, ...(value === undefined ? {} : { method: "POST", body: JSON.stringify(value) }) }); return { status: response.status, data: response.headers.get("content-type").includes("json") ? await response.json() : await response.text() }; };
  assert.equal((await fetch(new URL("/api/state", appUrl))).status, 403);
  assert.equal((await fetch(appUrl)).status, 200);
  for (const asset of ["/app.js", "/styles.css", "/manifest.webmanifest"]) assert.equal((await fetch(new URL(asset, appUrl))).status, 200);
  assert.equal((await fetch(new URL("/api/state", appUrl), { headers: { ...headers, Origin: "https://example.invalid" } })).status, 403);
  const inbox = await call("/api/inbox/create", { title: "API capture", body: "linked workflow" });
  assert.equal(inbox.status, 201);
  const task = await call("/api/inbox/convert", { id: inbox.data.result.id, target: "task" });
  assert.equal(task.data.result.title, "API capture");
  const focus = await call("/api/focus/start", { title: "Deep work" }); assert.equal(focus.status, 201);
  const stopped = await call("/api/focus/stop", { note: "Done" }); assert.equal(stopped.data.result.durationMinutes, 1);
  await fs.writeFile(path.join(item.files, "knowledge.md"), "game changing workspace");
  assert.equal((await call("/api/search/reindex", {})).data.status.files, 1);
  assert.equal((await call("/api/search?q=game%20changing")).data.results[0].name, "knowledge.md");
  const preview = await call("/api/automation/preview", { id: stopped.data.state.automations.find(value => value.action === "daily-note").id });
  await call("/api/inbox/create", { title: "Makes the preview stale" });
  assert.equal((await call("/api/automation/run", { previewId: preview.data.id })).status, 409);
  const freshPreview = await call("/api/automation/preview", { id: stopped.data.state.automations.find(value => value.action === "daily-note").id });
  const run = await call("/api/automation/run", { previewId: freshPreview.data.id });
  assert.equal(run.data.run.status, "completed");
  assert.equal((await call("/api/automation/undo", { id: run.data.run.id })).data.result.removed.length, 1);
  assert.match((await call("/api/worklog.md")).data, /Deep work/);
  assert.equal((await call("/api/health")).data.files, 1);
  assert.equal((await call("/api/export")).data.inbox.length, 2);
});
