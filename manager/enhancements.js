let preview = null;
let previewSelection = new Set();
const reasons = { ignored: "除外パターンに一致", link: "リンクのため保留", folder: "フォルダルールが未登録", recent: "更新直後のため待機中", protected: "保護された実行形式", unknown: "拡張子ルールが未登録", unsupported: "未対応の形式", missing: "ファイルが見つかりません", unreadable: "読み取れません", "changed since preview": "確認後に更新されました", "changed during apply": "実行中に更新されました" };
const statusLabels = { applied: "整理済み", applying: "中断・復旧待ち", undone: "取り消し済み", "partially-undone": "一部未復旧", empty: "移動なし" };

document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));
$("#conflictMetric").addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); event.currentTarget.click(); } });
document.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !document.querySelector("dialog[open]") && !busy) {
    event.preventDefault(); elements.searchInput.focus(); elements.searchInput.select();
  }
});
for (const id of ["#sortOrder", "#typeFilter"]) $(id).addEventListener("change", () => renderInventory(currentCategory()));

async function loadView(action) {
  if (busy) return;
  showLoading(true);
  try { await action(); $("#errorBanner").hidden = true; }
  catch (error) { toast(error.message, true); $("#errorBanner").textContent = error.message; $("#errorBanner").hidden = false; }
  finally { showLoading(false); }
}

$("#refreshButton").addEventListener("click", () => loadView(async () => {
  state = await request("/api/state"); render(); toast("最新の状態に更新しました");
}));

function downloadFile(name, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a"); link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function previewItems() {
  const term = $("#previewSearch").value.trim().toLocaleLowerCase("ja");
  return (preview?.planned ?? []).filter(item => `${item.name} ${item.category} ${item.target}`.toLocaleLowerCase("ja").includes(term));
}

function renderPreview() {
  const items = previewItems();
  const chosen = preview.planned.filter(item => previewSelection.has(item.name));
  $("#previewSummary").textContent = `${preview.planned.length}件が整理可能 / ${chosen.length}件を選択 · ${formatBytes(chosen.reduce((sum, item) => sum + item.size, 0))}`;
  $("#previewList").innerHTML = items.length ? items.map(item => `<label class="preview-item"><input type="checkbox" data-preview-name="${encodeURIComponent(item.name)}" ${previewSelection.has(item.name) ? "checked" : ""}><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.category)} · ${formatBytes(item.size)}${item.type === "directory" ? " · フォルダ" : ""}</small><span class="path-line">→ ${escapeHtml(item.target)}</span></span></label>`).join("") : '<p class="empty-copy">該当する移動予定はありません。保留理由や検索条件をご確認ください。</p>';
  $("#previewList").querySelectorAll("[data-preview-name]").forEach(input => input.addEventListener("change", () => {
    const name = decodeURIComponent(input.dataset.previewName);
    if (input.checked) previewSelection.add(name); else previewSelection.delete(name);
    updatePreviewSelection();
  }));
  updatePreviewSelection();
}

function updatePreviewSelection() {
  const chosen = preview.planned.filter(item => previewSelection.has(item.name));
  const visible = previewItems();
  $("#previewSummary").textContent = `${preview.planned.length}件が整理可能 / ${chosen.length}件を選択 · ${formatBytes(chosen.reduce((sum, item) => sum + item.size, 0))}`;
  $("#applyPreviewButton").disabled = !chosen.length;
  $("#applyPreviewButton").textContent = `${chosen.length}件を整理する`;
  $("#previewSelectAll").checked = visible.length > 0 && visible.every(item => previewSelection.has(item.name));
  $("#previewSelectAll").indeterminate = visible.some(item => previewSelection.has(item.name)) && !$("#previewSelectAll").checked;
}

async function openPreview() {
  await loadView(async () => {
    preview = await request("/api/preview");
    previewSelection = new Set(preview.planned.map(item => item.name));
    $("#previewSearch").value = "";
    $("#skippedSummary").textContent = `${preview.skipped.length}件を保留しています（理由を表示）`;
    $("#skippedList").innerHTML = preview.skipped.map(item => `<div class="detail-row"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(reasons[item.reason] ?? item.reason)}</span></div>`).join("");
    $("#skippedDetails").open = !preview.planned.length && preview.skipped.length > 0;
    renderPreview(); $("#previewDialog").showModal();
  });
}
$("#previewSearch").addEventListener("input", renderPreview);
$("#previewSelectAll").addEventListener("change", event => {
  for (const item of previewItems()) { if (event.target.checked) previewSelection.add(item.name); else previewSelection.delete(item.name); }
  renderPreview();
});
$("#applyPreviewButton").addEventListener("click", async () => {
  const result = await mutate("/api/organize", { previewId: preview.id, names: [...previewSelection] });
  if (!result) return;
  $("#previewDialog").close();
  const skipped = result.result.notMoved ?? [];
  toast(`${result.result.moved}件を整理しました${skipped.length ? ` · ${skipped.length}件は更新などのため保留` : "。履歴から元に戻せます"}`);
  if (skipped.length) { $("#errorBanner").hidden = false; $("#errorBanner").textContent = skipped.map(item => `${item.name}: ${reasons[item.reason] ?? item.reason}`).join(" / "); }
});
$("#exportPreviewButton").addEventListener("click", () => {
  const cell = value => `"${String(value).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
  const rows = [["名前", "配置先", "移動元", "移動先", "バイト", "選択"], ...preview.planned.map(item => [item.name, item.category, item.source, item.target, item.size, previewSelection.has(item.name) ? "選択" : "除外"])];
  downloadFile("orbit-preview.csv", "\ufeff" + rows.map(row => row.map(cell).join(",")).join("\r\n"), "text/csv;charset=utf-8");
});

async function refreshHistory() {
  const { records } = await request("/api/history");
  $("#undoOrganizeButton").disabled = !records.some(record => ["applied", "applying", "partially-undone"].includes(record.status));
  $("#historyList").innerHTML = records.length ? records.map(record => `<details class="history-card"><summary><span><strong>${escapeHtml(new Date(record.appliedAt).toLocaleString("ja-JP"))}</strong><small>${record.items}件 · ${formatBytes(record.bytes)}</small></span><span class="status-tag">${escapeHtml(statusLabels[record.status] ?? record.status)}</span></summary><div class="detail-list">${record.error ? `<p class="inline-error">${escapeHtml(record.error)}</p>` : ""}${record.moves.map(move => `<div class="detail-row"><span class="path-line">${escapeHtml(move.from)}</span><span class="path-line">→ ${escapeHtml(move.to)}</span></div>`).join("")}${[...record.notMoved, ...record.undoSkipped].map(item => `<div class="detail-row"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(reasons[item.reason] ?? item.reason)}</span></div>`).join("")}</div></details>`).join("") : '<p class="empty-copy">まだ整理履歴がありません。整理するとここに記録されます。</p>';
}
$("#historyButton").addEventListener("click", () => loadView(async () => { await refreshHistory(); $("#historyDialog").showModal(); }));
$("#undoOrganizeButton").addEventListener("click", async () => {
  if (!confirm("直近の整理を元に戻しますか？ 同名がある場合は別名で復元します。")) return;
  const data = await mutate("/api/undo-organize", {});
  if (!data) return;
  toast(data.record ? `${data.record.restored.length}件を復元しました${data.record.undoSkipped.length ? ` · ${data.record.undoSkipped.length}件は未復旧` : ""}` : "取り消せる整理はありません");
  await loadView(refreshHistory);
});

$("#settingsButton").addEventListener("click", () => {
  if (!state) return;
  const options = state.options;
  $("#minimumAge").value = options.minimumAgeMinutes;
  $("#dateFolders").value = options.dateFolders;
  $("#includeUnknown").checked = options.includeUnknown;
  $("#unknownCategory").value = options.unknownCategory;
  $("#allowInstallers").checked = options.allowInstallerFiles;
  $("#ignorePatterns").value = options.ignore.join("\n");
  $("#settingsError").textContent = "";
  $("#settingsDialog").showModal();
});
$("#settingsForm").addEventListener("submit", async event => {
  event.preventDefault();
  const data = await mutate("/api/options", {
    minimumAgeMinutes: Number($("#minimumAge").value), dateFolders: $("#dateFolders").value,
    includeUnknown: $("#includeUnknown").checked, unknownCategory: $("#unknownCategory").value.trim(),
    allowInstallerFiles: $("#allowInstallers").checked,
    ignore: $("#ignorePatterns").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
  }, "整理設定を保存しました");
  if (data) $("#settingsDialog").close();
  else $("#settingsError").textContent = $("#errorBanner").textContent;
});
$("#exportConfigButton").addEventListener("click", () => loadView(async () => {
  const config = await request("/api/config");
  downloadFile("orbit-config.json", JSON.stringify(config, null, 2) + "\n", "application/json");
}));

const checkLabels = { "Configuration is valid": "設定の形式", "Source folder exists": "整理元フォルダ", "Source folder is readable": "整理元の読み取り権限", "Destination can be written": "保存先の書き込み権限", "Destination is safely separated": "整理元と保存先の分離", "Every extension has one category": "拡張子ルールの一意性", "History files are readable": "履歴ファイルの整合性", "Paths do not traverse links": "リンクを経由しないパス", "No other apply is holding the lock": "実行ロック" };
$("#doctorButton").addEventListener("click", () => loadView(async () => {
  const { checks } = await request("/api/doctor");
  $("#doctorList").innerHTML = checks.map(check => `<div class="detail-row ${check.ok ? "" : "inline-error"}"><strong>${check.ok ? "✓" : "!"} ${escapeHtml(checkLabels[check.label] ?? check.label)}</strong><span>${check.ok ? "正常" : escapeHtml(check.detail)}</span></div>`).join("");
  $("#doctorDialog").showModal();
}));
