import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyPlan, createPlan, loadConfig, renderPlan, undoLatest } from "../src/file-organizer.mjs";

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-organizer-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "inbox");
  const destination = path.join(root, "sorted");
  await fs.mkdir(source);
  const configFile = path.join(root, "config.json");
  const configuration = {
    source,
    destination,
    categories: { Images: [".jpg", ".png"], Documents: [".pdf", ".txt"] },
    options: {
      minimumAgeMinutes: 1,
      dateFolders: "none",
      includeUnknown: false,
      unknownCategory: "Other",
      maxPreviewItems: 40,
      ignore: ["*.part", "*.tmp"],
    },
    ...overrides,
  };
  await fs.writeFile(configFile, JSON.stringify(configuration));
  return { root, source, destination, configFile, config: await loadConfig(configFile) };
}

async function oldFile(filePath, contents = "data") {
  await fs.writeFile(filePath, contents);
  const old = new Date(Date.now() - 5 * 60_000);
  await fs.utimes(filePath, old, old);
}

test("plans recognized files and explains every skipped entry", async (t) => {
  const item = await fixture(t, { options: {
    minimumAgeMinutes: 1, dateFolders: "month", includeUnknown: false,
    unknownCategory: "Other", maxPreviewItems: 40, ignore: ["*.part", "*.tmp"],
  } });
  await oldFile(path.join(item.source, "photo.jpg"), "image");
  await oldFile(path.join(item.source, "unknown.xyz"));
  await oldFile(path.join(item.source, "setup.exe"));
  await oldFile(path.join(item.source, "movie.part"));
  await oldFile(path.join(item.source, "~$draft.docx"));
  await fs.writeFile(path.join(item.source, "fresh.pdf"), "fresh");
  await fs.mkdir(path.join(item.source, "folder"));

  const plan = await createPlan(item.config);

  assert.equal(plan.planned.length, 1);
  assert.equal(plan.planned[0].name, "photo.jpg");
  assert.match(plan.planned[0].relativeTarget, new RegExp(`Images\\${path.sep}\\d{4}-\\d{2}\\${path.sep}photo\\.jpg$`));
  assert.deepEqual(new Set(plan.skipped.map((entry) => entry.reason)), new Set(["unknown", "protected", "ignored", "recent", "folder"]));
  assert.match(renderPlan(plan), /PREVIEW · nothing has been moved/);
  assert.match(renderPlan(plan), /Safely left in place/);
});

test("chooses a collision-free target without overwriting", async (t) => {
  const item = await fixture(t);
  await oldFile(path.join(item.source, "report.pdf"), "new");
  await fs.mkdir(path.join(item.destination, "Documents"), { recursive: true });
  await fs.writeFile(path.join(item.destination, "Documents", "report.pdf"), "old");

  const plan = await createPlan(item.config);

  assert.equal(path.basename(plan.planned[0].target), "report (2).pdf");
});

test("applies a batch, writes history, and restores it with undo", async (t) => {
  const item = await fixture(t);
  const original = path.join(item.source, "photo.jpg");
  await oldFile(original, "stars");
  const plan = await createPlan(item.config);

  const applied = await applyPlan(plan, item.config);
  assert.equal(applied.moves.length, 1);
  assert.equal(await fs.readFile(path.join(item.destination, "Images", "photo.jpg"), "utf8"), "stars");
  await assert.rejects(fs.access(original));

  const undone = await undoLatest(item.config);
  assert.equal(undone.status, "undone");
  assert.equal(await fs.readFile(original, "utf8"), "stars");
  await assert.rejects(fs.access(path.join(item.destination, "Images", "photo.jpg")));
});

test("moves only application folders explicitly matched by a folder rule", async (t) => {
  const item = await fixture(t, { folderCategories: { Applications: ["portable-*"] } });
  const application = path.join(item.source, "portable-tool");
  const unrelated = path.join(item.source, "personal-folder");
  await fs.mkdir(application);
  await fs.mkdir(unrelated);
  await fs.writeFile(path.join(application, "tool.dat"), "portable app");
  const old = new Date(Date.now() - 5 * 60_000);
  await fs.utimes(application, old, old);

  const plan = await createPlan(item.config);
  assert.equal(plan.planned.length, 1);
  assert.equal(plan.planned[0].type, "directory");
  assert.equal(plan.planned[0].size, 12);
  assert.equal(plan.skipped.find((entry) => entry.name === "personal-folder").reason, "folder");

  await applyPlan(plan, item.config);
  assert.equal(await fs.readFile(path.join(item.destination, "Applications", "portable-tool", "tool.dat"), "utf8"), "portable app");
  await undoLatest(item.config);
  assert.equal(await fs.readFile(path.join(application, "tool.dat"), "utf8"), "portable app");
});

test("organizes installer files only when explicitly enabled", async (t) => {
  const item = await fixture(t, {
    categories: { Installers: [".exe", ".msi"] },
    options: {
      minimumAgeMinutes: 1,
      dateFolders: "none",
      includeUnknown: false,
      allowInstallerFiles: true,
      unknownCategory: "Other",
      maxPreviewItems: 40,
      ignore: ["*.part"],
    },
  });
  await oldFile(path.join(item.source, "Setup.exe"), "installer");

  const plan = await createPlan(item.config);

  assert.equal(plan.planned.length, 1);
  assert.equal(plan.planned[0].category, "Installers");
});

test("organizes into and undoes from a per-category custom destination", async (t) => {
  const item = await fixture(t);
  const customImages = path.join(item.root, "Pictures", "Sorted");
  const document = JSON.parse(await fs.readFile(item.configFile, "utf8"));
  document.categoryDestinations = { Images: customImages };
  await fs.writeFile(item.configFile, JSON.stringify(document));
  const config = await loadConfig(item.configFile);
  const original = path.join(item.source, "photo.jpg");
  await oldFile(original, "custom orbit");

  const plan = await createPlan(config);
  assert.equal(plan.planned[0].target, path.join(customImages, "photo.jpg"));
  await applyPlan(plan, config);
  assert.equal(await fs.readFile(path.join(customImages, "photo.jpg"), "utf8"), "custom orbit");

  await undoLatest(config);
  assert.equal(await fs.readFile(original, "utf8"), "custom orbit");
});

test("undo never overwrites a file recreated at the original path", async (t) => {
  const item = await fixture(t);
  const original = path.join(item.source, "photo.jpg");
  await oldFile(original, "organized copy");
  await applyPlan(await createPlan(item.config), item.config);
  await fs.writeFile(original, "new original");

  const undone = await undoLatest(item.config);

  assert.equal(undone.status, "undone");
  assert.equal(await fs.readFile(original, "utf8"), "new original");
  assert.equal(await fs.readFile(path.join(item.source, "photo (restored 2).jpg"), "utf8"), "organized copy");
});

test("undo can recover a move left behind by an interrupted apply", async (t) => {
  const item = await fixture(t);
  const original = path.join(item.source, "notes.txt");
  const organized = path.join(item.destination, "Documents", "notes.txt");
  await fs.mkdir(path.dirname(organized), { recursive: true });
  await fs.writeFile(organized, "recover me");
  const history = path.join(item.destination, ".file-organizer", "history");
  await fs.mkdir(history, { recursive: true });
  const record = {
    version: 1,
    id: "2026-01-01T00-00-00-000Z",
    status: "applying",
    appliedAt: "2026-01-01T00:00:00.000Z",
    source: item.source,
    destination: item.destination,
    operations: [{ from: original, to: organized, size: 10 }],
    moves: [],
    notMoved: [],
  };
  await fs.writeFile(path.join(history, `${record.id}.json`), JSON.stringify(record));

  const undone = await undoLatest(item.config);

  assert.equal(undone.status, "undone");
  assert.equal(await fs.readFile(original, "utf8"), "recover me");
});

test("leaves a file in place when it changed after planning", async (t) => {
  const item = await fixture(t);
  const original = path.join(item.source, "notes.txt");
  await oldFile(original, "first");
  const plan = await createPlan(item.config);
  await fs.appendFile(original, " second");

  const applied = await applyPlan(plan, item.config);

  assert.equal(applied.moves.length, 0);
  assert.equal(applied.notMoved[0].reason, "changed since preview");
  assert.equal(await fs.readFile(original, "utf8"), "first second");
});

test("an apply lock prevents two organizers from moving the same inbox", async (t) => {
  const item = await fixture(t);
  await oldFile(path.join(item.source, "notes.txt"));
  const plan = await createPlan(item.config);
  const metadata = path.join(item.destination, ".file-organizer");
  await fs.mkdir(metadata, { recursive: true });
  await fs.writeFile(path.join(metadata, "apply.lock"), "already running");

  await assert.rejects(applyPlan(plan, item.config), /Another operation may be running/);
  assert.equal(await fs.readFile(path.join(item.source, "notes.txt"), "utf8"), "data");
});

test("rejects executable rules and a destination nested in source", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-organizer-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await fs.mkdir(source);
  const configFile = path.join(root, "config.json");
  await fs.writeFile(configFile, JSON.stringify({ source, destination: path.join(root, "destination"), categories: { Dangerous: [".exe"] } }));
  await assert.rejects(loadConfig(configFile), /protected executable extension/);

  await fs.writeFile(configFile, JSON.stringify({ source, destination: path.join(source, "sorted"), categories: { Text: [".txt"] } }));
  await assert.rejects(loadConfig(configFile), /Destination must be outside source/);

  const destination = path.join(root, "destination");
  await fs.writeFile(configFile, JSON.stringify({
    source,
    destination,
    categories: { Alpha: [".txt"], Beta: [".jpg"] },
    categoryDestinations: { Beta: path.join(destination, "Alpha", "Nested") },
  }));
  await assert.rejects(loadConfig(configFile), /cannot contain one another/);
});
