import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
} from "../src/config-manager.mjs";
import { createPlan, loadConfig } from "../src/file-organizer.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-manager-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "Downloads");
  const destination = path.join(root, "Documents");
  const stateDirectory = path.join(root, "state");
  await fs.mkdir(source);
  await fs.mkdir(destination);
  const configPath = path.join(root, "config.json");
  await fs.writeFile(configPath, JSON.stringify({
    source,
    destination,
    categories: { Alpha: [".txt"], Beta: [".jpg"] },
    folderCategories: {},
    options: { minimumAgeMinutes: 0, stateDirectory },
  }));
  return { root, source, destination, configPath, config: await loadConfig(configPath) };
}

test("creates categories and safely manages extension and folder rules", async (t) => {
  const item = await fixture(t);

  await createCategory(item.configPath, "3D Models");
  await updateRule(item.configPath, "addExtension", "3D Models", "blend");
  await updateRule(item.configPath, "addFolderPattern", "3D Models", "Project-*");
  let document = await readConfigDocument(item.configPath);
  assert.deepEqual(document.categories["3D Models"], [".blend"]);
  assert.deepEqual(document.folderCategories["3D Models"], ["Project-*"]);

  await updateRule(item.configPath, "removeExtension", "3D Models", ".blend");
  await updateRule(item.configPath, "removeFolderPattern", "3D Models", "Project-*");
  await deleteCategory(item.configPath, "3D Models");
  document = await readConfigDocument(item.configPath);
  assert.equal(Object.hasOwn(document.categories, "3D Models"), false);
});

test("reassigns existing files without overwriting and can undo", async (t) => {
  const item = await fixture(t);
  await fs.mkdir(path.join(item.destination, "Alpha"));
  await fs.mkdir(path.join(item.destination, "Beta"));
  await fs.writeFile(path.join(item.destination, "Alpha", "note.txt"), "moving");
  await fs.writeFile(path.join(item.destination, "Beta", "note.txt"), "existing");
  const document = await readConfigDocument(item.configPath);

  const record = await reassignItems(item.config, document, "Alpha", "Beta", ["note.txt"]);
  assert.equal(record.status, "applied");
  assert.equal(await fs.readFile(path.join(item.destination, "Beta", "note (2).txt"), "utf8"), "moving");
  assert.equal(await fs.readFile(path.join(item.destination, "Beta", "note.txt"), "utf8"), "existing");

  const undone = await undoLatestReassignment(item.config);
  assert.equal(undone.status, "undone");
  assert.equal(await fs.readFile(path.join(item.destination, "Alpha", "note.txt"), "utf8"), "moving");
});

test("renames a category together with its existing items", async (t) => {
  const item = await fixture(t);
  await fs.mkdir(path.join(item.destination, "Alpha"));
  await fs.writeFile(path.join(item.destination, "Alpha", "note.txt"), "content");

  await renameCategory(item.configPath, "Alpha", "Writing");

  const document = await readConfigDocument(item.configPath);
  assert.deepEqual(document.categories.Writing, [".txt"]);
  assert.equal(Object.hasOwn(document.categories, "Alpha"), false);
  assert.equal(await fs.readFile(path.join(item.destination, "Writing", "note.txt"), "utf8"), "content");
  await assert.rejects(fs.access(path.join(item.destination, "Alpha")));
});

test("discovers existing Documents folders that can be imported", async (t) => {
  const item = await fixture(t);
  await fs.mkdir(path.join(item.destination, "Existing Work"));

  const state = await dashboardState(item.configPath);

  assert.ok(state.availableFolders.includes("Existing Work"));
  assert.ok(!state.availableFolders.includes("Alpha"));
});

test("moves a category to a custom destination and can return to the default", async (t) => {
  const item = await fixture(t);
  const defaultDirectory = path.join(item.destination, "Alpha");
  const customDirectory = path.join(item.root, "Another Drive", "Writing");
  await fs.mkdir(defaultDirectory);
  await fs.writeFile(path.join(defaultDirectory, "note.txt"), "travels safely");

  await updateCategoryDestination(item.configPath, "Alpha", customDirectory);
  let document = await readConfigDocument(item.configPath);
  let state = await dashboardState(item.configPath);
  assert.equal(document.categoryDestinations.Alpha, customDirectory);
  assert.equal(state.categories.find((category) => category.name === "Alpha").path, customDirectory);
  assert.equal(await fs.readFile(path.join(customDirectory, "note.txt"), "utf8"), "travels safely");
  await assert.rejects(fs.access(defaultDirectory));

  await updateCategoryDestination(item.configPath, "Alpha", defaultDirectory);
  document = await readConfigDocument(item.configPath);
  state = await dashboardState(item.configPath);
  assert.equal(document.categoryDestinations, undefined);
  assert.equal(state.categories.find((category) => category.name === "Alpha").customDestination, false);
  assert.equal(await fs.readFile(path.join(defaultDirectory, "note.txt"), "utf8"), "travels safely");
  assert.ok(await fs.stat(customDirectory));
});

test("refuses to delete a category while it still contains items", async (t) => {
  const item = await fixture(t);
  await fs.mkdir(path.join(item.destination, "Alpha"));
  await fs.writeFile(path.join(item.destination, "Alpha", "keep.txt"), "safe");

  await assert.rejects(deleteCategory(item.configPath, "Alpha"), /Move the category's items/);
  assert.equal(await fs.readFile(path.join(item.destination, "Alpha", "keep.txt"), "utf8"), "safe");
});

test("reports a new folder-rule conflict and applies the selected priority", async (t) => {
  const item = await fixture(t);
  await updateRule(item.configPath, "addFolderPattern", "Beta", "*Tool*");
  const added = await updateRule(item.configPath, "addFolderPattern", "Alpha", "Office-*");

  assert.equal(added.conflicts.length, 1);
  assert.equal(added.conflicts[0].rules[0].category, "Alpha", "the more specific pattern should win by default");
  let state = await dashboardState(item.configPath);
  assert.equal(state.conflicts.length, 1);

  const conflict = state.conflicts[0];
  await setFolderRulePriority(item.configPath, conflict.rules[1], conflict.rules[0]);
  state = await dashboardState(item.configPath);
  assert.equal(state.conflicts[0].rules[0].category, "Beta");

  const matchingFolder = path.join(item.source, "Office-Tool");
  await fs.mkdir(matchingFolder);
  const old = new Date(Date.now() - 5 * 60_000);
  await fs.utimes(matchingFolder, old, old);
  const plan = await createPlan(await loadConfig(item.configPath));
  assert.equal(plan.planned[0].category, "Beta", "the organizer must use the saved priority");
});
