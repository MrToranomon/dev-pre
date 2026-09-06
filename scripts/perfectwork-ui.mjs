// Real Chromium regression checks. Only isolated test data is modified.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WorkspaceStore } from "../src/workspace-store.mjs";
import { localDay } from "../src/local-date.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "perfectwork-ui-"));
const files = path.join(root, "files"),
  data = path.join(root, "data");
await fs.mkdir(files);
const store = await new WorkspaceStore(data).init();
await store.updateSettings({
  searchRoots: [files],
  writeRoot: path.join(root, "output"),
});
await fs.writeFile(
  path.join(files, "design.md"),
  "# Design\nA wonderful searchable workspace",
);
const executables = [
  process.env.PERFECTWORK_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].filter(Boolean);
let executable;
for (const candidate of executables) {
  try {
    await fs.access(candidate);
    executable = candidate;
    break;
  } catch {}
}
if (!executable)
  throw new Error(
    "Chromiumが必要です。PERFECTWORK_BROWSERに実行ファイルを指定してください。",
  );
const children = [];
let socket;
let uiTaskId;
const errors = [];
const checks = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function launch(command, args, matcher, stream = "stdout") {
  const child = spawn(command, args, {
    cwd: path.resolve(import.meta.dirname, ".."),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`起動タイムアウト: ${output.slice(-800)}`)),
      20000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child[stream].on("data", (chunk) => {
      output += chunk;
      const match = output.match(matcher);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`起動に失敗: ${code}: ${output.slice(-800)}`));
    });
  });
}
try {
  const appUrl = await launch(
    process.execPath,
    ["work.mjs", "--no-open", "--data-dir", data],
    /http:\/\/127\.0\.0\.1:\d+\/\?token=\w+/,
  );
  const devtools = await launch(
    executable,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      "--remote-debugging-port=0",
      `--user-data-dir=${path.join(root, "browser")}`,
      "about:blank",
    ],
    /ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+/,
    "stderr",
  );
  const pages = await (
    await fetch(`http://${new URL(devtools).host}/json/list`)
  ).json();
  socket = new WebSocket(
    pages.find((item) => item.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const pending = new Map();
  let sequence = 0;
  socket.addEventListener("message", (event) => {
    const result = JSON.parse(event.data);
    if (result.method === "Runtime.exceptionThrown")
      errors.push(
        result.params.exceptionDetails.exception?.description ||
          result.params.exceptionDetails.text,
      );
    if (
      result.method === "Log.entryAdded" &&
      result.params.entry.level === "error" &&
      !result.params.entry.text.includes("favicon")
    )
      errors.push(result.params.entry.text);
    if (pending.has(result.id)) {
      const entry = pending.get(result.id);
      pending.delete(result.id);
      clearTimeout(entry.timer);
      if (result.error) entry.reject(new Error(result.error.message));
      else entry.resolve(result.result);
    }
  });
  const command = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await command("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text,
      );
    return result.result.value;
  };
  const waitFor = async (expression) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await delay(60);
    }
    throw new Error(`UI timeout: ${expression}`);
  };
  const click = (selector) =>
    evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const set = (selector, value) =>
    evaluate(
      `document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(value)}`,
    );
  const submit = async (selector, closed) => {
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).requestSubmit()`,
    );
    await waitFor(closed || "document.querySelector('#loading').hidden");
  };
  const check = async (name, action) => {
    await action();
    checks.push(name);
    process.stdout.write(`✓ ${name}\n`);
  };
  await command("Runtime.enable");
  await command("Log.enable");
  await command("Page.enable");
  await command("Page.addScriptToEvaluateOnNewDocument", {
    source:
      "window.__uiUnhandled=[];window.addEventListener('unhandledrejection',e=>window.__uiUnhandled.push(String(e.reason)));",
  });
  await command("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await command("Page.navigate", { url: appUrl });
  await waitFor(
    "document.querySelector('.home-hero') && document.querySelector('#loading').hidden",
  );
  await check("空のホームと初回ガイド", async () => {
    assert.equal(
      await evaluate("document.querySelectorAll('.getting-started').length"),
      1,
    );
  });
  await check("全11画面が描画できる", async () => {
    for (const name of [
      "today",
      "tasks",
      "planner",
      "projects",
      "inbox",
      "habits",
      "worklog",
      "search",
      "automations",
      "health",
      "library",
    ]) {
      await click(`#navigation [data-view="${name}"]`);
      assert.ok(
        await evaluate(
          "document.querySelector('#view').textContent.trim().length>20",
        ),
        name,
      );
    }
  });
  await check("テンプレートの確認と実際の作成", async () => {
    await click('[data-action="template-preview"][data-id="launch"]');
    await click('[data-action="apply-template"]');
    await waitFor(
      "!document.querySelector('#templateDialog').open && state.tasks.length===5",
    );
    assert.equal(await evaluate("state.projects.length"), 1);
  });
  await check("メモ保存後にダイアログが閉じる", async () => {
    await click("#captureButton");
    await set("#captureForm [name=title]", "UIメモ <script>alert(1)</script>");
    await set("#captureForm [name=body]", "保存と編集を確認");
    await submit(
      "#captureForm",
      "!document.querySelector('#captureDialog').open",
    );
  });
  await check("メモの編集・お気に入り・安全な表示", async () => {
    await click("#navigation [data-view=inbox]");
    assert.equal(
      await evaluate("document.querySelector('#view script')"),
      null,
    );
    await click("[data-action=edit-inbox]");
    await set("#captureForm [name=body]", "更新した本文");
    await submit(
      "#captureForm",
      "!document.querySelector('#captureDialog').open",
    );
    await click("[data-action=favorite-note]");
    await waitFor("state.inbox[0].favorite");
  });
  await check("タスクの予定日・見積・チェックリストを保存", async () => {
    await click("#navigation [data-view=tasks]");
    await click("[data-action=new-task]");
    await set("#taskForm [name=title]", "UI検証タスク");
    await set("#taskForm [name=scheduledDate]", localDay());
    await set("#taskForm [name=checklistText]", "下書き\n確認");
    await submit("#taskForm", "!document.querySelector('#taskDialog').open");
    assert.equal(await evaluate("state.tasks[0].checklist.length"), 2);
    uiTaskId = await evaluate("state.tasks[0].id");
  });
  await check("タスクの編集・ボード・保管と復帰", async () => {
    await click(`[data-task-id="${uiTaskId}"] [data-action=edit-task]`);
    await set("#taskForm [name=notes]", "編集してもチェックリストを保持");
    await submit("#taskForm", "!document.querySelector('#taskDialog').open");
    await click(`[data-task-id="${uiTaskId}"] [data-action=archive-task]`);
    await waitFor("state.tasks[0].status==='archived'");
    await click("[data-filter=archived]");
    await click("[data-action=restore-task]");
    await waitFor("state.tasks[0].status==='todo'");
    await click("[data-filter=open]");
  });
  await check("週間プランにタスクが表示される", async () => {
    await click("#navigation [data-view=planner]");
    assert.ok(
      await evaluate(
        "document.querySelector('.week-grid').textContent.includes('UI検証タスク')",
      ),
    );
  });
  await check("習慣の追加・チェック・解除", async () => {
    await click("#navigation [data-view=habits]");
    await set("#habitForm [name=name]", "10分読書");
    await submit(
      "#habitForm",
      "state.habits.length===1 && document.querySelector('#loading').hidden",
    );
    await click(`.habit-check[data-date="${localDay()}"]`);
    await waitFor("state.habits[0].days.length===1");
    await click(`.habit-check[data-date="${localDay()}"]`);
    await waitFor("state.habits[0].days.length===0");
  });
  await check("プロジェクトの詳細と色・進捗の編集", async () => {
    await click("#navigation [data-view=projects]");
    await click("[data-action=project-detail]");
    await click("[data-action=detail-edit-project]");
    await set("#projectForm [name=color]", "#447788");
    await set("#projectForm [name=progress]", "45");
    await submit(
      "#projectForm",
      "!document.querySelector('#projectDialog').open",
    );
    assert.equal(await evaluate("state.projects[0].color"), "#447788");
  });
  await check("集中の開始・一時停止・再開・完了がタスクと連動", async () => {
    await click("#navigation [data-view=tasks]");
    await click("[data-action=focus-task]");
    await submit(
      "#startFocusForm",
      "Boolean(document.querySelector('#finishFocusForm'))",
    );
    await set("#finishFocusForm [name=note]", "一時停止しても保持する下書き");
    await click("[data-action=pause-focus]");
    await waitFor("Boolean(state.computed.activeSession.pausedAt)");
    await click("[data-action=pause-focus]");
    await waitFor(
      "!state.computed.activeSession.pausedAt && document.querySelector('#loading').hidden",
    );
    assert.equal(
      await evaluate(
        "document.querySelector('#finishFocusForm [name=note]').value",
      ),
      "一時停止しても保持する下書き",
    );
    await set("#finishFocusForm [name=note]", "UI集中の成果");
    await click("#finishFocusForm [name=completeTask]");
    await submit(
      "#finishFocusForm",
      "!document.querySelector('#focusDialog').open",
    );
    assert.equal(await evaluate("state.worklogs[0].body"), "UI集中の成果");
    assert.ok(await evaluate("state.tasks.some(t=>t.status==='done')"));
  });
  await check("手動作業ログの保存と振り返り", async () => {
    await click("#navigation [data-view=worklog]");
    await click("[data-action=new-worklog]");
    await set("#worklogForm [name=title]", "UI手動記録");
    await submit(
      "#worklogForm",
      "!document.querySelector('#worklogDialog').open",
    );
    assert.ok(
      await evaluate(
        "document.querySelector('#view').textContent.includes('UI手動記録')",
      ),
    );
  });
  await check("目標と設定の保存", async () => {
    await click("#navigation [data-view=today]");
    await click("[data-action=edit-focus]");
    await set("#goalForm [name=dailyFocus]", "新しい挑戦を、一歩前へ。");
    await submit("#goalForm", "!document.querySelector('#goalDialog').open");
    await click("#settingsButton");
    await set("#settingsForm [name=name]", "Tora");
    await submit(
      "#settingsForm",
      "!document.querySelector('#settingsDialog').open",
    );
  });
  await check("作業記録を編集しても保存ダイアログが正常に閉じる", async () => {
    await click("#navigation [data-view=worklog]");
    await click("[data-action=edit-worklog]");
    await set("#worklogForm [name=title]", "編集した作業記録");
    await set("#worklogForm [name=minutes]", "45");
    await submit(
      "#worklogForm",
      "!document.querySelector('#worklogDialog').open",
    );
    assert.ok(
      await evaluate(
        "state.worklogs.some(log => log.title === '編集した作業記録' && log.minutes === 45)",
      ),
    );
  });
  await check("自動化の編集とプレビュー・実行", async () => {
    await click("#navigation [data-view=automations]");
    await click("[data-action=edit-automation]");
    await set("#automationForm [name=name]", "UIデイリーノート");
    await submit(
      "#automationForm",
      "!document.querySelector('#automationDialog').open",
    );
    await click("[data-action=preview-automation]");
    await waitFor(
      "document.querySelector('#automationPreviewDialog').open && document.querySelector('#loading').hidden",
    );
    await click("#automationRunButton");
    await waitFor("!document.querySelector('#automationPreviewDialog').open");
    assert.equal(await evaluate("state.automationRuns[0].status"), "completed");
  });
  await check("ファイル検索・索引更新", async () => {
    await click("#navigation [data-view=search]");
    await click("[data-action=reindex]");
    await waitFor("document.querySelector('#loading').hidden");
    await set("#pageSearch", "wonderful");
    await evaluate(
      "document.querySelector('#pageSearch').dispatchEvent(new Event('input',{bubbles:true}))",
    );
    await waitFor(
      "document.querySelector('#searchResults').textContent.includes('design.md')",
    );
  });
  await check("コマンド検索からメモを開ける", async () => {
    await click("#commandButton");
    await set("#commandInput", "UIメモ");
    await evaluate(
      "document.querySelector('#commandInput').dispatchEvent(new Event('input',{bubbles:true}))",
    );
    await waitFor(
      "document.querySelector('#commandResults').textContent.includes('UIメモ')",
    );
    await click("#commandResults [data-command]");
    await waitFor("document.querySelector('#captureDialog').open");
    await click("[data-close=captureDialog]");
  });
  await check("遅れて返る検索結果が最新の検索を上書きしない", async () => {
    await click("#navigation [data-view=search]");
    await evaluate(`(async()=>{
      const original=window.fetch;
      window.fetch=async (url,options)=>{
        if(String(url).includes('q=slow'))await new Promise(resolve=>setTimeout(resolve,250));
        return original(url,options);
      };
      try { await Promise.all([performSearch('slow'),performSearch('wonderful')]); }
      finally { window.fetch=original; }
    })()`);
    assert.ok(
      await evaluate(
        "document.querySelector('#searchResults').textContent.includes('design.md')",
      ),
    );
  });
  await check("再読み込み後に画面とデータが残る", async () => {
    await click("#navigation [data-view=habits]");
    await command("Page.reload");
    await waitFor(
      "document.querySelector('.habit-table') && document.querySelector('#loading').hidden",
    );
    assert.ok(
      await evaluate(
        "document.querySelector('#view').textContent.includes('10分読書')",
      ),
    );
  });
  const capture = async (name) => {
    const shot = await command("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(path.join(root, name), Buffer.from(shot.data, "base64"));
  };
  await click("#navigation [data-view=today]");
  await capture("home-desktop.png");
  await check("ダークテーマ切替", async () => {
    await click("#themeButton");
    await waitFor(
      "document.documentElement.dataset.theme==='dark' && document.querySelector('#loading').hidden",
    );
    await delay(200); // Let the theme's CSS transition finish before visual review.
    await capture("home-dark.png");
    await click("#themeButton");
    await waitFor(
      "document.documentElement.dataset.theme==='light' && document.querySelector('#loading').hidden",
    );
  });
  await check("390px幅の全画面でページ全体の横溢れがない", async () => {
    await command("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    for (const name of [
      "today",
      "tasks",
      "planner",
      "projects",
      "inbox",
      "habits",
      "worklog",
      "search",
      "automations",
      "health",
      "library",
    ]) {
      await evaluate(`navigate(${JSON.stringify(name)})`);
      const overflow = await evaluate(
        "document.documentElement.scrollWidth > innerWidth + 1",
      );
      assert.equal(overflow, false, name);
    }
    await evaluate("navigate('today')");
    await capture("home-mobile.png");
  });
  errors.push(...(await evaluate("window.__uiUnhandled")));
  assert.deepEqual(errors, [], "ブラウザのエラー");
  process.stdout.write(
    `\n${checks.length} UI checks passed. Screenshots: ${root}\n`,
  );
} finally {
  socket?.close();
  for (const child of children.reverse()) {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        delay(3000),
      ]);
    }
  }
  // Keep this clearly named temporary fixture and screenshots for visual review.
}
