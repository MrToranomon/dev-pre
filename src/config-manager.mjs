import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { applyPlan, createPlan, loadConfig } from "./file-organizer.mjs";
import { findFolderRuleConflicts, orderFolderRules, prioritizeFolderRule } from "./folder-rules.mjs";

function safeName(value, label = "Name") {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  const name = value.trim();
  if (name === "." || name === ".." || path.isAbsolute(name) || /[\\/:*?"<>|]/.test(name)) {
    throw new Error(`${label} must be one safe folder name.`);
  }
  return name;
}

function safePattern(value) {
  if (typeof value !== "string" || !value.trim() || /[\\/:"<>|]/.test(value)) {
    throw new Error("Folder pattern must be a name and may use * or ? wildcards.");
  }
  return value.trim();
}

function normalizedExtension(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Extension is required.");
  const extension = value.trim().toLowerCase();
  const withDot = extension.startsWith(".") ? extension : `.${extension}`;
  if (!/^\.[a-z0-9][a-z0-9.+_-]*$/i.test(withDot)) throw new Error(`Invalid extension: ${value}`);
  return withDot;
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function uniqueTarget(target, reserved = new Set(), label = null) {
  const parsed = path.parse(target);
  for (let number = 1; ; number += 1) {
    const suffix = number === 1 ? "" : ` (${label ? `${label} ${number}` : number})`;
    const candidate = path.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext}`);
    const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (!reserved.has(key) && !(await exists(candidate))) {
      reserved.add(key);
      return candidate;
    }
  }
}

export async function readConfigDocument(configPath) {
  return JSON.parse(await fs.readFile(configPath, "utf8"));
}

async function validateConfigDocument(configPath, document) {
  const temporary = `${configPath}.${process.pid}.validate.tmp`;
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  await fs.writeFile(temporary, contents, { flag: "wx" });
  try {
    return await loadConfig(temporary);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function saveConfigDocument(configPath, document) {
  await validateConfigDocument(configPath, document);
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  await fs.writeFile(configPath, contents);
  return loadConfig(configPath);
}

export function categoryNames(document) {
  return [...new Set([...Object.keys(document.categories ?? {}), ...Object.keys(document.folderCategories ?? {})])];
}

function syncFolderRuleOrder(document) {
  const ordered = orderFolderRules(document.folderCategories ?? {}, document.folderRuleOrder ?? []);
  if (ordered.length) document.folderRuleOrder = ordered;
  else delete document.folderRuleOrder;
  return ordered;
}

export async function inventory(config, document) {
  const result = {};
  for (const category of categoryNames(document)) {
    const directory = config.destinationByCategory.get(category);
    let entries = [];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    result[category] = await Promise.all(entries
      .filter((entry) => !entry.isSymbolicLink())
      .sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }))
      .map(async (entry) => {
        const stats = await fs.stat(path.join(directory, entry.name));
        return {
          name: entry.name,
          type: entry.isDirectory() ? "folder" : "file",
          size: entry.isFile() ? stats.size : null,
          modifiedAt: stats.mtime.toISOString(),
        };
      }));
  }
  return result;
}

function operationDirectory(config) {
  return path.join(config.stateDirectory, "manager-history");
}

async function operationRecords(config) {
  const directory = operationDirectory(config);
  let names = [];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const records = [];
  for (const name of names.filter((item) => item.endsWith(".json")).sort().reverse()) {
    try {
      records.push({
        file: path.join(directory, name),
        record: JSON.parse(await fs.readFile(path.join(directory, name), "utf8")),
      });
    } catch {
      // Ignore damaged history entries; no file operation is inferred from them.
    }
  }
  return records;
}

async function withManagerLock(config, action) {
  await fs.mkdir(config.stateDirectory, { recursive: true });
  const lock = path.join(config.stateDirectory, "manager.lock");
  try {
    await fs.writeFile(lock, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("Another reassignment is already running.");
    throw error;
  }
  try {
    return await action();
  } finally {
    await fs.unlink(lock).catch(() => {});
  }
}

async function movePath(source, target, type) {
  try {
    await fs.rename(source, target);
    return;
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
  }

  if (type === "folder") {
    await fs.cp(source, target, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    try {
      await fs.rm(source, { recursive: true });
    } catch (error) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return;
  }

  const stats = await fs.stat(source);
  await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  try {
    await fs.utimes(target, stats.atime, stats.mtime);
    await fs.unlink(source);
  } catch (error) {
    await fs.unlink(target).catch(() => {});
    throw error;
  }
}

async function moveBetweenDirectories(config, fromDirectory, toDirectory, names, metadata) {
  if (!Array.isArray(names) || names.length === 0) throw new Error("Select at least one item.");
  return withManagerLock(config, async () => {
    const operations = [];
    const reserved = new Set();
    for (const rawName of [...new Set(names)]) {
      const name = safeName(rawName, "Item name");
      const source = path.resolve(fromDirectory, name);
      if (!within(fromDirectory, source) || !(await exists(source))) throw new Error(`Item not found: ${name}`);
      const stats = await fs.lstat(source);
      if (stats.isSymbolicLink()) throw new Error(`Symbolic links cannot be reassigned: ${name}`);
      const target = await uniqueTarget(path.join(toDirectory, name), reserved);
      operations.push({ from: source, to: target, name, type: stats.isDirectory() ? "folder" : "file", size: stats.isFile() ? stats.size : null });
    }

    const directory = operationDirectory(config);
    await fs.mkdir(directory, { recursive: true });
    const id = new Date().toISOString().replace(/[:.]/g, "-");
    const record = { id, status: "applying", createdAt: new Date().toISOString(), ...metadata, operations, completed: [] };
    const historyFile = path.join(directory, `${id}.json`);
    const writeHistory = () => fs.writeFile(historyFile, `${JSON.stringify(record, null, 2)}\n`);
    await fs.writeFile(historyFile, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    try {
      await fs.mkdir(toDirectory, { recursive: true });
      for (const operation of operations) {
        await movePath(operation.from, operation.to, operation.type);
        record.completed.push(operation);
      }
      record.status = "applied";
      await writeHistory();
      return record;
    } catch (error) {
      for (const operation of [...record.completed].reverse()) {
        if (await exists(operation.to)) await movePath(operation.to, operation.from, operation.type).catch(() => {});
      }
      record.status = "rolled-back";
      record.error = error.message;
      await writeHistory().catch(() => {});
      throw error;
    }
  });
}

export async function reassignItems(config, document, fromCategory, toCategory, names, reason = "reassign") {
  const from = safeName(fromCategory, "Source category");
  const to = safeName(toCategory, "Destination category");
  const known = new Set(categoryNames(document));
  if (!known.has(from) || !known.has(to)) throw new Error("Both categories must exist.");
  if (from === to) throw new Error("Choose a different destination category.");
  const sourceDirectory = config.destinationByCategory.get(from) ?? path.join(config.destination, from);
  const targetDirectory = config.destinationByCategory.get(to) ?? path.join(config.destination, to);
  return moveBetweenDirectories(config, sourceDirectory, targetDirectory, names, {
    reason, fromCategory: from, toCategory: to,
  });
}

export async function undoLatestReassignment(config, { recordId = null } = {}) {
  return withManagerLock(config, async () => {
    const candidate = (await operationRecords(config)).find(({ record }) =>
      record.status === "applied" && (recordId ? record.id === recordId : record.reason === "reassign"));
    if (!candidate) return null;
    const restored = [];
    const reserved = new Set();
    for (const operation of [...candidate.record.completed].reverse()) {
      if (!(await exists(operation.to))) continue;
      const target = await uniqueTarget(operation.from, reserved, "restored");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await movePath(operation.to, target, operation.type);
      restored.push({ from: operation.to, to: target, type: operation.type, size: operation.size });
    }
    candidate.record.status = "undone";
    candidate.record.undoneAt = new Date().toISOString();
    candidate.record.restored = restored;
    await fs.writeFile(candidate.file, `${JSON.stringify(candidate.record, null, 2)}\n`);
    return candidate.record;
  });
}

export async function createCategory(configPath, name) {
  const document = await readConfigDocument(configPath);
  const category = safeName(name, "Category name");
  if (categoryNames(document).includes(category)) throw new Error(`Category already exists: ${category}`);
  document.categories ??= {};
  document.categories[category] = [];
  await saveConfigDocument(configPath, document);
  return category;
}

export async function deleteCategory(configPath, name) {
  const config = await loadConfig(configPath);
  const document = await readConfigDocument(configPath);
  const category = safeName(name, "Category name");
  if (!categoryNames(document).includes(category)) throw new Error(`Unknown category: ${category}`);
  const directory = config.destinationByCategory.get(category);
  if (await exists(directory)) {
    const entries = await fs.readdir(directory);
    if (entries.length) throw new Error("Move the category's items elsewhere before deleting it.");
    if (!Object.hasOwn(document.categoryDestinations ?? {}, category)) await fs.rmdir(directory);
  }
  delete document.categories?.[category];
  delete document.folderCategories?.[category];
  delete document.categoryDestinations?.[category];
  if (Array.isArray(document.folderRuleOrder)) {
    document.folderRuleOrder = document.folderRuleOrder.filter((rule) => rule.category !== category);
    syncFolderRuleOrder(document);
  }
  await saveConfigDocument(configPath, document);
}

export async function renameCategory(configPath, oldName, newName) {
  const config = await loadConfig(configPath);
  const document = await readConfigDocument(configPath);
  const from = safeName(oldName, "Current category");
  const to = safeName(newName, "New category");
  if (!categoryNames(document).includes(from)) throw new Error(`Unknown category: ${from}`);
  if (categoryNames(document).includes(to)) throw new Error(`Category already exists: ${to}`);

  const currentItems = (await inventory(config, document))[from];
  document.categories ??= {};
  if (Object.hasOwn(document.categories, from)) {
    document.categories[to] = document.categories[from];
    delete document.categories[from];
  }
  if (Object.hasOwn(document.folderCategories ?? {}, from)) {
    document.folderCategories[to] = document.folderCategories[from];
    delete document.folderCategories[from];
  }
  if (Array.isArray(document.folderRuleOrder)) {
    document.folderRuleOrder = document.folderRuleOrder.map((rule) => rule.category === from ? { ...rule, category: to } : rule);
    syncFolderRuleOrder(document);
  }

  const customDestination = document.categoryDestinations?.[from];
  if (customDestination) {
    document.categoryDestinations[to] = customDestination;
    delete document.categoryDestinations[from];
  }

  let moveRecord = null;
  if (currentItems.length && !customDestination) {
    const movementDocument = structuredClone(document);
    movementDocument.categories[from] = [];
    moveRecord = await reassignItems(config, movementDocument, from, to, currentItems.map((item) => item.name), "rename-category");
  }
  try {
    await saveConfigDocument(configPath, document);
    const oldDirectory = config.destinationByCategory.get(from);
    if (await exists(oldDirectory) && (await fs.readdir(oldDirectory)).length === 0) await fs.rmdir(oldDirectory);
  } catch (error) {
    if (moveRecord) await undoLatestReassignment(config, { recordId: moveRecord.id }).catch(() => {});
    throw error;
  }
  return to;
}

export async function updateCategoryDestination(configPath, categoryName, requestedPath) {
  const config = await loadConfig(configPath);
  const document = await readConfigDocument(configPath);
  const category = safeName(categoryName, "Category");
  if (!categoryNames(document).includes(category)) throw new Error(`Unknown category: ${category}`);
  if (typeof requestedPath !== "string" || !requestedPath.trim()) throw new Error("Choose a destination folder.");

  const currentWasCustom = Object.hasOwn(document.categoryDestinations ?? {}, category);
  document.categoryDestinations ??= {};
  document.categoryDestinations[category] = requestedPath.trim();
  const proposedConfig = await validateConfigDocument(configPath, document);
  const currentDirectory = config.destinationByCategory.get(category);
  const proposedDirectory = proposedConfig.destinationByCategory.get(category);
  const defaultDirectory = path.join(config.destination, category);
  const comparison = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  if (comparison(proposedDirectory) === comparison(defaultDirectory)) {
    delete document.categoryDestinations[category];
    if (Object.keys(document.categoryDestinations).length === 0) delete document.categoryDestinations;
  }
  if (comparison(currentDirectory) === comparison(proposedDirectory)) {
    await saveConfigDocument(configPath, document);
    return proposedDirectory;
  }

  let names = [];
  try {
    names = (await fs.readdir(currentDirectory, { withFileTypes: true }))
      .filter((entry) => !entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let moveRecord = null;
  if (names.length) {
    moveRecord = await moveBetweenDirectories(config, currentDirectory, proposedDirectory, names, {
      reason: "change-destination", category, fromDirectory: currentDirectory, toDirectory: proposedDirectory,
    });
  }
  try {
    await saveConfigDocument(configPath, document);
    if (!currentWasCustom && await exists(currentDirectory) && (await fs.readdir(currentDirectory)).length === 0) await fs.rmdir(currentDirectory);
  } catch (error) {
    if (moveRecord) await undoLatestReassignment(config, { recordId: moveRecord.id }).catch(() => {});
    throw error;
  }
  return proposedDirectory;
}

export async function updateRule(configPath, action, categoryName, value) {
  const document = await readConfigDocument(configPath);
  const category = safeName(categoryName, "Category");
  if (!categoryNames(document).includes(category)) throw new Error(`Unknown category: ${category}`);
  if (["addExtension", "removeExtension"].includes(action)) {
    const extension = normalizedExtension(value);
    document.categories ??= {};
    document.categories[category] ??= [];
    for (const [name, extensions] of Object.entries(document.categories)) {
      if (action === "addExtension" && extensions.map((item) => item.toLowerCase()).includes(extension)) {
        throw new Error(`${extension} is already assigned to ${name}.`);
      }
    }
    if (action === "addExtension") document.categories[category].push(extension);
    else document.categories[category] = document.categories[category].filter((item) => item.toLowerCase() !== extension);
  } else if (["addFolderPattern", "removeFolderPattern"].includes(action)) {
    const pattern = safePattern(value);
    document.folderCategories ??= {};
    document.folderCategories[category] ??= [];
    if (action === "addFolderPattern") {
      if (document.folderCategories[category].some((item) => item.toLowerCase() === pattern.toLowerCase())) throw new Error("That folder pattern already exists.");
      document.folderCategories[category].push(pattern);
    } else {
      document.folderCategories[category] = document.folderCategories[category].filter((item) => item.toLowerCase() !== pattern.toLowerCase());
      if (document.folderCategories[category].length === 0) delete document.folderCategories[category];
    }
    syncFolderRuleOrder(document);
  } else throw new Error(`Unknown rule action: ${action}`);
  const config = await saveConfigDocument(configPath, document);
  if (action === "addFolderPattern") {
    const conflicts = findFolderRuleConflicts(config.folderRules).filter((conflict) =>
      conflict.rules.some((rule) => rule.category === category && rule.pattern.toLowerCase() === safePattern(value).toLowerCase()));
    return { conflicts };
  }
  return { conflicts: [] };
}

export async function setFolderRulePriority(configPath, preferredRule, otherRule) {
  const document = await readConfigDocument(configPath);
  const ordered = orderFolderRules(document.folderCategories ?? {}, document.folderRuleOrder ?? []);
  document.folderRuleOrder = prioritizeFolderRule(ordered, preferredRule, otherRule);
  const config = await saveConfigDocument(configPath, document);
  return { conflicts: findFolderRuleConflicts(config.folderRules) };
}

export async function dashboardState(configPath) {
  const config = await loadConfig(configPath);
  const document = await readConfigDocument(configPath);
  const items = await inventory(config, document);
  const plan = await createPlan(config);
  const latestReassignment = (await operationRecords(config)).find(({ record }) => record.reason === "reassign")?.record ?? null;
  let destinationFolders = [];
  try {
    destinationFolders = (await fs.readdir(config.destination, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const knownCategories = new Set(categoryNames(document));
  return {
    destination: config.destination,
    source: config.source,
    categories: categoryNames(document).map((name) => ({
      name,
      path: config.destinationByCategory.get(name),
      customDestination: Object.hasOwn(document.categoryDestinations ?? {}, name),
      extensions: document.categories?.[name] ?? [],
      folderPatterns: document.folderCategories?.[name] ?? [],
      items: items[name] ?? [],
    })),
    waiting: { items: plan.planned.length, bytes: plan.totalBytes, skipped: plan.skipped.length },
    availableFolders: destinationFolders.filter((name) => !knownCategories.has(name)).sort((a, b) => a.localeCompare(b, "ja", { numeric: true })),
    conflicts: findFolderRuleConflicts(config.folderRules),
    latestReassignment: latestReassignment ? { status: latestReassignment.status, createdAt: latestReassignment.createdAt, count: latestReassignment.completed?.length ?? 0 } : null,
  };
}

export async function runOrganizer(configPath) {
  const config = await loadConfig(configPath);
  const plan = await createPlan(config);
  const record = await applyPlan(plan, config);
  return { moved: record.moves.length, skipped: plan.skipped.length, bytes: record.moves.reduce((sum, item) => sum + (item.size ?? 0), 0) };
}
