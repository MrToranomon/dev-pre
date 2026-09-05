const token = document.querySelector('meta[name="perfectwork-token"]').content;
history.replaceState(null, "", location.pathname);

const $ = selector => document.querySelector(selector);
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

const titles = {
  today: ["COMMAND CENTER", "今日"], search: ["UNIVERSAL SEARCH", "全文検索"], inbox: ["CAPTURE EVERYTHING", "インボックス"],
  tasks: ["NEXT ACTIONS", "タスク"], projects: ["MISSION CONTROL", "プロジェクト"], worklog: ["PROGRESS, REMEMBERED", "作業ログ"],
  automations: ["WORK ON AUTOPILOT", "自動化"], health: ["SYSTEM PULSE", "PC診断"],
};
const statusLabels = { todo:"未着手", doing:"進行中", done:"完了", archived:"アーカイブ", active:"進行中", paused:"保留", completed:"完了", manual:"手動", startup:"起動時", daily:"毎日", undone:"取消済み", "partially-undone":"一部未取消", failed:"失敗" };
const actionLabels = { "daily-note":"デイリーノート", "inbox-digest":"インボックス・ダイジェスト", "project-snapshot":"プロジェクト・スナップショット", backup:"データバックアップ" };
const icons = { capture:"↓", task:"✓", project:"◇", focus:"◷", worklog:"◷", automation:"⌁", settings:"⚙" };

function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, character => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[character])); }
function formatBytes(bytes = 0) { if (!bytes) return "0 B"; const units=["B","KB","MB","GB","TB"]; const index=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),units.length-1); return `${(bytes/1024**index).toFixed(index && bytes/1024**index<10?1:0)} ${units[index]}`; }
function formatMinutes(minutes = 0) { return minutes >= 60 ? `${Math.floor(minutes/60)}時間${minutes%60 ? `${minutes%60}分` : ""}` : `${minutes}分`; }
function formatDate(value, options = { month:"short", day:"numeric" }) { if (!value) return "期限なし"; return new Intl.DateTimeFormat("ja-JP", options).format(new Date(value.length === 10 ? `${value}T00:00:00` : value)); }
function relativeTime(value) { if (!value) return ""; const seconds=Math.round((new Date(value)-Date.now())/1000); const formatter=new Intl.RelativeTimeFormat("ja",{numeric:"auto"}); for(const [unit,size] of [["year",31536000],["month",2592000],["day",86400],["hour",3600],["minute",60]]) if(Math.abs(seconds)>=size || unit==="minute") return formatter.format(Math.round(seconds/size),unit); }
function projectName(id) { return state.projects.find(project => project.id === id)?.name ?? ""; }
function empty(icon, title, copy, button = "") { return `<div class="empty"><span>${icon}</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(copy)}</p>${button}</div>`; }
function tagsHtml(tags=[]) { return tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join(" "); }
function status(value) { return `<span class="status ${escapeHtml(value)}">${escapeHtml(statusLabels[value] ?? value)}</span>`; }

function toast(message, isError = false) {
  clearTimeout(toastTimer); const element=$("#toast"); element.textContent=message; element.classList.toggle("error",isError); element.classList.add("visible"); toastTimer=setTimeout(()=>element.classList.remove("visible"),4200);
}
function loading(active) { $("#loading").hidden=!active; document.querySelector(".app")?.toggleAttribute("inert",active); document.querySelectorAll("dialog").forEach(dialog=>dialog.toggleAttribute("inert",active)); }

async function request(route, options = {}) {
  let response;
  try { response=await fetch(route,{...options,headers:{"Content-Type":"application/json","X-PerfectWork-Token":token,...(options.headers??{})}}); }
  catch { throw new Error("PerfectWorkに接続できません。アプリを開き直してください。"); }
  const type=response.headers.get("content-type")??""; const data=type.includes("json")?await response.json():await response.text();
  if(!response.ok) throw new Error(data.error??"処理に失敗しました。"); return data;
}
async function mutate(route, data, success) {
  loading(true); $("#errorBanner").hidden=true;
  try { const response=await request(route,{method:"POST",body:JSON.stringify(data)}); if(response.state) state=response.state; if(success) toast(success); render(); return response; }
  catch(error){ $("#errorBanner").textContent=error.message; $("#errorBanner").hidden=false; toast(error.message,true); return null; }
  finally { loading(false); }
}
function download(name, contents, type="text/plain;charset=utf-8") { const url=URL.createObjectURL(new Blob([contents],{type})); const link=document.createElement("a"); link.href=url; link.download=name; document.body.append(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000); }

function renderHeader() {
  const [eyebrow,title]=titles[currentView]; $("#viewEyebrow").textContent=eyebrow; $("#viewTitle").textContent=title;
  $("#navInbox").textContent=state.computed.openInbox; $("#navTasks").textContent=state.computed.openTasks; $("#navProjects").textContent=state.computed.activeProjects;
  document.documentElement.dataset.accent=state.profile.accent; $("#profileButton").textContent=(state.profile.name||"PW").slice(0,2).toUpperCase();
  document.querySelectorAll("#navigation [data-view]").forEach(button=>button.classList.toggle("active",button.dataset.view===currentView));
  const session=state.computed.activeSession; $("#focusButton").classList.toggle("running",Boolean(session)); $("#focusLabel").textContent=session?session.title:"フォーカスを開始";
}

function taskItem(task) {
  return `<article class="list-item ${task.status==="done"?"done":""} ${task.priority==="high"?"priority-high":""}">
    <input class="task-check" type="checkbox" data-action="toggle-task" data-id="${task.id}" ${task.status==="done"?"checked":""} aria-label="${escapeHtml(task.title)}を${task.status==="done"?"未完了":"完了"}にする">
    <div><strong>${escapeHtml(task.title)}</strong><p>${escapeHtml(task.notes||"")}</p><small>${task.dueDate?`期限 ${formatDate(task.dueDate)}`:"期限なし"}${task.projectId?` · ${escapeHtml(projectName(task.projectId))}`:""}${task.priority==="high"?" · 優先":""}</small></div>
    <div class="item-actions"><button class="icon-button" data-action="edit-task" data-id="${task.id}">編集</button>${task.status!=="done"?`<button class="icon-button" data-action="doing-task" data-id="${task.id}">${task.status==="doing"?"未着手へ":"進行中へ"}</button>`:""}<button class="icon-button" data-action="archive-task" data-id="${task.id}">保管</button></div>
  </article>`;
}

function projectCard(project) {
  const tasks=state.tasks.filter(task=>task.projectId===project.id && task.status!=="archived"); const done=tasks.filter(task=>task.status==="done").length;
  return `<article class="project-card" style="--project-color:${escapeHtml(project.color)}"><div class="inline-actions">${status(project.status)}${project.dueDate?`<span class="tag">${formatDate(project.dueDate)}</span>`:""}</div><h3>${escapeHtml(project.name)}</h3><p>${escapeHtml(project.description||"ゴールを言葉にすると、次の一手が見えてきます。")}</p><div class="progress"><i style="width:${project.progress}%"></i></div><div class="progress-label"><span>進捗</span><strong>${project.progress}%</strong></div><div class="project-meta"><span>${done}/${tasks.length} タスク完了</span><span>${project.folder?"フォルダ連携":"フォルダ未登録"}</span></div><div class="inline-actions" style="margin-top:16px"><button class="button ghost small" data-action="edit-project" data-id="${project.id}">編集</button><button class="button ghost small" data-action="progress-project" data-id="${project.id}">＋10%</button>${project.folder?`<button class="button text small" data-action="open-path" data-path="${encodeURIComponent(project.folder)}">フォルダを開く</button>`:""}${(project.links??[]).map(link=>`<button class="button text small" data-action="open-url" data-url="${encodeURIComponent(link.url)}">${escapeHtml(link.label)}</button>`).join("")}</div></article>`;
}

function renderToday() {
  const name=state.profile.name?`${state.profile.name}さん、`:""; const hour=new Date().getHours(); const greeting=hour<11?"おはようございます":hour<18?"お疲れさまです":"今日も一日、お疲れさまです";
  const focus=state.profile.dailyFocus||"今日いちばん進めたいことを決めましょう。";
  const due=state.tasks.filter(task=>["todo","doing"].includes(task.status) && (!task.dueDate||task.dueDate<=state.computed.today)).slice(0,5);
  const projects=state.projects.filter(project=>project.status==="active").slice(0,3);
  const max=Math.max(1,...state.insights.days.map(day=>day.minutes));
  view.innerHTML=`<div class="hero-grid"><section class="focus-hero"><p class="date">${formatDate(new Date().toISOString(),{weekday:"long",year:"numeric",month:"long",day:"numeric"})}</p><h2>${escapeHtml(name)}${escapeHtml(greeting)}</h2><p class="focus-copy">${escapeHtml(focus)}</p><div class="hero-actions"><button class="button primary" data-action="focus">${state.computed.activeSession?"セッションを完了":"この仕事に集中する"}</button><button class="button ghost" data-action="edit-focus">今日のフォーカスを編集</button><button class="button text" data-action="capture">思いつきを記録</button></div></section><div class="stats-stack"><article class="stat"><span>今日の集中</span><strong>${formatMinutes(state.computed.focusToday)}</strong><small>今週 ${formatMinutes(state.computed.focusWeek)}</small></article><article class="stat"><span>今日までのタスク</span><strong>${state.computed.dueToday}</strong><small>未完了 ${state.computed.openTasks}件</small></article><article class="stat"><span>インボックス</span><strong>${state.computed.openInbox}</strong><small>あとで整理できる場所</small></article><article class="stat"><span>連続記録</span><strong>${state.insights.streak}日</strong><small>小さな前進も記録</small></article></div></div>
  <div class="section-grid"><section class="panel"><div class="panel-heading"><div><h3>いま取り組むこと</h3><p>期限と優先度から、次の行動を集めました。</p></div><button class="button ghost small" data-action="new-task">＋ タスク</button></div><div class="stack-list">${due.length?due.map(taskItem).join(""):empty("✓","今日の必須タスクはありません","新しいタスクを追加するか、プロジェクトを一歩進めましょう。",'<button class="button primary small" data-action="new-task">タスクを追加</button>')}</div></section>
  <section class="panel"><div class="panel-heading"><div><h3>14日間のリズム</h3><p>${state.insights.totalMinutes?`${formatMinutes(state.insights.totalMinutes)}の集中を記録`:"集中セッションを始めると見えてきます"}</p></div></div><div class="chart">${state.insights.days.map((day,index)=>`<i class="chart-bar" style="--height:${Math.max(4,day.minutes/max*100)}%" data-label="${index%2===0?day.date.slice(5).replace("-","/"):""}" title="${day.date}: ${day.minutes}分"></i>`).join("")}</div></section></div>
  <section class="panel" style="margin-top:16px"><div class="panel-heading"><div><h3>進行中のプロジェクト</h3><p>止まっている場所を見つけ、すぐに再開できます。</p></div><button class="button ghost small" data-action="new-project">＋ プロジェクト</button></div><div class="project-grid">${projects.length?projects.map(projectCard).join(""):empty("◇","最初のプロジェクトを始めましょう","目的、期限、フォルダ、タスク、作業ログが一つにつながります。",'<button class="button primary small" data-action="new-project">プロジェクトを開始</button>')}</div></section>
  <div class="section-grid"><section class="panel"><div class="panel-heading"><div><h3>最近の動き</h3><p>PerfectWorkで積み上げた行動です。</p></div></div><div class="timeline">${state.activity.slice(0,7).map(activity=>`<div class="timeline-item"><i class="activity-dot"></i><div><strong>${escapeHtml(activity.title)}</strong><p>${escapeHtml(activity.detail)}</p><time>${relativeTime(activity.at)}</time></div></div>`).join("")||empty("·","まだ記録はありません","クイックキャプチャやタスク追加から始められます。")}</div></section><section class="panel"><div class="panel-heading"><div><h3>システムの状態</h3><p>仕事環境を静かに見守ります。</p></div></div><div class="stack-list"><div class="list-item"><span class="item-icon">⌕</span><div><strong>全文検索</strong><p>${state.search.state==="ready"?`${state.search.files}ファイル · 内容検索 ${state.search.contentFiles}件`:state.search.state==="indexing"?`索引を作成中 · ${state.search.files}件`:"索引を準備できます"}</p></div><button class="icon-button" data-action="go-search">開く</button></div><div class="list-item"><span class="item-icon">✦</span><div><strong>Orbit Organizer</strong><p>${state.organizer?.waiting?`${state.organizer.waiting.items}件を整理できます`:state.organizer?.error?"設定を確認してください":"確認中"}</p></div><button class="icon-button" data-action="orbit">開く</button></div></div></section></div>`;
}

function renderSearch() {
  view.innerHTML=`<div class="search-page"><div class="search-main"><span>⌕</span><input id="pageSearch" type="search" autocomplete="off" placeholder="ファイル名、PDF、Word、Markdown、コードの中身を検索…"><button class="button ghost small" data-action="reindex">索引を更新</button></div><div class="search-meta"><span id="searchStatus">${state.search.state==="indexing"?`索引を作成中 · ${state.search.files}件`:state.search.updatedAt?`${state.search.files}ファイルを検索できます · ${relativeTime(state.search.updatedAt)}更新`:"索引を作成すると内容まで検索できます"}</span><span>対象 ${state.settings.searchRoots.length}フォルダ</span></div><div id="searchResults" class="stack-list">${empty("⌕","知識は、探せると資産になる","言葉を入力すると、ファイル名と対応ファイルの内容を横断検索します。")}</div></div>`;
  $("#pageSearch").focus(); $("#pageSearch").addEventListener("input",event=>{clearTimeout(searchTimer); searchTimer=setTimeout(()=>performSearch(event.target.value),180);});
}
async function performSearch(query) {
  const container=$("#searchResults"); if(!container)return; if(!query.trim()){container.innerHTML=empty("⌕","知識は、探せると資産になる","言葉を入力すると、ファイル名と対応ファイルの内容を横断検索します。");return;}
  container.innerHTML='<div class="empty"><span>···</span><p>検索しています</p></div>';
  try { const response=await request(`/api/search?q=${encodeURIComponent(query)}&limit=100`); searchResults=response.results; container.innerHTML=searchResults.length?searchResults.map(item=>`<article class="list-item search-result" data-action="open-path" data-path="${encodeURIComponent(item.path)}"><span class="item-icon">${item.extension===".pdf"?"P":item.extension===".docx"?"W":"◇"}</span><div><strong>${escapeHtml(item.name)}</strong>${item.snippet?`<p>${escapeHtml(item.snippet)}</p>`:""}<small class="path">${escapeHtml(item.path)} · ${formatBytes(item.size)} · ${formatDate(item.modifiedAt)}</small></div><span class="file-type">${escapeHtml(item.extension)}</span></article>`).join(""):empty("∅","見つかりませんでした","別の言葉に変えるか、索引を更新してください。"); }
  catch(error){container.innerHTML=empty("!","検索できませんでした",error.message);}
}

function renderInbox() {
  const items=state.inbox.filter(item=>currentFilter==="all"||item.status===currentFilter);
  view.innerHTML=`<div class="toolbar"><div class="filters"><button data-action="filter" data-filter="open" class="${currentFilter==="open"?"active":""}">未整理</button><button data-action="filter" data-filter="archived" class="${currentFilter==="archived"?"active":""}">アーカイブ</button><button data-action="filter" data-filter="all" class="${currentFilter==="all"?"active":""}">すべて</button></div><button class="button primary" data-action="capture">＋ キャプチャ</button></div><section class="panel"><div class="panel-heading"><div><h3>${currentFilter==="open"?"まだ行き先を決めなくていい場所":"キャプチャした情報"}</h3><p>タスクやプロジェクトへ変換しても、元の記録はアーカイブに残ります。</p></div><span class="tag">${items.length}件</span></div><div class="stack-list">${items.length?items.map(item=>`<article class="list-item"><span class="item-icon">${item.kind==="idea"?"✦":item.kind==="link"?"↗":"↓"}</span><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.body||item.url||"")}</p><small>${formatDate(item.createdAt,{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})} ${tagsHtml(item.tags)}</small></div><div class="item-actions"><button class="icon-button" data-action="edit-inbox" data-id="${item.id}">編集</button>${item.status==="open"?`<button class="icon-button" data-action="convert-task" data-id="${item.id}">タスクへ</button><button class="icon-button" data-action="convert-project" data-id="${item.id}">PJへ</button><button class="icon-button" data-action="archive-inbox" data-id="${item.id}">完了</button>`:`<button class="icon-button" data-action="restore-inbox" data-id="${item.id}">戻す</button>`}${item.url?`<button class="icon-button" data-action="open-url" data-url="${encodeURIComponent(item.url)}">開く</button>`:""}</div></article>`).join(""):empty("↓","インボックスは空です","気になったことをすぐ置いて、判断はあとに回せます。",'<button class="button primary small" data-action="capture">最初のメモを残す</button>')}</div></section>`;
}

function renderTasks() {
  const items=state.tasks.filter(task=>currentFilter==="all"?task.status!=="archived":currentFilter==="open"?["todo","doing"].includes(task.status):task.status===currentFilter).sort((a,b)=>(b.priority==="high")-(a.priority==="high")||(a.dueDate??"9999").localeCompare(b.dueDate??"9999"));
  view.innerHTML=`<div class="toolbar"><div class="filters"><button data-action="filter" data-filter="open" class="${currentFilter==="open"?"active":""}">未完了</button><button data-action="filter" data-filter="doing" class="${currentFilter==="doing"?"active":""}">進行中</button><button data-action="filter" data-filter="done" class="${currentFilter==="done"?"active":""}">完了</button><button data-action="filter" data-filter="all" class="${currentFilter==="all"?"active":""}">すべて</button></div><button class="button primary" data-action="new-task">＋ タスク</button></div><section class="panel"><div class="panel-heading"><div><h3>次の行動</h3><p>プロジェクトにつながる小さな一歩を明確にします。</p></div><span class="tag">${items.length}件</span></div><div class="stack-list">${items.length?items.map(taskItem).join(""):empty("✓","ここにはタスクがありません","フィルターを変えるか、新しいタスクを追加してください。")}</div></section>`;
}

function renderProjects() {
  const projects=state.projects.filter(project=>currentFilter==="all"?project.status!=="archived":project.status===currentFilter);
  view.innerHTML=`<div class="toolbar"><div class="filters"><button data-action="filter" data-filter="active" class="${currentFilter==="active"?"active":""}">進行中</button><button data-action="filter" data-filter="paused" class="${currentFilter==="paused"?"active":""}">保留</button><button data-action="filter" data-filter="completed" class="${currentFilter==="completed"?"active":""}">完了</button><button data-action="filter" data-filter="all" class="${currentFilter==="all"?"active":""}">すべて</button></div><div class="section-actions"><button class="button ghost" data-action="project-diagnostics">Git状況を更新</button><button class="button primary" data-action="new-project">＋ プロジェクト</button></div></div>${projectHealth?`<section class="panel" style="margin-bottom:16px"><div class="panel-heading"><div><h3>プロジェクト・パルス</h3><p>登録フォルダとGitの現在地です。</p></div></div><div class="stack-list">${projectHealth.map(item=>{const project=state.projects.find(p=>p.id===item.projectId);return `<div class="list-item"><span class="item-icon">${item.exists?"⌘":"!"}</span><div><strong>${escapeHtml(project?.name)}</strong><p>${!item.exists?"登録フォルダが見つかりません":item.git?`${item.git.branch||"detached"} · 変更 ${item.git.changedFiles}件${item.git.lastCommit?` · ${item.git.lastCommit.hash} ${escapeHtml(item.git.lastCommit.message)}`:""}`:"Git未使用"}</p><small class="path">${escapeHtml(item.folder)}</small></div></div>`}).join("")}</div></section>`:""}<div class="project-grid">${projects.length?projects.map(projectCard).join(""):empty("◇","プロジェクトはありません","ゴール、進捗、フォルダ、タスク、作業ログを一つにつなげます。",'<button class="button primary small" data-action="new-project">最初のプロジェクトを作る</button>')}</div>`;
}

function renderWorklog() {
  const logs=state.worklogs.filter(log=>currentFilter==="all"||log.date>=new Date(Date.now()-((currentFilter==="week"?7:30)*86400000)).toISOString().slice(0,10)); const max=Math.max(1,...state.insights.days.map(day=>day.minutes));
  view.innerHTML=`<div class="metric-strip"><article class="metric-card"><span>過去14日</span><strong>${formatMinutes(state.insights.totalMinutes)}</strong><small>集中と手動記録</small></article><article class="metric-card"><span>完了タスク</span><strong>${state.insights.completedTasks}</strong><small>過去14日</small></article><article class="metric-card"><span>継続</span><strong>${state.insights.streak}日</strong><small>成果を記録した日</small></article><article class="metric-card"><span>今週</span><strong>${formatMinutes(state.computed.focusWeek)}</strong><small>集中セッション</small></article></div><div class="section-grid"><section class="panel"><div class="panel-heading"><div><h3>作業の記録</h3><p>「やったこと」が消えず、振り返りと日報になります。</p></div><div class="section-actions"><button class="button ghost small" data-action="export-worklog">Markdown出力</button><button class="button primary small" data-action="new-worklog">＋ 記録</button></div></div><div class="stack-list">${logs.length?logs.slice(0,100).map(log=>`<article class="list-item"><span class="item-icon">${log.source==="focus"?"◷":"✓"}</span><div><strong>${escapeHtml(log.title)}</strong><p>${escapeHtml(log.body)}</p><small>${formatDate(log.date,{year:"numeric",month:"short",day:"numeric"})} · ${formatMinutes(log.minutes)}${log.projectId?` · ${escapeHtml(projectName(log.projectId))}`:""}</small></div></article>`).join(""):empty("◷","まだ作業ログがありません","集中セッションを完了するか、成果を手動で記録してください。")}</div></section><section class="panel"><div class="panel-heading"><div><h3>集中のリズム</h3><p>過去14日</p></div></div><div class="chart">${state.insights.days.map((day,index)=>`<i class="chart-bar" style="--height:${Math.max(4,day.minutes/max*100)}%" data-label="${index%2===0?day.date.slice(5).replace("-","/"):""}" title="${day.minutes}分"></i>`).join("")}</div></section></div>`;
}

function renderAutomations() {
  view.innerHTML=`<div class="toolbar"><p style="color:var(--muted);margin:0">実行前に必ず内容をプレビューし、既存ファイルを上書きしません。</p><button class="button primary" data-action="new-automation">＋ 自動化</button></div><div class="section-grid"><section class="panel"><div class="panel-heading"><div><h3>オートパイロット</h3><p>繰り返す整理や記録を、決めた手順で実行します。</p></div></div><div class="stack-list">${state.automations.map(auto=>`<article class="list-item"><span class="item-icon">⌁</span><div><strong>${escapeHtml(auto.name)}</strong><p>${escapeHtml(auto.description||actionLabels[auto.action])}</p><small>${escapeHtml(actionLabels[auto.action])} · ${escapeHtml(statusLabels[auto.trigger]??auto.trigger)}${auto.lastRunAt?` · 最終実行 ${relativeTime(auto.lastRunAt)}`:""}</small></div><div class="item-actions"><label class="automation-status"><input class="toggle" type="checkbox" data-action="toggle-automation" data-id="${auto.id}" ${auto.enabled?"checked":""} aria-label="${escapeHtml(auto.name)}の自動実行"></label><button class="icon-button" data-action="edit-automation" data-id="${auto.id}">編集</button><button class="button primary small" data-action="preview-automation" data-id="${auto.id}">プレビュー</button></div></article>`).join("")}</div></section><section class="panel"><div class="panel-heading"><div><h3>実行履歴</h3><p>直近の自動化は安全に取り消せます。</p></div></div><div class="stack-list">${state.automationRuns.slice(0,12).map(run=>`<article class="list-item"><span class="item-icon">${run.status==="completed"?"✓":run.status==="failed"?"!":"↶"}</span><div><strong>${escapeHtml(run.name)}</strong><p>${run.error?escapeHtml(run.error):`${run.operations?.length??0}件の操作`}</p><small>${relativeTime(run.createdAt)} · ${status(run.status)}</small></div>${run.status==="completed"?`<button class="icon-button" data-action="undo-automation" data-id="${run.id}">Undo</button>`:""}</article>`).join("")||empty("⌁","実行履歴はありません","プレビューから実行するとここに記録されます。")}</div></section></div>`;
}

function renderHealth() {
  if(!health){view.innerHTML=`<section class="panel">${empty("◉","PCの状態をスキャンします","検索対象フォルダの容量、巨大・古い・重複ファイルを読み取り専用で調べます。削除は行いません。",'<button class="button primary" data-action="scan-health">スキャンを開始</button>')}</section>`;return;}
  const issues=health.largest.length+health.duplicateGroups.length+health.errors.length; const score=Math.max(0,100-Math.min(50,health.duplicateGroups.length*4)-Math.min(30,health.errors.length*5)-Math.min(20,health.largest.length));
  view.innerHTML=`<div class="toolbar"><p style="color:var(--muted);margin:0">${formatDate(health.scannedAt,{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})} · ${health.files}ファイルを確認</p><button class="button ghost" data-action="scan-health">再スキャン</button></div><div class="metric-strip"><article class="metric-card"><span>環境スコア</span><strong class="${score>=80?"health-good":"health-warn"}">${score}</strong><small>情報提供のみ・自動削除なし</small></article><article class="metric-card"><span>確認容量</span><strong>${formatBytes(health.bytes)}</strong><small>${health.files}ファイル</small></article><article class="metric-card"><span>重複候補</span><strong>${health.duplicateGroups.length}</strong><small>${formatBytes(health.duplicateBytes)}を節約可能</small></article><article class="metric-card"><span>巨大ファイル</span><strong>${health.largest.length}</strong><small>${formatBytes(state.settings.healthLargeFileBytes)}以上</small></article></div><div class="section-grid"><section class="panel"><div class="panel-heading"><div><h3>ドライブ容量</h3><p>検索対象があるボリュームの空き容量です。</p></div></div>${health.volumes.map(volume=>{const used=volume.total-volume.free;return `<div class="volume"><div class="progress-label"><span class="path">${escapeHtml(volume.root)}</span><strong>空き ${formatBytes(volume.free)}</strong></div><div class="volume-bar"><i style="width:${Math.min(100,used/volume.total*100)}%"></i></div><small>${formatBytes(used)} / ${formatBytes(volume.total)} 使用</small></div>`}).join("")}</section><section class="panel"><div class="panel-heading"><div><h3>診断サマリー</h3><p>次に確認すると効果が大きい項目です。</p></div></div><div class="health-score"><strong class="${issues?"health-warn":"health-good"}">${issues}</strong><div><h3>${issues?"確認候補があります":"良好です"}</h3><p style="color:var(--muted);margin:0">重複や巨大ファイルは内容を確認してから、エクスプローラーで整理してください。</p></div></div></section></div><div class="section-grid"><section class="panel"><div class="panel-heading"><div><h3>重複ファイル候補</h3><p>サイズとSHA-256が同一のファイルです。</p></div></div><div class="stack-list">${health.duplicateGroups.slice(0,20).map(group=>`<article class="list-item"><span class="item-icon">＝</span><div><strong>${group.files.length}個 · ${formatBytes(group.size)}</strong><p>${group.files.map(file=>escapeHtml(file)).join("<br>")}</p><small>${formatBytes(group.recoverableBytes)}を節約可能</small></div></article>`).join("")||empty("✓","重複候補はありません","確認した範囲では同一内容のファイルは見つかりませんでした。")}</div></section><section class="panel"><div class="panel-heading"><div><h3>巨大ファイル</h3><p>容量の大きい順です。</p></div></div><div class="stack-list">${health.largest.slice(0,20).map(file=>`<article class="list-item"><span class="item-icon">▣</span><div><strong>${escapeHtml(file.name)}</strong><p class="path">${escapeHtml(file.path)}</p><small>${formatBytes(file.size)} · ${formatDate(file.modifiedAt)}</small></div><button class="icon-button" data-action="open-path" data-path="${encodeURIComponent(file.path)}">開く</button></article>`).join("")||empty("✓","巨大ファイルはありません","設定した基準を超えるファイルは見つかりませんでした。")}</div></section></div><section class="panel" style="margin-top:16px"><div class="panel-heading"><div><h3>長期間更新されていないファイル</h3><p>${state.settings.healthStaleDays}日以上前のファイル。必要性を見直す候補です。</p></div><span class="tag">${health.stale.length}件</span></div><div class="stack-list">${health.stale.slice(0,30).map(file=>`<article class="list-item"><span class="item-icon">◷</span><div><strong>${escapeHtml(file.name)}</strong><p class="path">${escapeHtml(file.path)}</p><small>${formatDate(file.modifiedAt,{year:"numeric",month:"short",day:"numeric"})} · ${formatBytes(file.size)}</small></div><button class="icon-button" data-action="open-path" data-path="${encodeURIComponent(file.path)}">開く</button></article>`).join("")||empty("✓","古いファイルはありません","設定した期間を超えるファイルは見つかりませんでした。")}</div></section>`;
  if(health.errors.length)view.insertAdjacentHTML("beforeend",`<section class="panel" style="margin-top:16px"><div class="panel-heading"><div><h3>読み取れなかった場所</h3><p>権限や接続状態を確認してください。ほかの診断結果には影響しません。</p></div><span class="status failed">${health.errors.length}件</span></div><div class="stack-list">${health.errors.map(item=>`<div class="list-item"><span class="item-icon">!</span><div><strong class="path">${escapeHtml(item.path)}</strong><p>${escapeHtml(item.error)}</p></div></div>`).join("")}</div></section>`);
}

function render() {
  if(!state)return; renderHeader();
  if(currentView==="today")renderToday(); else if(currentView==="search")renderSearch(); else if(currentView==="inbox")renderInbox(); else if(currentView==="tasks")renderTasks(); else if(currentView==="projects")renderProjects(); else if(currentView==="worklog")renderWorklog(); else if(currentView==="automations")renderAutomations(); else renderHealth();
}

function navigate(name) { currentView=name; currentFilter=name==="projects"?"active":"open"; $("#sidebar").classList.remove("open"); render(); window.scrollTo({top:0,behavior:"smooth"}); }
document.querySelectorAll("#navigation [data-view]").forEach(button=>button.addEventListener("click",()=>navigate(button.dataset.view)));
$("#mobileMenu").addEventListener("click",()=>$("#sidebar").classList.toggle("open"));

function fillProjectSelect(selector) { $(selector).innerHTML='<option value="">なし</option>'+state.projects.filter(project=>project.status!=="archived").map(project=>`<option value="${project.id}">${escapeHtml(project.name)}</option>`).join(""); }
function openDialog(id) { $(id).showModal(); }
document.querySelectorAll("[data-close]").forEach(button=>button.addEventListener("click",()=>$("#"+button.dataset.close).close()));
$("#captureButton").addEventListener("click",()=>{ $("#captureForm").reset(); $("#captureTitle").textContent="頭の中から、ここへ。"; openDialog("#captureDialog"); setTimeout(()=>$("#captureTitleInput").focus(),20); });

$("#captureForm").addEventListener("submit",async event=>{event.preventDefault();const form=new FormData(event.currentTarget);const data={id:form.get("id"),title:form.get("title"),kind:form.get("kind"),url:form.get("url"),body:form.get("body"),tags:String(form.get("tags")||"").split(/[,、]/).map(value=>value.trim()).filter(Boolean)};const response=await mutate(data.id?"/api/inbox/update":"/api/inbox/create",data,data.id?"インボックスを更新しました":"インボックスに保存しました");if(response)event.currentTarget.closest("dialog").close();});
$("#taskForm").addEventListener("submit",async event=>{event.preventDefault();const form=new FormData(event.currentTarget);const data=Object.fromEntries(form);const response=await mutate(data.id?"/api/task/update":"/api/task/create",data,data.id?"タスクを更新しました":"タスクを追加しました");if(response)event.currentTarget.closest("dialog").close();});
$("#projectForm").addEventListener("submit",async event=>{event.preventDefault();const data=Object.fromEntries(new FormData(event.currentTarget));data.progress=Number(data.progress);data.links=data.linkUrl?[{label:data.linkLabel||"関連リンク",url:data.linkUrl}]:[];delete data.linkLabel;delete data.linkUrl;const response=await mutate(data.id?"/api/project/update":"/api/project/create",data,data.id?"プロジェクトを更新しました":"プロジェクトを開始しました");if(response)event.currentTarget.closest("dialog").close();});
$("#worklogForm").addEventListener("submit",async event=>{event.preventDefault();const response=await mutate("/api/worklog/create",Object.fromEntries(new FormData(event.currentTarget)),"作業ログに記録しました");if(response)event.currentTarget.closest("dialog").close();});
$("#automationForm").addEventListener("submit",async event=>{event.preventDefault();const form=new FormData(event.currentTarget);const response=await mutate("/api/automation/save",{...Object.fromEntries(form),enabled:form.has("enabled")},"自動化を保存しました");if(response)event.currentTarget.closest("dialog").close();});

async function toggleFocus() { if(state.computed.activeSession){const note=prompt("今回できたこと、次にやることを短く残せます（空欄でも完了できます）。","");if(note===null)return;await mutate("/api/focus/stop",{note},"集中セッションを完了しました");}else{await mutate("/api/focus/start",{title:state.profile.dailyFocus||"集中作業"},"集中セッションを開始しました");} }
$("#focusButton").addEventListener("click",toggleFocus);

view.addEventListener("change",async event=>{
  const action=event.target.dataset.action;
  if(action==="toggle-task")await mutate("/api/task/update",{id:event.target.dataset.id,status:event.target.checked?"done":"todo"},event.target.checked?"タスクを完了しました":"未完了に戻しました");
  if(action==="toggle-automation"){const auto=state.automations.find(item=>item.id===event.target.dataset.id);await mutate("/api/automation/save",{...auto,enabled:event.target.checked},event.target.checked?"自動実行を有効にしました":"自動実行を停止しました");}
});

view.addEventListener("click",async event=>{
  const target=event.target.closest("[data-action]"); if(!target)return; const action=target.dataset.action; const itemId=target.dataset.id;
  if(action==="capture")$("#captureButton").click();
  else if(action==="new-task"){$("#taskForm").reset();$("#taskDialogTitle").textContent="タスクを追加";fillProjectSelect("#taskProject");openDialog("#taskDialog");}
  else if(action==="new-project"){$("#projectForm").reset();$("#projectDialogTitle").textContent="プロジェクトを開始";$("#projectForm [name=color]").value="#8b7cff";openDialog("#projectDialog");}
  else if(action==="new-worklog"){ $("#worklogForm").reset(); $("#worklogForm [name=date]").value=state.computed.today; fillProjectSelect("#worklogProject");openDialog("#worklogDialog");}
  else if(action==="new-automation"){ $("#automationForm").reset();$("#automationTitle").textContent="自動化を作成";openDialog("#automationDialog");}
  else if(action==="focus")await toggleFocus();
  else if(action==="edit-focus"){const value=prompt("今日いちばん進めたいことは？",state.profile.dailyFocus);if(value!==null)await mutate("/api/profile",{dailyFocus:value},"今日のフォーカスを更新しました");}
  else if(action==="filter"){currentFilter=target.dataset.filter;render();}
  else if(action==="doing-task"){const task=state.tasks.find(item=>item.id===itemId);await mutate("/api/task/update",{id:itemId,status:task.status==="doing"?"todo":"doing"},"タスクの状態を更新しました");}
  else if(action==="edit-task"){const task=state.tasks.find(item=>item.id===itemId);const form=$("#taskForm");form.reset();fillProjectSelect("#taskProject");for(const key of ["id","title","dueDate","priority","projectId","notes"])form.elements[key].value=task[key]??"";$("#taskDialogTitle").textContent="タスクを編集";openDialog("#taskDialog");}
  else if(action==="archive-task")await mutate("/api/task/update",{id:itemId,status:"archived"},"タスクをアーカイブしました");
  else if(action==="edit-inbox"){const item=state.inbox.find(entry=>entry.id===itemId);const form=$("#captureForm");form.reset();for(const key of ["id","title","kind","url","body"])form.elements[key].value=item[key]??"";form.elements.tags.value=(item.tags??[]).join(", ");$("#captureTitle").textContent="キャプチャを編集";openDialog("#captureDialog");}
  else if(action==="archive-inbox"||action==="restore-inbox")await mutate("/api/inbox/update",{id:itemId,status:action==="archive-inbox"?"archived":"open"},"インボックスを更新しました");
  else if(action==="convert-task"||action==="convert-project")await mutate("/api/inbox/convert",{id:itemId,target:action==="convert-task"?"task":"project"},`${action==="convert-task"?"タスク":"プロジェクト"}へ変換しました`);
  else if(action==="edit-project"){const project=state.projects.find(item=>item.id===itemId);const form=$("#projectForm");form.reset();for(const key of ["id","name","description","dueDate","folder","color","status","progress","notes"])form.elements[key].value=project[key]??"";form.elements.linkLabel.value=project.links?.[0]?.label??"";form.elements.linkUrl.value=project.links?.[0]?.url??"";$("#projectDialogTitle").textContent="プロジェクトを編集";openDialog("#projectDialog");}
  else if(action==="progress-project"){const project=state.projects.find(item=>item.id===itemId);await mutate("/api/project/update",{id:itemId,progress:Math.min(100,project.progress+10),status:project.progress+10>=100?"completed":project.status},"進捗を更新しました");}
  else if(action==="go-search")navigate("search");
  else if(action==="reindex"){loading(true);try{const response=await request("/api/search/reindex",{method:"POST",body:"{}"});state.search=response.status;toast(`${response.status.files}ファイルの索引を更新しました`);render();}catch(error){toast(error.message,true);}finally{loading(false);}}
  else if(action==="scan-health"){loading(true);try{health=await request("/api/health");toast(`${health.files}ファイルを診断しました`);render();}catch(error){toast(error.message,true);}finally{loading(false);}}
  else if(action==="project-diagnostics"){loading(true);try{projectHealth=(await request("/api/projects/diagnostics")).diagnostics;render();}catch(error){toast(error.message,true);}finally{loading(false);}}
  else if(action==="open-path")await mutate("/api/open",{path:decodeURIComponent(target.dataset.path)});
  else if(action==="open-url")await mutate("/api/open",{url:decodeURIComponent(target.dataset.url)});
  else if(action==="orbit")$("#orbitButton").click();
  else if(action==="export-worklog"){const contents=await request("/api/worklog.md");download(`perfectwork-log-${state.computed.today}.md`,contents,"text/markdown;charset=utf-8");}
  else if(action==="preview-automation"){loading(true);try{automationPreview=await request("/api/automation/preview",{method:"POST",body:JSON.stringify({id:itemId})});$("#automationPreviewSummary").textContent=`「${automationPreview.automationName}」は次の操作を行います。`;$("#automationPreviewList").innerHTML=automationPreview.operations.map(operation=>`<div class="list-item"><span class="item-icon">＋</span><div><strong>${escapeHtml(operation.description)}</strong><p class="path">${escapeHtml(operation.path)}</p><small>${formatBytes(operation.bytes)}</small></div></div>`).join("");openDialog("#automationPreviewDialog");}catch(error){toast(error.message,true);}finally{loading(false);}}
  else if(action==="edit-automation"){const automation=state.automations.find(item=>item.id===itemId);const form=$("#automationForm");form.reset();for(const key of ["id","name","description","action","trigger"])form.elements[key].value=automation[key]??"";form.elements.enabled.checked=automation.enabled;$("#automationTitle").textContent="自動化を編集";openDialog("#automationDialog");}
  else if(action==="undo-automation"){if(!confirm("この自動化で作成したファイルを取り消しますか？ 作成後に編集したファイルは残します。"))return;await mutate("/api/automation/undo",{id:itemId},"自動化を取り消しました");}
});

$("#automationRunButton").addEventListener("click",async()=>{if(!automationPreview)return;const response=await mutate("/api/automation/run",{previewId:automationPreview.id},"自動化を実行しました");if(response)$("#automationPreviewDialog").close();});

function openSettings() { const form=$("#settingsForm");form.elements.name.value=state.profile.name;form.elements.accent.value=state.profile.accent;form.elements.searchRoots.value=state.settings.searchRoots.join("\n");form.elements.writeRoot.value=state.settings.writeRoot;form.elements.searchMaxFiles.value=state.settings.searchMaxFiles;form.elements.healthLargeFileMB.value=Math.round(state.settings.healthLargeFileBytes/1024/1024);form.elements.healthStaleDays.value=state.settings.healthStaleDays;openDialog("#settingsDialog"); }
$("#settingsButton").addEventListener("click",openSettings); $("#profileButton").addEventListener("click",openSettings);
$("#settingsForm").addEventListener("submit",async event=>{event.preventDefault();const form=new FormData(event.currentTarget);loading(true);try{const response=await request("/api/settings",{method:"POST",body:JSON.stringify({profile:{name:form.get("name"),accent:form.get("accent")},searchRoots:String(form.get("searchRoots")).split(/\r?\n/).map(value=>value.trim()).filter(Boolean),writeRoot:form.get("writeRoot"),searchMaxFiles:Number(form.get("searchMaxFiles")),healthLargeFileBytes:Number(form.get("healthLargeFileMB"))*1024*1024,healthStaleDays:Number(form.get("healthStaleDays"))})});state=response.state;event.currentTarget.closest("dialog").close();render();toast("設定を保存しました。検索索引を更新してください");}catch(error){toast(error.message,true);}finally{loading(false);}});
$("#exportDataButton").addEventListener("click",async()=>{try{const data=await request("/api/export");download(`perfectwork-backup-${state.computed.today}.json`,`${JSON.stringify(data,null,2)}\n`,"application/json;charset=utf-8");}catch(error){toast(error.message,true);}});
$("#orbitButton").addEventListener("click",async()=>{const response=await mutate("/api/orbit",{});if(response)toast("Orbit Organizerを開きました");});

const commands=[
  {icon:"↓",label:"クイックキャプチャ",hint:"インボックス",run:()=>$("#captureButton").click()}, {icon:"✓",label:"新しいタスク",hint:"タスク",run:()=>{navigate("tasks");setTimeout(()=>view.querySelector('[data-action="new-task"]').click(),0)}},
  {icon:"◇",label:"新しいプロジェクト",hint:"プロジェクト",run:()=>{navigate("projects");setTimeout(()=>view.querySelector('[data-action="new-project"]').click(),0)}}, {icon:"◷",label:"集中セッションを開始／完了",hint:"フォーカス",run:toggleFocus},
  {icon:"⌕",label:"全文検索を開く",hint:"検索",run:()=>navigate("search")}, {icon:"◉",label:"PC診断を開く",hint:"診断",run:()=>navigate("health")}, {icon:"⌁",label:"自動化を開く",hint:"自動化",run:()=>navigate("automations")}, {icon:"✦",label:"Orbit Organizerを開く",hint:"ファイル整理",run:()=>$("#orbitButton").click()},
];
async function renderCommands() {
  const version=++commandSearchVersion; const query=$("#commandInput").value.trim().toLocaleLowerCase("ja"); const matches=commands.filter(command=>command.label.toLocaleLowerCase("ja").includes(query));
  if(query.length>=2){try{commandFiles=(await request(`/api/search?q=${encodeURIComponent(query)}&limit=8`)).results;}catch{commandFiles=[];}}else commandFiles=[];
  if(version!==commandSearchVersion)return;
  const rows=[...matches.map(command=>({type:"command",command})),...commandFiles.map(file=>({type:"file",file}))]; commandIndex=Math.min(commandIndex,Math.max(0,rows.length-1));
  $("#commandResults").innerHTML=rows.map((row,index)=>row.type==="command"?`<button class="command-result ${index===commandIndex?"selected":""}" data-command="${commands.indexOf(row.command)}"><i>${row.command.icon}</i><span>${row.command.label}</span><small>${row.command.hint}</small></button>`:`<button class="command-result ${index===commandIndex?"selected":""}" data-file-path="${encodeURIComponent(row.file.path)}"><i>◇</i><span>${escapeHtml(row.file.name)}</span><small>${escapeHtml(row.file.extension)}</small></button>`).join("")||'<p class="empty-copy">該当するコマンドやファイルがありません</p>';
}
function openCommands(){commandIndex=0;$("#commandInput").value="";renderCommands();$("#commandDialog").showModal();setTimeout(()=>$("#commandInput").focus(),20);}
$("#commandButton").addEventListener("click",openCommands);$("#searchTrigger").addEventListener("click",openCommands);
$("#commandInput").addEventListener("input",renderCommands);$("#commandInput").addEventListener("keydown",event=>{const buttons=[...document.querySelectorAll("#commandResults [data-command],#commandResults [data-file-path]")];if(event.key==="ArrowDown"){event.preventDefault();commandIndex=Math.min(buttons.length-1,commandIndex+1);renderCommands();}else if(event.key==="ArrowUp"){event.preventDefault();commandIndex=Math.max(0,commandIndex-1);renderCommands();}else if(event.key==="Enter"){event.preventDefault();buttons[commandIndex]?.click();}});
$("#commandResults").addEventListener("click",async event=>{const button=event.target.closest("[data-command],[data-file-path]");if(!button)return;$("#commandDialog").close();if(button.dataset.command!==undefined)commands[Number(button.dataset.command)].run();else await mutate("/api/open",{path:decodeURIComponent(button.dataset.filePath)});});
document.addEventListener("keydown",event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"){event.preventDefault();openCommands();}else if(!event.ctrlKey&&!event.metaKey&&!event.altKey&&!document.querySelector("dialog[open]")&&!/input|textarea|select/i.test(event.target.tagName)){if(event.key.toLowerCase()==="n")$("#captureButton").click();else if(/^[1-8]$/.test(event.key))navigate(["today","search","inbox","tasks","projects","worklog","automations","health"][Number(event.key)-1]);}});

setInterval(()=>{if(!state)return;const session=state.computed.activeSession;if(!session){$("#focusClock").textContent="";return;}const minutes=Math.floor((Date.now()-new Date(session.startedAt))/60000);const seconds=Math.floor((Date.now()-new Date(session.startedAt))/1000)%60;$("#focusClock").textContent=`${String(minutes).padStart(2,"0")}:${String(seconds).padStart(2,"0")}`;},1000);

async function start(){loading(true);try{state=await request("/api/state");health=state.health;render();}catch(error){$("#errorBanner").textContent=error.message;$("#errorBanner").hidden=false;toast(error.message,true);}finally{loading(false);}}
start();
