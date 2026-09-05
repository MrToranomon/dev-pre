import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { exists } from "./safety.mjs";

const execute = promisify(execFile);

export async function projectDiagnostics(projects) {
  const results = [];
  for (const project of projects.filter(item => item.folder).slice(0, 40)) {
    const folder = path.resolve(project.folder);
    if (!(await exists(folder))) { results.push({ projectId: project.id, folder, exists: false }); continue; }
    let git = null;
    try {
      const [status, log, branch] = await Promise.all([
        execute("git", ["-C", folder, "status", "--porcelain"], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }),
        execute("git", ["-C", folder, "log", "-1", "--format=%h%x00%s%x00%cI"], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }),
        execute("git", ["-C", folder, "branch", "--show-current"], { windowsHide: true, timeout: 5000 }),
      ]);
      const [hash, message, date] = log.stdout.trim().split("\0");
      git = { branch: branch.stdout.trim(), changedFiles: status.stdout.split(/\r?\n/).filter(Boolean).length, lastCommit: hash ? { hash, message, date } : null };
    } catch { /* The project folder does not need to be a Git repository. */ }
    results.push({ projectId: project.id, folder, exists: true, git });
  }
  return results;
}

export function markdownWorklog(data, { from, to } = {}) {
  const lower = from || "0000-00-00"; const upper = to || "9999-99-99";
  const logs = data.worklogs.filter(item => item.date >= lower && item.date <= upper).sort((a, b) => b.date.localeCompare(a.date));
  const projects = new Map(data.projects.map(item => [item.id, item.name]));
  const grouped = Map.groupBy(logs, item => item.date);
  const lines = ["# PerfectWork 作業ログ", "", `期間: ${from || "すべて"} 〜 ${to || "現在"}`, "", `合計: ${logs.reduce((sum, item) => sum + (item.minutes ?? 0), 0)}分`, ""];
  for (const [date, items] of grouped) {
    lines.push(`## ${date}`, "");
    for (const item of items) lines.push(`- ${item.title}${item.minutes ? ` (${item.minutes}分)` : ""}${item.projectId ? ` — ${projects.get(item.projectId) ?? "不明なプロジェクト"}` : ""}${item.body ? `\n  ${item.body.replace(/\n/g, "\n  ")}` : ""}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function productivityInsights(data) {
  const today = new Date(); const days = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = new Date(today); date.setDate(date.getDate() - offset); const key = date.toISOString().slice(0, 10);
    const minutes = data.worklogs.filter(item => item.date === key).reduce((sum, item) => sum + (item.minutes ?? 0), 0);
    const completed = data.tasks.filter(item => item.completedAt?.startsWith(key)).length;
    days.push({ date: key, minutes, completed });
  }
  let streak = 0;
  for (const day of [...days].reverse()) { if (day.minutes || day.completed) streak += 1; else if (day.date !== today.toISOString().slice(0, 10) || streak) break; }
  const byProject = new Map();
  for (const log of data.worklogs) if (log.projectId) byProject.set(log.projectId, (byProject.get(log.projectId) ?? 0) + (log.minutes ?? 0));
  return { days, streak, totalMinutes: days.reduce((sum, day) => sum + day.minutes, 0), completedTasks: days.reduce((sum, day) => sum + day.completed, 0), byProject: [...byProject].map(([projectId, minutes]) => ({ projectId, minutes })).sort((a, b) => b.minutes - a.minutes) };
}
