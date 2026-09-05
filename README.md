# Orbit Organizer ✦

散らかった `Downloads` を、安心して片づけるためのゼロ依存CLIです。

ただ移動するのではなく、**先に全行程を見せる**、**作業中らしいファイルには触れない**、**実行後も一括で戻せる**ことを大切にしています。Node.js だけで動き、ファイル名の衝突時にも既存ファイルを上書きしません。

標準設定では「文書」「画像」「PDF」「インストーラー」「アプリ」などの整理先を `Documents` 直下に作ります。アプリの状態とUndo履歴は `%LOCALAPPDATA%\\Orbit Organizer` に分離するため、Documents に管理用フォルダを増やしません。

デスクトップの「ダウンロード配下整理ツール」をダブルクリックすると、プレビューと確認画面が開きます。コマンドを入力する必要はありません。

## 割り振り管理アプリ

デスクトップの「割り振り管理アプリ」から、整理ルールと配置済みアイテムを画面で管理できます。ブラウザを画面として使いますが、サーバーは `127.0.0.1` のみに公開され、外部通信は行いません。起動ごとにランダムなセッショントークンを発行します。

管理画面では次の操作ができます。

- 配置先カテゴリの追加、名称変更、削除
- カテゴリごとにDocuments以外や別ドライブの保存先を指定
- 新しい拡張子ルールの追加と削除
- `*Portable*` のようなフォルダ名ルールの追加と削除
- フォルダ名ルールの競合検知、原因表示、優先順位の変更
- Documentsにすでにあるフォルダを配置先として登録
- 配置済みファイルやフォルダの検索と複数選択
- 選択したアイテムを別カテゴリへ再割り振り
- 直近の再割り振りをUndo
- 現在のルールでDownloadsを即時整理

カテゴリ名を変更すると、ルールだけでなく配置済みアイテムも一緒に移動します。中身のあるカテゴリは誤操作防止のため削除できません。先に画面上で中身を別カテゴリへ再割り振りしてください。同名ファイルがある場合は通常整理と同様に `(2)` を付け、既存ファイルを守ります。

新しく作るカテゴリの保存先は、既定では `Documents\\カテゴリ名` です。カテゴリを選択して「保存先を変更」を押すと、Pictures、Music、外付けドライブなど任意のフォルダへ変更できます。「参照...」からWindowsのフォルダ選択画面も利用できます。変更時には、そのカテゴリへ配置済みのアイテムも新しい場所へ移動します。

フォルダ名パターンが複数の配置先に一致する場合は、登録直後に競合画面を表示します。初期優先順位は、完全一致、固定文字が多い具体的なパターン、広いワイルドカードの順です。競合画面またはホームの「ルール競合センター」で優先する側を選べます。優先順位の変更は次回の整理から反映され、配置済みアイテムは自動移動しません。

コマンドから開く場合は次を使えます。

```powershell
npm.cmd run manage
```

## まず使う

```powershell
npm run preview
```

表示された Flight plan を確認し、問題がなければ実行します。

```powershell
npm run apply
```

直前の実行を取り消すには次を使います。

```powershell
npm run undo
```

PowerShell の実行ポリシーで `npm` が止められる環境では、`npm.cmd run preview` のように `npm.cmd` を使うか、`node organize.mjs preview` を直接実行できます。

## コマンド

| コマンド | 役割 |
|---|---|
| `npm run preview` | 移動予定、カテゴリ別件数、容量、保留理由を表示します。ファイルは変更しません |
| `npm run apply` | 同じ安全チェックをもう一度行い、ファイルを移動してUndo履歴を残します |
| `npm run undo` | 直近の未取消バッチを元のフォルダへ戻します |
| `npm run history` | 直近10回の実行日時、状態、件数、容量を表示します |
| `npm run doctor` | 設定、元フォルダ、読み取り権限、安全なパス構成を診断します |
| `npm test` | 安全性を含む自動テストを実行します |

全件表示は `node organize.mjs preview --all`、自動化向けJSONは `node organize.mjs preview --json`、別設定の試用は `node organize.mjs preview --config my-config.json` です。

## 安全設計

- Preview が標準動作です。明示的に `apply` するまで移動しません。
- シンボリックリンク、未知の種類、登録されていないフォルダには触れません。
- インストーラー形式は明示的に許可した場合だけ整理し、スクリプトなどその他の実行形式は引き続き拒否します。
- ポータブルアプリのフォルダは、`folderCategories` に登録された名前だけを移動します。
- `~$*`、`.crdownload`、`.part`、`.tmp` などOfficeロック・ダウンロード途中・一時ファイルを保留します。
- 更新後1分未満のファイルは、まだ書き込み中かもしれないため保留します。
- Preview 後にサイズや更新日時が変わったファイルは、Apply 時に移動しません。
- 同名ファイルがあれば `report (2).pdf` のような新しい名前を選び、上書きしません。
- 別ドライブへの移動にも対応し、コピー失敗時は元ファイルを残します。
- 実行前にジャーナルを作り、実行履歴を移動先の `.file-organizer/history` に保存します。途中で停止してもUndoで回収できます。
- 二重実行ロックと上書き不能な移動処理により、並行実行や確認後の競合から既存ファイルを守ります。
- Undo 時に元の名前がすでに使われていた場合も上書きせず、`(restored 2)` を付けます。

## ルールを変える

`config.json` で元フォルダ、移動先、カテゴリ、挙動を設定できます。パス内の `%USERPROFILE%` などのWindows環境変数は実行時に展開されます。

```json
{
  "source": "%USERPROFILE%\\Downloads",
  "destination": "%USERPROFILE%\\Documents",
  "categories": {
    "PDF": [".pdf"],
    "画像": [".jpg", ".png", ".webp"],
    "インストーラー": [".exe", ".msi", ".msix"]
  },
  "folderCategories": {
    "アプリ": ["clibor", "Office_Tool*"]
  },
  "categoryDestinations": {
    "画像": "%USERPROFILE%\\Pictures\\整理済み"
  },
  "options": {
    "minimumAgeMinutes": 1,
    "dateFolders": "none",
    "includeUnknown": false,
    "allowInstallerFiles": true,
    "unknownCategory": "Other",
    "maxPreviewItems": 40,
    "stateDirectory": "%LOCALAPPDATA%\\Orbit Organizer",
    "ignore": ["~$*", "*.crdownload", "*.part", "*.tmp"]
  }
}
```

`dateFolders` は `"none"`、`"year"`、`"month"` から選べます。`"month"` にすると `Images/2026-09/photo.jpg` のように整理します。`includeUnknown` を `true` にすると、未登録の種類も `unknownCategory` へ送れます。

危険な実行形式は、設定に書いても拒否されます。カテゴリ名はフォルダ1階層分だけを指定でき、移動先を元フォルダの内側にする設定も拒否されます。

## 設計思想

Orbit Organizer は「勝手に賢く片づける」より、「何をするか明快で、失敗しても戻れる」ことを選びます。定期実行や細かな分類に拡張しても、この透明性と可逆性は崩さない方針です。
