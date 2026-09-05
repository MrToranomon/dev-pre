import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { atomicJson, exists } from "./safety.mjs";

const VERSION = 1;
const nowIso = () => new Date().toISOString();
const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const dayKey = (date = new Date()) => date.toISOString().slice(0, 10);

function text(value, label, max = 10_000, { required = true } = {}) {
  if (typeof value !== "string") throw new Error(`${label}は文字列で入力してください。`);
  const result = value.trim();
  if (required && !result) throw new Error(`${label}を入力してください。`);
  if (result.length > max) throw new Error(`${label}は${max}文字以内で入力してください。`);
  return result;
}

function optionalDate(value, label) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error(`${label}が正しくありません。`);
  return value;
}

function tags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => text(String(item), "タグ", 40)).slice(0, 20))];
}

function defaultRoots() {
  if (process.env.PERFECTWORK_DEFAULT_ROOT) return [path.resolve(process.env.PERFECTWORK_DEFAULT_ROOT)];
  const home = os.homedir();
  return ["Documents", "Desktop", "Downloads"].map(name => path.join(home, name));
}

function defaultState() {
  return {
    version: VERSION,
    profile: { name: "", dailyFocus: "", accent: "violet", createdAt: nowIso() },
    settings: {
      searchRoots: defaultRoots(),
      writeRoot: path.join(os.homedir(), "Documents", "PerfectWork"),
      searchMaxFiles: 15_000,
      searchMaxFileBytes: 8 * 1024 * 1024,
      healthLargeFileBytes: 500 * 1024 * 1024,
      healthStaleDays: 180,
      startWeekOnMonday: true,
    },
    inbox: [], tasks: [], projects: [], worklogs: [], sessions: [],
    automations: [
      { id: id("auto"), name: "デイリーノートを準備", description: "今日の日付のMarkdownノートを作成します。", enabled: false, trigger: "manual", action: "daily-note", options: {}, lastRunAt: null, lastRunDay: null },
      { id: id("auto"), name: "インボックス・ダイジェスト", description: "未処理アイテムを読みやすいMarkdownにまとめます。", enabled: false, trigger: "manual", action: "inbox-digest", options: {}, lastRunAt: null, lastRunDay: null },
      { id: id("auto"), name: "ワークスペースをバックアップ", description: "PerfectWorkの全データを日時付きJSONで保存します。", enabled: false, trigger: "manual", action: "backup", options: {}, lastRunAt: null, lastRunDay: null },
    ],
    automationRuns: [], bookmarks: [], activity: [], createdAt: nowIso(), updatedAt: nowIso(),
  };
}

function migrate(raw) {
  const defaults = defaultState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;
  const merged = { ...defaults, ...raw, profile: { ...defaults.profile, ...(raw.profile ?? {}) }, settings: { ...defaults.settings, ...(raw.settings ?? {}) } };
  for (const key of ["inbox", "tasks", "projects", "worklogs", "sessions", "automations", "automationRuns", "bookmarks", "activity"]) if (!Array.isArray(merged[key])) merged[key] = [];
  merged.version = VERSION;
  return merged;
}

export function workspaceDataDirectory(environment = process.env) {
  if (environment.PERFECTWORK_DATA_DIR) return path.resolve(environment.PERFECTWORK_DATA_DIR);
  const base = environment.LOCALAPPDATA || path.join(os.homedir(), ".local", "share");
  return path.join(base, "PerfectWork");
}

export class WorkspaceStore {
  constructor(directory = workspaceDataDirectory()) {
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, "workspace.json");
    this.queue = Promise.resolve();
    this.data = null;
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    if (await exists(this.file)) {
      try { this.data = migrate(JSON.parse(await fs.readFile(this.file, "utf8"))); }
      catch (error) {
        const damaged = path.join(this.directory, `workspace.damaged-${Date.now()}.json`);
        await fs.copyFile(this.file, damaged);
        throw new Error(`PerfectWorkのデータを読み込めません。破損ファイルを保全しました: ${damaged} (${error.message})`);
      }
    } else {
      this.data = defaultState();
      await atomicJson(this.file, this.data);
    }
    return this;
  }

  snapshot() { return structuredClone(this.data); }

  async change(action) {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.data);
      const result = await action(draft);
      draft.updatedAt = nowIso();
      await atomicJson(this.file, draft);
      this.data = draft;
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  activity(draft, type, title, detail = "", metadata = {}) {
    draft.activity.unshift({ id: id("event"), type, title, detail, metadata, at: nowIso() });
    draft.activity = draft.activity.slice(0, 2_000);
  }

  async updateProfile(input) {
    return this.change(draft => {
      if (input.name !== undefined) draft.profile.name = text(input.name, "名前", 80, { required: false });
      if (input.dailyFocus !== undefined) draft.profile.dailyFocus = text(input.dailyFocus, "今日のフォーカス", 240, { required: false });
      if (input.accent !== undefined && ["violet", "cyan", "lime", "sunset"].includes(input.accent)) draft.profile.accent = input.accent;
      this.activity(draft, "settings", "プロフィールを更新", draft.profile.dailyFocus);
    });
  }

  async updateSettings(input) {
    return this.change(draft => {
      if (input.profile !== undefined) {
        if (!input.profile || typeof input.profile !== "object" || Array.isArray(input.profile)) throw new Error("プロフィール設定が正しくありません。");
        if (input.profile.name !== undefined) draft.profile.name = text(input.profile.name, "名前", 80, { required: false });
        if (input.profile.accent !== undefined) {
          if (!["violet", "cyan", "lime", "sunset"].includes(input.profile.accent)) throw new Error("アクセントカラーが正しくありません。");
          draft.profile.accent = input.profile.accent;
        }
      }
      if (input.searchRoots !== undefined) {
        if (!Array.isArray(input.searchRoots) || !input.searchRoots.length) throw new Error("検索対象フォルダを1つ以上指定してください。");
        draft.settings.searchRoots = [...new Set(input.searchRoots.map(value => path.resolve(text(value, "検索対象", 500))))].slice(0, 20);
      }
      if (input.writeRoot !== undefined) draft.settings.writeRoot = path.resolve(text(input.writeRoot, "自動化の保存先", 500));
      for (const [key, min, max] of [["searchMaxFiles", 100, 100_000], ["searchMaxFileBytes", 1_024, 100 * 1024 * 1024], ["healthLargeFileBytes", 1024 * 1024, 10 * 1024 ** 3], ["healthStaleDays", 1, 3650]]) {
        if (input[key] !== undefined) {
          const value = Number(input[key]);
          if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key}の値が範囲外です。`);
          draft.settings[key] = Math.round(value);
        }
      }
      this.activity(draft, "settings", "ワークスペース設定を更新");
    });
  }

  async capture(input) {
    return this.change(draft => {
      const item = { id: id("inbox"), title: text(input.title, "タイトル", 300), body: text(input.body ?? "", "本文", 20_000, { required: false }), kind: ["note", "link", "idea", "file"].includes(input.kind) ? input.kind : "note", url: text(input.url ?? "", "URL", 2_000, { required: false }), tags: tags(input.tags), favorite: false, status: "open", createdAt: nowIso(), updatedAt: nowIso() };
      if (item.url && !/^https?:\/\//i.test(item.url)) throw new Error("URLはhttp://またはhttps://で入力してください。");
      draft.inbox.unshift(item); this.activity(draft, "capture", "インボックスに追加", item.title, { id: item.id }); return item;
    });
  }

  async updateInbox(itemId, input) {
    return this.change(draft => {
      const item = draft.inbox.find(candidate => candidate.id === itemId); if (!item) throw new Error("インボックス項目が見つかりません。");
      if (input.status !== undefined && ["open", "archived"].includes(input.status)) item.status = input.status;
      if (input.favorite !== undefined) item.favorite = Boolean(input.favorite);
      if (input.title !== undefined) item.title = text(input.title, "タイトル", 300);
      if (input.body !== undefined) item.body = text(input.body, "本文", 20_000, { required: false });
      if (input.kind !== undefined && ["note", "link", "idea", "file"].includes(input.kind)) item.kind = input.kind;
      if (input.url !== undefined) {
        item.url = text(input.url, "URL", 2_000, { required: false });
        if (item.url && !/^https?:\/\//i.test(item.url)) throw new Error("URLはhttp://またはhttps://で入力してください。");
      }
      if (input.tags !== undefined) item.tags = tags(input.tags);
      item.updatedAt = nowIso(); this.activity(draft, "capture", item.status === "archived" ? "インボックスを完了" : "インボックスを更新", item.title); return item;
    });
  }

  async createTask(input) {
    return this.change(draft => {
      const task = { id: id("task"), title: text(input.title, "タスク", 300), notes: text(input.notes ?? "", "メモ", 10_000, { required: false }), status: "todo", priority: ["low", "normal", "high"].includes(input.priority) ? input.priority : "normal", dueDate: optionalDate(input.dueDate, "期限"), projectId: input.projectId && draft.projects.some(item => item.id === input.projectId) ? input.projectId : null, tags: tags(input.tags), createdAt: nowIso(), completedAt: null, updatedAt: nowIso() };
      draft.tasks.unshift(task); this.activity(draft, "task", "タスクを追加", task.title, { id: task.id }); return task;
    });
  }

  async updateTask(taskId, input) {
    return this.change(draft => {
      const task = draft.tasks.find(candidate => candidate.id === taskId); if (!task) throw new Error("タスクが見つかりません。");
      if (input.title !== undefined) task.title = text(input.title, "タスク", 300);
      if (input.status !== undefined && ["todo", "doing", "done", "archived"].includes(input.status)) { task.status = input.status; task.completedAt = input.status === "done" ? nowIso() : null; }
      if (input.priority !== undefined && ["low", "normal", "high"].includes(input.priority)) task.priority = input.priority;
      if (input.dueDate !== undefined) task.dueDate = optionalDate(input.dueDate, "期限");
      if (input.projectId !== undefined) task.projectId = input.projectId && draft.projects.some(item => item.id === input.projectId) ? input.projectId : null;
      if (input.notes !== undefined) task.notes = text(input.notes, "メモ", 10_000, { required: false });
      task.updatedAt = nowIso(); this.activity(draft, "task", task.status === "done" ? "タスクを完了" : "タスクを更新", task.title); return task;
    });
  }

  async createProject(input) {
    return this.change(draft => {
      const project = { id: id("project"), name: text(input.name, "プロジェクト名", 200), description: text(input.description ?? "", "説明", 10_000, { required: false }), status: "active", color: /^#[0-9a-f]{6}$/i.test(input.color ?? "") ? input.color : "#8b7cff", progress: 0, dueDate: optionalDate(input.dueDate, "期限"), folder: text(input.folder ?? "", "フォルダ", 500, { required: false }), links: Array.isArray(input.links) ? input.links.slice(0, 30).map(link => ({ label: text(link.label, "リンク名", 100), url: text(link.url, "URL", 2_000) })).filter(link => /^https?:\/\//i.test(link.url)) : [], notes: text(input.notes ?? "", "ノート", 30_000, { required: false }), createdAt: nowIso(), updatedAt: nowIso() };
      draft.projects.unshift(project); this.activity(draft, "project", "プロジェクトを開始", project.name, { id: project.id }); return project;
    });
  }

  async updateProject(projectId, input) {
    return this.change(draft => {
      const project = draft.projects.find(candidate => candidate.id === projectId); if (!project) throw new Error("プロジェクトが見つかりません。");
      if (input.name !== undefined) project.name = text(input.name, "プロジェクト名", 200);
      if (input.description !== undefined) project.description = text(input.description, "説明", 10_000, { required: false });
      if (input.notes !== undefined) project.notes = text(input.notes, "ノート", 30_000, { required: false });
      if (input.status !== undefined && ["active", "paused", "completed", "archived"].includes(input.status)) project.status = input.status;
      if (input.progress !== undefined) { const value = Number(input.progress); if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("進捗は0〜100で指定してください。"); project.progress = Math.round(value); }
      if (input.dueDate !== undefined) project.dueDate = optionalDate(input.dueDate, "期限");
      if (input.folder !== undefined) project.folder = text(input.folder, "フォルダ", 500, { required: false });
      if (input.links !== undefined) {
        if (!Array.isArray(input.links)) throw new Error("リンクの形式が正しくありません。");
        project.links = input.links.slice(0, 30).map(link => ({ label: text(link.label, "リンク名", 100), url: text(link.url, "URL", 2_000) })).filter(link => /^https?:\/\//i.test(link.url));
      }
      project.updatedAt = nowIso(); this.activity(draft, "project", "プロジェクトを更新", project.name); return project;
    });
  }

  async convertInbox(itemId, target) {
    return this.change(draft => {
      const item = draft.inbox.find(candidate => candidate.id === itemId); if (!item) throw new Error("インボックス項目が見つかりません。");
      let created;
      if (target === "task") {
        created = { id: id("task"), title: item.title, notes: item.body, status: "todo", priority: "normal", dueDate: null, projectId: null, tags: item.tags, createdAt: nowIso(), completedAt: null, updatedAt: nowIso() };
        draft.tasks.unshift(created);
      } else if (target === "project") {
        created = { id: id("project"), name: item.title, description: item.body, status: "active", color: "#8b7cff", progress: 0, dueDate: null, folder: "", links: item.url ? [{ label: item.title, url: item.url }] : [], notes: "", createdAt: nowIso(), updatedAt: nowIso() };
        draft.projects.unshift(created);
      } else throw new Error("変換先が正しくありません。");
      item.status = "archived"; item.updatedAt = nowIso(); this.activity(draft, target, `${target === "task" ? "タスク" : "プロジェクト"}へ変換`, item.title); return created;
    });
  }

  async startFocus(input) {
    return this.change(draft => {
      if (draft.sessions.some(item => !item.endedAt)) throw new Error("すでに集中セッションが進行中です。");
      const session = { id: id("session"), title: text(input.title || draft.profile.dailyFocus || "集中作業", "セッション名", 200), projectId: input.projectId && draft.projects.some(item => item.id === input.projectId) ? input.projectId : null, startedAt: nowIso(), endedAt: null, durationMinutes: null, note: "" };
      draft.sessions.unshift(session); this.activity(draft, "focus", "集中セッションを開始", session.title); return session;
    });
  }

  async stopFocus(input = {}) {
    return this.change(draft => {
      const session = draft.sessions.find(item => !item.endedAt); if (!session) throw new Error("進行中の集中セッションはありません。");
      session.endedAt = nowIso(); session.durationMinutes = Math.max(1, Math.round((new Date(session.endedAt) - new Date(session.startedAt)) / 60_000)); session.note = text(input.note ?? "", "振り返り", 5_000, { required: false });
      draft.worklogs.unshift({ id: id("log"), title: session.title, body: session.note, projectId: session.projectId, date: dayKey(), minutes: session.durationMinutes, source: "focus", createdAt: nowIso() });
      this.activity(draft, "focus", "集中セッションを完了", `${session.title} · ${session.durationMinutes}分`); return session;
    });
  }

  async addWorklog(input) {
    return this.change(draft => {
      const minutes = Number(input.minutes ?? 0); if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) throw new Error("作業時間は0〜1440分で入力してください。");
      const log = { id: id("log"), title: text(input.title, "作業内容", 300), body: text(input.body ?? "", "詳細", 20_000, { required: false }), projectId: input.projectId && draft.projects.some(item => item.id === input.projectId) ? input.projectId : null, date: optionalDate(input.date, "日付") ?? dayKey(), minutes: Math.round(minutes), source: "manual", createdAt: nowIso() };
      draft.worklogs.unshift(log); this.activity(draft, "worklog", "作業ログを記録", log.title); return log;
    });
  }

  async saveAutomation(input) {
    return this.change(draft => {
      const existing = input.id ? draft.automations.find(item => item.id === input.id) : null;
      const automation = existing ?? { id: id("auto"), lastRunAt: null, lastRunDay: null };
      automation.name = text(input.name, "自動化名", 200); automation.description = text(input.description ?? "", "説明", 1_000, { required: false });
      automation.action = ["daily-note", "inbox-digest", "project-snapshot", "backup"].includes(input.action) ? input.action : "daily-note";
      automation.trigger = ["manual", "startup", "daily"].includes(input.trigger) ? input.trigger : "manual";
      automation.enabled = Boolean(input.enabled); automation.options = {};
      if (!existing) draft.automations.push(automation);
      this.activity(draft, "automation", "自動化を保存", automation.name); return automation;
    });
  }

  summary() {
    const data = this.snapshot(); const today = dayKey(); const weekAgo = Date.now() - 7 * 86_400_000;
    const focusToday = data.sessions.filter(item => item.endedAt?.startsWith(today)).reduce((sum, item) => sum + (item.durationMinutes ?? 0), 0);
    const focusWeek = data.sessions.filter(item => new Date(item.endedAt ?? 0).getTime() >= weekAgo).reduce((sum, item) => sum + (item.durationMinutes ?? 0), 0);
    const dueToday = data.tasks.filter(item => item.status !== "done" && item.status !== "archived" && item.dueDate && item.dueDate <= today);
    return { ...data, computed: { today, openInbox: data.inbox.filter(item => item.status === "open").length, openTasks: data.tasks.filter(item => ["todo", "doing"].includes(item.status)).length, dueToday: dueToday.length, activeProjects: data.projects.filter(item => item.status === "active").length, focusToday, focusWeek, activeSession: data.sessions.find(item => !item.endedAt) ?? null } };
  }
}
