#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { WorkspaceStore, workspaceDataDirectory } from "./src/workspace-store.mjs";
import { SearchEngine, fileHealth } from "./src/search-engine.mjs";
import { automationPreview, runAutomation, undoAutomationRun } from "./src/automation-engine.mjs";
import { markdownWorklog, productivityInsights, projectDiagnostics } from "./src/workspace-insights.mjs";
import { dashboardState } from "./src/config-manager.mjs";
import { exists, within } from "./src/safety.mjs";

const root = import.meta.dirname;
const dataIndex = process.argv.indexOf("--data-dir");
if (dataIndex !== -1 && !process.argv[dataIndex + 1]) throw new Error("--data-dir requires a path.");
const dataDirectory = dataIndex === -1 ? workspaceDataDirectory() : path.resolve(process.argv[dataIndex + 1]);
const store = await new WorkspaceStore(dataDirectory).init();
const search = await new SearchEngine(dataDirectory).init();
const token = crypto.randomBytes(24).toString("hex");
const automationPreviews = new Map();
let server;
let orbitProcess = null;
let healthCache = null;

const assets = new Map([
  ["/", ["workbench/index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["workbench/app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["workbench/styles.css", "text/css; charset=utf-8"]],
  ["/manifest.webmanifest", ["workbench/manifest.webmanifest", "application/manifest+json"]],
]);

function headers(response, status, type) {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
}

function send(response, status, body, type = "application/json; charset=utf-8") {
  headers(response, status, type);
  response.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function body(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 2_000_000) throw new Error("送信内容が大きすぎます。"); chunks.push(chunk); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("送信内容を読み取れませんでした。"); }
}

function safeUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("開けるURLはhttpまたはhttpsのみです。");
  return url.toString();
}

function openExternal(target) {
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", target] : [target];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }); child.unref();
}

function allowedLocalPath(file, state) {
  const resolved = path.resolve(file);
  const roots = [...state.settings.searchRoots, state.settings.writeRoot, ...state.projects.map(project => project.folder).filter(Boolean)].map(item => path.resolve(item));
  return roots.some(rootPath => path.relative(rootPath, resolved) === "" || within(rootPath, resolved));
}

async function appState() {
  const data = store.summary();
  let organizer = null;
  try {
    const configPath = path.join(root, "config.json");
    organizer = await dashboardState(configPath);
    organizer = { waiting: organizer.waiting, categories: organizer.categories.length, source: organizer.source };
  } catch (error) { organizer = { error: error.message }; }
  return { ...data, insights: productivityInsights(data), search: search.status, health: healthCache, organizer };
}

async function mutate(response, operation, successStatus = 200) {
  const result = await operation();
  return send(response, successStatus, { result, state: await appState() });
}

async function api(request, response, url) {
  if (request.headers["x-perfectwork-token"] !== token) return send(response, 403, { error: "セッションが無効です。アプリを開き直してください。" });
  if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) return send(response, 403, { error: "Origin not allowed." });
  const route = url.pathname;
  if (request.method === "GET" && route === "/api/state") return send(response, 200, await appState());
  if (request.method === "GET" && route === "/api/search") return send(response, 200, { results: search.search(url.searchParams.get("q"), url.searchParams.get("limit")), status: search.status });
  if (request.method === "GET" && route === "/api/health") {
    healthCache = await fileHealth(store.data.settings); return send(response, 200, healthCache);
  }
  if (request.method === "GET" && route === "/api/projects/diagnostics") return send(response, 200, { diagnostics: await projectDiagnostics(store.data.projects) });
  if (request.method === "GET" && route === "/api/export") return send(response, 200, `${JSON.stringify(store.snapshot(), null, 2)}\n`, "application/json; charset=utf-8");
  if (request.method === "GET" && route === "/api/worklog.md") return send(response, 200, markdownWorklog(store.data, { from: url.searchParams.get("from"), to: url.searchParams.get("to") }), "text/markdown; charset=utf-8");
  if (request.method !== "POST") return send(response, 405, { error: "Method not allowed." });
  const input = await body(request);

  if (route === "/api/profile") return mutate(response, () => store.updateProfile(input));
  if (route === "/api/settings") return mutate(response, () => store.updateSettings(input));
  if (route === "/api/inbox/create") return mutate(response, () => store.capture(input), 201);
  if (route === "/api/inbox/update") return mutate(response, () => store.updateInbox(input.id, input));
  if (route === "/api/inbox/convert") return mutate(response, () => store.convertInbox(input.id, input.target));
  if (route === "/api/task/create") return mutate(response, () => store.createTask(input), 201);
  if (route === "/api/task/update") return mutate(response, () => store.updateTask(input.id, input));
  if (route === "/api/project/create") return mutate(response, () => store.createProject(input), 201);
  if (route === "/api/project/update") return mutate(response, () => store.updateProject(input.id, input));
  if (route === "/api/focus/start") return mutate(response, () => store.startFocus(input), 201);
  if (route === "/api/focus/stop") return mutate(response, () => store.stopFocus(input));
  if (route === "/api/worklog/create") return mutate(response, () => store.addWorklog(input), 201);
  if (route === "/api/search/reindex") {
    const status = await search.build(store.data.settings); return send(response, 200, { status });
  }
  if (route === "/api/automation/save") return mutate(response, () => store.saveAutomation(input));
  if (route === "/api/automation/preview") {
    for (const [key, value] of automationPreviews) if (value.expiresAt < Date.now()) automationPreviews.delete(key);
    if (automationPreviews.size >= 30) automationPreviews.delete(automationPreviews.keys().next().value);
    const automation = store.data.automations.find(item => item.id === input.id);
    const preview = automationPreview(store.snapshot(), automation); preview.expiresAt = Date.now() + 10 * 60_000;
    automationPreviews.set(preview.id, preview);
    return send(response, 200, { id: preview.id, automationId: preview.automationId, automationName: preview.automationName, createdAt: preview.createdAt, expiresAt: preview.expiresAt, operations: preview.operations });
  }
  if (route === "/api/automation/run") {
    const preview = automationPreviews.get(input.previewId);
    if (!preview || preview.expiresAt < Date.now()) return send(response, 409, { error: "プレビューの有効期限が切れました。もう一度確認してください。" });
    if (preview.dataUpdatedAt !== store.data.updatedAt) return send(response, 409, { error: "データが更新されています。自動化をもう一度プレビューしてください。" });
    automationPreviews.delete(input.previewId);
    const operations = await runAutomation(preview, store.data.settings.writeRoot);
    const run = await store.change(draft => {
      const automation = draft.automations.find(item => item.id === preview.automationId); if (!automation) throw new Error("自動化が削除されています。");
      const record = { id: `run_${crypto.randomUUID()}`, automationId: automation.id, name: automation.name, status: "completed", createdAt: new Date().toISOString(), operations };
      automation.lastRunAt = record.createdAt; automation.lastRunDay = record.createdAt.slice(0, 10); draft.automationRuns.unshift(record); draft.automationRuns = draft.automationRuns.slice(0, 200); store.activity(draft, "automation", "自動化を実行", automation.name); return record;
    });
    return send(response, 200, { run, state: await appState() });
  }
  if (route === "/api/automation/undo") {
    const run = store.data.automationRuns.find(item => item.id === input.id);
    const result = await undoAutomationRun(run, store.data.settings.writeRoot);
    await store.change(draft => { const record = draft.automationRuns.find(item => item.id === input.id); record.status = result.skipped.length ? "partially-undone" : "undone"; record.undoneAt = new Date().toISOString(); record.undo = result; store.activity(draft, "automation", "自動化を取り消し", record.name); });
    return send(response, 200, { result, state: await appState() });
  }
  if (route === "/api/open") {
    const state = store.snapshot();
    if (input.url) openExternal(safeUrl(input.url));
    else {
      const target = path.resolve(input.path ?? "");
      if (!allowedLocalPath(target, state) || !(await exists(target))) throw new Error("登録された検索対象・プロジェクト以外のパスは開けません。");
      openExternal(target);
    }
    return send(response, 200, { ok: true });
  }
  if (route === "/api/orbit") {
    if (!orbitProcess || orbitProcess.exitCode !== null) {
      orbitProcess = spawn(process.execPath, [path.join(root, "manage.mjs")], { cwd: root, detached: true, stdio: "ignore", windowsHide: true }); orbitProcess.unref();
    }
    return send(response, 200, { ok: true });
  }
  if (route === "/api/shutdown") { send(response, 200, { ok: true }); setTimeout(() => server.close(() => process.exit(0)), 100); return; }
  return send(response, 404, { error: "Not found." });
}

server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.headers.host !== `127.0.0.1:${server.address().port}`) return send(response, 403, { error: "Host not allowed." });
    if (url.pathname.startsWith("/api/")) return await api(request, response, url);
    if (url.pathname === "/") {
      const cookie = request.headers.cookie?.split(";").some(part => part.trim() === `perfectwork-session=${token}`);
      if (url.searchParams.get("token") !== token && !cookie) return send(response, 403, "Session expired. Please reopen PerfectWork.", "text/plain; charset=utf-8");
      response.setHeader("Set-Cookie", `perfectwork-session=${token}; HttpOnly; SameSite=Strict; Path=/`);
    }
    const asset = assets.get(url.pathname); if (!asset) return send(response, 404, "Not found.", "text/plain; charset=utf-8");
    let contents = await fs.readFile(path.join(root, asset[0]));
    if (url.pathname === "/") contents = Buffer.from(contents.toString("utf8").replace("__PERFECTWORK_TOKEN__", token));
    return send(response, 200, contents, asset[1]);
  } catch (error) {
    const status = /見つかりません|有効期限|すでに/.test(error.message) ? 409 : 400;
    return send(response, status, { error: error.message });
  }
});
server.requestTimeout = 60_000;

async function runScheduled() {
  const state = store.snapshot(); const today = new Date().toISOString().slice(0, 10);
  for (const automation of state.automations.filter(item => item.enabled && item.trigger !== "manual" && item.lastRunDay !== today)) {
    try {
      const preview = automationPreview(store.snapshot(), automation); const operations = await runAutomation(preview, store.data.settings.writeRoot);
      await store.change(draft => { const item = draft.automations.find(candidate => candidate.id === automation.id); const at = new Date().toISOString(); item.lastRunAt = at; item.lastRunDay = today; draft.automationRuns.unshift({ id: `run_${crypto.randomUUID()}`, automationId: item.id, name: item.name, status: "completed", scheduled: true, createdAt: at, operations }); store.activity(draft, "automation", "自動化を予定実行", item.name); });
    } catch (error) { await store.change(draft => { draft.automationRuns.unshift({ id: `run_${crypto.randomUUID()}`, automationId: automation.id, name: automation.name, status: "failed", scheduled: true, createdAt: new Date().toISOString(), error: error.message }); }); }
  }
}

server.listen(0, "127.0.0.1", async () => {
  const { port } = server.address(); const url = `http://127.0.0.1:${port}/?token=${token}`;
  process.stdout.write(`PerfectWork is open at ${url}\nData: ${dataDirectory}\n`);
  if (!process.argv.includes("--no-open")) openExternal(url);
  runScheduled().catch(() => {});
  search.build(store.data.settings).catch(() => {});
});
setInterval(() => runScheduled().catch(() => {}), 60_000).unref();
