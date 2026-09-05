import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { orderFolderRules } from "./folder-rules.mjs";

const APP_NAME = "Orbit Organizer";
const APP_VERSION = "2.2.0";
const HISTORY_DIRECTORY = ".file-organizer/history";
const PROTECTED_EXTENSIONS = new Set([
  ".app", ".appx", ".appxbundle", ".bat", ".cmd", ".com", ".cpl", ".dll", ".exe", ".gadget",
  ".hta", ".inf", ".ins", ".iso", ".jar", ".js", ".jse", ".lnk",
  ".msi", ".msix", ".msixbundle", ".msp", ".mst", ".pif", ".ps1", ".reg", ".scr", ".sct",
  ".sh", ".sys", ".vb", ".vbe", ".vbs", ".ws", ".wsc", ".wsf", ".wsh",
]);
const INSTALLER_EXTENSIONS = new Set([
  ".app", ".appx", ".appxbundle", ".deb", ".dmg", ".exe", ".iso", ".msi",
  ".msix", ".msixbundle", ".pkg", ".rpm",
]);

const DEFAULT_OPTIONS = Object.freeze({
  minimumAgeMinutes: 1,
  dateFolders: "none",
  includeUnknown: false,
  allowInstallerFiles: false,
  unknownCategory: "Other",
  maxPreviewItems: 40,
  ignore: ["desktop.ini", "thumbs.db", ".DS_Store", "~$*", "*.crdownload", "*.download", "*.part", "*.partial", "*.tmp"],
});

function color(code, value, enabled) {
  return enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / 1024 ** index;
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function plural(number, singular, pluralForm = `${singular}s`) {
  return `${number} ${number === 1 ? singular : pluralForm}`;
}

function expandEnvironmentVariables(value, environment = process.env) {
  return value.replace(/%([^%]+)%/g, (token, name) => {
    const match = Object.keys(environment).find((key) => key.toLowerCase() === name.toLowerCase());
    if (!match) throw new Error(`Unknown environment variable in path: ${token}`);
    return environment[match];
  });
}

function assertSafeSegment(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  if (value === "." || value === ".." || path.isAbsolute(value) || /[\\/:*?"<>|]/.test(value)) {
    throw new Error(`${label} must be a single safe folder name: ${JSON.stringify(value)}`);
  }
}

function normalizeExtension(extension, category) {
  if (typeof extension !== "string" || !/^\.[a-z0-9][a-z0-9.+_-]*$/i.test(extension)) {
    throw new Error(`Invalid extension ${JSON.stringify(extension)} in category ${JSON.stringify(category)}.`);
  }
  return extension.toLowerCase();
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function loadConfig(configFile, environment = process.env) {
  const absoluteConfigPath = path.resolve(configFile);
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(absoluteConfigPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${absoluteConfigPath}: ${error.message}`);
    throw error;
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Configuration must be a JSON object.");
  if (typeof raw.source !== "string" || typeof raw.destination !== "string") {
    throw new Error("Configuration requires string values for source and destination.");
  }
  if (!raw.categories || typeof raw.categories !== "object" || Array.isArray(raw.categories)) {
    throw new Error("Configuration requires a categories object.");
  }

  const source = path.resolve(expandEnvironmentVariables(raw.source, environment));
  const destination = path.resolve(expandEnvironmentVariables(raw.destination, environment));
  if (source === destination) throw new Error("Source and destination must be different folders.");
  if (isWithin(source, destination)) throw new Error("Destination must be outside source.");

  const options = { ...DEFAULT_OPTIONS, ...(raw.options ?? {}) };
  if (typeof options.allowInstallerFiles !== "boolean") throw new Error("options.allowInstallerFiles must be true or false.");

  const categoryByExtension = new Map();
  for (const [category, extensions] of Object.entries(raw.categories)) {
    assertSafeSegment(category, "Category");
    if (!Array.isArray(extensions)) {
      throw new Error(`Category ${JSON.stringify(category)} must contain an array of extensions.`);
    }
    for (const rawExtension of extensions) {
      const extension = normalizeExtension(rawExtension, category);
      if (PROTECTED_EXTENSIONS.has(extension) && !(options.allowInstallerFiles && INSTALLER_EXTENSIONS.has(extension))) {
        throw new Error(`Refusing protected executable extension ${extension} in category ${JSON.stringify(category)}.`);
      }
      if (categoryByExtension.has(extension)) {
        throw new Error(`Extension ${extension} appears in both ${JSON.stringify(categoryByExtension.get(extension))} and ${JSON.stringify(category)}.`);
      }
      categoryByExtension.set(extension, category);
    }
  }

  if (!Number.isFinite(options.minimumAgeMinutes) || options.minimumAgeMinutes < 0) {
    throw new Error("options.minimumAgeMinutes must be a non-negative number.");
  }
  if (!["none", "year", "month"].includes(options.dateFolders)) {
    throw new Error('options.dateFolders must be "none", "year", or "month".');
  }
  if (typeof options.includeUnknown !== "boolean") throw new Error("options.includeUnknown must be true or false.");
  assertSafeSegment(options.unknownCategory, "options.unknownCategory");
  if (!Number.isInteger(options.maxPreviewItems) || options.maxPreviewItems < 1 || options.maxPreviewItems > 1000) {
    throw new Error("options.maxPreviewItems must be an integer from 1 to 1000.");
  }
  if (!Array.isArray(options.ignore) || options.ignore.some((item) => typeof item !== "string" || !item)) {
    throw new Error("options.ignore must be an array of non-empty strings.");
  }

  const folderCategories = raw.folderCategories ?? {};
  if (!folderCategories || typeof folderCategories !== "object" || Array.isArray(folderCategories)) {
    throw new Error("folderCategories must be an object when provided.");
  }
  for (const [category, patterns] of Object.entries(folderCategories)) {
    assertSafeSegment(category, "Folder category");
    if (!Array.isArray(patterns)) {
      throw new Error(`Folder category ${JSON.stringify(category)} must contain an array of name patterns.`);
    }
    for (const pattern of patterns) {
      if (typeof pattern !== "string" || !pattern || /[\\/:"<>|]/.test(pattern)) {
        throw new Error(`Invalid folder name pattern in ${JSON.stringify(category)}: ${JSON.stringify(pattern)}.`);
      }
    }
  }
  if (raw.folderRuleOrder !== undefined && !Array.isArray(raw.folderRuleOrder)) {
    throw new Error("folderRuleOrder must be an array when provided.");
  }
  const folderRules = orderFolderRules(folderCategories, raw.folderRuleOrder);

  let stateDirectory = path.join(destination, ".file-organizer");
  if (options.stateDirectory !== undefined) {
    if (typeof options.stateDirectory !== "string" || !options.stateDirectory) {
      throw new Error("options.stateDirectory must be a non-empty path string.");
    }
    stateDirectory = path.resolve(expandEnvironmentVariables(options.stateDirectory, environment));
  }
  if (stateDirectory === source || isWithin(source, stateDirectory)) {
    throw new Error("options.stateDirectory must be outside source.");
  }

  const categoryNames = [...new Set([...Object.keys(raw.categories), ...folderRules.map((rule) => rule.category)])];
  const categoryDestinations = raw.categoryDestinations ?? {};
  if (!categoryDestinations || typeof categoryDestinations !== "object" || Array.isArray(categoryDestinations)) {
    throw new Error("categoryDestinations must be an object when provided.");
  }
  for (const category of Object.keys(categoryDestinations)) {
    if (!categoryNames.includes(category)) throw new Error(`categoryDestinations contains an unknown category: ${category}`);
    if (typeof categoryDestinations[category] !== "string" || !categoryDestinations[category]) {
      throw new Error(`Custom destination for ${category} must be a non-empty path string.`);
    }
  }
  const destinationByCategory = new Map();
  const usedDestinations = new Map();
  for (const category of categoryNames) {
    const configured = categoryDestinations[category];
    const categoryDestination = configured
      ? path.resolve(expandEnvironmentVariables(configured, environment))
      : path.join(destination, category);
    if (categoryDestination === source || isWithin(source, categoryDestination)) {
      throw new Error(`Destination for ${category} must be outside source.`);
    }
    if (path.parse(categoryDestination).root === categoryDestination) {
      throw new Error(`Destination for ${category} cannot be a drive or filesystem root.`);
    }
    if (categoryDestination === stateDirectory || isWithin(categoryDestination, stateDirectory) || isWithin(stateDirectory, categoryDestination)) {
      throw new Error(`Destination for ${category} must be separate from the application state directory.`);
    }
    for (const [otherCategory, otherDestination] of destinationByCategory) {
      if (isWithin(otherDestination, categoryDestination) || isWithin(categoryDestination, otherDestination)) {
        throw new Error(`Destinations for ${otherCategory} and ${category} cannot contain one another.`);
      }
    }
    const key = process.platform === "win32" ? categoryDestination.toLowerCase() : categoryDestination;
    if (usedDestinations.has(key)) throw new Error(`Categories ${usedDestinations.get(key)} and ${category} cannot use the same destination.`);
    usedDestinations.set(key, category);
    destinationByCategory.set(category, categoryDestination);
  }

  return { source, destination, stateDirectory, destinationByCategory, categoryByExtension, folderRules, categories: raw.categories, options, configPath: absoluteConfigPath };
}

function wildcardMatches(name, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(name);
}

function dateBucket(date, mode) {
  if (mode === "none") return null;
  const year = String(date.getFullYear());
  if (mode === "year") return year;
  return `${year}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function directorySize(directory) {
  let total = 0;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(entryPath);
    else if (entry.isFile()) total += (await fs.stat(entryPath)).size;
  }
  return total;
}

async function unusedTarget(target, reserved = new Set(), suffix = null) {
  const parsed = path.parse(target);
  for (let number = 1; ; number += 1) {
    const label = number === 1 ? "" : ` (${suffix ? `${suffix} ${number}` : number})`;
    const candidate = path.join(parsed.dir, `${parsed.name}${label}${parsed.ext}`);
    const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (!reserved.has(key) && !(await pathExists(candidate))) {
      reserved.add(key);
      return candidate;
    }
  }
}

export async function createPlan(config, now = new Date()) {
  let entries;
  try {
    entries = await fs.readdir(config.source, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Source folder does not exist: ${config.source}`);
    throw error;
  }

  const planned = [];
  const skipped = [];
  const reserved = new Set();
  const minimumModifiedTime = now.getTime() - config.options.minimumAgeMinutes * 60_000;

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    const sourcePath = path.join(config.source, entry.name);
    if (config.options.ignore.some((pattern) => wildcardMatches(entry.name, pattern))) {
      skipped.push({ name: entry.name, reason: "ignored" });
      continue;
    }
    if (entry.isSymbolicLink()) {
      skipped.push({ name: entry.name, reason: "link" });
      continue;
    }

    if (entry.isDirectory()) {
      const rule = config.folderRules.find(({ pattern }) => wildcardMatches(entry.name, pattern));
      if (!rule) {
        skipped.push({ name: entry.name, reason: "folder" });
        continue;
      }
      const stats = await fs.stat(sourcePath);
      if (stats.mtimeMs > minimumModifiedTime) {
        skipped.push({ name: entry.name, reason: "recent" });
        continue;
      }
      const bucket = dateBucket(stats.mtime, config.options.dateFolders);
      const categoryDestination = config.destinationByCategory.get(rule.category);
      const targetDirectory = bucket ? path.join(categoryDestination, bucket) : categoryDestination;
      const target = await unusedTarget(path.join(targetDirectory, entry.name), reserved);
      planned.push({
        name: entry.name,
        category: rule.category,
        type: "directory",
        source: sourcePath,
        target,
        relativeTarget: isWithin(config.destination, target) ? path.relative(config.destination, target) : target,
        size: await directorySize(sourcePath),
        snapshotSize: stats.size,
        mtimeMs: stats.mtimeMs,
      });
      continue;
    }

    if (!entry.isFile()) {
      skipped.push({ name: entry.name, reason: "unsupported" });
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    const category = config.categoryByExtension.get(extension)
      ?? (config.options.includeUnknown ? config.options.unknownCategory : null);
    const allowedInstaller = config.options.allowInstallerFiles && INSTALLER_EXTENSIONS.has(extension) && category;
    if (PROTECTED_EXTENSIONS.has(extension) && !allowedInstaller) {
      skipped.push({ name: entry.name, reason: "protected" });
      continue;
    }
    if (!category) {
      skipped.push({ name: entry.name, reason: "unknown" });
      continue;
    }

    const stats = await fs.stat(sourcePath);
    if (stats.mtimeMs > minimumModifiedTime) {
      skipped.push({ name: entry.name, reason: "recent" });
      continue;
    }

    const bucket = dateBucket(stats.mtime, config.options.dateFolders);
    const categoryDestination = config.destinationByCategory.get(category);
    const targetDirectory = bucket ? path.join(categoryDestination, bucket) : categoryDestination;
    const target = await unusedTarget(path.join(targetDirectory, entry.name), reserved);
    planned.push({
      name: entry.name,
      category,
      type: "file",
      source: sourcePath,
      target,
      relativeTarget: isWithin(config.destination, target) ? path.relative(config.destination, target) : target,
      size: stats.size,
      snapshotSize: stats.size,
      mtimeMs: stats.mtimeMs,
    });
  }

  return {
    createdAt: now.toISOString(), source: config.source, destination: config.destination,
    planned, skipped, totalBytes: planned.reduce((sum, item) => sum + item.size, 0),
  };
}

function reasonSummary(skipped) {
  const labels = { folder: "unmatched folders", link: "links", ignored: "temporary/ignored", protected: "protected", unknown: "unknown types", recent: "still recent", unsupported: "unsupported" };
  const counts = new Map();
  for (const item of skipped) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) => `${count} ${labels[reason] ?? reason}`).join(", ");
}

function itemSummary(planned) {
  const files = planned.filter((item) => item.type !== "directory").length;
  const folders = planned.length - files;
  return [files ? plural(files, "file") : null, folders ? plural(folders, "folder") : null].filter(Boolean).join(" + ");
}

function categorySummary(planned) {
  const categories = new Map();
  for (const item of planned) {
    const current = categories.get(item.category) ?? { count: 0, bytes: 0 };
    current.count += 1;
    current.bytes += item.size;
    categories.set(item.category, current);
  }
  return [...categories].map(([name, value]) => ({ name, ...value }));
}

export function renderPlan(plan, { apply = false, all = false, colors = false } = {}) {
  const lines = [color("1;36", `✦ ${APP_NAME}`, colors), color("2", apply ? "  APPLY" : "  PREVIEW · nothing has been moved", colors), ""];
  lines.push(`  From  ${plan.source}`, `  To    ${plan.destination}`, "");
  if (plan.planned.length === 0) {
    lines.push(color("33", "  No files are ready to organize.", colors));
  } else {
    for (const summary of categorySummary(plan.planned)) {
      lines.push(`  ${color("36", "●", colors)} ${summary.name.padEnd(18)} ${String(summary.count).padStart(3)}  ${formatBytes(summary.bytes).padStart(9)}`);
    }
    lines.push(`  ${"─".repeat(35)}`, `  ${itemSummary(plan.planned).padEnd(23)} ${formatBytes(plan.totalBytes).padStart(11)}`, "", color("1", "  Flight plan", colors));
    const limit = all ? plan.planned.length : Math.min(plan.planned.length, plan.maxPreviewItems ?? 40);
    for (const [index, item] of plan.planned.slice(0, limit).entries()) {
      const destination = item.relativeTarget.split(path.sep).join(" / ");
      lines.push(`  ${String(index + 1).padStart(2)}  ${item.name}  ${color("2", "→", colors)}  ${destination}`);
    }
    if (limit < plan.planned.length) lines.push(color("2", `  … and ${plan.planned.length - limit} more (use --all to show every file)`, colors));
  }
  if (plan.skipped.length) lines.push("", color("2", `  Safely left in place: ${reasonSummary(plan.skipped)}`, colors));
  if (!apply && plan.planned.length) lines.push("", `  Ready? Run ${color("1;32", "npm run apply", colors)}`);
  return lines.join("\n");
}

function historyRoot(config) {
  return path.join(config.stateDirectory, "history");
}

function batchId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function moveFileSafely(source, target) {
  try {
    await fs.link(source, target);
    try {
      await fs.unlink(source);
    } catch (unlinkError) {
      await fs.unlink(target).catch(() => {});
      throw unlinkError;
    }
  } catch (error) {
    if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) throw error;
    const stats = await fs.stat(source);
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    try {
      await fs.utimes(target, stats.atime, stats.mtime);
      await fs.unlink(source);
    } catch (unlinkError) {
      await fs.unlink(target).catch(() => {});
      throw unlinkError;
    }
  }
}

async function moveEntrySafely(source, target, type = "file") {
  if (type !== "directory") return moveFileSafely(source, target);
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (error?.code === "EXDEV") throw new Error(`Cannot move application folder across drives: ${source}`);
    throw error;
  }
}

export async function applyPlan(plan, config, now = new Date()) {
  const directory = historyRoot(config);
  const metadataDirectory = path.dirname(directory);
  const lockFile = path.join(metadataDirectory, "apply.lock");
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(lockFile, `${JSON.stringify({ pid: process.pid, startedAt: now.toISOString() })}\n`, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Another apply may be running. If it is not, remove the stale lock: ${lockFile}`);
    throw error;
  }

  const completed = [];
  const changed = [];
  const operations = [];
  const reserved = new Set();
  const record = {
    version: 1, id: batchId(now), status: "applying", appliedAt: now.toISOString(),
    source: config.source, destination: config.destination,
    allowedDestinations: [...config.destinationByCategory.values()], operations, moves: completed, notMoved: changed,
  };
  const recordFile = path.join(directory, `${record.id}.json`);
  const writeRecord = () => fs.writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`);

  try {
    for (const item of plan.planned) {
      let current;
      try {
        current = await fs.stat(item.source);
      } catch (error) {
        changed.push({ name: item.name, reason: error?.code === "ENOENT" ? "missing" : "unreadable" });
        continue;
      }
      const expectedType = item.type ?? "file";
      const typeMatches = expectedType === "directory" ? current.isDirectory() : current.isFile();
      if (!typeMatches || current.size !== (item.snapshotSize ?? item.size) || current.mtimeMs !== item.mtimeMs) {
        changed.push({ name: item.name, reason: "changed since preview" });
        continue;
      }
      const finalTarget = await unusedTarget(item.target, reserved);
      operations.push({ from: item.source, to: finalTarget, type: expectedType, size: item.size, snapshotSize: item.snapshotSize ?? item.size, mtimeMs: item.mtimeMs });
    }

    await fs.writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    for (const operation of operations) {
      const current = await fs.stat(operation.from).catch(() => null);
      const typeMatches = operation.type === "directory" ? current?.isDirectory() : current?.isFile();
      if (!current || !typeMatches || current.size !== operation.snapshotSize || current.mtimeMs !== operation.mtimeMs) {
        changed.push({ name: path.basename(operation.from), reason: "changed during apply" });
        continue;
      }
      await fs.mkdir(path.dirname(operation.to), { recursive: true });
      try {
        await moveEntrySafely(operation.from, operation.to, operation.type);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        operation.to = await unusedTarget(operation.to, reserved);
        await writeRecord();
        await moveEntrySafely(operation.from, operation.to, operation.type);
      }
      completed.push({ ...operation });
    }
    record.status = completed.length ? "applied" : "empty";
    await writeRecord();
    return record;
  } finally {
    await fs.unlink(lockFile).catch(() => {});
  }
}

async function historyRecords(config) {
  const directory = historyRoot(config);
  let names;
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const name of names.filter((item) => item.endsWith(".json")).sort().reverse()) {
    try {
      const record = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
      records.push({ record, file: path.join(directory, name) });
    } catch {
      // A malformed history file cannot stop organizing; doctor can surface it later.
    }
  }
  return records;
}

export async function undoLatest(config, now = new Date()) {
  const candidate = (await historyRecords(config)).find(({ record }) => ["applied", "applying", "partially-undone"].includes(record.status));
  if (!candidate) return null;
  const { record, file } = candidate;
  if (path.resolve(record.source) !== config.source || path.resolve(record.destination) !== config.destination) {
    throw new Error("Latest history entry belongs to different source or destination folders.");
  }

  const restored = [];
  const skipped = [];
  const reserved = new Set();
  const movesToInspect = record.status === "applying" ? record.operations : record.moves;
  for (const move of [...movesToInspect].reverse()) {
    const from = path.resolve(move.from);
    const to = path.resolve(move.to);
    const allowedDestinations = record.allowedDestinations ?? [record.destination];
    const destinationIsSafe = allowedDestinations.some((directory) => isWithin(path.resolve(directory), to));
    if (!(from === config.source || isWithin(config.source, from)) || !destinationIsSafe) {
      skipped.push({ name: path.basename(to), reason: "unsafe history path" });
      continue;
    }
    const sourceExists = await pathExists(from);
    const targetExists = await pathExists(to);
    if (sourceExists && !targetExists) continue;
    if (sourceExists && targetExists && record.status === "applying") {
      skipped.push({ name: path.basename(to), reason: "both original and organized paths exist" });
      continue;
    }
    if (!targetExists) {
      skipped.push({ name: path.basename(to), reason: "both paths are missing" });
      continue;
    }
    const restoreTarget = await unusedTarget(from, reserved, "restored");
    await fs.mkdir(path.dirname(restoreTarget), { recursive: true });
    await moveEntrySafely(to, restoreTarget, move.type);
    restored.push({ from: to, to: restoreTarget, type: move.type ?? "file", size: move.size });
  }

  record.status = skipped.length ? "partially-undone" : "undone";
  record.undoneAt = now.toISOString();
  record.restored = restored;
  record.undoSkipped = skipped;
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function diagnose(config) {
  const checks = [];
  async function check(label, action) {
    try {
      await action();
      checks.push({ label, ok: true });
    } catch (error) {
      checks.push({ label, ok: false, detail: error.message });
    }
  }
  await check("Configuration is valid", async () => {});
  await check("Source folder exists", async () => {
    const stats = await fs.stat(config.source);
    if (!stats.isDirectory()) throw new Error("path is not a folder");
  });
  await check("Source folder is readable", () => fs.access(config.source, fs.constants.R_OK));
  await check("Destination can be written", async () => {
    for (const configuredDestination of new Set([config.destination, ...config.destinationByCategory.values()])) {
      let candidate = configuredDestination;
      while (!(await pathExists(candidate))) {
        const parent = path.dirname(candidate);
        if (parent === candidate) throw new Error(`no existing parent folder for ${configuredDestination}`);
        candidate = parent;
      }
      await fs.access(candidate, fs.constants.W_OK);
    }
  });
  await check("Destination is safely separated", async () => {
    if (config.source === config.destination || isWithin(config.source, config.destination)) throw new Error("destination is inside source");
  });
  await check("Every extension has one category", async () => {});
  await check("No other apply is holding the lock", async () => {
    const lockFile = path.join(path.dirname(historyRoot(config)), "apply.lock");
    if (await pathExists(lockFile)) throw new Error(`lock exists at ${lockFile}`);
  });
  return checks;
}

export async function listHistory(config, limit = 10) {
  return (await historyRecords(config)).slice(0, limit).map(({ record }) => ({
    id: record.id,
    status: record.status,
    appliedAt: record.appliedAt,
    items: record.moves?.length ?? 0,
    bytes: (record.moves ?? []).reduce((sum, move) => sum + (move.size ?? 0), 0),
  }));
}

function parseArguments(argumentsList) {
  let command = "preview";
  let configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config.json");
  let json = false;
  let all = false;
  let help = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (["preview", "apply", "undo", "history", "doctor", "help"].includes(argument)) command = argument;
    else if (argument === "--apply") command = "apply";
    else if (argument === "--json") json = true;
    else if (argument === "--all") all = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--config") {
      if (!argumentsList[index + 1]) throw new Error("--config requires a file path.");
      configPath = path.resolve(argumentsList[index += 1]);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return { command, configPath, json, all, help };
}

function helpText() {
  return `${APP_NAME} ${APP_VERSION}\n\n` +
    "Usage: node organize.mjs [command] [options]\n\n" +
    "Commands:\n" +
    "  preview   Show exactly what would move (default)\n" +
    "  apply     Move the previewed files and write undo history\n" +
    "  undo      Restore the latest completed batch\n" +
    "  history   Show the 10 most recent batches\n" +
    "  doctor    Validate configuration and folder access\n" +
    "  help      Show this guide\n\n" +
    "Options:\n" +
    "  --config <path>  Use another configuration file\n" +
    "  --all            Show the complete flight plan\n" +
    "  --json           Print machine-readable output\n" +
    "  -h, --help       Show this guide";
}

function output(value, stream = process.stdout) {
  stream.write(`${value}\n`);
}

export async function runCli(argumentsList, io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    const args = parseArguments(argumentsList);
    if (args.help || args.command === "help") {
      output(helpText(), io.stdout);
      return 0;
    }
    const config = await loadConfig(args.configPath);
    if (args.command === "doctor") {
      const checks = await diagnose(config);
      if (args.json) output(JSON.stringify({ checks }, null, 2), io.stdout);
      else {
        output(`✦ ${APP_NAME}\n  DOCTOR\n`, io.stdout);
        for (const check of checks) output(`  ${check.ok ? "✓" : "✗"} ${check.label}${check.detail ? ` — ${check.detail}` : ""}`, io.stdout);
      }
      return checks.every((check) => check.ok) ? 0 : 1;
    }
    if (args.command === "history") {
      const records = await listHistory(config);
      if (args.json) output(JSON.stringify({ records }, null, 2), io.stdout);
      else if (!records.length) output(`✦ ${APP_NAME}\n\n  No organization history yet.`, io.stdout);
      else {
        output(`✦ ${APP_NAME}\n  RECENT FLIGHTS\n`, io.stdout);
        for (const record of records) {
          const date = new Date(record.appliedAt).toLocaleString();
          output(`  ${date.padEnd(24)} ${record.status.padEnd(18)} ${String(record.items).padStart(3)} items  ${formatBytes(record.bytes).padStart(9)}`, io.stdout);
        }
      }
      return 0;
    }
    if (args.command === "undo") {
      const record = await undoLatest(config);
      if (args.json) output(JSON.stringify({ record }, null, 2), io.stdout);
      else if (!record) output(`✦ ${APP_NAME}\n\n  Nothing to undo.`, io.stdout);
      else output(`✦ ${APP_NAME}\n  UNDO COMPLETE\n\n  Restored ${itemSummary(record.restored)}.${record.undoSkipped.length ? ` ${plural(record.undoSkipped.length, "item")} could not be restored.` : ""}`, io.stdout);
      return record?.undoSkipped?.length ? 1 : 0;
    }

    const plan = await createPlan(config);
    plan.maxPreviewItems = config.options.maxPreviewItems;
    if (args.command === "preview") {
      if (args.json) output(JSON.stringify(plan, null, 2), io.stdout);
      else output(renderPlan(plan, { all: args.all, colors: Boolean(io.stdout.isTTY) && !process.env.NO_COLOR }), io.stdout);
      return 0;
    }

    const record = await applyPlan(plan, config);
    if (args.json) output(JSON.stringify({ plan, record }, null, 2), io.stdout);
    else {
      output(renderPlan(plan, { apply: true, all: args.all, colors: Boolean(io.stdout.isTTY) && !process.env.NO_COLOR }), io.stdout);
      output(`\n  ${record.moves.length ? `✓ Moved ${itemSummary(record.moves)}. Run npm run undo to bring the batch back.` : "No files were moved."}`, io.stdout);
      if (record.notMoved.length) output(`  ${plural(record.notMoved.length, "file")} changed during the run and were safely left in place.`, io.stdout);
    }
    return record.notMoved.length ? 1 : 0;
  } catch (error) {
    output(`Orbit Organizer: ${error.message}`, io.stderr);
    return 1;
  }
}
