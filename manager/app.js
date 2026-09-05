const token = document.querySelector('meta[name="orbit-token"]').content;
const palette = ["#d9f36a", "#f1aa70", "#83c5be", "#b7a5e8", "#efcf67", "#79acd8", "#e58da7", "#9cc878", "#dc9c73", "#91b7a8"];

let state = null;
let selectedCategory = null;
let selectedItems = new Set();
let dialogResolver = null;
let toastTimer = null;

const $ = (selector) => document.querySelector(selector);
const elements = {
  categoryList: $("#categoryList"),
  categoryTitle: $("#categoryTitle"),
  categoryPath: $("#categoryPath"),
  categoryOrbit: $("#categoryOrbit"),
  extensionChips: $("#extensionChips"),
  patternChips: $("#patternChips"),
  inventoryBody: $("#inventoryBody"),
  emptyState: $("#emptyState"),
  itemCount: $("#itemCount"),
  moveBar: $("#moveBar"),
  selectedCount: $("#selectedCount"),
  moveDestination: $("#moveDestination"),
  selectAll: $("#selectAll"),
  searchInput: $("#searchInput"),
  toast: $("#toast"),
  loading: $("#loading"),
  dialog: $("#textDialog"),
  dialogForm: $("#textDialogForm"),
  dialogEyebrow: $("#dialogEyebrow"),
  dialogTitle: $("#dialogTitle"),
  dialogDescription: $("#dialogDescription"),
  dialogLabel: $("#dialogLabel"),
  dialogInput: $("#dialogInput"),
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}

function formatBytes(bytes) {
  if (bytes == null) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
}

function categoryColor(index) {
  return palette[index % palette.length];
}

function showLoading(visible) {
  elements.loading.classList.toggle("visible", visible);
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.classList.add("visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 3600);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Orbit-Token": token, ...(options.headers ?? {}) },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "処理に失敗しました。");
  return data;
}

async function mutate(path, body, successMessage) {
  showLoading(true);
  try {
    const data = await request(path, { method: "POST", body: JSON.stringify(body) });
    if (data.state) state = data.state;
    render();
    if (successMessage) toast(successMessage);
    return data;
  } catch (error) {
    toast(error.message, true);
    return null;
  } finally {
    showLoading(false);
  }
}

function currentCategory() {
  return state?.categories.find((category) => category.name === selectedCategory) ?? null;
}

function renderOverview() {
  const managed = state.categories.reduce((total, category) => total + category.items.length, 0);
  $("#waitingCount").textContent = `${state.waiting.items}件`;
  $("#waitingSize").textContent = state.waiting.items ? `${formatBytes(state.waiting.bytes)} が整理可能` : "Downloadsは整理済み";
  $("#categoryCount").textContent = `${state.categories.length}種類`;
  $("#managedCount").textContent = `${managed}件`;
  $("#destinationLabel").textContent = state.destination;
  const conflicts = state.conflicts.length;
  $("#conflictCount").textContent = `${conflicts}件`;
  $("#conflictSummary").textContent = conflicts ? "クリックして優先順位を確認" : "競合はありません";
  $("#conflictMetric").classList.toggle("has-conflicts", conflicts > 0);
  const latest = state.latestReassignment;
  $("#undoButton").disabled = !latest || latest.status !== "applied";
  $("#organizeButton").disabled = state.waiting.items === 0;
}

function conflictCard(conflict, conflictIndex) {
  return `<article class="conflict-card">
    <div class="conflict-reason"><i>!</i><span>${escapeHtml(conflict.reason)}</span></div>
    <div class="priority-rules">${conflict.rules.map((rule, ruleIndex) => `
      <div class="priority-rule ${rule.preferred ? "preferred" : ""}">
        <span class="priority-number">${rule.priority}</span>
        <span class="rule-identity"><strong>${escapeHtml(rule.category)}</strong><code>${escapeHtml(rule.pattern)}</code></span>
        <button type="button" data-priority-conflict="${conflictIndex}" data-priority-rule="${ruleIndex}" ${rule.preferred ? "disabled" : ""}>${rule.preferred ? "現在の優先" : "こちらを優先"}</button>
      </div>`).join("")}</div>
  </article>`;
}

function renderConflictList(container, conflicts) {
  container.innerHTML = conflicts.map(conflictCard).join("");
  container.querySelectorAll("[data-priority-conflict]").forEach((button) => button.addEventListener("click", async () => {
    const conflict = conflicts[Number(button.dataset.priorityConflict)];
    const preferred = conflict.rules[Number(button.dataset.priorityRule)];
    const other = conflict.rules.find((rule) => rule !== preferred);
    const data = await mutate("/api/folder-priority", { preferred, other }, `${preferred.category} の「${preferred.pattern}」を優先しました`);
    if (data && $("#conflictDialog").open) renderConflictList($("#newConflictList"), data.conflicts ?? state.conflicts);
  }));
}

function renderConflicts() {
  const visible = state.conflicts.length > 0;
  $("#conflictCenter").classList.toggle("visible", visible);
  $("#conflictTotal").textContent = `${state.conflicts.length}件の競合`;
  renderConflictList($("#conflictList"), state.conflicts);
}

function renderCategories() {
  elements.categoryList.innerHTML = state.categories.map((category, index) => `
    <button class="category-item ${category.name === selectedCategory ? "active" : ""}" type="button" data-category="${encodeURIComponent(category.name)}" style="--dot:${categoryColor(index)}" title="${escapeHtml(category.path)}">
      <i class="category-dot"></i><span>${escapeHtml(category.name)}</span><small>${category.items.length}</small>
    </button>`).join("");
  elements.categoryList.querySelectorAll("[data-category]").forEach((button) => button.addEventListener("click", () => {
    selectedCategory = decodeURIComponent(button.dataset.category);
    selectedItems.clear();
    elements.searchInput.value = "";
    render();
  }));
}

function chip(value, action) {
  return `<span class="chip">${escapeHtml(value)}<button type="button" data-rule-action="${action}" data-rule-value="${encodeURIComponent(value)}" aria-label="${escapeHtml(value)}を削除">×</button></span>`;
}

function renderRules(category) {
  elements.extensionChips.innerHTML = category.extensions.length
    ? category.extensions.map((value) => chip(value, "removeExtension")).join("")
    : '<span class="chip-empty">拡張子ルールはまだありません</span>';
  elements.patternChips.innerHTML = category.folderPatterns.length
    ? category.folderPatterns.map((value) => chip(value, "removeFolderPattern")).join("")
    : '<span class="chip-empty">フォルダルールはまだありません</span>';
  document.querySelectorAll("[data-rule-action]").forEach((button) => button.addEventListener("click", async () => {
    const value = decodeURIComponent(button.dataset.ruleValue);
    await mutate("/api/rule", { action: button.dataset.ruleAction, category: selectedCategory, value }, `${value} をルールから削除しました`);
  }));
}

function filteredItems(category) {
  const term = elements.searchInput.value.trim().toLocaleLowerCase("ja");
  return term ? category.items.filter((item) => item.name.toLocaleLowerCase("ja").includes(term)) : category.items;
}

function renderInventory(category) {
  const items = filteredItems(category);
  elements.itemCount.textContent = category.items.length;
  elements.inventoryBody.innerHTML = items.map((item) => `
    <tr>
      <td class="check-cell"><input type="checkbox" data-item="${encodeURIComponent(item.name)}" ${selectedItems.has(item.name) ? "checked" : ""} aria-label="${escapeHtml(item.name)}を選択"></td>
      <td><div class="item-name"><span class="item-icon">${item.type === "folder" ? "□" : "◇"}</span><span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span></div></td>
      <td><span class="type-label">${item.type === "folder" ? "フォルダ" : "ファイル"}</span></td>
      <td>${formatBytes(item.size)}</td><td>${formatDate(item.modifiedAt)}</td>
    </tr>`).join("");
  elements.emptyState.classList.toggle("visible", items.length === 0);
  elements.inventoryBody.querySelectorAll("[data-item]").forEach((checkbox) => checkbox.addEventListener("change", () => {
    const name = decodeURIComponent(checkbox.dataset.item);
    if (checkbox.checked) selectedItems.add(name); else selectedItems.delete(name);
    renderMoveBar(category);
  }));
  elements.selectAll.checked = items.length > 0 && items.every((item) => selectedItems.has(item.name));
  elements.selectAll.indeterminate = selectedItems.size > 0 && !elements.selectAll.checked;
  renderMoveBar(category);
}

function renderMoveBar(category) {
  elements.selectedCount.textContent = selectedItems.size;
  elements.moveBar.classList.toggle("visible", selectedItems.size > 0);
  const previous = elements.moveDestination.value;
  elements.moveDestination.innerHTML = state.categories.filter((item) => item.name !== category.name)
    .map((item) => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.name)}</option>`).join("");
  if ([...elements.moveDestination.options].some((option) => option.value === previous)) elements.moveDestination.value = previous;
  $("#moveButton").disabled = !elements.moveDestination.value;
}

function renderWorkspace() {
  const category = currentCategory();
  const disabled = !category;
  $("#renameButton").disabled = disabled;
  $("#destinationButton").disabled = disabled;
  $("#deleteButton").disabled = disabled;
  $("#addExtensionButton").disabled = disabled;
  $("#addPatternButton").disabled = disabled;
  if (!category) return;
  const index = state.categories.indexOf(category);
  elements.categoryTitle.textContent = category.name;
  elements.categoryPath.textContent = `${category.path}${category.customDestination ? "  ·  カスタム保存先" : "  ·  既定"}`;
  elements.categoryOrbit.style.setProperty("--category-color", categoryColor(index));
  renderRules(category);
  renderInventory(category);
}

function render() {
  if (!state) return;
  if (!state.categories.some((category) => category.name === selectedCategory)) selectedCategory = state.categories[0]?.name ?? null;
  renderOverview();
  renderConflicts();
  renderCategories();
  renderWorkspace();
}

function openConflictDialog(conflicts) {
  renderConflictList($("#newConflictList"), conflicts);
  $("#conflictDialog").showModal();
}

function closeTextDialog(value) {
  if (!elements.dialog.open) return;
  elements.dialog.close();
  const resolve = dialogResolver;
  dialogResolver = null;
  resolve?.(value);
}

function askText({ eyebrow, title, description, label, value = "", placeholder = "", suggestions = [], browse = false }) {
  if (elements.dialog.open) closeTextDialog(null);
  elements.dialogEyebrow.textContent = eyebrow;
  elements.dialogTitle.textContent = title;
  elements.dialogDescription.textContent = description;
  elements.dialogLabel.textContent = label;
  elements.dialogInput.value = value;
  elements.dialogInput.placeholder = placeholder;
  const suggestionList = $("#folderSuggestions");
  suggestionList.innerHTML = suggestions.map((item) => `<option value="${escapeHtml(item)}"></option>`).join("");
  if (suggestions.length) elements.dialogInput.setAttribute("list", "folderSuggestions");
  else elements.dialogInput.removeAttribute("list");
  $("#dialogBrowse").classList.toggle("visible", browse);
  elements.dialog.showModal();
  setTimeout(() => elements.dialogInput.select(), 30);
  return new Promise((resolve) => { dialogResolver = resolve; });
}

elements.dialogForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = elements.dialogInput.value.trim();
  if (!value) return;
  closeTextDialog(value);
});
$("#dialogClose").addEventListener("click", () => closeTextDialog(null));
$("#dialogCancel").addEventListener("click", () => closeTextDialog(null));
elements.dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeTextDialog(null); });
$("#dialogBrowse").addEventListener("click", async () => {
  $("#dialogBrowse").disabled = true;
  try {
    const data = await request("/api/pick-folder", { method: "POST", body: "{}" });
    if (data.path) elements.dialogInput.value = data.path;
  } catch (error) {
    toast(error.message, true);
  } finally {
    $("#dialogBrowse").disabled = false;
    elements.dialogInput.focus();
  }
});

$("#addCategoryButton").addEventListener("click", async () => {
  const name = await askText({ eyebrow: "NEW DESTINATION", title: "配置先を追加", description: "新規名を入力するか、Documentsにある既存フォルダを選びます。同名フォルダがあれば中身も管理対象になります。", label: "配置先の名前", placeholder: "例：3Dモデル", suggestions: state.availableFolders });
  if (!name) return;
  selectedCategory = name;
  await mutate("/api/category", { action: "create", name }, `${name} を追加しました`);
});

$("#importFolderButton").addEventListener("click", () => $("#addCategoryButton").click());

$("#renameButton").addEventListener("click", async () => {
  const oldName = selectedCategory;
  const newName = await askText({ eyebrow: "RENAME DESTINATION", title: "配置先の名前を変更", description: "ルールと配置済みアイテムをまとめて新しい名前へ移します。", label: "新しい名前", value: oldName });
  if (!newName || newName === oldName) return;
  selectedCategory = newName;
  await mutate("/api/category", { action: "rename", name: oldName, newName }, `${oldName} を ${newName} に変更しました`);
});

$("#destinationButton").addEventListener("click", async () => {
  const category = currentCategory();
  const destination = await askText({
    eyebrow: "DESTINATION FOLDER",
    title: "保存先を変更",
    description: "Documents以外や別ドライブも指定できます。配置済みアイテムは新しい保存先へまとめて安全に移動します。既定へ戻す場合は、Documents内のカテゴリ名フォルダを指定してください。",
    label: "保存先フォルダ",
    value: category.path,
    placeholder: "例：D:\\整理済み\\画像",
    browse: true,
  });
  if (!destination || destination === category.path) return;
  if (!confirm(`「${category.name}」の保存先を次へ変更しますか？\n\n${destination}\n\n配置済みの${category.items.length}件も一緒に移動します。`)) return;
  await mutate("/api/destination", { category: category.name, path: destination }, `${category.name} の保存先を変更しました`);
});

$("#deleteButton").addEventListener("click", async () => {
  const category = currentCategory();
  const detail = category.items.length ? `\n\n${category.items.length}件が入っています。先に別の配置先へ再割り振りしてください。` : "";
  if (!confirm(`「${category.name}」を割り振り設定から削除しますか？${detail}`)) return;
  if (category.items.length) return toast("アイテムが残っている配置先は削除できません。", true);
  const oldName = category.name;
  const response = await mutate("/api/category", { action: "delete", name: oldName }, `${oldName} を削除しました`);
  if (response) { selectedCategory = state.categories[0]?.name ?? null; render(); }
});

$("#addExtensionButton").addEventListener("click", async () => {
  const value = await askText({ eyebrow: "FILE RULE", title: "拡張子を追加", description: `一致するファイルを「${selectedCategory}」へ自動配置します。`, label: "拡張子", placeholder: "例：.blend" });
  if (value) await mutate("/api/rule", { action: "addExtension", category: selectedCategory, value }, `${value} を追加しました`);
});

$("#addPatternButton").addEventListener("click", async () => {
  const value = await askText({ eyebrow: "FOLDER RULE", title: "フォルダ名パターンを追加", description: "* は任意の文字列、? は任意の1文字に一致します。", label: "フォルダ名パターン", placeholder: "例：*Portable*" });
  if (value) {
    const data = await mutate("/api/rule", { action: "addFolderPattern", category: selectedCategory, value }, `${value} を追加しました`);
    if (data?.conflicts?.length) openConflictDialog(data.conflicts);
  }
});

$("#conflictMetric").addEventListener("click", () => {
  if (state?.conflicts.length) $("#conflictCenter").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#conflictDialogClose").addEventListener("click", () => $("#conflictDialog").close());
$("#conflictDialogDone").addEventListener("click", () => $("#conflictDialog").close());
$("#conflictDialog").addEventListener("cancel", (event) => { event.preventDefault(); $("#conflictDialog").close(); });

elements.searchInput.addEventListener("input", () => renderInventory(currentCategory()));
elements.selectAll.addEventListener("change", () => {
  for (const item of filteredItems(currentCategory())) {
    if (elements.selectAll.checked) selectedItems.add(item.name); else selectedItems.delete(item.name);
  }
  renderInventory(currentCategory());
});
$("#clearSelectionButton").addEventListener("click", () => { selectedItems.clear(); renderInventory(currentCategory()); });
$("#moveButton").addEventListener("click", async () => {
  const destination = elements.moveDestination.value;
  const names = [...selectedItems];
  if (!destination || !names.length) return;
  if (!confirm(`${names.length}件を「${selectedCategory}」から「${destination}」へ再割り振りしますか？`)) return;
  const response = await mutate("/api/reassign", { from: selectedCategory, to: destination, names }, `${names.length}件を ${destination} へ移動しました`);
  if (response) { selectedItems.clear(); render(); }
});

$("#undoButton").addEventListener("click", async () => {
  if (!confirm("直近の再割り振りを元に戻しますか？")) return;
  await mutate("/api/undo-reassignment", {}, "直近の再割り振りを元に戻しました");
});

$("#organizeButton").addEventListener("click", async () => {
  if (!state.waiting.items) return toast("Downloadsはすでに整理されています。");
  if (!confirm(`Downloadsの整理待ち${state.waiting.items}件を、現在のルールで配置しますか？`)) return;
  const data = await mutate("/api/organize", {}, null);
  if (data) toast(`${data.result.moved}件を整理しました`);
});

$("#shutdownButton").addEventListener("click", async () => {
  try { await request("/api/shutdown", { method: "POST", body: "{}" }); } catch { /* Server may close first. */ }
  document.body.innerHTML = '<main class="closed"><h1>Orbit Rulesを終了しました</h1><p>このタブは閉じてかまいません。</p></main>';
});

async function start() {
  showLoading(true);
  try {
    state = await request("/api/state");
    selectedCategory = state.categories[0]?.name ?? null;
    render();
  } catch (error) {
    toast(error.message, true);
  } finally {
    showLoading(false);
  }
}

start();
