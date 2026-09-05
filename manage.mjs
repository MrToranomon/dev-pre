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
  runOrganizer,
  setFolderRulePriority,
  undoLatestReassignment,
  updateCategoryDestination,
  updateRule,
} from "./src/config-manager.mjs";
import { loadConfig } from "./src/file-organizer.mjs";

const root = import.meta.dirname;
const configPath = path.join(root, "config.json");
const token = crypto.randomBytes(24).toString("hex");
const staticFiles = new Map([
  ["/", { file: "manager/index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "manager/app.js", type: "text/javascript; charset=utf-8" }],
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
  if (request.method === "GET" && pathname === "/api/state") return send(response, 200, await dashboardState(configPath));
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
  } else if (pathname === "/api/organize") {
    const result = await runOrganizer(configPath);
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
    if (url.pathname.startsWith("/api/")) return await api(request, response, url.pathname);
    if (url.searchParams.get("token") !== token && url.pathname === "/") return send(response, 403, "Session expired.", "text/plain; charset=utf-8");
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
