import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { WorkspaceStore } from "../src/workspace-store.mjs";
import { localDay } from "../src/local-date.mjs";
import { productivityInsights } from "../src/workspace-insights.mjs";
import { walkFiles, fileHealth } from "../src/search-engine.mjs";

async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "perfectwork-experience-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return new WorkspaceStore(directory).init();
}

test("calendar dates use the local day at midnight in Japan and America", () => {
  const script =
    "import {localDay} from './src/local-date.mjs'; process.stdout.write(localDay('2026-09-05T15:30:00Z'))";
  assert.equal(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, TZ: "Asia/Tokyo" },
    }),
    "2026-09-06",
  );
  assert.equal(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, TZ: "America/Los_Angeles" },
    }),
    "2026-09-05",
  );
});

test("invalid dates and task details are rejected without partial writes", async (t) => {
  const store = await fixture(t);
  const before = store.snapshot();
  await assert.rejects(
    store.createTask({ title: "Impossible date", dueDate: "2026-02-30" }),
    /正しく/,
  );
  await assert.rejects(
    store.createTask({
      title: "Impossible month",
      scheduledDate: "2026-13-01",
    }),
    /正しく/,
  );
  await assert.rejects(
    store.createTask({ title: "Impossible estimate", estimateMinutes: -1 }),
    /見積/,
  );
  assert.deepEqual(store.snapshot(), before);
  const task = await store.createTask({
    title: "Leap day",
    dueDate: "2028-02-29",
    scheduledDate: "2028-02-27",
    estimateMinutes: 50,
    checklist: [{ title: "Review", done: false }],
  });
  await store.updateTask(task.id, {
    checklist: [{ title: "Review", done: true }],
  });
  const reload = await new WorkspaceStore(store.directory).init();
  assert.equal(reload.data.tasks[0].scheduledDate, "2028-02-27");
  assert.equal(reload.data.tasks[0].checklist[0].done, true);
});

test("task completion timestamps survive duplicate updates and archive/restore", async (t) => {
  const store = await fixture(t);
  const task = await store.createTask({ title: "Done" });
  await store.updateTask(task.id, { status: "done" });
  const completed = store.data.tasks[0].completedAt;
  await store.updateTask(task.id, { status: "done" });
  assert.equal(store.data.tasks[0].completedAt, completed);
  await store.updateTask(task.id, { status: "archived" });
  assert.equal(store.data.tasks[0].previousStatus, "done");
  await store.updateTask(task.id, { status: "done" });
  assert.equal(store.data.tasks[0].completedAt, completed);
});

test("project creation honors status, color, progress; editing retains unrelated links", async (t) => {
  const store = await fixture(t);
  const project = await store.createProject({
    name: "Research",
    status: "paused",
    progress: 42,
    color: "#112233",
    links: [
      { label: "A", url: "https://example.com/a" },
      { label: "B", url: "https://example.com/b" },
    ],
  });
  assert.equal(project.status, "paused");
  assert.equal(project.progress, 42);
  await store.updateProject(project.id, {
    color: "#556677",
    description: "Changed",
  });
  assert.equal(store.data.projects[0].color, "#556677");
  assert.equal(store.data.projects[0].links.length, 2);
  await assert.rejects(
    store.updateProject(project.id, { color: "red; display:none" }),
    /色/,
  );
  assert.equal(store.data.projects[0].color, "#556677");
});

test("concurrent inbox conversion creates one task and preserves the source URL", async (t) => {
  const store = await fixture(t);
  const item = await store.capture({
    title: "Read",
    body: "Notes",
    url: "https://example.com/article",
  });
  const outcomes = await Promise.allSettled([
    store.convertInbox(item.id, "task"),
    store.convertInbox(item.id, "task"),
  ]);
  assert.equal(
    outcomes.filter((item) => item.status === "fulfilled").length,
    1,
  );
  assert.equal(store.data.tasks.length, 1);
  assert.match(store.data.tasks[0].notes, /https:\/\/example.com\/article/);
  assert.equal(store.data.inbox[0].convertedTo.id, store.data.tasks[0].id);
});

test("focus pauses persist, excluded time is not logged, and completion links to the task", async (t) => {
  const store = await fixture(t);
  const project = await store.createProject({ name: "Launch" });
  const task = await store.createTask({ title: "Ship", projectId: project.id });
  await store.startFocus({ taskId: task.id, plannedMinutes: 50 });
  assert.equal(store.data.tasks[0].status, "doing");
  await assert.rejects(store.startFocus({}), /すでに/);
  await store.change((draft) => {
    draft.sessions[0].startedAt = new Date(
      Date.now() - 30 * 60_000,
    ).toISOString();
    draft.sessions[0].pausedMilliseconds = 10 * 60_000;
    draft.sessions[0].pausedAt = new Date(
      Date.now() - 5 * 60_000,
    ).toISOString();
  });
  const reloaded = await new WorkspaceStore(store.directory).init();
  assert.ok(reloaded.data.sessions[0].pausedAt);
  await reloaded.stopFocus({ note: "Delivered", completeTask: true });
  assert.equal(reloaded.data.worklogs[0].minutes, 15);
  assert.equal(reloaded.data.worklogs[0].projectId, project.id);
  assert.equal(reloaded.data.tasks[0].status, "done");
  assert.equal(reloaded.summary().computed.activeSession, null);
});

test("habits support idempotent check-ins, archive, restore and migration", async (t) => {
  const store = await fixture(t);
  const habit = await store.saveHabit({ name: "Read 10 minutes" });
  await store.saveHabit({ id: habit.id, date: localDay(), done: true });
  await store.saveHabit({ id: habit.id, date: localDay(), done: true });
  assert.equal(store.data.habits[0].days.length, 1);
  await store.saveHabit({ id: habit.id, archived: true });
  await store.saveHabit({ id: habit.id, archived: false });
  assert.equal(store.data.habits[0].days.length, 1);
  await assert.rejects(
    store.saveHabit({ id: habit.id, date: "2999-01-01", done: true }),
    /今日/,
  );
  await store.saveHabit({ id: habit.id, date: localDay(), done: false });
  assert.equal(store.data.habits[0].days.length, 0);
  const old = store.snapshot();
  delete old.habits;
  delete old.profile.theme;
  await fs.writeFile(store.file, JSON.stringify(old));
  const reloaded = await new WorkspaceStore(store.directory).init();
  assert.deepEqual(reloaded.data.habits, []);
  assert.equal(reloaded.data.profile.theme, "light");
});

test("templates create linked real tasks in one persisted transaction", async (t) => {
  const store = await fixture(t);
  const before = store.snapshot();
  await assert.rejects(
    store.applyTemplate({ templateId: "missing" }),
    /見つかりません/,
  );
  assert.deepEqual(store.snapshot(), before);
  const project = await store.applyTemplate({ templateId: "launch" });
  const reloaded = await new WorkspaceStore(store.directory).init();
  assert.equal(reloaded.data.tasks.length, 5);
  assert.ok(reloaded.data.tasks.every((task) => task.projectId === project.id));
  assert.equal(reloaded.data.tasks[0].scheduledDate, localDay());
  assert.equal(reloaded.data.profile.onboarded, true);
});

test("a real 30-day streak is not capped at the 14-day chart", async (t) => {
  const store = await fixture(t);
  const data = store.snapshot();
  data.worklogs = Array.from({ length: 30 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - index);
    return { date: localDay(date), minutes: 25 };
  });
  const insights = productivityInsights(data);
  assert.equal(insights.streak, 30);
  assert.equal(insights.days.length, 14);
  assert.equal(insights.totalMinutes, 350);
});

test("work log corrections persist and invalid edits roll back", async (t) => {
  const store = await fixture(t);
  const log = await store.addWorklog({ title: "Initial record", minutes: 25 });
  await store.updateWorklog(log.id, {
    title: "Corrected record",
    minutes: 40,
    body: "Added context",
  });
  const before = store.snapshot();
  await assert.rejects(
    store.updateWorklog(log.id, { title: "Must not save", minutes: -5 }),
    /作業時間/,
  );
  assert.deepEqual(store.snapshot(), before);
  assert.equal(
    (await new WorkspaceStore(store.directory).init()).data.worklogs[0].minutes,
    40,
  );
});

test("overlapping search roots do not count the same file twice or invent duplicates", async (t) => {
  const store = await fixture(t);
  const files = path.join(store.directory, "files"),
    nested = path.join(files, "nested");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, "unique.txt"), "Unique content");
  const roots = [files, nested, files];
  assert.equal((await walkFiles(roots)).files.length, 1);
  const health = await fileHealth({
    ...store.data.settings,
    searchRoots: roots,
  });
  assert.equal(health.files, 1);
  assert.equal(health.duplicateGroups.length, 0);
});

test("database-backed store imports JSON, persists revisions, and keeps a recovery mirror", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "perfectwork-db-store-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const original = await new WorkspaceStore(directory).init();
  await original.createTask({ title: "Import this task" });
  const repository = {
    state: null,
    revision: 0,
    async init() {},
    async load() {
      return this.state
        ? { state: structuredClone(this.state), revision: this.revision }
        : null;
    },
    async initialize(state) {
      this.state = structuredClone(state);
      this.revision = 1;
      return this.load();
    },
    async save(state, expected) {
      assert.equal(expected, this.revision);
      this.state = structuredClone(state);
      return ++this.revision;
    },
    async status() {
      return {
        backend: "postgresql",
        connected: true,
        revision: this.revision,
        entities: this.state.tasks.length,
      };
    },
    async close() {},
  };
  const databaseStore = await new WorkspaceStore(directory, {
    repository,
  }).init();
  assert.equal(databaseStore.data.tasks[0].title, "Import this task");
  assert.equal(databaseStore.revision, 1);
  await databaseStore.createTask({ title: "Stored in both places" });
  assert.equal(repository.state.tasks.length, 2);
  assert.equal(
    JSON.parse(await fs.readFile(databaseStore.file, "utf8")).tasks.length,
    2,
  );
  assert.equal((await databaseStore.storageStatus()).backend, "postgresql");
  assert.ok(
    (await fs.readdir(directory)).some((file) =>
      file.startsWith("workspace.before-postgres-"),
    ),
  );
});
