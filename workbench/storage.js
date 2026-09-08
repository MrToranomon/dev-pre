let storageData = null, storageBusy = false, storageError = '', storageGeneration = 0, storageSignature = '';
let storageGrouping = 'children';
const healthRoots = () => state.settings.healthRoots ?? state.settings.searchRoots;
const storagePercent = value => value == null ? '取得不可' : value > 0 && value < 0.1 ? '0.1%未満' : `${value.toFixed(1)}%`;

function renderHealth() {
  const signature = JSON.stringify(healthRoots());
  if (signature !== storageSignature) {
    storageSignature = signature; storageGeneration++; storageData = null; storageBusy = false; storageError = ''; health = null;
  }
  if (!storageData && !storageBusy && !storageError) queueMicrotask(() => loadStorage());
  renderHealthDetails();
  const data = storageData;
  const rows = data ? (storageGrouping === 'roots' ? data.folders : data.ranking).slice(0, 10) : [];
  view.insertAdjacentHTML('afterbegin', `<div class="storage-overview"><div class="toolbar"><p class="hint" role="status">${storageBusy ? '容量を集計中… 画面を移動しても続行します。' : data ? `${formatDate(data.scannedAt, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}時点` : '容量を読み込みます'}</p><div class="inline-actions"><button class="button ghost" data-action="storage-folders">表示フォルダを選択</button><button class="button ghost" data-action="storage-refresh" ${storageBusy ? 'disabled' : ''}>更新</button></div></div>
    ${storageError ? `<p class="storage-warning" role="alert">${escapeHtml(storageError)} 「更新」で再試行できます。</p>` : ''}
    <section class="panel"><div class="panel-heading"><div><h3>ストレージ使用率</h3><p>選択フォルダがあるドライブ全体。同じドライブは1回だけ表示します。</p></div></div><div class="storage-volumes">${data ? data.volumes.map(disk => `<article class="storage-disk"><div class="folder-usage"><strong>${escapeHtml(disk.root)}</strong><strong>${storagePercent(disk.usedPercent)}</strong></div><progress max="100" value="${disk.usedPercent}" aria-label="${escapeHtml(disk.root)}の使用率"></progress><p>${formatBytes(disk.used)} / ${formatBytes(disk.total)} 使用 <span class="hint">・空き ${formatBytes(disk.free)}</span></p></article>`).join('') || '<p class="hint">ドライブ情報を取得できませんでした。</p>' : '<p class="hint">読み込み中…</p>'}</div></section>
    <section class="panel"><div class="panel-heading"><div><h3>容量の大きいフォルダ <span class="tag">上位10件</span></h3><p>選択範囲内の容量順。割合は、そのドライブの総容量に対する値です。</p></div><div class="filters"><button data-action="storage-group" data-group="children" aria-pressed="${storageGrouping === 'children'}" class="${storageGrouping === 'children' ? 'active' : ''}">直下のフォルダ</button><button data-action="storage-group" data-group="roots" aria-pressed="${storageGrouping === 'roots'}" class="${storageGrouping === 'roots' ? 'active' : ''}">選択フォルダ</button></div></div>
    ${data?.limited || data?.errors.length ? '<p class="storage-warning">一部集計です。上限・読み取りエラーがあるため、順位と容量は確認できた範囲の値です。</p>' : ''}
    <div class="storage-ranking">${rows.map((folder, index) => `<article class="storage-rank"><span class="rank-number">${index+1}</span><div><strong class="path">${escapeHtml(folder.root)}${folder.direct ? '（直下のファイル）' : ''}</strong><small>${folder.files.toLocaleString()}ファイル</small><progress max="100" value="${Math.min(100, folder.percent || 0)}" aria-label="${escapeHtml(folder.root)}の総容量に対する割合"></progress></div><div class="storage-rank-value"><strong>${formatBytes(folder.bytes)}</strong><small>${storagePercent(folder.percent)}</small></div></article>`).join('') || `<p class="hint">${data ? '選択範囲に集計できるファイルはありません。' : 'フォルダ容量を集計しています…'}</p>`}</div>
    <p class="hint">ファイルの論理サイズを集計します。圧縮・クラウドファイル等では実際のディスク使用量と異なります。入れ子の選択範囲は最も内側に計上し、リンク先は追跡しません。</p>
    ${data?.errors.length ? `<details><summary>読み取れなかった場所（${data.errors.length}件）</summary>${data.errors.map(error => `<p class="hint path">${escapeHtml(error.path)}: ${escapeHtml(error.error)}</p>`).join('')}</details>` : ''}</section></div>`);
}

async function loadStorage(refresh = false) {
  if (storageBusy) return;
  const generation = storageGeneration;
  storageBusy = true; storageError = '';
  if (currentView === 'health') render();
  try {
    if (!storageData && !refresh) {
      const cached = await request('/api/storage/cached');
      if (generation !== storageGeneration) return;
      storageData = cached;
      if (currentView === 'health') render();
    }
    const data = await request(`/api/storage${refresh ? '?refresh=1' : ''}`);
    if (generation === storageGeneration) storageData = data;
  } catch (error) { if (generation === storageGeneration) storageError = error.message; }
  finally {
    if (generation === storageGeneration) {
      storageBusy = false;
      if (currentView === 'health') render();
    }
  }
}

function showStorageFolders() {
  if (!$('#storageFoldersDialog')) {
    const dialog = document.createElement('dialog');
    dialog.id = 'storageFoldersDialog'; dialog.setAttribute('aria-labelledby','storageFoldersHeading');
    dialog.innerHTML = `<form id="storageFoldersForm" class="dialog-body"><button class="dialog-close" type="button" id="closeStorageFolders" aria-label="閉じる">×</button><h2 id="storageFoldersHeading">表示フォルダを選択</h2><p class="hint">診断対象を1〜20件選びます。ファイル検索の設定は変わりません。</p><div id="storageFolderChoices" class="storage-folder-choices"></div><button type="button" id="browseStorageFolders" class="button ghost">フォルダを参照…</button><label><span>追加するフォルダの絶対パス（1行に1件）</span><textarea id="storageFolderPaths" rows="3" maxlength="10000"></textarea></label><p class="hint" id="storageFolderError" role="alert"></p><div class="dialog-actions"><button class="button primary" type="submit">保存して表示</button></div></form>`;
    document.body.append(dialog);
    $('#closeStorageFolders').onclick = () => dialog.close();
    $('#browseStorageFolders').hidden = !window.tigerGateDesktop?.chooseFolders;
    $('#browseStorageFolders').onclick = async () => {
      try {
        const paths = await window.tigerGateDesktop.chooseFolders();
        if (paths.length) $('#storageFolderPaths').value = [...new Set([...$('#storageFolderPaths').value.split(/\r?\n/).filter(Boolean), ...paths])].join('\n');
      } catch (error) { $('#storageFolderError').textContent = error.message; }
    };
    $('#storageFoldersForm').onsubmit = async event => {
      event.preventDefault();
      const roots = [...new Set([...document.querySelectorAll('#storageFolderChoices input:checked')].map(input => input.value).concat($('#storageFolderPaths').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean)))];
      if (!roots.length || roots.length > 20) { $('#storageFolderError').textContent = 'フォルダを1〜20件指定してください。'; return; }
      if (await mutate('/api/settings', { healthRoots: roots }, '診断対象を保存しました')) dialog.close();
    };
  }
  const selected = healthRoots();
  $('#storageFolderChoices').innerHTML = [...new Set([...selected, ...state.settings.searchRoots])].map(root => `<label class="check"><input type="checkbox" value="${escapeHtml(root)}" ${selected.includes(root) ? 'checked' : ''}><span class="path">${escapeHtml(root)}</span></label>`).join('');
  $('#storageFolderPaths').value = ''; $('#storageFolderError').textContent = '';
  openDialog('#storageFoldersDialog');
}
document.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  if (target.dataset.action === 'storage-refresh') loadStorage(true);
  if (target.dataset.action === 'storage-folders') showStorageFolders();
  if (target.dataset.action === 'storage-group') { storageGrouping = target.dataset.group; render(); }
});
