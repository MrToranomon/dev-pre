import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// A fully isolated playground: never points at the user's Downloads or Documents.
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-demo-"));
const source = path.join(sandbox, "Downloads");
const destination = path.join(sandbox, "Documents");
await fs.mkdir(source); await fs.mkdir(destination);
const categories = { "ドキュメント": [".txt", ".md", ".docx"], "画像": [".png", ".jpg", ".webp"], PDF: [".pdf"], "アーカイブ": [".zip", ".tar.gz"], "アプリ": [] };
for (const category of Object.keys(categories)) await fs.mkdir(path.join(destination, category));
for (const [name, content] of [["旅の計画.txt", "京都旅行のメモ"], ["プロジェクト概要.md", "# 次のアイデア"], ["請求書.pdf", "Demo PDF placeholder"], ["夕焼け.jpg", "Demo image placeholder"], ["backup.tar.gz", "Demo archive placeholder"], ["未分類.xyz", "Unknown file"], ["進行中.part", "Partial download"]]) await fs.writeFile(path.join(source, name), content);
await fs.writeFile(path.join(destination, "ドキュメント", "アイデアノート.txt"), "明日のアイデア");
await fs.writeFile(path.join(destination, "ドキュメント", "旅の計画.txt"), "以前の旅の計画");
const config = path.join(sandbox, "config.json");
await fs.writeFile(config, JSON.stringify({ source, destination, categories, options: { minimumAgeMinutes: 0, stateDirectory: path.join(sandbox, "state") } }, null, 2));
process.stdout.write(`デモ用フォルダ: ${sandbox}\n`);
const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../manage.mjs"), "--config", config, ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });
child.on("error", error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 0; });
process.on("SIGINT", () => child.kill());
