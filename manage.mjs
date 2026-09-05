#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import {
  createCategory,
  dashboardState,
  deleteCategory,
  readConfigDocument,
  reassignItems,
  renameCategory,
  setFolderRulePriority,
  undoLatestReassignment,
  updateCategoryDestination,
  updateRule,
  updateOptions,
} from "./src/config-manager.mjs";
import { loadConfig, createPlan, applyPlan, undoLatest, listHistory, diagnose } from "./src/file-organizer.mjs";
import { withOperationLock } from "./src/safety.mjs";

const root = import.meta.dirname;
const configIndex = process.argv.indexOf("--config");
if (configIndex !== -1 && !process.argv[configIndex + 1]) throw new Error("--config requires a path.");
const configPath = configIndex === -1 ? path.join(root, "config.json") : path.resolve(process.argv[configIndex + 1]);
const previews = new Map();
let mutationBusy = false;
const token = crypto.randomBytes(24).toString("hex");
const staticFiles = new Map([
  ["/", { file: "manager/index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "manager/app.js", type: "text/javascript; charset=utf-8" }],
  ["/enhancements.js", { file: "manager/enhancements.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "manager/styles.css", type: "text/css; charset=utf-8" }],
]);

let idleTimer;
let server;
function resetIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => server?.close(() => process.exit(0)), 2 * 60 * 60 * 1000);
  idleTimer.unref();
}

function send(response, status, body, contentType = "application/json; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function jsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function pickFolder() {
  if (process.platform !== "win32") throw new Error("Folder picker is currently available on Windows only.");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = '配置先フォルダを選択してください'",
    "$dialog.ShowNewFolderButton = $true",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
  ].join("; ");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { windowsHide: true });
    const output = [];
    const errors = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(Buffer.concat(errors).toString("utf8").trim() || "Folder picker failed."));
      return resolve(Buffer.concat(output).toString("utf8").trim() || null);
    });
  });
}

async function api(request, response, pathname) {
  if (request.headers["x-orbit-token"] !== token) return send(response, 403, { error: "Invalid session token." });
  if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) return send(response, 403, { error: "Origin not allowed." });
  if (request.method === "GET" && pathname === "/api/state") return send(response, 200, await dashboardState(configPath));
  if (request.method === "GET" && pathname === "/api/history") return send(response, 200, { records: await listHistory(await loadConfig(configPath), 50) });
  if (request.method === "GET" && pathname === "/api/doctor") return send(response, 200, { checks: await diagnose(await loadConfig(configPath)) });
  if (request.method === "GET" && pathname === "/api/config") return send(response, 200, await readConfigDocument(configPath));
  if (request.method === "GET" && pathname === "/api/preview") {
    const config = await loadConfig(configPath);
    const fingerprint = await fs.readFile(configPath, "utf8");
    const plan = await createPlan(config);
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + 10 * 60_000;
    for (const [key, value] of previews) if (value.expiresAt < Date.now()) previews.delete(key);
    if (previews.size >= 20) previews.delete(previews.keys().next().value);
    previews.set(id, { plan, fingerprint, expiresAt });
    return send(response, 200, { id, expiresAt, ...plan });
  }
  if (request.method !== "POST") return send(response, 405, { error: "Method not allowed." });
  const body = await jsonBody(request);

  if (pathname === "/api/category") {
    if (body.action === "create") await createCategory(configPath, body.name);
    else if (body.action === "rename") await renameCategory(configPath, body.name, body.newName);
    else if (body.action === "delete") await deleteCategory(configPath, body.name);
    else throw new Error("Unknown category action.");
  } else if (pathname === "/api/rule") {
    const result = await updateRule(configPath, body.action, body.category, body.value);
    return send(response, 200, { state: await dashboardState(configPath), ...result });
  } else if (pathname === "/api/folder-priority") {
    const result = await setFolderRulePriority(configPath, body.preferred, body.other);
    return send(response, 200, { state: await dashboardState(configPath), ...result });
  } else if (pathname === "/api/destination") {
    await updateCategoryDestination(configPath, body.category, body.path);
  } else if (pathname === "/api/pick-folder") {
    return send(response, 200, { path: await pickFolder() });
  } else if (pathname === "/api/reassign") {
    const config = await loadConfig(configPath);
    const document = await readConfigDocument(configPath);
    await reassignItems(config, document, body.from, body.to, body.names);
  } else if (pathname === "/api/undo-reassignment") {
    const config = await loadConfig(configPath);
    const record = await undoLatestReassignment(config);
    if (!record) return send(response, 409, { error: "取り消せる再割り振りはありません。" });
    return send(response, 200, { record, state: await dashboardState(configPath) });
  } else if (pathname === "/api/options") {
    await updateOptions(configPath, body);
  } else if (pathname === "/api/undo-organize") {
    const record = await undoLatest(await loadConfig(configPath));
    return send(response, 200, { record, state: await dashboardState(configPath) });
  } else if (pathname === "/api/organize") {
    const preview = previews.get(body.previewId);
    if (!preview || preview.expiresAt < Date.now()) return send(response, 409, { error: "プレビューの有効期限が切れました。もう一度確認してください。" });
    if (preview.fingerprint !== await fs.readFile(configPath, "utf8")) return send(response, 409, { error: "設定が変更されています。プレビューを更新してください。" });
    if (!Array.isArray(body.names) || !body.names.length || body.names.some(name => !preview.plan.planned.some(item => item.name === name))) throw new Error("整理するアイテムを選んでください。");
    const plan = { ...preview.plan, planned: preview.plan.planned.filter(item => body.names.includes(item.name)) };
    previews.delete(body.previewId);
    const record = await applyPlan(plan, await loadConfig(configPath));
    const result = { moved: record.moves.length, notMoved: record.notMoved, bytes: record.moves.reduce((sum, item) => sum + item.size, 0) };
    return send(response, 200, { result, state: await dashboardState(configPath) });
  } else if (pathname === "/api/shutdown") {
    send(response, 200, { ok: true });
    setTimeout(() => server.close(() => process.exit(0)), 150);
    return;
  } else return send(response, 404, { error: "Not found." });

  return send(response, 200, { state: await dashboardState(configPath) });
}

server = http.createServer(async (request, response) => {
  resetIdleTimer();
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.headers.host !== `127.0.0.1:${server.address().port}`) return send(response, 403, { error: "Host not allowed." });
    if (url.pathname.startsWith("/api/")) {
      if (request.method !== "POST" || ["/api/shutdown", "/api/pick-folder"].includes(url.pathname)) return await api(request, response, url.pathname);
      if (request.headers["x-orbit-token"] !== token) return send(response, 403, { error: "Invalid session token." });
      if (mutationBusy) return send(response, 409, { error: "処理中です。完了後にもう一度お試しください。" });
      mutationBusy = true;
      try { return await withOperationLock(await loadConfig(configPath), () => api(request, response, url.pathname)); }
      finally { mutationBusy = false; }
    }
    if (url.pathname === "/") {
      const sessionCookie = request.headers.cookie?.split(";").some(part => part.trim() === `orbit-session=${token}`);
      if (url.searchParams.get("token") !== token && !sessionCookie) return send(response, 403, "Session expired. Please reopen Orbit Organizer.", "text/plain; charset=utf-8");
      response.setHeader("Set-Cookie", `orbit-session=${token}; HttpOnly; SameSite=Strict; Path=/`);
    }
    const asset = staticFiles.get(url.pathname);
    if (!asset) return send(response, 404, "Not found.", "text/plain; charset=utf-8");
    let contents = await fs.readFile(path.join(root, asset.file), "utf8");
    if (url.pathname === "/") contents = contents.replace("__ORBIT_TOKEN__", token);
    return send(response, 200, contents, asset.type);
  } catch (error) {
    const status = /already exists|Move the category|取り消せる|different destination/i.test(error.message) ? 409 : 400;
    return send(response, status, { error: error.message });
  }
});

server.on("error", (error) => {
  process.stderr.write(`Orbit Rules: ${error.message}\n`);
  process.exitCode = 1;
});
server.requestTimeout = 30_000;

server.listen(0, "127.0.0.1", () => {
  resetIdleTimer();
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/?token=${token}`;
  if (!process.argv.includes("--no-open")) {
    const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  }
  process.stdout.write(`Orbit Rules is open at ${url}\n`);
});
