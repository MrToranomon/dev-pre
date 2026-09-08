import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { atomicJson, exists } from "./safety.mjs";
import { localDay, validDay } from "./local-date.mjs";
import { workspaceTemplates } from "./workspace-templates.mjs";

const VERSION = 2;
const nowIso = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const dayKey = localDay;

function text(value, label, max = 10_000, { required = true } = {}) {
  if (typeof value !== "string")
    throw new Error(`${label}は文字列で入力してください。`);
  const result = value.trim();
  if (required && !result) throw new Error(`${label}を入力してください。`);
  if (result.length > max)
    throw new Error(`${label}は${max}文字以内で入力してください。`);
  return result;
}

function optionalDate(value, label) {
  if (value === null || value === undefined || value === "") return null;
  if (!validDay(value)) throw new Error(`${label}が正しくありません。`);
  return value;
}

function tags(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.map((item) => text(String(item), "タグ", 40)).slice(0, 20),
    ),
  ];
}

function taskDetails(task, input) {
  if (input.scheduledDate !== undefined)
    task.scheduledDate = optionalDate(input.scheduledDate, "予定日");
  if (input.estimateMinutes !== undefined) {
    const minutes = Number(input.estimateMinutes);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440)
      throw new Error("見積時間は0〜1440分で入力してください。");
    task.estimateMinutes = minutes;
  }
  if (input.checklist !== undefined) {
    if (!Array.isArray(input.checklist) || input.checklist.length > 50)
      throw new Error("チェックリストは50項目以内で入力してください。");
    task.checklist = input.checklist.map((item) => ({
      title: text(item.title, "チェック項目", 300),
      done: item.done === true,
    }));
  }
}

function defaultRoots() {
  if (process.env.PERFECTWORK_DEFAULT_ROOT)
    return [path.resolve(process.env.PERFECTWORK_DEFAULT_ROOT)];
  const home = os.homedir();
  return ["Documents", "Desktop", "Downloads"].map((name) =>
    path.join(home, name),
  );
}

function defaultState() {
  return {
    version: VERSION,
    profile: {
      name: "",
      dailyFocus: "",
      dailyFocusDate: dayKey(),
      accent: "violet",
      theme: "light",
      onboarded: false,
      createdAt: nowIso(),
    },
    settings: {
      searchRoots: defaultRoots(),
      writeRoot: path.join(os.homedir(), "Documents", "PerfectWork"),
      searchMaxFiles: 15_000,
      searchMaxFileBytes: 8 * 1024 * 1024,
      healthLargeFileBytes: 500 * 1024 * 1024,
      healthStaleDays: 180,
      startWeekOnMonday: true,
    },
    inbox: [],
    tasks: [],
    projects: [],
    worklogs: [],
    sessions: [],
    habits: [],
    automations: [
      {
        id: id("auto"),
        name: "デイリーノートを準備",
        description: "今日の日付のMarkdownノートを作成します。",
        enabled: false,
        trigger: "manual",
        action: "daily-note",
        options: {},
        lastRunAt: null,
        lastRunDay: null,
      },
      {
        id: id("auto"),
        name: "インボックス・ダイジェスト",
        description: "未処理アイテムを読みやすいMarkdownにまとめます。",
        enabled: false,
        trigger: "manual",
        action: "inbox-digest",
        options: {},
        lastRunAt: null,
        lastRunDay: null,
      },
      {
        id: id("auto"),
        name: "ワークスペースをバックアップ",
        description: "PerfectWorkの全データを日時付きJSONで保存します。",
        enabled: false,
        trigger: "manual",
        action: "backup",
        options: {},
        lastRunAt: null,
        lastRunDay: null,
      },
    ],
    automationRuns: [],
    bookmarks: [],
    activity: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function migrate(raw) {
  const defaults = defaultState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;
  const merged = {
    ...defaults,
    ...raw,
    profile: { ...defaults.profile, ...(raw.profile ?? {}) },
    settings: { ...defaults.settings, ...(raw.settings ?? {}) },
  };
  for (const key of [
    "inbox",
    "tasks",
    "projects",
    "worklogs",
    "sessions",
    "habits",
    "automations",
    "automationRuns",
    "bookmarks",
    "activity",
  ])
    if (!Array.isArray(merged[key])) merged[key] = [];
  merged.version = VERSION;
  return merged;
}

export function workspaceDataDirectory(environment = process.env) {
  if (environment.PERFECTWORK_DATA_DIR)
    return path.resolve(environment.PERFECTWORK_DATA_DIR);
  const base =
    environment.LOCALAPPDATA || path.join(os.homedir(), ".local", "share");
  return path.join(base, "PerfectWork");
}

export class WorkspaceStore {
  constructor(
    directory = workspaceDataDirectory(),
    { repository = null } = {},
  ) {
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, "workspace.json");
    this.queue = Promise.resolve();
    this.data = null;
    this.repository = repository;
    this.revision = 0;
    this.mirrorError = null;
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    if (this.repository) {
      await this.repository.init();
      const saved = await this.repository.load();
      if (saved) {
        this.data = migrate(saved.state);
        this.revision = saved.revision;
      } else {
        const hadJson = await exists(this.file);
        this.data = await this.#readJsonOrDefault();
        if (hadJson)
          await fs.copyFile(
            this.file,
            path.join(
              this.directory,
              `workspace.before-postgres-${Date.now()}.json`,
            ),
          );
        const initialized = await this.repository.initialize(
          this.data,
          hadJson ? "Imported workspace.json" : "Created new workspace",
        );
        this.data = migrate(initialized.state);
        this.revision = initialized.revision;
      }
      await this.#mirror();
    } else {
      const hadJson = await exists(this.file);
      this.data = await this.#readJsonOrDefault();
      if (!hadJson) await atomicJson(this.file, this.data);
    }
    return this;
  }

  async #readJsonOrDefault() {
    if (await exists(this.file)) {
      try {
        return migrate(JSON.parse(await fs.readFile(this.file, "utf8")));
      } catch (error) {
        const damaged = path.join(
          this.directory,
          `workspace.damaged-${Date.now()}.json`,
        );
        await fs.copyFile(this.file, damaged);
        throw new Error(
          `PerfectWorkのデータを読み込めません。破損ファイルを保全しました: ${damaged} (${error.message})`,
        );
      }
    }
    return defaultState();
  }

  async #mirror() {
    try {
      await atomicJson(this.file, this.data);
      this.mirrorError = null;
    } catch (error) {
      this.mirrorError = error.message;
      process.stderr.write(`JSON mirror warning: ${error.message}\n`);
    }
  }

  snapshot() {
    return structuredClone(this.data);
  }

  async change(action) {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.data);
      const result = await action(draft);
      draft.updatedAt = nowIso();
      if (this.repository)
        this.revision = await this.repository.save(
          draft,
          this.revision,
          draft.activity[0]?.title || "Workspace update",
        );
      else await atomicJson(this.file, draft);
      this.data = draft;
      if (this.repository) await this.#mirror();
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async storageStatus() {
    if (!this.repository)
      return {
        backend: "json",
        connected: true,
        file: this.file,
        mirror: null,
      };
    return {
      ...(await this.repository.status()),
      mirror: this.file,
      mirrorError: this.mirrorError,
    };
  }

  async close() {
    await this.queue;
    await this.repository?.close();
  }

  async databaseBackup() {
    if (!this.repository?.backup)
      throw new Error(
        "PostgreSQLを使用していないため、DBバックアップは必要ありません。",
      );
    return this.repository.backup(
      path.join(this.directory, "database-backups"),
    );
  }

  activity(draft, type, title, detail = "", metadata = {}) {
    draft.activity.unshift({
      id: id("event"),
      type,
      title,
      detail,
      metadata,
      at: nowIso(),
    });
    draft.activity = draft.activity.slice(0, 2_000);
  }

  async updateProfile(input) {
    return this.change((draft) => {
      if (input.name !== undefined)
        draft.profile.name = text(input.name, "名前", 80, { required: false });
      if (input.dailyFocus !== undefined) {
        draft.profile.dailyFocus = text(
          input.dailyFocus,
          "今日のフォーカス",
          240,
          { required: false },
        );
        draft.profile.dailyFocusDate = dayKey();
      }
      if (input.onboarded !== undefined)
        draft.profile.onboarded = Boolean(input.onboarded);
      if (input.theme !== undefined && ["light", "dark"].includes(input.theme))
        draft.profile.theme = input.theme;
      if (
        input.accent !== undefined &&
        ["violet", "cyan", "lime", "sunset"].includes(input.accent)
      )
        draft.profile.accent = input.accent;
      this.activity(
        draft,
        "settings",
        "プロフィールを更新",
        draft.profile.dailyFocus,
      );
    });
  }

  async updateSettings(input) {
    return this.change((draft) => {
      if (input.profile !== undefined) {
        if (
          !input.profile ||
          typeof input.profile !== "object" ||
          Array.isArray(input.profile)
        )
          throw new Error("プロフィール設定が正しくありません。");
        if (input.profile.name !== undefined)
          draft.profile.name = text(input.profile.name, "名前", 80, {
            required: false,
          });
        if (input.profile.accent !== undefined) {
          if (
            !["violet", "cyan", "lime", "sunset"].includes(input.profile.accent)
          )
            throw new Error("アクセントカラーが正しくありません。");
          draft.profile.accent = input.profile.accent;
        }
      }
      if (input.searchRoots !== undefined) {
        if (!Array.isArray(input.searchRoots) || !input.searchRoots.length)
          throw new Error("検索対象フォルダを1つ以上指定してください。");
        draft.settings.searchRoots = [
          ...new Set(
            input.searchRoots.map((value) =>
              path.resolve(text(value, "検索対象", 500)),
            ),
          ),
        ].slice(0, 20);
      }
      if (input.healthRoots !== undefined) {
        if (!Array.isArray(input.healthRoots) || input.healthRoots.length < 1 || input.healthRoots.length > 20)
          throw new Error("診断対象フォルダを1〜20件指定してください。");
        const roots = input.healthRoots.map(value => {
          const root = text(value, "診断対象", 500);
          if (!path.isAbsolute(root)) throw new Error("フォルダは絶対パスで指定してください。");
          return path.resolve(root);
        });
        draft.settings.healthRoots = [...new Map(roots.map(root => [process.platform === 'win32' ? root.toLowerCase() : root, root])).values()];
      }
      if (input.writeRoot !== undefined)
        draft.settings.writeRoot = path.resolve(
          text(input.writeRoot, "自動化の保存先", 500),
        );
      for (const [key, min, max] of [
        ["searchMaxFiles", 100, 100_000],
        ["searchMaxFileBytes", 1_024, 100 * 1024 * 1024],
        ["healthLargeFileBytes", 1024 * 1024, 10 * 1024 ** 3],
        ["healthStaleDays", 1, 3650],
      ]) {
        if (input[key] !== undefined) {
          const value = Number(input[key]);
          if (!Number.isFinite(value) || value < min || value > max)
            throw new Error(`${key}の値が範囲外です。`);
          draft.settings[key] = Math.round(value);
        }
      }
      this.activity(draft, "settings", "ワークスペース設定を更新");
    });
  }

  async capture(input) {
    return this.change((draft) => {
      const item = {
        id: id("inbox"),
        title: text(input.title, "タイトル", 300),
        body: text(input.body ?? "", "本文", 20_000, { required: false }),
        kind: ["note", "link", "idea", "file"].includes(input.kind)
          ? input.kind
          : "note",
        url: text(input.url ?? "", "URL", 2_000, { required: false }),
        tags: tags(input.tags),
        favorite: false,
        status: "open",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      if (item.url && !/^https?:\/\//i.test(item.url))
        throw new Error("URLはhttp://またはhttps://で入力してください。");
      draft.inbox.unshift(item);
      this.activity(draft, "capture", "インボックスに追加", item.title, {
        id: item.id,
      });
      return item;
    });
  }

  async updateInbox(itemId, input) {
    return this.change((draft) => {
      const item = draft.inbox.find((candidate) => candidate.id === itemId);
      if (!item) throw new Error("インボックス項目が見つかりません。");
      if (
        input.status !== undefined &&
        ["open", "archived"].includes(input.status)
      )
        item.status = input.status;
      if (input.favorite !== undefined) item.favorite = Boolean(input.favorite);
      if (input.title !== undefined)
        item.title = text(input.title, "タイトル", 300);
      if (input.body !== undefined)
        item.body = text(input.body, "本文", 20_000, { required: false });
      if (
        input.kind !== undefined &&
        ["note", "link", "idea", "file"].includes(input.kind)
      )
        item.kind = input.kind;
      if (input.url !== undefined) {
        item.url = text(input.url, "URL", 2_000, { required: false });
        if (item.url && !/^https?:\/\//i.test(item.url))
          throw new Error("URLはhttp://またはhttps://で入力してください。");
      }
      if (input.tags !== undefined) item.tags = tags(input.tags);
      item.updatedAt = nowIso();
      this.activity(
        draft,
        "capture",
        item.status === "archived"
          ? "インボックスを完了"
          : "インボックスを更新",
        item.title,
      );
      return item;
    });
  }

  async createTask(input) {
    return this.change((draft) => {
      const task = {
        id: id("task"),
        title: text(input.title, "タスク", 300),
        notes: text(input.notes ?? "", "メモ", 10_000, { required: false }),
        status: "todo",
        priority: ["low", "normal", "high"].includes(input.priority)
          ? input.priority
          : "normal",
        dueDate: optionalDate(input.dueDate, "期限"),
        projectId:
          input.projectId &&
          draft.projects.some((item) => item.id === input.projectId)
            ? input.projectId
            : null,
        tags: tags(input.tags),
        createdAt: nowIso(),
        completedAt: null,
        updatedAt: nowIso(),
      };
      taskDetails(task, input);
      draft.tasks.unshift(task);
      this.activity(draft, "task", "タスクを追加", task.title, { id: task.id });
      return task;
    });
  }

  async updateTask(taskId, input) {
    return this.change((draft) => {
      const task = draft.tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error("タスクが見つかりません。");
      if (input.title !== undefined)
        task.title = text(input.title, "タスク", 300);
      if (
        input.status !== undefined &&
        ["todo", "doing", "done", "archived"].includes(input.status)
      ) {
        if (input.status === "archived") task.previousStatus = task.status;
        task.status = input.status;
        task.completedAt =
          input.status === "done"
            ? (task.completedAt ?? nowIso())
            : input.status === "archived"
              ? task.completedAt
              : null;
      }
      if (
        input.priority !== undefined &&
        ["low", "normal", "high"].includes(input.priority)
      )
        task.priority = input.priority;
      if (input.dueDate !== undefined)
        task.dueDate = optionalDate(input.dueDate, "期限");
      if (input.projectId !== undefined)
        task.projectId =
          input.projectId &&
          draft.projects.some((item) => item.id === input.projectId)
            ? input.projectId
            : null;
      if (input.notes !== undefined)
        task.notes = text(input.notes, "メモ", 10_000, { required: false });
      taskDetails(task, input);
      task.updatedAt = nowIso();
      this.activity(
        draft,
        "task",
        task.status === "done" ? "タスクを完了" : "タスクを更新",
        task.title,
      );
      return task;
    });
  }

  async createTaskBatch(input) {
    if (!Array.isArray(input.titles) || !input.titles.length || input.titles.length > 50)
      throw new Error('タスクは1〜50件で入力してください。');
    const titles = input.titles.map(title => text(title, 'タスク', 300));
    const scheduledDate = optionalDate(input.scheduledDate, '予定日');
    return this.change(draft => {
      if (input.projectId && !draft.projects.some(project => project.id === input.projectId))
        throw new Error('プロジェクトが見つかりません。');
      const stamp = nowIso();
      const tasks = titles.map(title => {
        const task = { id: id('task'), title, notes: '', status: 'todo', priority: 'normal', dueDate: null,
          projectId: input.projectId || null, tags: [], createdAt: stamp, updatedAt: stamp, completedAt: null };
        taskDetails(task, { scheduledDate, estimateMinutes: 25 });
        return task;
      });
      draft.tasks.unshift(...tasks);
      this.activity(draft, 'task', 'タスクを一括追加', `${tasks.length}件`);
      return tasks;
    });
  }

  async createProject(input) {
    return this.change((draft) => {
      const project = {
        id: id("project"),
        name: text(input.name, "プロジェクト名", 200),
        description: text(input.description ?? "", "説明", 10_000, {
          required: false,
        }),
        status: "active",
        color: /^#[0-9a-f]{6}$/i.test(input.color ?? "")
          ? input.color
          : "#8b7cff",
        progress: 0,
        dueDate: optionalDate(input.dueDate, "期限"),
        folder: text(input.folder ?? "", "フォルダ", 500, { required: false }),
        links: Array.isArray(input.links)
          ? input.links
              .slice(0, 30)
              .map((link) => ({
                label: text(link.label, "リンク名", 100),
                url: text(link.url, "URL", 2_000),
              }))
              .filter((link) => /^https?:\/\//i.test(link.url))
          : [],
        notes: text(input.notes ?? "", "ノート", 30_000, { required: false }),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      if (["active", "paused", "completed", "archived"].includes(input.status))
        project.status = input.status;
      if (input.progress !== undefined) {
        const value = Number(input.progress);
        if (!Number.isFinite(value) || value < 0 || value > 100)
          throw new Error("進捗は0〜100で指定してください。");
        project.progress = Math.round(value);
      }
      draft.projects.unshift(project);
      this.activity(draft, "project", "プロジェクトを開始", project.name, {
        id: project.id,
      });
      return project;
    });
  }

  async updateProject(projectId, input) {
    return this.change((draft) => {
      const project = draft.projects.find(
        (candidate) => candidate.id === projectId,
      );
      if (!project) throw new Error("プロジェクトが見つかりません。");
      if (input.name !== undefined)
        project.name = text(input.name, "プロジェクト名", 200);
      if (input.description !== undefined)
        project.description = text(input.description, "説明", 10_000, {
          required: false,
        });
      if (input.notes !== undefined)
        project.notes = text(input.notes, "ノート", 30_000, {
          required: false,
        });
      if (input.color !== undefined) {
        if (!/^#[0-9a-f]{6}$/i.test(input.color))
          throw new Error("色が正しくありません。");
        project.color = input.color;
      }
      if (
        input.status !== undefined &&
        ["active", "paused", "completed", "archived"].includes(input.status)
      )
        project.status = input.status;
      if (input.progress !== undefined) {
        const value = Number(input.progress);
        if (!Number.isFinite(value) || value < 0 || value > 100)
          throw new Error("進捗は0〜100で指定してください。");
        project.progress = Math.round(value);
      }
      if (input.dueDate !== undefined)
        project.dueDate = optionalDate(input.dueDate, "期限");
      if (input.folder !== undefined)
        project.folder = text(input.folder, "フォルダ", 500, {
          required: false,
        });
      if (input.links !== undefined) {
        if (!Array.isArray(input.links))
          throw new Error("リンクの形式が正しくありません。");
        project.links = input.links
          .slice(0, 30)
          .map((link) => ({
            label: text(link.label, "リンク名", 100),
            url: text(link.url, "URL", 2_000),
          }))
          .filter((link) => /^https?:\/\//i.test(link.url));
      }
      project.updatedAt = nowIso();
      this.activity(draft, "project", "プロジェクトを更新", project.name);
      return project;
    });
  }

  async convertInbox(itemId, target) {
    return this.change((draft) => {
      const item = draft.inbox.find((candidate) => candidate.id === itemId);
      if (!item) throw new Error("インボックス項目が見つかりません。");
      let created;
      if (item.convertedTo)
        throw new Error(
          "このメモはすでに変換されています。作成済みの項目を確認してください。",
        );
      if (target === "task") {
        created = {
          id: id("task"),
          title: item.title,
          notes: item.body,
          status: "todo",
          priority: "normal",
          dueDate: null,
          projectId: null,
          tags: item.tags,
          createdAt: nowIso(),
          completedAt: null,
          updatedAt: nowIso(),
        };
        created.notes = [item.body, item.url].filter(Boolean).join("\n\n");
        draft.tasks.unshift(created);
      } else if (target === "project") {
        created = {
          id: id("project"),
          name: item.title,
          description: item.body,
          status: "active",
          color: "#8b7cff",
          progress: 0,
          dueDate: null,
          folder: "",
          links: item.url ? [{ label: item.title, url: item.url }] : [],
          notes: "",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        draft.projects.unshift(created);
      } else throw new Error("変換先が正しくありません。");
      item.convertedTo = { type: target, id: created.id };
      item.status = "archived";
      item.updatedAt = nowIso();
      this.activity(
        draft,
        target,
        `${target === "task" ? "タスク" : "プロジェクト"}へ変換`,
        item.title,
      );
      return created;
    });
  }

  async startFocus(input) {
    return this.change((draft) => {
      if (draft.sessions.some((item) => !item.endedAt))
        throw new Error("すでに集中セッションが進行中です。");
      const session = {
        id: id("session"),
        title: text(
          input.title || draft.profile.dailyFocus || "集中作業",
          "セッション名",
          200,
        ),
        projectId:
          input.projectId &&
          draft.projects.some((item) => item.id === input.projectId)
            ? input.projectId
            : null,
        startedAt: nowIso(),
        endedAt: null,
        durationMinutes: null,
        note: "",
      };
      const planned = Number(input.plannedMinutes ?? 25);
      if (!Number.isInteger(planned) || planned < 1 || planned > 180)
        throw new Error("集中時間は1〜180分で入力してください。");
      session.plannedMinutes = planned;
      session.pausedAt = null;
      session.pausedMilliseconds = 0;
      const task = draft.tasks.find(
        (item) =>
          item.id === input.taskId && ["todo", "doing"].includes(item.status),
      );
      if (task) {
        session.taskId = task.id;
        session.projectId = task.projectId;
        session.title = task.title;
        task.status = "doing";
        task.updatedAt = nowIso();
      }
      draft.sessions.unshift(session);
      this.activity(draft, "focus", "集中セッションを開始", session.title);
      return session;
    });
  }

  async stopFocus(input = {}) {
    return this.change((draft) => {
      const session = draft.sessions.find((item) => !item.endedAt);
      if (!session) throw new Error("進行中の集中セッションはありません。");
      session.endedAt = nowIso();
      const elapsed =
        new Date(session.pausedAt || session.endedAt) -
        new Date(session.startedAt) -
        (session.pausedMilliseconds || 0);
      session.durationMinutes = Math.max(1, Math.round(elapsed / 60_000));
      session.note = text(input.note ?? "", "振り返り", 5_000, {
        required: false,
      });
      if (input.completeTask && session.taskId) {
        const task = draft.tasks.find((item) => item.id === session.taskId);
        if (task && ["todo", "doing"].includes(task.status)) {
          task.status = "done";
          task.completedAt = session.endedAt;
          task.updatedAt = session.endedAt;
        }
      }
      draft.worklogs.unshift({
        id: id("log"),
        title: session.title,
        body: session.note,
        projectId: session.projectId,
        date: dayKey(),
        minutes: session.durationMinutes,
        source: "focus",
        createdAt: nowIso(),
      });
      this.activity(
        draft,
        "focus",
        "集中セッションを完了",
        `${session.title} · ${session.durationMinutes}分`,
      );
      return session;
    });
  }

  async addWorklog(input) {
    return this.change((draft) => {
      const minutes = Number(input.minutes ?? 0);
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440)
        throw new Error("作業時間は0〜1440分で入力してください。");
      const log = {
        id: id("log"),
        title: text(input.title, "作業内容", 300),
        body: text(input.body ?? "", "詳細", 20_000, { required: false }),
        projectId:
          input.projectId &&
          draft.projects.some((item) => item.id === input.projectId)
            ? input.projectId
            : null,
        date: optionalDate(input.date, "日付") ?? dayKey(),
        minutes: Math.round(minutes),
        source: "manual",
        createdAt: nowIso(),
      };
      draft.worklogs.unshift(log);
      this.activity(draft, "worklog", "作業ログを記録", log.title);
      return log;
    });
  }

  async pauseFocus() {
    return this.change((draft) => {
      const session = draft.sessions.find((item) => !item.endedAt);
      if (!session) throw new Error("進行中の集中セッションはありません。");
      if (session.pausedAt) {
        session.pausedMilliseconds =
          (session.pausedMilliseconds || 0) +
          Date.now() -
          new Date(session.pausedAt).getTime();
        session.pausedAt = null;
      } else session.pausedAt = nowIso();
      return session;
    });
  }

  async updateWorklog(logId, input) {
    return this.change((draft) => {
      const log = draft.worklogs.find((item) => item.id === logId);
      if (!log) throw new Error("作業記録が見つかりません。");
      if (input.title !== undefined)
        log.title = text(input.title, "作業内容", 300);
      if (input.body !== undefined)
        log.body = text(input.body, "詳細", 20_000, { required: false });
      if (input.minutes !== undefined) {
        const minutes = Number(input.minutes);
        if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440)
          throw new Error("作業時間は0〜1440分で入力してください。");
        log.minutes = Math.round(minutes);
      }
      if (input.date !== undefined) {
        const date = optionalDate(input.date, "日付");
        if (!date) throw new Error("日付を入力してください。");
        log.date = date;
      }
      if (input.projectId !== undefined)
        log.projectId = draft.projects.some(
          (item) => item.id === input.projectId,
        )
          ? input.projectId
          : null;
      log.updatedAt = nowIso();
      this.activity(draft, "worklog", "作業記録を編集", log.title);
      return log;
    });
  }

  async saveHabit(input) {
    return this.change((draft) => {
      let habit = input.id
        ? draft.habits.find((item) => item.id === input.id)
        : null;
      if (input.id && !habit) throw new Error("習慣が見つかりません。");
      if (!habit) {
        habit = {
          id: id("habit"),
          name: "",
          days: [],
          archived: false,
          createdAt: nowIso(),
        };
        draft.habits.push(habit);
      }
      if (input.name !== undefined)
        habit.name = text(input.name, "習慣の名前", 120);
      if (!habit.name) throw new Error("習慣の名前を入力してください。");
      if (input.archived !== undefined)
        habit.archived = Boolean(input.archived);
      if (input.date !== undefined) {
        const date = optionalDate(input.date, "記録日");
        if (!date || date > dayKey())
          throw new Error("今日までの日付を選んでください。");
        if (input.done === true)
          habit.days = [...new Set([...habit.days, date])].sort();
        else habit.days = habit.days.filter((day) => day !== date);
      }
      return habit;
    });
  }

  async applyTemplate(input) {
    const template = workspaceTemplates.find(
      (item) => item.id === input.templateId,
    );
    if (!template) throw new Error("テンプレートが見つかりません。");
    return this.change((draft) => {
      const project = {
        id: id("project"),
        name: template.name,
        description: template.description,
        color: template.color,
        status: "active",
        progress: 0,
        dueDate: null,
        folder: "",
        links: [],
        notes: "",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      draft.projects.unshift(project);
      const tasks = template.tasks.map((title, index) => ({
        id: id("task"),
        title,
        notes: "",
        status: "todo",
        priority: index === 0 ? "high" : "normal",
        scheduledDate: index === 0 ? dayKey() : null,
        dueDate: null,
        estimateMinutes: 25,
        projectId: project.id,
        tags: [],
        checklist: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
        completedAt: null,
      }));
      draft.tasks.unshift(...tasks);
      draft.profile.onboarded = true;
      this.activity(
        draft,
        "project",
        "テンプレートからプロジェクトを開始",
        project.name,
      );
      return project;
    });
  }

  async saveAutomation(input) {
    return this.change((draft) => {
      const existing = input.id
        ? draft.automations.find((item) => item.id === input.id)
        : null;
      const automation = existing ?? {
        id: id("auto"),
        lastRunAt: null,
        lastRunDay: null,
      };
      automation.name = text(input.name, "自動化名", 200);
      automation.description = text(input.description ?? "", "説明", 1_000, {
        required: false,
      });
      automation.action = [
        "daily-note",
        "inbox-digest",
        "project-snapshot",
        "backup",
      ].includes(input.action)
        ? input.action
        : "daily-note";
      automation.trigger = ["manual", "startup", "daily"].includes(
        input.trigger,
      )
        ? input.trigger
        : "manual";
      automation.enabled = Boolean(input.enabled);
      automation.options = {};
      if (!existing) draft.automations.push(automation);
      this.activity(draft, "automation", "自動化を保存", automation.name);
      return automation;
    });
  }

  summary() {
    const data = this.snapshot();
    const today = dayKey();
    const weekAgo = Date.now() - 7 * 86_400_000;
    const focusToday = data.sessions
      .filter((item) => item.endedAt && dayKey(item.endedAt) === today)
      .reduce((sum, item) => sum + (item.durationMinutes ?? 0), 0);
    const focusWeek = data.sessions
      .filter((item) => new Date(item.endedAt ?? 0).getTime() >= weekAgo)
      .reduce((sum, item) => sum + (item.durationMinutes ?? 0), 0);
    const dueToday = data.tasks.filter(
      (item) =>
        item.status !== "done" &&
        item.status !== "archived" &&
        item.dueDate &&
        item.dueDate <= today,
    );
    return {
      ...data,
      computed: {
        today,
        openInbox: data.inbox.filter((item) => item.status === "open").length,
        openTasks: data.tasks.filter((item) =>
          ["todo", "doing"].includes(item.status),
        ).length,
        dueToday: dueToday.length,
        activeProjects: data.projects.filter((item) => item.status === "active")
          .length,
        focusToday,
        focusWeek,
        activeSession: data.sessions.find((item) => !item.endedAt) ?? null,
      },
    };
  }
}
