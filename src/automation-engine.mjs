import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertNoLinks, atomicJson, exists, within } from "./safety.mjs";
import { localDay } from "./local-date.mjs";

const dateKey = localDay;
const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function checkedTarget(root, target) {
  const base = path.resolve(root); const resolved = path.resolve(target);
  if (!within(base, resolved)) throw new Error("自動化の出力先は設定した保存先の内側にしてください。");
  return resolved;
}

function dailyNote(data, root) {
  const date = dateKey();
  const due = data.tasks.filter(task => ["todo", "doing"].includes(task.status) && task.dueDate && task.dueDate <= date);
  const lines = [`# ${date} Daily Note`, "", "## 今日のフォーカス", "", data.profile.dailyFocus || "- ", "", "## 今日のタスク", "", ...(due.length ? due.map(task => `- [ ] ${task.title}`) : ["- [ ] "]), "", "## メモ", "", "", "## 振り返り", ""];
  return { type: "create-file", path: checkedTarget(root, path.join(root, "Daily Notes", `${date}.md`)), content: `${lines.join("\n")}\n`, description: "今日のデイリーノートを作成" };
}

function inboxDigest(data, root) {
  const items = data.inbox.filter(item => item.status === "open");
  const lines = [`# Inbox Digest — ${dateKey()}`, "", `未処理: ${items.length}件`, "", ...items.flatMap(item => [`## ${item.title}`, "", item.body || item.url || "（本文なし）", "", item.tags?.length ? `Tags: ${item.tags.join(", ")}` : "", ""] )];
  return { type: "create-file", path: checkedTarget(root, path.join(root, "Digests", `inbox-${timestamp()}.md`)), content: `${lines.join("\n")}\n`, description: `${items.length}件のインボックスをMarkdownに整理` };
}

function projectSnapshot(data, root) {
  const projects = data.projects.filter(project => project.status !== "archived");
  const lines = [`# Project Snapshot — ${dateKey()}`, "", ...projects.flatMap(project => [`## ${project.name}`, "", `${project.progress}% · ${project.status}${project.dueDate ? ` · 期限 ${project.dueDate}` : ""}`, "", project.description || "", ""] )];
  return { type: "create-file", path: checkedTarget(root, path.join(root, "Snapshots", `projects-${timestamp()}.md`)), content: `${lines.join("\n")}\n`, description: `${projects.length}件のプロジェクト状況を保存` };
}

function backup(data, root) {
  return { type: "create-file", path: checkedTarget(root, path.join(root, "Backups", `perfectwork-${timestamp()}.json`)), content: `${JSON.stringify(data, null, 2)}\n`, description: "PerfectWorkの全データをバックアップ" };
}

export function automationPreview(data, automation) {
  if (!automation) throw new Error("自動化が見つかりません。");
  const root = path.resolve(data.settings.writeRoot);
  const factories = { "daily-note": dailyNote, "inbox-digest": inboxDigest, "project-snapshot": projectSnapshot, backup };
  const factory = factories[automation.action];
  if (!factory) throw new Error("未対応の自動化です。");
  const operations = [factory(data, root)];
  return { id: crypto.randomUUID(), automationId: automation.id, automationName: automation.name, dataUpdatedAt: data.updatedAt, createdAt: new Date().toISOString(), fingerprint: crypto.createHash("sha256").update(JSON.stringify(operations)).digest("hex"), operations: operations.map(({ content, ...operation }) => ({ ...operation, bytes: Buffer.byteLength(content, "utf8"), exists: false })) , privateOperations: operations };
}

async function unusedTarget(target) {
  const parsed = path.parse(target);
  for (let count = 1; ; count += 1) {
    const candidate = count === 1 ? target : path.join(parsed.dir, `${parsed.name} (${count})${parsed.ext}`);
    if (!(await exists(candidate))) return candidate;
  }
}

export async function runAutomation(preview, writeRoot) {
  const results = [];
  for (const operation of preview.privateOperations) {
    if (operation.type !== "create-file") throw new Error("未対応の自動化操作です。");
    const target = await unusedTarget(checkedTarget(writeRoot, operation.path));
    await assertNoLinks(target);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, operation.content, { flag: "wx" });
    const digest = crypto.createHash("sha256").update(operation.content).digest("hex");
    results.push({ type: operation.type, path: target, bytes: Buffer.byteLength(operation.content), digest, createdAt: new Date().toISOString() });
  }
  return results;
}

export async function undoAutomationRun(run, writeRoot) {
  if (!run || run.status !== "completed") throw new Error("取り消せる自動化履歴がありません。");
  const removed = [], skipped = [];
  for (const operation of [...run.operations].reverse()) {
    const target = checkedTarget(writeRoot, operation.path);
    try {
      const contents = await fs.readFile(target);
      const digest = crypto.createHash("sha256").update(contents).digest("hex");
      if (digest !== operation.digest) { skipped.push({ path: target, reason: "作成後に内容が変更されています" }); continue; }
      await fs.unlink(target); removed.push(target);
    } catch (error) { skipped.push({ path: target, reason: error.code === "ENOENT" ? "すでに存在しません" : error.message }); }
  }
  return { removed, skipped };
}
