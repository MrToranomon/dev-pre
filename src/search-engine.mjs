import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicJson, exists, within } from "./safety.mjs";

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".xml", ".html", ".htm", ".css", ".scss", ".less", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sql", ".sh", ".ps1", ".bat", ".cmd", ".ini", ".toml", ".env", ".log", ".rtf"]);
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", ".svn", ".hg", ".idea", ".vscode", "dist", "build", "coverage", "$recycle.bin", "system volume information", "windows", "program files", "program files (x86)"]);

function normalize(value) { return value.normalize("NFKC").toLocaleLowerCase("ja"); }
function isTextFile(name) { return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase()) || ["readme", "license", "makefile", "dockerfile"].includes(path.basename(name).toLowerCase()); }
function safeSnippet(contents, query, length = 240) {
  const compact = contents.replace(/\s+/g, " ").trim();
  const index = normalize(compact).indexOf(normalize(query));
  const start = Math.max(0, index === -1 ? 0 : index - 70);
  return `${start ? "…" : ""}${compact.slice(start, start + length)}${start + length < compact.length ? "…" : ""}`;
}

async function extractPdf(file) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = new Uint8Array(await fs.readFile(file));
  const loadingTask = pdfjs.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true });
  const document = await loadingTask.promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 500); pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => item.str).join(" "));
    }
  } finally { await loadingTask.destroy(); }
  return pages.join("\n");
}

async function extractDocx(file) {
  const mammoth = await import("mammoth");
  return (await mammoth.extractRawText({ buffer: await fs.readFile(file) })).value;
}

async function extractContent(file, size) {
  if (!size) return "";
  const extension = path.extname(file).toLowerCase();
  if (isTextFile(file)) return fs.readFile(file, "utf8");
  if (extension === ".pdf") return extractPdf(file);
  if (extension === ".docx") return extractDocx(file);
  return "";
}

export async function walkFiles(roots, { maxFiles = 15_000, onProgress = () => {} } = {}) {
  const files = [];
  const errors = [];
  const queue = [...new Set(roots.map(root => path.resolve(root)))];
  while (queue.length && files.length < maxFiles) {
    const directory = queue.shift();
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { errors.push({ path: directory, error: error.message }); continue; }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.isSymbolicLink()) continue;
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name.toLowerCase())) queue.push(location);
      } else if (entry.isFile()) {
        try {
          const stats = await fs.stat(location);
          files.push({ path: location, name: entry.name, size: stats.size, modifiedAt: stats.mtime.toISOString(), mtimeMs: stats.mtimeMs, extension: path.extname(entry.name).toLowerCase() || "file" });
        } catch (error) { errors.push({ path: location, error: error.message }); }
      }
    }
    if (files.length % 250 < entries.length) onProgress(files.length);
  }
  return { files, errors, limited: files.length >= maxFiles };
}

export class SearchEngine {
  constructor(directory) {
    this.file = path.join(directory, "search-index.json");
    this.index = [];
    this.status = { state: "idle", files: 0, contentFiles: 0, errors: 0, updatedAt: null, limited: false };
    this.running = null;
  }

  async init() {
    if (await exists(this.file)) {
      try {
        const cached = JSON.parse(await fs.readFile(this.file, "utf8"));
        if (Array.isArray(cached.documents)) { this.index = cached.documents; this.status = { ...this.status, ...cached.status, state: "ready" }; }
      } catch { /* A fresh index is safer than trusting damaged cached data. */ }
    }
    return this;
  }

  async build(settings) {
    if (this.running) return this.running;
    this.running = this.#build(settings).finally(() => { this.running = null; });
    return this.running;
  }

  async #build(settings) {
    this.status = { ...this.status, state: "indexing", files: 0, contentFiles: 0, errors: 0 };
    const roots = settings.searchRoots.filter(Boolean);
    const walked = await walkFiles(roots, { maxFiles: settings.searchMaxFiles, onProgress: files => { this.status.files = files; } });
    const old = new Map(this.index.map(item => [item.path, item]));
    const documents = [];
    let extracted = 0;
    for (const item of walked.files) {
      const cached = old.get(item.path);
      if (cached && cached.mtimeMs === item.mtimeMs && cached.size === item.size) { documents.push(cached); if (cached.content) extracted += 1; continue; }
      let content = "";
      let extractionError = null;
      if (item.size <= settings.searchMaxFileBytes && (isTextFile(item.name) || [".pdf", ".docx"].includes(item.extension))) {
        try { content = (await extractContent(item.path, item.size)).slice(0, 2_000_000); extracted += 1; }
        catch (error) { extractionError = error.message; }
      }
      documents.push({ ...item, content, extractionError });
      this.status.files = documents.length; this.status.contentFiles = extracted;
    }
    this.index = documents;
    this.status = { state: "ready", files: documents.length, contentFiles: extracted, errors: walked.errors.length + documents.filter(item => item.extractionError).length, updatedAt: new Date().toISOString(), limited: walked.limited, roots };
    await atomicJson(this.file, { version: 1, status: this.status, documents });
    return this.status;
  }

  search(query, limit = 100) {
    const raw = String(query ?? "").trim();
    if (!raw) return [];
    const terms = [...new Set(normalize(raw).split(/\s+/).filter(Boolean))];
    return this.index.map(item => {
      const name = normalize(item.name), location = normalize(item.path), content = normalize(item.content ?? "");
      if (!terms.every(term => name.includes(term) || location.includes(term) || content.includes(term))) return null;
      let score = 0;
      for (const term of terms) { if (name === term) score += 100; else if (name.includes(term)) score += 45; if (location.includes(term)) score += 12; if (content.includes(term)) score += 8; }
      score += Math.max(0, 10 - (Date.now() - new Date(item.modifiedAt)) / 86_400_000 / 30);
      return { ...item, content: undefined, snippet: item.content ? safeSnippet(item.content, terms.find(term => content.includes(term)) ?? raw) : "", score };
    }).filter(Boolean).sort((a, b) => b.score - a.score || new Date(b.modifiedAt) - new Date(a.modifiedAt)).slice(0, Math.min(Number(limit) || 100, 200));
  }

  isAllowed(file, roots) {
    const resolved = path.resolve(file);
    return roots.some(root => path.relative(path.resolve(root), resolved) === "" || within(path.resolve(root), resolved));
  }
}

export async function fileHealth(settings) {
  const roots = settings.searchRoots.filter(Boolean);
  const walked = await walkFiles(roots, { maxFiles: Math.min(settings.searchMaxFiles, 30_000) });
  const staleBoundary = Date.now() - settings.healthStaleDays * 86_400_000;
  const largest = walked.files.filter(item => item.size >= settings.healthLargeFileBytes).sort((a, b) => b.size - a.size).slice(0, 100);
  const stale = walked.files.filter(item => item.mtimeMs < staleBoundary).sort((a, b) => a.mtimeMs - b.mtimeMs).slice(0, 100);
  const bySize = new Map();
  for (const item of walked.files.filter(item => item.size > 0 && item.size <= 500 * 1024 * 1024)) {
    const group = bySize.get(item.size) ?? []; group.push(item); bySize.set(item.size, group);
  }
  const duplicateGroups = [];
  let hashes = 0;
  for (const group of [...bySize.values()].filter(items => items.length > 1).sort((a, b) => b[0].size - a[0].size)) {
    if (hashes >= 500) break;
    const byHash = new Map();
    for (const item of group) {
      if (hashes++ >= 500) break;
      try {
        const hash = crypto.createHash("sha256");
        await new Promise((resolve, reject) => createReadStream(item.path).on("data", chunk => hash.update(chunk)).on("end", resolve).on("error", reject));
        const digest = hash.digest("hex"); const items = byHash.get(digest) ?? []; items.push(item); byHash.set(digest, items);
      } catch { /* reported by scan when possible */ }
    }
    for (const [hash, items] of byHash) if (items.length > 1) duplicateGroups.push({ hash, size: items[0].size, recoverableBytes: items[0].size * (items.length - 1), files: items.map(item => item.path) });
  }
  duplicateGroups.sort((a, b) => b.recoverableBytes - a.recoverableBytes);
  const volumes = [];
  for (const root of roots) {
    try { const stats = await fs.statfs(root); volumes.push({ root, total: stats.blocks * stats.bsize, free: stats.bavail * stats.bsize }); }
    catch (error) { walked.errors.push({ path: root, error: error.message }); }
  }
  return { scannedAt: new Date().toISOString(), files: walked.files.length, bytes: walked.files.reduce((sum, item) => sum + item.size, 0), limited: walked.limited, largest, stale, duplicateGroups: duplicateGroups.slice(0, 50), duplicateBytes: duplicateGroups.reduce((sum, item) => sum + item.recoverableBytes, 0), volumes, errors: walked.errors.slice(0, 100) };
}
