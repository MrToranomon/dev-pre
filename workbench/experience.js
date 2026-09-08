// Product views share the authenticated store and UI primitives in app.js.
let taskLayout = "board";
let taskQuery = "";
let taskProjectFilter = "";
let noteQuery = "";
let weekOffset = 0;
let reviewRange = "week";
let searchVersion = 0;
let searchQuery = "";
let focusNotified = "";
let availableMinutes = 30;
const dateKey = (value = new Date()) => {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const shiftDay = (key, offset) => {
  const d = new Date(`${key}T12:00:00`);
  d.setDate(d.getDate() + offset);
  return dateKey(d);
};
const isOpenTask = (task) => ["todo", "doing"].includes(task.status);
const rankTasks = (a, b) =>
  (a.dueDate && a.dueDate < state.computed.today ? -1 : 0) -
    (b.dueDate && b.dueDate < state.computed.today ? -1 : 0) ||
  { high: 0, normal: 1, low: 2 }[a.priority] -
    { high: 0, normal: 1, low: 2 }[b.priority] ||
  (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999");
const navButton = (name, label, classes = "button text small") =>
  `<button class="${classes}" data-action="navigate" data-view="${name}">${label}</button>`;
const intro = (copy) =>
  `<p class="page-help">${escapeHtml(copy)}</p>`;

function applyVisualStyles() {
  document.querySelectorAll("progress").forEach((element) => {
    if (!element.hasAttribute("aria-label"))
      element.setAttribute("aria-label", "進捗");
  });
}

function taskCard(task, compact = false) {
  const overdue =
    isOpenTask(task) && task.dueDate && task.dueDate < state.computed.today;
  const checks = task.checklist ?? [];
  return `<article class="work-card ${task.status === "done" ? "is-complete" : ""}" data-task-id="${task.id}">
    <div class="work-card-head"><input class="task-check" type="checkbox" data-action="toggle-task" data-id="${task.id}" ${task.status === "done" ? "checked" : ""} aria-label="${escapeHtml(task.title)}を${task.status === "done" ? "未完了" : "完了"}にする"><button class="task-title" data-action="edit-task" data-id="${task.id}">${escapeHtml(task.title)}</button></div>
    <div class="work-card-meta">${task.priority === "high" ? '<span class="tag warm">優先</span>' : ""}${overdue ? '<span class="tag overdue">期限超過</span>' : ""}${task.dueDate ? `<span>期限 ${formatDate(task.dueDate)}</span>` : ""}${task.estimateMinutes ? `<span>◷ ${task.estimateMinutes}分</span>` : ""}${task.projectId ? `<span class="project-label">◇ ${escapeHtml(projectName(task.projectId))}</span>` : ""}</div>
    ${!compact && checks.length ? `<details class="task-checklist"><summary>チェックリスト ${checks.filter((item) => item.done).length}/${checks.length}</summary>${checks.map((item, index) => `<label><input type="checkbox" data-action="check-subtask" data-id="${task.id}" data-index="${index}" ${item.done ? "checked" : ""}><span>${escapeHtml(item.title)}</span></label>`).join("")}</details>` : ""}
    <div class="card-actions">${task.status === "archived" ? `<button data-action="restore-task" data-id="${task.id}">↶ 戻す</button>` : isOpenTask(task) ? `<button data-action="focus-task" data-id="${task.id}">集中</button>${task.scheduledDate === state.computed.today ? "" : `<button data-action="plan-today" data-id="${task.id}">今日に設定</button>`}<button data-action="doing-task" data-id="${task.id}">${task.status === "doing" ? "未着手へ" : "着手"}</button>` : ""}${!compact && task.status !== "archived" ? `<button data-action="archive-task" data-id="${task.id}" aria-label="${escapeHtml(task.title)}を保管">保管</button>` : ""}</div>
  </article>`;
}

function renderHome() {
  const today = state.computed.today;
  const planned = state.tasks
    .filter(
      (task) =>
        isOpenTask(task) &&
        (task.scheduledDate === today ||
          (task.dueDate && task.dueDate <= today)),
    )
    .sort(rankTasks);
  const next = planned[0] || state.tasks.filter(isOpenTask).sort(rankTasks)[0];
  const completed = state.tasks.filter(
    (task) => task.completedAt && dateKey(task.completedAt) === today,
  ).length;
  const goal =
    state.profile.dailyFocusDate === today ? state.profile.dailyFocus : "";
  const habits = state.habits.filter((item) => !item.archived);
  const projects = state.projects
    .filter((item) => item.status === "active")
    .slice(0, 3);
  view.innerHTML = `<div class="home-summary"><span class="day-label">${formatDate(today, { month: "long", day: "numeric", weekday: "long" })}</span></div>
    ${quickTaskForm()}
    <section class="daily-goal" aria-label="今日の目標"><div><h2>今日の目標</h2><p>${goal ? escapeHtml(goal) : "未設定"}</p></div><button class="button ghost small" data-action="edit-focus">${goal ? "編集" : "設定"}</button></section>
    <div class="home-metrics"><article><div><strong>${planned.length}<small> 件</small></strong><span>今日の予定・期限</span></div></article><article><div><strong>${completed}<small> 件</small></strong><span>今日の完了</span></div></article><article><div><strong>${state.computed.focusToday}<small> 分</small></strong><span>今日の集中</span></div></article><article><div><strong>${state.computed.openTasks}<small> 件</small></strong><span>未完了タスク</span></div></article></div>
    <div class="home-columns"><div><section class="panel"><div class="panel-heading"><div><h3>今日のタスク <span class="count-badge">${planned.length}</span></h3><p>今日の予定と、今日までが期限のタスク</p></div>${navButton("planner", "週間プラン")}</div>${
      planned.length
        ? `<div class="stack-list">${planned.slice(0, 5).map((task) => taskCard(task, true)).join("")}</div>${planned.length > 5 ? navButton("tasks", "すべてのタスクを見る", "button ghost task-more") : ""}`
        : empty("", "今日のタスクはありません", "", next ? `<button class="button ghost" data-action="plan-today" data-id="${next.id}">次のタスクを今日に設定</button><p class="suggested-task">${escapeHtml(next.title)}</p>` : "")
    }</section>
    <section class="panel home-projects"><div class="panel-heading"><h3>進行中のプロジェクト</h3>${navButton("projects", "すべて見る")}</div>${
      projects.length
        ? projects.map((project) => {
            const tasks = state.tasks.filter((task) => task.projectId === project.id && task.status !== "archived");
            const done = tasks.filter((task) => task.status === "done").length;
            return `<button class="project-summary" data-action="project-detail" data-id="${project.id}"><div><strong>${escapeHtml(project.name)}</strong><small>${done}/${tasks.length} タスク完了</small><progress max="${Math.max(1, tasks.length)}" value="${done}" aria-label="${escapeHtml(project.name)}のタスク完了率"></progress></div><span aria-hidden="true">›</span></button>`;
          }).join("")
        : empty("", "プロジェクトはありません", "", '<button class="button ghost" data-action="new-project">プロジェクトを追加</button>')
    }</section></div>
    <div>${renderTimeSuggestions()}<section class="panel focus-widget"><div class="panel-heading"><h3>集中タイマー</h3></div><div class="mini-clock" id="homeFocusClock">25:00</div>${state.computed.activeSession ? `<p>${escapeHtml(state.computed.activeSession.title)}</p>` : ""}<button class="button primary" data-action="focus">${state.computed.activeSession ? "タイマーを開く" : "タイマーを設定"}</button></section>
    <section class="panel habit-widget"><div class="panel-heading"><h3>習慣</h3>${navButton("habits", "すべて見る")}</div>${
      habits.length
        ? habits.slice(0, 4).map((habit) => `<label class="habit-today"><input type="checkbox" data-action="habit-today" data-id="${habit.id}" ${habit.days.includes(today) ? "checked" : ""}><span>${escapeHtml(habit.name)}</span></label>`).join("")
        : empty("", "習慣はありません", "", navButton("habits", "習慣を追加", "button ghost"))
    }</section></div></div>`;
  updateFocusClock();
}

function renderTaskBoard() {
  const filters = [
    ["open", "未完了"],
    ["today", "今日"],
    ["overdue", "期限超過"],
    ["done", "完了"],
    ["archived", "保管"],
    ["all", "すべて"],
  ];
  let items = state.tasks.filter((task) =>
    currentFilter === "all"
      ? task.status !== "archived"
      : currentFilter === "open"
        ? isOpenTask(task)
        : currentFilter === "today"
          ? isOpenTask(task) &&
            (task.scheduledDate === state.computed.today ||
              task.dueDate === state.computed.today)
          : currentFilter === "overdue"
            ? isOpenTask(task) &&
              task.dueDate &&
              task.dueDate < state.computed.today
            : task.status === currentFilter,
  );
  items = items
    .filter(
      (task) =>
        (!taskProjectFilter || task.projectId === taskProjectFilter) &&
        `${task.title} ${task.notes}`
          .toLocaleLowerCase()
          .includes(taskQuery.toLocaleLowerCase()),
    )
    .sort(rankTasks);
  view.innerHTML = `${quickTaskForm()}<div class="toolbar"><div class="filters">${filters.map(([key, label]) => `<button data-action="filter" data-filter="${key}" class="${currentFilter === key ? "active" : ""}">${label}</button>`).join("")}</div><button class="button primary" data-action="new-task">タスクを追加</button></div><div class="task-controls"><input id="taskQuery" type="search" aria-label="タスクを検索" placeholder="⌕ タスクを検索" value="${escapeHtml(taskQuery)}"><select id="taskProjectFilter" aria-label="プロジェクトで絞り込む"><option value="">すべてのプロジェクト</option>${state.projects.map((project) => `<option value="${project.id}" ${taskProjectFilter === project.id ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}</select><div class="filters"><button data-action="task-layout" data-layout="board" class="${taskLayout === "board" ? "active" : ""}">ボード</button><button data-action="task-layout" data-layout="list" class="${taskLayout === "list" ? "active" : ""}">リスト</button></div><span class="result-count">${items.length}件</span></div>
    ${
      !items.length
        ? `<section class="panel">${empty("☑", "この条件のタスクはありません", "条件を変えるか、新しいタスクを追加してください。", '<button class="button ghost" data-action="new-task">タスクを追加</button>')}</section>`
        : taskLayout === "board" && currentFilter !== "archived"
          ? `<div class="kanban">${[
              ["todo", "未着手"],
              ["doing", "進行中"],
              ["done", "完了"],
            ]
              .map(
                ([key, label]) =>
                  `<section class="kanban-column ${key}"><h3><i></i>${label}<span>${items.filter((task) => task.status === key).length}</span></h3><div class="stack-list">${
                    items
                      .filter((task) => task.status === key)
                      .map((task) => taskCard(task))
                      .join("") ||
                    '<p class="column-empty">ここにタスクが並びます</p>'
                  }</div></section>`,
              )
              .join("")}</div>`
          : `<div class="stack-list">${items.map((task) => taskCard(task)).join("")}</div>`
    }`;
  $("#taskProjectFilter").onchange = (event) => {
    taskProjectFilter = event.target.value;
    render();
  };
  bindLiveFilter("#taskQuery", value => { taskQuery = value; });
}

function renderPlanner() {
  const today = state.computed.today;
  const weekday = new Date(`${today}T12:00:00`).getDay();
  const monday = shiftDay(today, -((weekday + 6) % 7) + weekOffset * 7);
  const dates = Array.from({ length: 7 }, (_, i) => shiftDay(monday, i));
  const unscheduled = state.tasks
    .filter((task) => isOpenTask(task) && !task.scheduledDate)
    .sort(rankTasks);
  view.innerHTML = `${intro("タスクの予定日を週ごとに確認できます。")}<div class="toolbar"><div class="week-heading"><button class="icon-button" data-action="week-shift" data-offset="-1" aria-label="前の週">←</button><h3>${formatDate(monday)} — ${formatDate(dates[6])}</h3><button class="icon-button" data-action="week-shift" data-offset="1" aria-label="次の週">→</button><button class="button ghost small" data-action="week-reset">今週</button></div><button class="button primary" data-action="new-task">タスクを追加</button></div><div class="week-grid">${dates
    .map((date, i) => {
      const tasks = state.tasks
        .filter(
          (task) =>
            task.status !== "archived" &&
            (task.scheduledDate === date ||
              (!task.scheduledDate && task.dueDate === date)),
        )
        .sort(rankTasks);
      const minutes = tasks
        .filter(isOpenTask)
        .reduce((sum, task) => sum + (task.estimateMinutes || 0), 0);
      return `<section class="day-column ${date === today ? "is-today" : ""}"><header><span>${["月", "火", "水", "木", "金", "土", "日"][i]}</span><strong>${Number(date.slice(-2))}</strong><small>${minutes ? formatMinutes(minutes) : "余白あり"}</small></header>${tasks.map((task) => `<button class="planned-task ${task.status === "done" ? "is-complete" : ""}" data-action="edit-task" data-id="${task.id}"><strong>${task.status === "done" ? "✓ " : ""}${escapeHtml(task.title)}</strong><small>${task.estimateMinutes ? `${task.estimateMinutes}分` : "時間未設定"}${!task.scheduledDate ? " · 締切" : ""}</small></button>`).join("")}<button class="add-day" data-action="add-day-task" data-date="${date}" aria-label="${date}にタスクを追加">＋</button></section>`;
    })
    .join(
      "",
    )}</div><section class="panel unscheduled"><div class="panel-heading"><div><h3>まだ予定していないこと <span class="count-badge">${unscheduled.length}</span></h3><p>「今日に設定」でホームへ。別の日ならタスクを編集して予定日を選べます。</p></div></div><div class="unscheduled-grid">${unscheduled.map((task) => taskCard(task, true)).join("") || empty("✓", "すべて予定できています", "")}</div></section>`;
}

function renderKnowledge() {
  const items = state.inbox.filter(
    (item) =>
      (currentFilter === "favorites"
        ? item.favorite
        : currentFilter === "all"
          ? true
          : item.status === currentFilter) &&
      `${item.title} ${item.body} ${item.url} ${(item.tags ?? []).join(" ")}`
        .toLocaleLowerCase()
        .includes(noteQuery.toLocaleLowerCase()),
  );
  view.innerHTML = `${intro("メモやリンクを保存し、タスクやプロジェクトに変換できます。")}<div class="toolbar"><div class="filters">${[
    ["open", "未整理"],
    ["favorites", "★ お気に入り"],
    ["archived", "保管"],
    ["all", "すべて"],
  ]
    .map(
      ([key, label]) =>
        `<button class="${key === currentFilter ? "active" : ""}" data-action="filter" data-filter="${key}">${label}</button>`,
    )
    .join(
      "",
    )}</div><button class="button primary" data-action="capture">メモを追加</button></div><input class="note-search" id="noteQuery" type="search" aria-label="メモを検索" placeholder="⌕ タイトル、本文、タグから探す" value="${escapeHtml(noteQuery)}"><div class="note-grid">${items.map((item) => `<article class="note-card"><div class="note-card-top"><span class="tag">${{ note: "メモ", idea: "✦ アイデア", link: "↗ リンク", file: "ファイル" }[item.kind] ?? "メモ"}</span><button class="favorite-button ${item.favorite ? "selected" : ""}" data-action="favorite-note" data-id="${item.id}" aria-label="${escapeHtml(item.title)}のお気に入りを${item.favorite ? "解除" : "登録"}" aria-pressed="${item.favorite}">${item.favorite ? "★" : "☆"}</button></div><button class="note-title" data-action="edit-inbox" data-id="${item.id}">${escapeHtml(item.title)}</button><p class="note-body">${escapeHtml(item.body || item.url || "本文なし")}</p><div class="note-tags">${tagsHtml(item.tags)}</div><small>${relativeTime(item.updatedAt)}</small><div class="card-actions"><button data-action="edit-inbox" data-id="${item.id}">編集</button>${item.convertedTo ? "<span>変換済み</span>" : `<button data-action="convert-task" data-id="${item.id}">タスクへ</button><button data-action="convert-project" data-id="${item.id}">プロジェクトへ</button>`}${item.url ? `<button data-action="open-url" data-url="${encodeURIComponent(item.url)}">リンク</button>` : ""}<button data-action="${item.status === "open" ? "archive-inbox" : "restore-inbox"}" data-id="${item.id}">${item.status === "open" ? "保管" : "戻す"}</button></div></article>`).join("") || empty("✦", "メモはありません", "", '<button class="button primary" data-action="capture">メモを追加</button>')}</div>`;
  bindLiveFilter("#noteQuery", value => { noteQuery = value; });
}

function renderSearch() {
  view.innerHTML = `${intro("登録フォルダのファイル名と、PDF・Word・テキストの内容を検索します。")}<div class="search-page"><div class="search-main"><span>⌕</span><input id="pageSearch" type="search" autocomplete="off" aria-label="ファイルの名前や内容を検索" placeholder="ファイル名、資料に書かれた言葉…" value="${escapeHtml(searchQuery)}"><button class="button ghost small" data-action="reindex">索引を更新</button></div><div class="search-meta"><span id="searchStatus">${state.search.state === "indexing" ? `索引を作成中 · ${state.search.files}件` : state.search.updatedAt ? `${state.search.files}ファイル · 内容を検索できるファイル ${state.search.contentFiles}件` : "索引を準備しています"}</span><button class="button text small" data-action="settings">検索するフォルダを設定</button></div>${state.search.errors ? `<p class="hint">${state.search.errors}件の読み取りをスキップしました。読み取り可能なファイルは検索できます。</p>` : ""}${state.search.limited ? '<p class="hint">検索上限に達しています。設定で対象を絞るか、最大ファイル数を増やしてください。</p>' : ""}<div id="searchResults" class="stack-list"></div></div>`;
  $("#pageSearch").oninput = (event) => {
    searchQuery = event.target.value;
    ++searchVersion;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => performSearch(searchQuery), 180);
  };
  performSearch(searchQuery);
}

async function performSearch(query) {
  const version = ++searchVersion;
  const container = $("#searchResults");
  if (!container) return;
  if (!query.trim()) {
    container.innerHTML = empty(
      "⌕",
      "知識は、見つけられると力になる",
      "キーワードを入力してください。メモやタスクは Ctrl K からも検索できます。",
    );
    return;
  }
  container.innerHTML = empty(
    "···",
    "検索しています",
    "ファイルの名前と内容を調べています。",
  );
  try {
    const response = await request(
      `/api/search?q=${encodeURIComponent(query)}&limit=100`,
    );
    if (
      version !== searchVersion ||
      currentView !== "search" ||
      !container.isConnected
    )
      return;
    searchResults = response.results;
    container.innerHTML = searchResults.length
      ? searchResults
          .map(
            (item) =>
              `<article class="list-item search-result"><span class="item-icon">${item.extension === ".pdf" ? "P" : item.extension === ".docx" ? "W" : "◇"}</span><div><strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(item.snippet || "ファイル名で一致しました")}</p><small class="path">${escapeHtml(item.path)}</small><small>${formatBytes(item.size)} · ${formatDate(item.modifiedAt)}</small></div><button class="button ghost small" data-action="open-path" data-path="${encodeURIComponent(item.path)}" aria-label="${escapeHtml(item.name)}を開く">開く</button></article>`,
          )
          .join("")
      : empty(
          "⌕",
          "一致するファイルはありません",
          "別の言葉で検索するか、検索フォルダと索引を確認してください。",
        );
  } catch (error) {
    if (version === searchVersion && container.isConnected)
      container.innerHTML = empty("!", "検索できませんでした", error.message);
  }
}

function renderHabits() {
  const days = Array.from({ length: 7 }, (_, i) =>
    shiftDay(state.computed.today, i - 6),
  );
  const habits = state.habits.filter((item) =>
    currentFilter === "archived" ? item.archived : !item.archived,
  );
  view.innerHTML = `${intro("日ごとの実施状況を記録できます。")}<form id="habitForm" class="habit-add"><input name="name" required maxlength="120" aria-label="新しい習慣" placeholder="例：10分読書する、ストレッチする"><button class="button primary" type="submit">習慣を追加</button></form><div class="toolbar"><div class="filters"><button data-action="filter" data-filter="open" class="${currentFilter !== "archived" ? "active" : ""}">登録中</button><button data-action="filter" data-filter="archived" class="${currentFilter === "archived" ? "active" : ""}">保管</button></div><span class="result-count">直近7日</span></div><section class="panel habit-table-wrap"><table class="habit-table"><thead><tr><th scope="col">習慣</th>${days.map((day) => `<th scope="col" class="${day === state.computed.today ? "today-cell" : ""}">${formatDate(day, { weekday: "short" })}<small>${formatDate(day)}</small></th>`).join("")}<th scope="col">管理</th></tr></thead><tbody>${habits.map((habit) => `<tr><th scope="row">${escapeHtml(habit.name)}<small>${habit.days.filter((day) => days.includes(day)).length}/7日 達成</small></th>${days.map((day) => `<td><button class="habit-check ${habit.days.includes(day) ? "checked" : ""}" aria-pressed="${habit.days.includes(day)}" aria-label="${escapeHtml(habit.name)} ${day}" data-action="habit-day" data-id="${habit.id}" data-date="${day}">${habit.days.includes(day) ? "✓" : "·"}</button></td>`).join("")}<td><button class="icon-button" data-action="archive-habit" data-id="${habit.id}">${habit.archived ? "戻す" : "保管"}</button></td></tr>`).join("")}</tbody></table>${habits.length ? "" : empty("♧", "習慣はありません", "上の入力欄で追加できます。")}</section>`;
  $("#habitForm").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const response = await mutate(
      "/api/habit/save",
      { name: form.elements.name.value },
      "新しい習慣を追加しました",
    );
    if (response) $("#habitForm input").focus();
  };
}

function renderLibrary() {
  view.innerHTML = `${intro("テンプレートからプロジェクトとタスクをまとめて追加できます。")}<div class="template-grid">${state.templates.map((template) => `<article class="template-card"><div><span class="tag">${template.tasks.length} タスク</span><h3>${template.name}</h3><p>${template.description}</p><button class="button ghost" data-action="template-preview" data-id="${template.id}">内容を見る</button></div></article>`).join("")}</div><section class="panel guide-panel"><div class="panel-heading"><div><h3>TigerGateの使い方</h3></div></div><div class="guide-grid">${[
    [
      "01",
      "メモする",
      "頭に浮かんだことを「メモ・アイデア」に。タイトルだけでも保存できます。",
      "inbox",
    ],
    [
      "02",
      "計画する",
      "メモをタスクに変換。週間プランで予定日を決め、プロジェクトにまとめます。",
      "planner",
    ],
    [
      "03",
      "集中する",
      "タスクの「集中」からタイマーを開始。一時停止しても記録は残ります。",
      "tasks",
    ],
    [
      "04",
      "振り返る",
      "集中を終えると作業記録に。積み重ねを確認して、Markdownで日報を出力。",
      "worklog",
    ],
  ]
    .map(
      ([n, title, copy, name]) =>
        `<article><span>${n}</span><h3>${title}</h3><p>${copy}</p>${navButton(name, "開く →")}</article>`,
    )
    .join(
      "",
    )}</div></section><div class="section-grid"><section class="panel"><h3>キーボードショートカット</h3><p class="shortcut-line"><kbd>N</kbd> メモを追加</p><p class="shortcut-line"><kbd>Ctrl / ⌘ K</kbd> タスク・メモ・プロジェクトを探す</p><p class="shortcut-line"><kbd>Esc</kbd> ダイアログを閉じる</p></section><section class="panel"><h3>データの保存</h3><p class="muted-copy">登録した内容はこのPCに保存されます。設定の「全データを書き出す」でJSONに、自動化の「バックアップ」で指定フォルダに保存できます。</p><button class="button ghost" data-action="settings">設定・バックアップを開く</button></section></div>`;
}

function renderReview() {
  renderWorklog();
  const from =
    reviewRange === "all"
      ? null
      : shiftDay(state.computed.today, reviewRange === "week" ? -6 : -29);
  const logs = state.worklogs
    .filter(
      (log) => (!from || log.date >= from) && log.date <= state.computed.today,
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  const section = view.querySelector(".section-grid > section");
  section.innerHTML = `<div class="panel-heading"><div><h3>作業記録</h3><p>${logs.length}件 · ${formatMinutes(logs.reduce((sum, log) => sum + log.minutes, 0))}</p></div><button class="button primary small" data-action="new-worklog">記録</button></div><div class="toolbar"><div class="filters">${[
    ["week", "過去7日"],
    ["month", "過去30日"],
    ["all", "すべて"],
  ]
    .map(
      ([key, label]) =>
        `<button data-action="review-range" data-range="${key}" class="${reviewRange === key ? "active" : ""}">${label}</button>`,
    )
    .join(
      "",
    )}</div><button class="button ghost small" data-action="export-review">日報を出力</button></div><div class="stack-list">${logs.map((log) => `<article class="list-item"><span class="item-icon">${log.source === "focus" ? "◷" : "✓"}</span><div><strong>${escapeHtml(log.title)}</strong><p class="preserve-lines">${escapeHtml(log.body)}</p><small>${formatDate(log.date)} · ${formatMinutes(log.minutes)} ${escapeHtml(projectName(log.projectId))}</small></div><button class="icon-button" data-action="edit-worklog" data-id="${log.id}">編集</button></article>`).join("") || empty("◷", "作業記録はありません", "集中セッションを完了するか、手動で記録できます。")}</div>`;
}

function showProject(id) {
  const project = state.projects.find((item) => item.id === id);
  if (!project) return;
  const tasks = state.tasks.filter(
    (task) => task.projectId === id && task.status !== "archived",
  );
  const logs = state.worklogs.filter((log) => log.projectId === id);
  const done = tasks.filter((task) => task.status === "done").length;
  $("#projectDetail").innerHTML =
    `<h2 id="projectDetailTitle">${escapeHtml(project.name)}</h2><p class="muted-copy preserve-lines">${escapeHtml(project.description)}</p><div class="project-detail-metrics"><span>${done}/${tasks.length} タスク完了</span><span>${formatMinutes(logs.reduce((sum, log) => sum + log.minutes, 0))}の作業</span>${status(project.status)}</div><progress max="${Math.max(1, tasks.length)}" value="${done}" aria-label="タスク完了率"></progress><div class="dialog-actions"><button class="button ghost" data-action="detail-edit-project" data-id="${id}">プロジェクトを編集</button><button class="button primary" data-action="detail-add-task" data-id="${id}">タスクを追加</button></div><h3>次の行動</h3><div class="stack-list">${tasks.map((task) => `<button class="detail-task" data-action="detail-edit-task" data-id="${task.id}"><span>${task.status === "done" ? "✓" : "○"}</span>${escapeHtml(task.title)}<small>${statusLabels[task.status]}</small></button>`).join("") || '<p class="muted-copy">タスクはありません。</p>'}</div>${project.notes ? `<h3 class="detail-heading">プロジェクトノート</h3><p class="preserve-lines muted-copy">${escapeHtml(project.notes)}</p>` : ""}${project.links.length ? `<h3 class="detail-heading">関連リンク</h3><div class="stack-list">${project.links.map((link) => `<a class="resource-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`).join("")}</div>` : ""}<h3 class="detail-heading">最近の作業</h3>${
      logs
        .slice(0, 5)
        .map(
          (log) =>
            `<p class="muted-copy">${formatDate(log.date)} · ${escapeHtml(log.title)} · ${formatMinutes(log.minutes)}</p>`,
        )
        .join("") ||
      '<p class="muted-copy">作業記録はありません。</p>'
    }`;
  openDialog("#projectDetailDialog");
}

function showFocus(taskId = "") {
  const noteDraft = $("#finishFocusForm [name=note]")?.value ?? "";
  const completeDraft =
    $("#finishFocusForm [name=completeTask]")?.checked ?? false;
  const session = state.computed.activeSession;
  const tasks = state.tasks.filter(isOpenTask);
  const goal =
    state.profile.dailyFocusDate === state.computed.today
      ? state.profile.dailyFocus
      : "";
  $("#focusContents").innerHTML = session
    ? `<p class="focus-task-name">${escapeHtml(session.title)}</p><div class="focus-countdown" id="focusCountdown"></div><p class="focus-state" id="focusState"></p><div class="focus-options"><button class="button ghost" data-action="pause-focus">${session.pausedAt ? "再開する" : "Ⅱ 一時停止"}</button></div><form id="finishFocusForm"><label><span>できたこと・次にやること</span><textarea name="note" rows="3" maxlength="5000" placeholder="作業内容や次の手順を記入"></textarea></label>${session.taskId ? '<label class="check"><input name="completeTask" type="checkbox"> このタスクも完了にする</label>' : ""}<div class="dialog-actions"><button class="button primary" type="submit">✓ 集中を終えて記録する</button></div></form>`
    : `<p class="muted-copy">タスクと時間を選んで開始します。</p><form id="startFocusForm"><label><span>取り組むタスク</span><select name="taskId"><option value="">タスクを指定せず集中する</option>${tasks.map((task) => `<option value="${task.id}" ${task.id === taskId ? "selected" : ""}>${escapeHtml(task.title)}</option>`).join("")}</select></label><label><span>セッション名（タスク未指定の場合）</span><input name="title" maxlength="200" value="${escapeHtml(goal || "集中作業")}"></label><div class="field-row"><label><span>集中時間</span><input name="plannedMinutes" type="number" min="1" max="180" step="1" value="25" required inputmode="numeric"><small class="hint">1〜180分・1分単位</small><div class="focus-presets">${[15,25,50,90].map(minutes => `<button type="button" class="button ghost small" data-action="focus-preset" data-minutes="${minutes}">${minutes}分</button>`).join("")}</div></label><label><span>プロジェクト</span><select name="projectId"><option value="">なし</option>${state.projects
        .filter((item) => item.status === "active")
        .map(
          (item) =>
            `<option value="${item.id}">${escapeHtml(item.name)}</option>`,
        )
        .join(
          "",
        )}</select></label></div><p class="hint">時間になると画面でお知らせします。終了ボタンで実際の集中時間を記録できます。</p><div class="dialog-actions"><button class="button primary" type="submit">開始</button></div></form>`;
  if ($("#startFocusForm"))
    $("#startFocusForm").onsubmit = async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget));
      if (
        await mutate("/api/focus/start", data, "集中セッションを開始しました")
      )
        showFocus();
    };
  if ($("#finishFocusForm")) {
    $("#finishFocusForm [name=note]").value = noteDraft;
    if ($("#finishFocusForm [name=completeTask]"))
      $("#finishFocusForm [name=completeTask]").checked = completeDraft;
    $("#finishFocusForm").onsubmit = async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      if (
        await mutate(
          "/api/focus/stop",
          { note: form.get("note"), completeTask: form.has("completeTask") },
          "集中の記録を保存しました",
        )
      )
        $("#focusDialog").close();
    };
  }
  openDialog("#focusDialog");
  updateFocusClock();
}

function updateFocusClock() {
  if (!state) return;
  const session = state.computed.activeSession;
  if (!session) {
    $("#focusClock").textContent = "";
    if ($("#homeFocusClock")) $("#homeFocusClock").textContent = "25:00";
    document.title = "TigerGate";
    return;
  }
  const elapsed = Math.max(
    0,
    Math.floor(
      (new Date(session.pausedAt || Date.now()) -
        new Date(session.startedAt) -
        (session.pausedMilliseconds || 0)) /
        1000,
    ),
  );
  const remaining = Math.max(0, (session.plannedMinutes || 25) * 60 - elapsed);
  const clock = `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
  $("#focusClock").textContent = clock;
  if ($("#homeFocusClock")) $("#homeFocusClock").textContent = clock;
  if ($("#focusCountdown")) $("#focusCountdown").textContent = clock;
  if ($("#focusState"))
    $("#focusState").textContent = session.pausedAt
      ? "一時停止中"
      : remaining === 0
        ? "設定した集中時間になりました"
        : `集中中 · ${Math.floor(elapsed / 60)}分経過`;
  document.title = `${clock} ${session.pausedAt ? "一時停止" : "集中"} — TigerGate`;
  if (!remaining && focusNotified !== session.id) {
    focusNotified = session.id;
    toast("設定した集中時間になりました。");
  }
}

// Route actions through one delegate, including controls inside detail dialogs.
function dispatchViewAction(action, id) {
  const button = document.createElement("button");
  button.dataset.action = action;
  if (id) button.dataset.id = id;
  button.hidden = true;
  view.append(button);
  button.click();
  button.remove();
}
document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;
  try {
    if (action === "navigate") navigate(target.dataset.view);
    else if (action === "settings") openSettings();
    else if (action === "db-backup") {
      loading(true);
      try {
        const backup = await request("/api/storage/backup", {
          method: "POST",
          body: "{}",
        });
        toast(`DBバックアップを作成しました: ${backup.path}`);
      } finally {
        loading(false);
      }
    } else if (action === "dismiss-guide")
      await mutate(
        "/api/profile",
        { onboarded: true },
        "使い方はテンプレート画面で確認できます",
      );
    else if (action === "task-layout") {
      taskLayout = target.dataset.layout;
      render();
    } else if (action === "focus-task") showFocus(id);
    else if (action === "plan-today")
      await mutate(
        "/api/task/update",
        { id, scheduledDate: state.computed.today },
        "今日の予定に追加しました",
      );
    else if (action === "restore-task") {
      const task = state.tasks.find((item) => item.id === id);
      await mutate(
        "/api/task/update",
        {
          id,
          status:
            task.previousStatus === "archived"
              ? "todo"
              : task.previousStatus || "todo",
        },
        "タスクを戻しました",
      );
    } else if (action === "week-shift") {
      weekOffset += Number(target.dataset.offset);
      render();
    } else if (action === "week-reset") {
      weekOffset = 0;
      render();
    } else if (action === "add-day-task") {
      dispatchViewAction("new-task");
      $("#taskForm [name=scheduledDate]").value = target.dataset.date;
    } else if (action === "favorite-note") {
      const note = state.inbox.find((item) => item.id === id);
      await mutate(
        "/api/inbox/update",
        { id, favorite: !note.favorite },
        note.favorite ? "お気に入りを解除しました" : "お気に入りに追加しました",
      );
    } else if (action === "habit-day") {
      const habit = state.habits.find((item) => item.id === id);
      await mutate(
        "/api/habit/save",
        {
          id,
          date: target.dataset.date,
          done: !habit.days.includes(target.dataset.date),
        },
        "習慣の記録を更新しました",
      );
    } else if (action === "archive-habit") {
      const habit = state.habits.find((item) => item.id === id);
      await mutate(
        "/api/habit/save",
        { id, archived: !habit.archived },
        habit.archived ? "習慣を戻しました" : "習慣を保管しました",
      );
    } else if (action === "edit-worklog") {
      const log = state.worklogs.find((item) => item.id === id);
      const form = $("#worklogForm");
      form.reset();
      fillProjectSelect("#worklogProject");
      for (const key of ["id", "title", "body", "minutes", "date", "projectId"])
        form.elements[key].value = log[key] ?? "";
      $("#worklogTitle").textContent = "作業記録を編集";
      openDialog("#worklogDialog");
    } else if (action === "review-range") {
      reviewRange = target.dataset.range;
      render();
    } else if (action === "export-review") {
      const from =
        reviewRange === "all"
          ? ""
          : shiftDay(state.computed.today, reviewRange === "week" ? -6 : -29);
      download(
        `perfectwork-review-${state.computed.today}.md`,
        await request(
          `/api/worklog.md?from=${from}&to=${state.computed.today}`,
        ),
        "text/markdown;charset=utf-8",
      );
      toast("選んだ期間の日報を書き出しました");
    } else if (action === "project-detail") showProject(id);
    else if (action === "detail-edit-project") {
      $("#projectDetailDialog").close();
      dispatchViewAction("edit-project", id);
    } else if (action === "detail-add-task") {
      $("#projectDetailDialog").close();
      dispatchViewAction("new-task");
      $("#taskProject").value = id;
    } else if (action === "detail-edit-task") {
      $("#projectDetailDialog").close();
      dispatchViewAction("edit-task", id);
    } else if (action === "pause-focus") {
      if (await mutate("/api/focus/pause", {}, "集中セッションを更新しました"))
        showFocus();
    } else if (action === "template-preview") {
      const template = state.templates.find((item) => item.id === id);
      $("#templateContents").innerHTML =
        `<h2 id="templateTitle">${template.name}</h2><p class="muted-copy">${template.description}</p><ol class="template-steps">${template.tasks.map((title) => `<li>${title}</li>`).join("")}</ol><p class="hint">プロジェクト1件とタスク${template.tasks.length}件を追加します。最初のタスクは今日に設定されます。内容は自由に編集できます。</p><div class="dialog-actions"><button class="button primary" data-action="apply-template" data-id="${id}">テンプレートを追加</button></div>`;
      openDialog("#templateDialog");
    } else if (action === "apply-template") {
      const response = await mutate(
        "/api/template/apply",
        { templateId: id },
        "プロジェクトとタスクを追加しました",
      );
      if (response) {
        $("#templateDialog").close();
        navigate("today");
      }
    }
  } catch (error) {
    toast(error.message, true);
  }
});
view.addEventListener("change", async (event) => {
  const target = event.target;
  if (target.dataset.action === "habit-today")
    await mutate(
      "/api/habit/save",
      {
        id: target.dataset.id,
        date: state.computed.today,
        done: target.checked,
      },
      target.checked
        ? "習慣を記録しました"
        : "今日のチェックを戻しました",
    );
  if (target.dataset.action === "check-subtask") {
    const task = state.tasks.find((item) => item.id === target.dataset.id);
    const checklist = task.checklist.map((item, index) =>
      index === Number(target.dataset.index)
        ? { ...item, done: target.checked }
        : item,
    );
    await mutate(
      "/api/task/update",
      { id: task.id, checklist },
      "チェックリストを更新しました",
    );
  }
});
$("#goalForm").onsubmit = async (event) => {
  event.preventDefault();
  if (
    await mutate(
      "/api/profile",
      Object.fromEntries(new FormData(event.currentTarget)),
      "今日の目標を保存しました",
    )
  )
    $("#goalDialog").close();
};
$("#themeButton").onclick = () =>
  mutate("/api/profile", {
    theme: state.profile.theme === "dark" ? "light" : "dark",
  });
setInterval(updateFocusClock, 1000);
// Refresh calendar boundaries and external-tab changes only while no form is open.
let refreshing = false;
async function refreshWorkspace() {
  if (
    refreshing ||
    !state ||
    document.hidden ||
    document.querySelector("dialog[open]") ||
    busyDepth > 0 ||
    /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? "")
  )
    return;
  refreshing = true;
  try {
    const revision = state.updatedAt;
    const fresh = await request("/api/state");
    if (busyDepth > 0 || state.updatedAt !== revision) return;
    const changed =
      fresh.updatedAt !== state.updatedAt ||
      fresh.computed.today !== state.computed.today;
    state = fresh;
    if (
      changed &&
      !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? "")
    )
      render();
    else renderHeader();
  } catch {
    /* Keep the last usable view when temporarily disconnected. */
  } finally {
    refreshing = false;
  }
}
setInterval(refreshWorkspace, 30000);
window.addEventListener("focus", refreshWorkspace);
window.addEventListener("hashchange", () => {
  const name = location.hash.slice(1);
  if (titles[name]) navigate(name, true);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    $("#sidebar").classList.remove("open");
    $("#mobileMenu").setAttribute("aria-expanded", "false");
  }
});
$("#mobileMenu").addEventListener("click", () =>
  $("#mobileMenu").setAttribute(
    "aria-expanded",
    String($("#sidebar").classList.contains("open")),
  ),
);
function timeCandidates() {
  const today = state.computed.today;
  return state.tasks.filter(task => {
    const project = state.projects.find(item => item.id === task.projectId);
    return isOpenTask(task) && (!project || project.status === 'active') &&
      (!task.scheduledDate || task.scheduledDate <= today) &&
      (task.estimateMinutes || 25) <= availableMinutes;
  }).sort((a, b) => rankTasks(a, b) || (a.status === 'doing' ? -1 : 0) - (b.status === 'doing' ? -1 : 0)).slice(0, 3);
}
function renderTimeSuggestions() {
  const today = state.computed.today;
  return `<section class="panel time-suggestions"><div class="panel-heading"><h3>空き時間から選ぶ</h3></div><div class="filters time-budgets">${[15, 30, 60, 90].map(minutes => `<button data-action="time-budget" data-minutes="${minutes}" class="${minutes === availableMinutes ? 'active' : ''}" aria-pressed="${minutes === availableMinutes}">${minutes}分</button>`).join('')}</div><p class="hint">見積時間・期限・優先度から候補を表示</p><div class="stack-list">${timeCandidates().map(task => {
    const reason = task.dueDate && task.dueDate < today ? '期限超過' : task.dueDate === today ? '今日が期限' : task.priority === 'high' ? '優先度：高' : task.status === 'doing' ? '作業中' : task.scheduledDate === today ? '今日の予定' : task.scheduledDate ? '予定日経過' : '未予定';
    return `<article class="time-candidate"><button class="task-title" data-action="edit-task" data-id="${task.id}">${escapeHtml(task.title)}</button><small>${task.estimateMinutes ? `${task.estimateMinutes}分` : '25分（見積未設定）'} · ${reason}</small><button class="button ghost" data-action="start-candidate" data-id="${task.id}">取り組む</button></article>`;
  }).join('') || '<p class="muted-copy">この時間に収まる候補はありません。</p>'}</div></section>`;
}
function bulkTaskTitles(value) {
  return value.split(/\r?\n/).map(line => line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s*/, '').trim()).filter(Boolean);
}
function showBatchTasks() {
  if (!$('#batchTaskDialog')) {
    const dialog = document.createElement('dialog');
    dialog.id = 'batchTaskDialog';
    dialog.setAttribute('aria-labelledby', 'batchTaskHeading');
    dialog.innerHTML = `<form id="batchTaskForm" class="dialog-body"><button class="dialog-close" type="button" id="closeBatchTasks" aria-label="閉じる">×</button><h2 id="batchTaskHeading">タスクを一括追加</h2><label><span>1行に1タスク（最大50件）</span><textarea id="batchTaskInput" rows="7" maxlength="20000" required placeholder="資料を確認する&#10;見積を作成する&#10;日程を調整する"></textarea></label><label><span>プロジェクト</span><select id="batchTaskProject"></select></label><label class="check"><input id="batchTaskToday" type="checkbox">今日の予定にする</label><p class="hint" id="batchTaskCount" aria-live="polite"></p><ol id="batchTaskPreview" class="batch-preview"></ol><div class="dialog-actions"><button class="button primary" id="saveBatchTasks" type="submit">追加</button></div></form>`;
    document.body.append(dialog);
    $('#closeBatchTasks').onclick = () => dialog.close();
    $('#batchTaskInput').addEventListener('input', updateBatchPreview);
    $('#batchTaskForm').onsubmit = async event => {
      event.preventDefault();
      if (!updateBatchPreview()) return;
      const submittedDraft = $('#batchTaskInput').value;
      const response = await mutate('/api/task/batch', { titles: bulkTaskTitles(submittedDraft), projectId: $('#batchTaskProject').value || null, scheduledDate: $('#batchTaskToday').checked ? state.computed.today : null }, 'タスクをまとめて追加しました');
      if (response && $('#batchTaskInput').value === submittedDraft) { dialog.close(); $('#batchTaskInput').value = ''; }
      updateBatchPreview();
    };
  }
  const selection = $('#batchTaskProject').value;
  fillProjectSelect('#batchTaskProject');
  $('#batchTaskProject').value = selection || (currentView === 'tasks' ? taskProjectFilter : '');
  if (!$('#batchTaskInput').value) $('#batchTaskToday').checked = currentView === 'today';
  updateBatchPreview();
  openDialog('#batchTaskDialog');
  $('#batchTaskInput').focus();
}
function updateBatchPreview() {
  const titles = bulkTaskTitles($('#batchTaskInput').value);
  const valid = titles.length > 0 && titles.length <= 50 && titles.every(title => title.length <= 300);
  $('#batchTaskCount').textContent = titles.length > 50 ? '50件以下に分けてください。' : titles.some(title => title.length > 300) ? '各タスクは300文字以内にしてください。' : `${titles.length}件を追加します`;
  $('#batchTaskPreview').innerHTML = titles.slice(0, 50).map(title => `<li>${escapeHtml(title)}</li>`).join('');
  $('#saveBatchTasks').disabled = !valid || busyDepth > 0;
  return valid;
}
document.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  if (target.dataset.action === 'focus-preset') {
    const input = $('#startFocusForm [name=plannedMinutes]');
    if (input) { input.value = target.dataset.minutes; input.focus(); }
  }
  if (target.dataset.action === 'batch-tasks') showBatchTasks();
  if (target.dataset.action === 'time-budget') {
    availableMinutes = Number(target.dataset.minutes);
    render();
  }
  if (target.dataset.action === 'start-candidate') {
    const task = state.tasks.find(item => item.id === target.dataset.id);
    if (!task) return;
    showFocus(task.id);
    const select = $('#startFocusForm [name=plannedMinutes]');
    if (select) {
      const minutes = Math.min(180, task.estimateMinutes || 25);
      select.value = String(minutes);
    }
  }
});
start();
