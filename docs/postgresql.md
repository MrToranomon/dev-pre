# PerfectWork PostgreSQL構成

## 保存先の役割

| 保存先                                               | 役割                                                       | 正本か                 |
| ---------------------------------------------------- | ---------------------------------------------------------- | ---------------------- |
| PostgreSQL `perfectwork.workspace_state`             | アプリの現在状態。更新はトランザクションで確定             | 正本                   |
| PostgreSQL `perfectwork.workspace_revision`          | 直近100版の状態と変更理由                                  | 復旧履歴               |
| PostgreSQL `perfectwork.entity`                      | タスク等を種類・状態・予定日・期限・プロジェクトで扱う索引 | 正本から再構築可能     |
| `%LOCALAPPDATA%\PerfectWork\workspace.json`          | DB確定後に更新する、人が読める復旧ミラー                   | ミラー                 |
| `%LOCALAPPDATA%\PerfectWork\search-index.json`       | PC内ファイルの全文検索索引                                 | 再生成可能なキャッシュ |
| `%LOCALAPPDATA%\PerfectWork\database-backups\*.dump` | 設定画面から作るPostgreSQLカスタム形式バックアップ         | 手動バックアップ       |

DBへの保存が成功してからJSONミラーを更新します。DBが構成済みなのに接続できない場合はJSONへ勝手に切り替えません。DBとJSONに別々の更新が発生することを防ぐため、起動をエラーにして原因を表示します。緊急時にJSONだけで内容を確認する場合は `npm.cmd run work -- --json-only` を利用できます。このモードで更新した内容はDBへ自動統合されないため、通常運用には使用しません。

## 初回移行

`database.json`があり、DBに状態がまだない場合、起動時に既存の`workspace.json`を1トランザクションで取り込みます。取り込み前に`workspace.before-postgres-<timestamp>.json`を作成します。DBに状態がある場合はDBを優先し、JSONミラーをDBの内容で更新します。

## 認証と権限

- DB: `perfectwork`
- アプリ専用ロール: `perfectwork_app`
- ロール権限: LOGINのみ。スーパーユーザー、ロール作成、DB作成、レプリケーション権限なし
- `PUBLIC`から専用DBへの権限を削除
- パスワード: Windows DPAPIのCurrentUserスコープで暗号化し、`postgres.secret`へ保存
- `postgres.secret`と`database.json`: 現在のWindowsユーザーだけにファイル権限を付与

管理者パスワードやアプリ用パスワードは、リポジトリ、`workspace.json`、ログ、URLへ保存しません。環境変数`PERFECTWORK_DATABASE_URL`を指定した場合は、ローカル設定より優先します。

## コマンド

```powershell
# 初期設定または認証情報の再設定
npm.cmd run setup:postgres

# 接続先・リビジョン・索引件数を表示（パスワードは表示しない）
npm.cmd run db:status

# DBを含む分離統合テスト。専用の一時スキーマを作り、終了時に削除
npm.cmd run test:postgres
```

DBバックアップはPerfectWorkの「設定・バックアップ」から作成できます。復元はアプリとPostgreSQLの停止・データ確認が必要な管理操作なので、自動実行しません。

## A5:SQL Mk-2

Microsoft Store版のA5:SQL Mk-2をインストール後、次のコマンドで「PerfectWork」接続を登録できます。

```powershell
npm.cmd run setup:a5
```

接続情報はA5:SQL Mk-2自身の暗号化ワークスペースへ保存されます。登録前のワークスペースは `%LOCALAPPDATA%\PerfectWork\a5-backups` にコピーします。A5のデータベースツリーから「PerfectWork」を開くと、`perfectwork`スキーマのテーブルに加えて、確認しやすい次のビューを利用できます。

- `v_workspace`: 現在のリビジョンとデータ件数
- `v_tasks`: タスク
- `v_projects`: プロジェクト
- `v_inbox`: メモ・アイデア
- `v_worklogs`: 作業記録
- `v_habits`: 習慣

ビューの`payload`列と`workspace_state.state`列はJSONBです。直接更新するとアプリの整合性を壊す可能性があるため、通常の登録・編集はPerfectWorkの画面から行い、A5は調査、集計、SQL学習、バックアップ内容の確認に使用することを推奨します。
