const token = document.querySelector('meta[name="perfectwork-token"]').content;
history.replaceState(null, "", location.pathname + location.hash);

const $ = (selector) => document.querySelector(selector);
const view = $("#view");
let state = null;
let currentView = "today";
let currentFilter = "open";
let searchResults = [];
let searchTimer = null;
let toastTimer = null;
let health = null;
let projectHealth = null;
let automationPreview = null;
let commandIndex = 0;
let commandSearchVersion = 0;
let commandFiles = [];
let commandChoices = [];

const titles = {
  today: ["YOUR PERSONAL WORKSPACE", "ホーム"],
  search: ["FIND YOUR KNOWLEDGE", "ファイル検索"],
  inbox: ["IDEAS WORTH KEEPING", "メモ・アイデア"],
  tasks: ["NEXT ACTIONS", "タスク"],
  projects: ["MISSION CONTROL", "プロジェクト"],
  worklog: ["PROGRESS, REMEMBERED", "振り返り"],
  automations: ["WORK ON AUTOPILOT", "自動化"],
  health: ["WORKSPACE HEALTH", "ファイル診断"],
  planner: ["MAKE SPACE FOR WHAT MATTERS", "週間プラン"],
  habits: ["SMALL STEPS, EVERY DAY", "習慣"],
  library: ["A LITTLE INSPIRATION", "はじめ方・テンプレート"],
};
const statusLabels = {
  todo: "未着手",
  doing: "進行中",
  done: "完了",
  archived: "アーカイブ",
  active: "進行中",
  paused: "保留",
  completed: "完了",
  manual: "手動",
  startup: "起動時",
  daily: "毎日",
  undone: "取消済み",
  "partially-undone": "一部未取消",
  failed: "失敗",
};
const actionLabels = {
  "daily-note": "デイリーノート",
  "inbox-digest": "インボックス・ダイジェスト",
  "project-snapshot": "プロジェクト・スナップショット",
  backup: "データバックアップ",
};
const icons = {
  capture: "↓",
  task: "✓",
  project: "◇",
  focus: "◷",
  worklog: "◷",
  automation: "⌁",
  settings: "⚙",
};

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        character
      ],
  );
}
function formatBytes(bytes = 0) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** index).toFixed(index && bytes / 1024 ** index < 10 ? 1 : 0)} ${units[index]}`;
}
function formatMinutes(minutes = 0) {
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}時間${minutes % 60 ? `${minutes % 60}分` : ""}`
    : `${minutes}分`;
}
function formatDate(value, options = { month: "short", day: "numeric" }) {
  if (!value) return "期限なし";
  return new Intl.DateTimeFormat("ja-JP", options).format(
    new Date(value.length === 10 ? `${value}T00:00:00` : value),
  );
}
function relativeTime(value) {
  if (!value) return "";
  const seconds = Math.round((new Date(value) - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("ja", { numeric: "auto" });
  for (const [unit, size] of [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ])
    if (Math.abs(seconds) >= size || unit === "minute")
      return formatter.format(Math.round(seconds / size), unit);
}
function projectName(id) {
  return state.projects.find((project) => project.id === id)?.name ?? "";
}
function empty(icon, title, copy, button = "") {
  return `<div class="empty"><span>${icon}</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(copy)}</p>${button}</div>`;
}
function tagsHtml(tags = []) {
  return tags
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join(" ");
}
function status(value) {
  return `<span class="status ${escapeHtml(value)}">${escapeHtml(statusLabels[value] ?? value)}</span>`;
}

function toast(message, isError = false) {
  clearTimeout(toastTimer);
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("error", isError);
  element.classList.add("visible");
  toastTimer = setTimeout(() => element.classList.remove("visible"), 4200);
}
function loading(active) {
  $("#loading").hidden = !active;
  document.querySelector(".app")?.toggleAttribute("inert", active);
  document
    .querySelectorAll("dialog")
    .forEach((dialog) => dialog.toggleAttribute("inert", active));
}

async function request(route, options = {}) {
  let response;
  try {
    response = await fetch(route, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-PerfectWork-Token": token,
        ...(options.headers ?? {}),
      },
    });
  } catch {
    throw new Error(
      "PerfectWorkに接続できません。アプリを開き直してください。",
    );
  }
  const type = response.headers.get("content-type") ?? "";
  const data = type.includes("json")
    ? await response.json()
    : await response.text();
  if (!response.ok) throw new Error(data.error ?? "処理に失敗しました。");
  return data;
}
async function mutate(route, data, success) {
  loading(true);
  $("#errorBanner").hidden = true;
  try {
    const response = await request(route, {
      method: "POST",
      body: JSON.stringify(data),
    });
    if (response.state) {
      state = response.state;
      render();
    }
    if (success) toast(success);
    return response;
  } catch (error) {
    $("#errorBanner").textContent = error.message;
    $("#errorBanner").hidden = false;
    toast(error.message, true);
    return null;
  } finally {
    loading(false);
  }
}
function download(name, contents, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderHeader() {
  const [eyebrow, title] = titles[currentView];
  $("#viewEyebrow").textContent = eyebrow;
  $("#viewTitle").textContent = title;
  $("#navInbox").textContent = state.computed.openInbox;
  $("#navTasks").textContent = state.computed.openTasks;
  $("#navProjects").textContent = state.computed.activeProjects;
  document.documentElement.dataset.accent = state.profile.accent;
  document.documentElement.dataset.theme = state.profile.theme || "light";
  $("#profileButton").textContent = (state.profile.name || "PW")
    .slice(0, 2)
    .toUpperCase();
  document.querySelectorAll("#navigation [data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === currentView);
    if (button.dataset.view === currentView)
      button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  const session = state.computed.activeSession;
  $("#focusButton").classList.toggle("running", Boolean(session));
  $("#focusLabel").textContent = session ? session.title : "フォーカスを開始";
}

function projectCard(project) {
  const tasks = state.tasks.filter(
    (task) => task.projectId === project.id && task.status !== "archived",
  );
  const done = tasks.filter((task) => task.status === "done").length;
  return `<article class="project-card" style="--project-color:${escapeHtml(project.color)}"><div class="inline-actions">${status(project.status)}${project.dueDate ? `<span class="tag">期限 ${formatDate(project.dueDate)}</span>` : ""}</div><h3>${escapeHtml(project.name)}</h3><p>${escapeHtml(project.description || "このプロジェクトで叶えたいことを書いてみましょう。")}</p><progress max="${Math.max(1, tasks.length)}" value="${done}" aria-label="タスク完了率"></progress><div class="project-meta"><span>${done}/${tasks.length} タスク完了</span><span>全体進捗 ${project.progress}%</span></div><div class="inline-actions detail-heading"><button class="button primary small" data-action="project-detail" data-id="${project.id}">ワークスペースを開く ↗</button><button class="button ghost small" data-action="edit-project" data-id="${project.id}">編集</button>${project.folder ? `<button class="button text small" data-action="open-path" data-path="${encodeURIComponent(project.folder)}">フォルダ ↗</button>` : ""}</div></article>`;
}

function renderProjects() {
  const projects = state.projects.filter((project) =>
    currentFilter === "all"
      ? project.status !== "archived"
      : project.status === currentFilter,
  );
  view.innerHTML = `<div class="toolbar"><div class="filters"><button data-action="filter" data-filter="active" class="${currentFilter === "active" ? "active" : ""}">進行中</button><button data-action="filter" data-filter="paused" class="${currentFilter === "paused" ? "active" : ""}">保留</button><button data-action="filter" data-filter="completed" class="${currentFilter === "completed" ? "active" : ""}">完了</button><button data-action="filter" data-filter="all" class="${currentFilter === "all" ? "active" : ""}">すべて</button><button data-action="filter" data-filter="archived" class="${currentFilter === "archived" ? "active" : ""}">保管</button></div><div class="section-actions"><button class="button ghost" data-action="project-diagnostics">Git状況を更新</button><button class="button primary" data-action="new-project">＋ プロジェクト</button></div></div>${
    projectHealth
      ? `<section class="panel" style="margin-bottom:16px"><div class="panel-heading"><div><h3>プロジェクト・パルス</h3><p>登録フォルダとGitの現在地です。</p></div></div><div class="stack-list">${projectHealth
          .map((item) => {
            const project = state.projects.find((p) => p.id === item.projectId);
            return `<div class="list-item"><span class="item-icon">${item.exists ? "⌘" : "!"}</span><div><strong>${escapeHtml(project?.name)}</strong><p>${!item.exists ? "登録フォルダが見つかりません" : item.git ? `${escapeHtml(item.git.branch || "detached")} · 変更 ${item.git.changedFiles}件${item.git.lastCommit ? ` · ${item.git.lastCommit.hash} ${escapeHtml(item.git.lastCommit.message)}` : ""}` : "Git未使用"}</p><small class="path">${escapeHtml(item.folder)}</small></div></div>`;
          })
          .join("")}</div></section>`
      : ""
  }<div class="project-grid">${projects.length ? projects.map(projectCard).join("") : empty("◇", "プロジェクトはありません", "ゴール、進捗、フォルダ、タスク、作業ログを一つにつなげます。", '<button class="button primary small" data-action="new-project">最初のプロジェクトを作る</button>')}</div>`;
}

function renderWorklog() {
  const logs = state.worklogs.filter(
    (log) =>
      currentFilter === "all" ||
      log.date >=
        new Date(Date.now() - (currentFilter === "week" ? 7 : 30) * 86400000)
          .toISOString()
          .slice(0, 10),
  );
  const max = Math.max(1, ...state.insights.days.map((day) => day.minutes));
  view.innerHTML = `<div class="metric-strip"><article class="metric-card"><span>過去14日</span><strong>${formatMinutes(state.insights.totalMinutes)}</strong><small>集中と手動記録</small></article><article class="metric-card"><span>完了タスク</span><strong>${state.insights.completedTasks}</strong><small>過去14日</small></article><article class="metric-card"><span>継続</span><strong>${state.insights.streak}日</strong><small>成果を記録した日</small></article><article class="metric-card"><span>過去7日</span><strong>${formatMinutes(state.computed.focusWeek)}</strong><small>集中セッション</small></article></div><div class="section-grid"><section class="panel"><div class="panel-heading"><div><h3>作業の記録</h3><p>「やったこと」が消えず、振り返りと日報になります。</p></div><div class="section-actions"><button class="button ghost small" data-action="export-worklog">Markdown出力</button><button class="button primary small" data-action="new-worklog">＋ 記録</button></div></div><div class="stack-list">${
    logs.length
      ? logs
          .slice(0, 100)
          .map(
            (log) =>
              `<article class="list-item"><span class="item-icon">${log.source === "focus" ? "◷" : "✓"}</span><div><strong>${escapeHtml(log.title)}</strong><p>${escapeHtml(log.body)}</p><small>${formatDate(log.date, { year: "numeric", month: "short", day: "numeric" })} · ${formatMinutes(log.minutes)}${log.projectId ? ` · ${escapeHtml(projectName(log.projectId))}` : ""}</small></div></article>`,
          )
          .join("")
      : empty(
          "◷",
          "まだ作業ログがありません",
          "集中セッションを完了するか、成果を手動で記録してください。",
        )
  }</div></section><section class="panel"><div class="panel-heading"><div><h3>集中のリズム</h3><p>過去14日</p></div></div><div class="chart">${state.insights.days.map((day, index) => `<i class="chart-bar" style="--height:${Math.max(4, (day.minutes / max) * 100)}%" data-label="${index % 2 === 0 ? day.date.slice(5).replace("-", "/") : ""}" title="${day.minutes}分"></i>`).join("")}</div></section></div>`;
}

function renderAutomations() {
  view.innerHTML = `<div class="toolbar"><p style="color:var(--muted);margin:0">手動実行はプレビューで確認。自動実行は、有効にしたスケジュールで動きます。</p><button class="button primary" data-action="new-automation">＋ 自動化</button></div><div class="section-grid"><section class="panel"><div class="panel-heading"><div><h3>オートパイロット</h3><p>繰り返す整理や記録を、決めた手順で実行します。</p></div></div><div class="stack-list">${state.automations.map((auto) => `<article class="list-item"><span class="item-icon">⌁</span><div><strong>${escapeHtml(auto.name)}</strong><p>${escapeHtml(auto.description || actionLabels[auto.action])}</p><small>${escapeHtml(actionLabels[auto.action])} · ${escapeHtml(statusLabels[auto.trigger] ?? auto.trigger)}${auto.lastRunAt ? ` · 最終実行 ${relativeTime(auto.lastRunAt)}` : ""}</small></div><div class="item-actions"><label class="automation-status"><input class="toggle" type="checkbox" data-action="toggle-automation" data-id="${auto.id}" ${auto.enabled ? "checked" : ""} aria-label="${escapeHtml(auto.name)}の自動実行"></label><button class="icon-button" data-action="edit-automation" data-id="${auto.id}">編集</button><button class="button primary small" data-action="preview-automation" data-id="${auto.id}">プレビュー</button></div></article>`).join("")}</div></section><section class="panel"><div class="panel-heading"><div><h3>実行履歴</h3><p>直近の自動化は安全に取り消せます。</p></div></div><div class="stack-list">${
    state.automationRuns
      .slice(0, 12)
      .map(
        (run) =>
          `<article class="list-item"><span class="item-icon">${run.status === "completed" ? "✓" : run.status === "failed" ? "!" : "↶"}</span><div><strong>${escapeHtml(run.name)}</strong><p>${run.error ? escapeHtml(run.error) : `${run.operations?.length ?? 0}件の操作`}</p><small>${relativeTime(run.createdAt)} · ${status(run.status)}</small></div>${run.status === "completed" ? `<button class="icon-button" data-action="undo-automation" data-id="${run.id}">Undo</button>` : ""}</article>`,
      )
      .join("") ||
    empty(
      "⌁",
      "実行履歴はありません",
      "プレビューから実行するとここに記録されます。",
    )
  }</div></section></div>`;
}

function renderHealth() {
  if (!health) {
    view.innerHTML = `<section class="panel">${empty("◉", "PCの状態をスキャンします", "検索対象フォルダの容量、巨大・古い・重複ファイルを読み取り専用で調べます。削除は行いません。", '<button class="button primary" data-action="scan-health">スキャンを開始</button>')}</section>`;
    return;
  }
  const issues =
    health.largest.length +
    health.duplicateGroups.length +
    health.errors.length;
  view.innerHTML = `<div class="toolbar"><p style="color:var(--muted);margin:0">${formatDate(health.scannedAt, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${health.files}ファイルを確認</p><button class="button ghost" data-action="scan-health">再スキャン</button></div><div class="metric-strip"><article class="metric-card"><span>スキャン範囲</span><strong>${health.files}件</strong><small>${health.limited ? "上限に到達・一部を確認" : "登録フォルダ内を確認"} · ファイルの削除なし</small></article><article class="metric-card"><span>確認容量</span><strong>${formatBytes(health.bytes)}</strong><small>${health.files}ファイル</small></article><article class="metric-card"><span>重複候補</span><strong>${health.duplicateGroups.length}</strong><small>${formatBytes(health.duplicateBytes)}を節約可能</small></article><article class="metric-card"><span>巨大ファイル</span><strong>${health.largest.length}</strong><small>${formatBytes(state.settings.healthLargeFileBytes)}以上</small></article></div><div class="section-grid"><section class="panel"><div class="panel-heading"><div><h3>ドライブ容量</h3><p>検索対象があるボリュームの空き容量です。</p></div></div>${health.volumes
    .map((volume) => {
      const used = volume.total - volume.free;
      return `<div class="volume"><div class="progress-label"><span class="path">${escapeHtml(volume.root)}</span><strong>空き ${formatBytes(volume.free)}</strong></div><div class="volume-bar"><i style="width:${Math.min(100, (used / volume.total) * 100)}%"></i></div><small>${formatBytes(used)} / ${formatBytes(volume.total)} 使用</small></div>`;
    })
    .join(
      "",
    )}</section><section class="panel"><div class="panel-heading"><div><h3>診断サマリー</h3><p>次に確認すると効果が大きい項目です。</p></div></div><div class="health-score"><strong class="${issues ? "health-warn" : "health-good"}">${issues}</strong><div><h3>${issues ? "確認候補があります" : "確認範囲に候補はありません"}</h3><p style="color:var(--muted);margin:0">重複や巨大ファイルは内容を確認してから、エクスプローラーで整理してください。</p></div></div></section></div><div class="section-grid"><section class="panel"><div class="panel-heading"><div><h3>重複ファイル候補</h3><p>サイズとSHA-256が同一のファイルです。</p></div></div><div class="stack-list">${
    health.duplicateGroups
      .slice(0, 20)
      .map(
        (group) =>
          `<article class="list-item"><span class="item-icon">＝</span><div><strong>${group.files.length}個 · ${formatBytes(group.size)}</strong><p>${group.files.map((file) => escapeHtml(file)).join("<br>")}</p><small>${formatBytes(group.recoverableBytes)}を節約可能</small></div></article>`,
      )
      .join("") ||
    empty(
      "✓",
      "重複候補はありません",
      "確認した範囲では同一内容のファイルは見つかりませんでした。",
    )
  }</div></section><section class="panel"><div class="panel-heading"><div><h3>巨大ファイル</h3><p>容量の大きい順です。</p></div></div><div class="stack-list">${
    health.largest
      .slice(0, 20)
      .map(
        (file) =>
          `<article class="list-item"><span class="item-icon">▣</span><div><strong>${escapeHtml(file.name)}</strong><p class="path">${escapeHtml(file.path)}</p><small>${formatBytes(file.size)} · ${formatDate(file.modifiedAt)}</small></div><button class="icon-button" data-action="open-path" data-path="${encodeURIComponent(file.path)}">開く</button></article>`,
      )
      .join("") ||
    empty(
      "✓",
      "巨大ファイルはありません",
      "設定した基準を超えるファイルは見つかりませんでした。",
    )
  }</div></section></div><section class="panel" style="margin-top:16px"><div class="panel-heading"><div><h3>長期間更新されていないファイル</h3><p>${state.settings.healthStaleDays}日以上前のファイル。必要性を見直す候補です。</p></div><span class="tag">${health.stale.length}件</span></div><div class="stack-list">${
    health.stale
      .slice(0, 30)
      .map(
        (file) =>
          `<article class="list-item"><span class="item-icon">◷</span><div><strong>${escapeHtml(file.name)}</strong><p class="path">${escapeHtml(file.path)}</p><small>${formatDate(file.modifiedAt, { year: "numeric", month: "short", day: "numeric" })} · ${formatBytes(file.size)}</small></div><button class="icon-button" data-action="open-path" data-path="${encodeURIComponent(file.path)}">開く</button></article>`,
      )
      .join("") ||
    empty(
      "✓",
      "古いファイルはありません",
      "設定した期間を超えるファイルは見つかりませんでした。",
    )
  }</div></section>`;
  if (health.errors.length)
    view.insertAdjacentHTML(
      "beforeend",
      `<section class="panel" style="margin-top:16px"><div class="panel-heading"><div><h3>読み取れなかった場所</h3><p>権限や接続状態を確認してください。ほかの診断結果には影響しません。</p></div><span class="status failed">${health.errors.length}件</span></div><div class="stack-list">${health.errors.map((item) => `<div class="list-item"><span class="item-icon">!</span><div><strong class="path">${escapeHtml(item.path)}</strong><p>${escapeHtml(item.error)}</p></div></div>`).join("")}</div></section>`,
    );
}

function render() {
  if (!state) return;
  renderHeader();
  if (currentView === "today") renderHome();
  else if (currentView === "search") renderSearch();
  else if (currentView === "inbox") renderKnowledge();
  else if (currentView === "tasks") renderTaskBoard();
  else if (currentView === "projects") renderProjects();
  else if (currentView === "worklog") renderReview();
  else if (currentView === "automations") renderAutomations();
  else if (currentView === "planner") renderPlanner();
  else if (currentView === "habits") renderHabits();
  else if (currentView === "library") renderLibrary();
  else renderHealth();
  applyVisualStyles();
}

function navigate(name) {
  if (!titles[name]) return;
  currentView = name;
  currentFilter =
    name === "projects" ? "active" : name === "tasks" ? "all" : "open";
  history.replaceState(null, "", `#${name}`);
  $("#sidebar").classList.remove("open");
  $("#mobileMenu").setAttribute("aria-expanded", "false");
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
document
  .querySelectorAll("#navigation [data-view]")
  .forEach((button) =>
    button.addEventListener("click", () => navigate(button.dataset.view)),
  );
$("#mobileMenu").addEventListener("click", () =>
  $("#sidebar").classList.toggle("open"),
);

function fillProjectSelect(selector) {
  $(selector).innerHTML =
    '<option value="">なし</option>' +
    state.projects
      .filter((project) => project.status !== "archived")
      .map(
        (project) =>
          `<option value="${project.id}">${escapeHtml(project.name)}</option>`,
      )
      .join("");
}
function openDialog(id) {
  if (!$(id).open) $(id).showModal();
}
document
  .querySelectorAll("[data-close]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      $("#" + button.dataset.close).close(),
    ),
  );
$("#captureButton").addEventListener("click", () => {
  $("#captureForm").reset();
  $("#captureTitle").textContent = "頭の中から、ここへ。";
  openDialog("#captureDialog");
  setTimeout(() => $("#captureTitleInput").focus(), 20);
});

$("#captureForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const data = {
    id: form.get("id"),
    title: form.get("title"),
    kind: form.get("kind"),
    url: form.get("url"),
    body: form.get("body"),
    tags: String(form.get("tags") || "")
      .split(/[,、]/)
      .map((value) => value.trim())
      .filter(Boolean),
  };
  const response = await mutate(
    data.id ? "/api/inbox/update" : "/api/inbox/create",
    data,
    data.id ? "インボックスを更新しました" : "インボックスに保存しました",
  );
  if (response) formElement.closest("dialog").close();
});
$("#taskForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const data = Object.fromEntries(form);
  const previous =
    state.tasks.find((task) => task.id === data.id)?.checklist ?? [];
  data.checklist = String(data.checklistText)
    .split(/\r?\n/)
    .map((title) => title.trim())
    .filter(Boolean)
    .map((title) => ({
      title,
      done: previous.find((item) => item.title === title)?.done ?? false,
    }));
  delete data.checklistText;
  const response = await mutate(
    data.id ? "/api/task/update" : "/api/task/create",
    data,
    data.id ? "タスクを更新しました" : "タスクを追加しました",
  );
  if (response) formElement.closest("dialog").close();
});
$("#projectForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const data = Object.fromEntries(new FormData(formElement));
  data.progress = Number(data.progress);
  const otherLinks = data.id
    ? (state.projects.find((item) => item.id === data.id)?.links ?? []).slice(1)
    : [];
  data.links = [
    ...(data.linkUrl
      ? [{ label: data.linkLabel || "関連リンク", url: data.linkUrl }]
      : []),
    ...otherLinks,
  ];
  delete data.linkLabel;
  delete data.linkUrl;
  const response = await mutate(
    data.id ? "/api/project/update" : "/api/project/create",
    data,
    data.id ? "プロジェクトを更新しました" : "プロジェクトを開始しました",
  );
  if (response) formElement.closest("dialog").close();
});
$("#worklogForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const response = await mutate(
    formElement.elements.id.value
      ? "/api/worklog/update"
      : "/api/worklog/create",
    Object.fromEntries(new FormData(formElement)),
    "作業ログに記録しました",
  );
  if (response) formElement.closest("dialog").close();
});
$("#automationForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const response = await mutate(
    "/api/automation/save",
    { ...Object.fromEntries(form), enabled: form.has("enabled") },
    "自動化を保存しました",
  );
  if (response) formElement.closest("dialog").close();
});

async function toggleFocus() {
  showFocus();
}
$("#focusButton").addEventListener("click", toggleFocus);

view.addEventListener("change", async (event) => {
  const action = event.target.dataset.action;
  if (action === "toggle-task")
    await mutate(
      "/api/task/update",
      {
        id: event.target.dataset.id,
        status: event.target.checked ? "done" : "todo",
      },
      event.target.checked ? "タスクを完了しました" : "未完了に戻しました",
    );
  if (action === "toggle-automation") {
    const auto = state.automations.find(
      (item) => item.id === event.target.dataset.id,
    );
    await mutate(
      "/api/automation/save",
      { ...auto, enabled: event.target.checked },
      event.target.checked
        ? "自動実行を有効にしました"
        : "自動実行を停止しました",
    );
  }
});

view.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const itemId = target.dataset.id;
  if (action === "capture") $("#captureButton").click();
  else if (action === "new-task") {
    $("#taskForm").reset();
    $("#taskDialogTitle").textContent = "タスクを追加";
    $("#taskForm [type=submit]").textContent = "追加する";
    fillProjectSelect("#taskProject");
    openDialog("#taskDialog");
  } else if (action === "new-project") {
    $("#projectForm").reset();
    $("#projectDialogTitle").textContent = "プロジェクトを開始";
    $("#projectForm [name=color]").value = "#8b7cff";
    openDialog("#projectDialog");
  } else if (action === "new-worklog") {
    $("#worklogForm").reset();
    $("#worklogTitle").textContent = "作業を記録";
    $("#worklogForm [name=date]").value = state.computed.today;
    fillProjectSelect("#worklogProject");
    openDialog("#worklogDialog");
  } else if (action === "new-automation") {
    $("#automationForm").reset();
    $("#automationTitle").textContent = "自動化を作成";
    openDialog("#automationDialog");
  } else if (action === "focus") await toggleFocus();
  else if (action === "edit-focus") {
    $("#goalForm [name=dailyFocus]").value = state.profile.dailyFocus;
    openDialog("#goalDialog");
  } else if (action === "filter") {
    currentFilter = target.dataset.filter;
    render();
  } else if (action === "doing-task") {
    const task = state.tasks.find((item) => item.id === itemId);
    await mutate(
      "/api/task/update",
      { id: itemId, status: task.status === "doing" ? "todo" : "doing" },
      "タスクの状態を更新しました",
    );
  } else if (action === "edit-task") {
    const task = state.tasks.find((item) => item.id === itemId);
    const form = $("#taskForm");
    form.reset();
    fillProjectSelect("#taskProject");
    for (const key of [
      "id",
      "title",
      "dueDate",
      "priority",
      "projectId",
      "notes",
      "scheduledDate",
      "estimateMinutes",
    ])
      form.elements[key].value = task[key] ?? "";
    form.elements.checklistText.value = (task.checklist ?? [])
      .map((item) => item.title)
      .join("\n");
    $("#taskForm [type=submit]").textContent = "変更を保存";
    $("#taskDialogTitle").textContent = "タスクを編集";
    openDialog("#taskDialog");
  } else if (action === "archive-task")
    await mutate(
      "/api/task/update",
      { id: itemId, status: "archived" },
      "タスクをアーカイブしました",
    );
  else if (action === "edit-inbox") {
    const item = state.inbox.find((entry) => entry.id === itemId);
    const form = $("#captureForm");
    form.reset();
    for (const key of ["id", "title", "kind", "url", "body"])
      form.elements[key].value = item[key] ?? "";
    form.elements.tags.value = (item.tags ?? []).join(", ");
    $("#captureTitle").textContent = "キャプチャを編集";
    openDialog("#captureDialog");
  } else if (action === "archive-inbox" || action === "restore-inbox")
    await mutate(
      "/api/inbox/update",
      { id: itemId, status: action === "archive-inbox" ? "archived" : "open" },
      "インボックスを更新しました",
    );
  else if (action === "convert-task" || action === "convert-project")
    await mutate(
      "/api/inbox/convert",
      { id: itemId, target: action === "convert-task" ? "task" : "project" },
      `${action === "convert-task" ? "タスク" : "プロジェクト"}へ変換しました`,
    );
  else if (action === "edit-project") {
    const project = state.projects.find((item) => item.id === itemId);
    const form = $("#projectForm");
    form.reset();
    for (const key of [
      "id",
      "name",
      "description",
      "dueDate",
      "folder",
      "color",
      "status",
      "progress",
      "notes",
    ])
      form.elements[key].value = project[key] ?? "";
    form.elements.linkLabel.value = project.links?.[0]?.label ?? "";
    form.elements.linkUrl.value = project.links?.[0]?.url ?? "";
    $("#projectDialogTitle").textContent = "プロジェクトを編集";
    openDialog("#projectDialog");
  } else if (action === "progress-project") {
    const project = state.projects.find((item) => item.id === itemId);
    await mutate(
      "/api/project/update",
      {
        id: itemId,
        progress: Math.min(100, project.progress + 10),
        status: project.progress + 10 >= 100 ? "completed" : project.status,
      },
      "進捗を更新しました",
    );
  } else if (action === "go-search") navigate("search");
  else if (action === "reindex") {
    loading(true);
    try {
      const response = await request("/api/search/reindex", {
        method: "POST",
        body: "{}",
      });
      state.search = response.status;
      toast(`${response.status.files}ファイルの索引を更新しました`);
      render();
    } catch (error) {
      toast(error.message, true);
    } finally {
      loading(false);
    }
  } else if (action === "scan-health") {
    loading(true);
    try {
      health = await request("/api/health");
      toast(`${health.files}ファイルを診断しました`);
      render();
    } catch (error) {
      toast(error.message, true);
    } finally {
      loading(false);
    }
  } else if (action === "project-diagnostics") {
    loading(true);
    try {
      projectHealth = (await request("/api/projects/diagnostics")).diagnostics;
      render();
    } catch (error) {
      toast(error.message, true);
    } finally {
      loading(false);
    }
  } else if (action === "open-path")
    await mutate("/api/open", {
      path: decodeURIComponent(target.dataset.path),
    });
  else if (action === "open-url")
    await mutate("/api/open", { url: decodeURIComponent(target.dataset.url) });
  else if (action === "orbit") $("#orbitButton").click();
  else if (action === "export-worklog") {
    const contents = await request("/api/worklog.md");
    download(
      `perfectwork-log-${state.computed.today}.md`,
      contents,
      "text/markdown;charset=utf-8",
    );
  } else if (action === "preview-automation") {
    loading(true);
    try {
      automationPreview = await request("/api/automation/preview", {
        method: "POST",
        body: JSON.stringify({ id: itemId }),
      });
      $("#automationPreviewSummary").textContent =
        `「${automationPreview.automationName}」は次の操作を行います。`;
      $("#automationPreviewList").innerHTML = automationPreview.operations
        .map(
          (operation) =>
            `<div class="list-item"><span class="item-icon">＋</span><div><strong>${escapeHtml(operation.description)}</strong><p class="path">${escapeHtml(operation.path)}</p><small>${formatBytes(operation.bytes)}</small></div></div>`,
        )
        .join("");
      openDialog("#automationPreviewDialog");
    } catch (error) {
      toast(error.message, true);
    } finally {
      loading(false);
    }
  } else if (action === "edit-automation") {
    const automation = state.automations.find((item) => item.id === itemId);
    const form = $("#automationForm");
    form.reset();
    for (const key of ["id", "name", "description", "action", "trigger"])
      form.elements[key].value = automation[key] ?? "";
    form.elements.enabled.checked = automation.enabled;
    $("#automationTitle").textContent = "自動化を編集";
    openDialog("#automationDialog");
  } else if (action === "undo-automation") {
    if (
      !confirm(
        "この自動化で作成したファイルを取り消しますか？ 作成後に編集したファイルは残します。",
      )
    )
      return;
    await mutate(
      "/api/automation/undo",
      { id: itemId },
      "自動化を取り消しました",
    );
  }
});

$("#automationRunButton").addEventListener("click", async () => {
  if (!automationPreview) return;
  const response = await mutate(
    "/api/automation/run",
    { previewId: automationPreview.id },
    "自動化を実行しました",
  );
  if (response) $("#automationPreviewDialog").close();
});

function openSettings() {
  const form = $("#settingsForm");
  form.elements.name.value = state.profile.name;
  form.elements.accent.value = state.profile.accent;
  form.elements.searchRoots.value = state.settings.searchRoots.join("\n");
  form.elements.writeRoot.value = state.settings.writeRoot;
  form.elements.searchMaxFiles.value = state.settings.searchMaxFiles;
  form.elements.healthLargeFileMB.value = Math.round(
    state.settings.healthLargeFileBytes / 1024 / 1024,
  );
  form.elements.healthStaleDays.value = state.settings.healthStaleDays;
  form.elements.launcherHotkey.value = state.hotkey?.shortcut || "Win+Insert";
  form.elements.hotkeyEnabled.checked = state.hotkey?.enabled !== false;
  const hotkey = state.hotkey;
  $("#hotkeySummary").innerHTML = `<span class="storage-mark">⌨</span><div><strong>${escapeHtml(hotkey?.shortcut || "Win+Insert")}</strong><p>${hotkey?.registered ? "グローバル起動キーは待機中です" : hotkey?.enabled ? "常駐ランチャーが停止しています" : "グローバル起動キーは無効です"}</p><small>${hotkey?.error ? escapeHtml(hotkey.error) : "変更は常駐ランチャーへ自動反映されます。"}</small></div>`;
  const storage = state.storage;
  $("#storageSummary").innerHTML =
    storage?.backend === "postgresql"
      ? `<span class="storage-mark">DB</span><div><strong>PostgreSQL ${escapeHtml(storage.version || "")}</strong><p>${escapeHtml(storage.database)} · revision ${storage.revision} · ${storage.entities} entities</p><small>入力データの正本はPostgreSQL。復旧用JSONミラーも自動更新します。</small><button class="button ghost small storage-backup" type="button" data-action="db-backup">DBバックアップを作成</button></div>`
      : `<span class="storage-mark">JSON</span><div><strong>JSONファイル</strong><p>ローカルファイルをデータの正本として使用中</p></div>`;
  openDialog("#settingsDialog");
}
$("#settingsButton").addEventListener("click", openSettings);
$("#profileButton").addEventListener("click", openSettings);
$("#settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  loading(true);
  try {
    const response = await request("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        profile: { name: form.get("name"), accent: form.get("accent") },
        searchRoots: String(form.get("searchRoots"))
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean),
        writeRoot: form.get("writeRoot"),
        searchMaxFiles: Number(form.get("searchMaxFiles")),
        healthLargeFileBytes:
          Number(form.get("healthLargeFileMB")) * 1024 * 1024,
        healthStaleDays: Number(form.get("healthStaleDays")),
        hotkey: {
          shortcut: form.get("launcherHotkey"),
          enabled: form.get("hotkeyEnabled") === "on",
        },
      }),
    });
    state = response.state;
    formElement.closest("dialog").close();
    render();
    toast("設定を保存しました。検索索引を更新してください");
  } catch (error) {
    toast(error.message, true);
  } finally {
    loading(false);
  }
});
$("#exportDataButton").addEventListener("click", async () => {
  try {
    const data = await request("/api/export");
    download(
      `perfectwork-backup-${state.computed.today}.json`,
      `${JSON.stringify(data, null, 2)}\n`,
      "application/json;charset=utf-8",
    );
  } catch (error) {
    toast(error.message, true);
  }
});
$("#orbitButton").addEventListener("click", async () => {
  const response = await mutate("/api/orbit", {});
  if (response) toast("Orbit Organizerを開きました");
});

const commands = [
  {
    icon: "↓",
    label: "クイックキャプチャ",
    hint: "インボックス",
    run: () => $("#captureButton").click(),
  },
  {
    icon: "✓",
    label: "新しいタスク",
    hint: "タスク",
    run: () => {
      navigate("tasks");
      setTimeout(
        () => view.querySelector('[data-action="new-task"]').click(),
        0,
      );
    },
  },
  {
    icon: "◇",
    label: "新しいプロジェクト",
    hint: "プロジェクト",
    run: () => {
      navigate("projects");
      setTimeout(
        () => view.querySelector('[data-action="new-project"]').click(),
        0,
      );
    },
  },
  {
    icon: "◷",
    label: "集中セッションを開始／完了",
    hint: "フォーカス",
    run: toggleFocus,
  },
  {
    icon: "⌕",
    label: "全文検索を開く",
    hint: "検索",
    run: () => navigate("search"),
  },
  {
    icon: "◉",
    label: "PC診断を開く",
    hint: "診断",
    run: () => navigate("health"),
  },
  {
    icon: "⌁",
    label: "自動化を開く",
    hint: "自動化",
    run: () => navigate("automations"),
  },
  {
    icon: "✦",
    label: "Orbit Organizerを開く",
    hint: "ファイル整理",
    run: () => $("#orbitButton").click(),
  },
];
async function renderCommands() {
  const version = ++commandSearchVersion;
  const query = $("#commandInput").value.trim().toLocaleLowerCase("ja");
  commandChoices = [
    ...commands,
    ...Object.entries(titles).map(([name, [, label]]) => ({
      icon: "↗",
      label: `${label}を開く`,
      hint: "画面",
      run: () => navigate(name),
    })),
  ];
  if (query)
    commandChoices.push(
      ...state.tasks
        .filter((task) => task.status !== "archived")
        .map((task) => ({
          icon: "✓",
          label: task.title,
          hint: "タスク",
          run: () => {
            navigate("tasks");
            dispatchViewAction("edit-task", task.id);
          },
        })),
      ...state.inbox.map((item) => ({
        icon: "▤",
        label: item.title,
        hint: "メモ",
        run: () => {
          navigate("inbox");
          dispatchViewAction("edit-inbox", item.id);
        },
      })),
      ...state.projects.map((project) => ({
        icon: "◇",
        label: project.name,
        hint: "プロジェクト",
        run: () => showProject(project.id),
      })),
    );
  const matches = commandChoices
    .map((command, index) => ({ command, index }))
    .filter(({ command }) =>
      command.label.toLocaleLowerCase("ja").includes(query),
    )
    .slice(0, 24);
  const markup = () =>
    matches
      .map(
        ({ command, index }) =>
          `<button class="command-result" data-command="${index}"><i>${command.icon}</i><span>${escapeHtml(command.label)}</span><small>${command.hint}</small></button>`,
      )
      .join("");
  $("#commandResults").innerHTML =
    markup() || '<p class="empty-copy">検索しています…</p>';
  selectCommandRow();
  let files = [];
  if (query.length >= 2) {
    try {
      files = (
        await request(`/api/search?q=${encodeURIComponent(query)}&limit=8`)
      ).results;
    } catch {}
  }
  if (version !== commandSearchVersion) return;
  commandFiles = files;
  $("#commandResults").innerHTML =
    markup() +
      files
        .map(
          (file) =>
            `<button class="command-result" data-file-path="${encodeURIComponent(file.path)}"><i>◇</i><span>${escapeHtml(file.name)}</span><small>${escapeHtml(file.extension)}</small></button>`,
        )
        .join("") || '<p class="empty-copy">一致する項目はありません</p>';
  selectCommandRow();
}
function selectCommandRow() {
  const buttons = [
    ...document.querySelectorAll("#commandResults .command-result"),
  ];
  commandIndex = Math.max(0, Math.min(commandIndex, buttons.length - 1));
  buttons.forEach((button, index) =>
    button.classList.toggle("selected", index === commandIndex),
  );
  buttons[commandIndex]?.scrollIntoView({ block: "nearest" });
}

function openCommands() {
  if (!state) return;
  commandIndex = 0;
  $("#commandInput").value = "";
  renderCommands();
  openDialog("#commandDialog");
  setTimeout(() => $("#commandInput").focus(), 20);
}
$("#commandButton").addEventListener("click", openCommands);
$("#searchTrigger").addEventListener("click", openCommands);
$("#commandInput").addEventListener("input", () => {
  commandIndex = 0;
  renderCommands();
});
$("#commandInput").addEventListener("keydown", (event) => {
  const buttons = [
    ...document.querySelectorAll(
      "#commandResults [data-command],#commandResults [data-file-path]",
    ),
  ];
  if (event.key === "ArrowDown") {
    event.preventDefault();
    commandIndex = Math.min(buttons.length - 1, commandIndex + 1);
    selectCommandRow();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    commandIndex = Math.max(0, commandIndex - 1);
    selectCommandRow();
  } else if (event.key === "Enter") {
    event.preventDefault();
    buttons[commandIndex]?.click();
  }
});
$("#commandResults").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-command],[data-file-path]");
  if (!button) return;
  $("#commandDialog").close();
  if (button.dataset.command !== undefined)
    commandChoices[Number(button.dataset.command)]?.run();
  else
    await mutate("/api/open", {
      path: decodeURIComponent(button.dataset.filePath),
    });
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openCommands();
  } else if (
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !document.querySelector("dialog[open]") &&
    !/input|textarea|select/i.test(event.target.tagName)
  ) {
    if (event.key.toLowerCase() === "n") $("#captureButton").click();
    else if (/^[1-8]$/.test(event.key))
      navigate(
        [
          "today",
          "search",
          "inbox",
          "tasks",
          "projects",
          "worklog",
          "automations",
          "health",
        ][Number(event.key) - 1],
      );
  }
});

// Focus clock is updated by experience.js, including persisted pauses.

async function start() {
  loading(true);
  try {
    state = await request("/api/state");
    health = state.health;
    if (titles[location.hash.slice(1)]) currentView = location.hash.slice(1);
    currentFilter =
      currentView === "projects"
        ? "active"
        : currentView === "tasks"
          ? "all"
          : "open";
    render();
  } catch (error) {
    $("#errorBanner").textContent = error.message;
    $("#errorBanner").hidden = false;
    toast(error.message, true);
  } finally {
    loading(false);
  }
}
