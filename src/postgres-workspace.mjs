import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { exists } from "./safety.mjs";

const { Pool } = pg;
const SCHEMA_VERSION = 2;

async function findPgDump(environment = process.env) {
  const candidates = [environment.PERFECTWORK_PG_DUMP];
  if (process.platform === "win32") {
    const base = "C:\\Program Files\\PostgreSQL";
    try {
      const versions = (await fs.readdir(base)).sort(
        (a, b) => Number(b) - Number(a),
      );
      candidates.push(
        ...versions.map((version) =>
          path.join(base, version, "bin", "pg_dump.exe"),
        ),
      );
    } catch {}
  } else candidates.push("pg_dump");
  for (const candidate of candidates.filter(Boolean)) {
    if (candidate === "pg_dump" || (await exists(candidate))) return candidate;
  }
  throw new Error(
    "pg_dumpが見つかりません。PERFECTWORK_PG_DUMPを設定してください。",
  );
}

function decryptWindowsSecret(file) {
  if (process.platform !== "win32")
    throw new Error(
      "暗号化されたPostgreSQL認証情報はWindowsでのみ復号できます。PERFECTWORK_DATABASE_URLを設定してください。",
    );
  const script = `$ErrorActionPreference='Stop';$secure=(Get-Content -Raw -LiteralPath $env:PERFECTWORK_SECRET_FILE).Trim()|ConvertTo-SecureString;$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, PERFECTWORK_SECRET_FILE: file },
      maxBuffer: 16_384,
    },
  );
  if (result.status !== 0 || !result.stdout)
    throw new Error(
      `PostgreSQL認証情報を復号できません。${result.stderr?.trim() || "認証情報を再設定してください。"}`,
    );
  return result.stdout;
}

export async function postgresConfiguration(
  directory,
  environment = process.env,
) {
  if (environment.PERFECTWORK_DATABASE_URL)
    return {
      connectionString: environment.PERFECTWORK_DATABASE_URL,
      source: "environment",
    };
  const file = path.join(directory, "database.json");
  if (!(await exists(file))) return null;
  let config;
  try {
    config = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    throw new Error(
      `PostgreSQL設定を読み取れません: ${file} (${error.message})`,
    );
  }
  const host = String(config.host || "127.0.0.1"),
    port = Number(config.port || 5432),
    database = String(config.database || "perfectwork"),
    user = String(config.user || "perfectwork_app"),
    schema = String(config.schema || "perfectwork");
  if (
    !/^[a-zA-Z0-9_.-]+$/.test(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^[a-zA-Z0-9_]+$/.test(database) ||
    !/^[a-zA-Z0-9_]+$/.test(user) ||
    !/^[a-zA-Z0-9_]+$/.test(schema)
  )
    throw new Error("PostgreSQL接続設定が正しくありません。");
  const secretFile = path.resolve(
    directory,
    config.secretFile || "postgres.secret",
  );
  if (!(await exists(secretFile)))
    throw new Error(`PostgreSQL認証情報がありません: ${secretFile}`);
  return {
    host,
    port,
    database,
    user,
    schema,
    password: decryptWindowsSecret(secretFile),
    ssl: config.ssl === true,
    source: file,
    secretFile,
  };
}

function entityRows(state) {
  const rows = [];
  const add = (type, item, title, body = "") =>
    rows.push({
      type,
      id: item.id,
      title,
      body,
      status: item.status ?? (item.archived ? "archived" : null),
      projectId: item.projectId ?? null,
      dueDate: item.dueDate ?? null,
      scheduledDate: item.scheduledDate ?? null,
      updatedAt: item.updatedAt ?? item.createdAt ?? new Date().toISOString(),
      payload: item,
    });
  for (const item of state.tasks ?? [])
    add(
      "task",
      item,
      item.title,
      `${item.notes ?? ""}\n${(item.checklist ?? []).map((entry) => entry.title).join("\n")}`,
    );
  for (const item of state.projects ?? [])
    add(
      "project",
      item,
      item.name,
      `${item.description ?? ""}\n${item.notes ?? ""}`,
    );
  for (const item of state.inbox ?? [])
    add(
      "inbox",
      item,
      item.title,
      `${item.body ?? ""}\n${item.url ?? ""}\n${(item.tags ?? []).join(" ")}`,
    );
  for (const item of state.worklogs ?? [])
    add("worklog", item, item.title, item.body ?? "");
  for (const item of state.habits ?? []) add("habit", item, item.name);
  for (const item of state.automations ?? [])
    add("automation", item, item.name, item.description ?? "");
  return rows;
}

export class PostgresWorkspaceRepository {
  constructor(config) {
    this.config = config;
    const schema = String(config.schema || "perfectwork");
    if (!/^[a-zA-Z0-9_]+$/.test(schema))
      throw new Error("PostgreSQLスキーマ名が正しくありません。");
    this.schema = `"${schema}"`;
    this.pool = new Pool({
      ...config,
      application_name: "PerfectWork",
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    this.pool.on("error", (error) =>
      process.stderr.write(`PostgreSQL pool error: ${error.message}\n`),
    );
  }

  async init() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(727364928301)");
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this.schema}.schema_version (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this.schema}.workspace_state (id smallint PRIMARY KEY CHECK (id = 1), revision bigint NOT NULL, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this.schema}.workspace_revision (revision bigint PRIMARY KEY, reason text NOT NULL, state jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this.schema}.entity (entity_type text NOT NULL, entity_id text NOT NULL, title text NOT NULL, body text NOT NULL DEFAULT '', status text, project_id text, due_date date, scheduled_date date, updated_at timestamptz NOT NULL, payload jsonb NOT NULL, PRIMARY KEY (entity_type, entity_id))`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS entity_project_idx ON ${this.schema}.entity(project_id) WHERE project_id IS NOT NULL`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS entity_due_idx ON ${this.schema}.entity(due_date) WHERE due_date IS NOT NULL`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS entity_scheduled_idx ON ${this.schema}.entity(scheduled_date) WHERE scheduled_date IS NOT NULL`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS entity_payload_idx ON ${this.schema}.entity USING gin(payload jsonb_path_ops)`,
      );
      await client.query(
        `CREATE OR REPLACE VIEW ${this.schema}.v_workspace AS
         SELECT revision, updated_at,
           jsonb_array_length(COALESCE(state->'tasks', '[]'::jsonb)) AS task_count,
           jsonb_array_length(COALESCE(state->'projects', '[]'::jsonb)) AS project_count,
           jsonb_array_length(COALESCE(state->'inbox', '[]'::jsonb)) AS inbox_count,
           jsonb_array_length(COALESCE(state->'worklogs', '[]'::jsonb)) AS worklog_count
         FROM ${this.schema}.workspace_state WHERE id = 1`,
      );
      await client.query(
        `CREATE OR REPLACE VIEW ${this.schema}.v_tasks AS
         SELECT entity_id AS id, title, status, project_id, due_date, scheduled_date,
           NULLIF(payload->>'priority', '')::integer AS priority,
           NULLIF(payload->>'estimateMinutes', '')::integer AS estimate_minutes,
           payload->>'completedAt' AS completed_at, updated_at, payload
         FROM ${this.schema}.entity WHERE entity_type = 'task'`,
      );
      await client.query(
        `CREATE OR REPLACE VIEW ${this.schema}.v_projects AS
         SELECT entity_id AS id, title AS name, status,
           NULLIF(payload->>'progress', '')::integer AS progress,
           payload->>'dueDate' AS due_date, payload->>'folder' AS folder,
           updated_at, payload
         FROM ${this.schema}.entity WHERE entity_type = 'project'`,
      );
      await client.query(
        `CREATE OR REPLACE VIEW ${this.schema}.v_inbox AS
         SELECT entity_id AS id, title, body, payload->>'url' AS url,
           COALESCE(payload->'tags', '[]'::jsonb) AS tags,
           (payload->>'favorite')::boolean AS favorite,
           (payload->>'archived')::boolean AS archived, updated_at, payload
         FROM ${this.schema}.entity WHERE entity_type = 'inbox'`,
      );
      await client.query(
        `CREATE OR REPLACE VIEW ${this.schema}.v_worklogs AS
         SELECT entity_id AS id, title, project_id,
           payload->>'date' AS work_date,
           NULLIF(payload->>'minutes', '')::integer AS minutes,
           body, updated_at, payload
         FROM ${this.schema}.entity WHERE entity_type = 'worklog'`,
      );
      await client.query(
        `CREATE OR REPLACE VIEW ${this.schema}.v_habits AS
         SELECT entity_id AS id, title AS name,
           (payload->>'archived')::boolean AS archived,
           COALESCE(payload->'days', '[]'::jsonb) AS completed_days,
           updated_at, payload
         FROM ${this.schema}.entity WHERE entity_type = 'habit'`,
      );
      await client.query(
        `INSERT INTO ${this.schema}.schema_version(version) VALUES($1) ON CONFLICT DO NOTHING`,
        [SCHEMA_VERSION],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`PostgreSQLの初期化に失敗しました: ${error.message}`);
    } finally {
      client.release();
    }
    return this;
  }

  async load() {
    const result = await this.pool.query(
      `SELECT revision, state FROM ${this.schema}.workspace_state WHERE id = 1`,
    );
    return result.rows[0]
      ? {
          revision: Number(result.rows[0].revision),
          state: result.rows[0].state,
        }
      : null;
  }

  async initialize(state, reason = "Initial JSON import") {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(727364928301)");
      const inserted = await client.query(
        `INSERT INTO ${this.schema}.workspace_state(id, revision, state) VALUES(1, 1, $1::jsonb) ON CONFLICT DO NOTHING RETURNING revision`,
        [JSON.stringify(state)],
      );
      if (inserted.rowCount) {
        await client.query(
          `INSERT INTO ${this.schema}.workspace_revision(revision, reason, state) VALUES(1, $1, $2::jsonb)`,
          [reason, JSON.stringify(state)],
        );
        await this.#replaceEntities(client, state);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return this.load();
  }

  async save(state, expectedRevision, reason = "Workspace update") {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(727364928301)");
      const updated = await client.query(
        `UPDATE ${this.schema}.workspace_state SET revision = revision + 1, state = $1::jsonb, updated_at = now() WHERE id = 1 AND revision = $2 RETURNING revision`,
        [JSON.stringify(state), expectedRevision],
      );
      if (!updated.rowCount)
        throw Object.assign(
          new Error(
            "PostgreSQL上のデータが別の接続で更新されました。PerfectWorkを開き直してください。",
          ),
          { code: "PERFECTWORK_REVISION_CONFLICT" },
        );
      const revision = Number(updated.rows[0].revision);
      await client.query(
        `INSERT INTO ${this.schema}.workspace_revision(revision, reason, state) VALUES($1, $2, $3::jsonb)`,
        [revision, reason, JSON.stringify(state)],
      );
      await this.#replaceEntities(client, state);
      await client.query(
        `DELETE FROM ${this.schema}.workspace_revision WHERE revision < $1`,
        [Math.max(1, revision - 99)],
      );
      await client.query("COMMIT");
      return revision;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async #replaceEntities(client, state) {
    await client.query(`DELETE FROM ${this.schema}.entity`);
    for (const row of entityRows(state))
      await client.query(
        `INSERT INTO ${this.schema}.entity(entity_type, entity_id, title, body, status, project_id, due_date, scheduled_date, updated_at, payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [
          row.type,
          row.id,
          row.title,
          row.body,
          row.status,
          row.projectId,
          row.dueDate,
          row.scheduledDate,
          row.updatedAt,
          JSON.stringify(row.payload),
        ],
      );
  }

  async status() {
    const result = await this.pool.query(
      `SELECT current_database() AS database, current_user AS "user", current_setting('server_version') AS version, (SELECT revision FROM ${this.schema}.workspace_state WHERE id=1) AS revision, (SELECT count(*)::integer FROM ${this.schema}.entity) AS entities`,
    );
    return {
      backend: "postgresql",
      connected: true,
      schema: this.config.schema || "perfectwork",
      ...result.rows[0],
      revision: Number(result.rows[0].revision ?? 0),
    };
  }

  async backup(
    directory = path.join(
      os.homedir(),
      "Documents",
      "PerfectWork",
      "Database Backups",
    ),
  ) {
    await fs.mkdir(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(directory, `perfectwork-${stamp}.dump`);
    const command = await findPgDump();
    const args = [
      "--format=custom",
      "--no-owner",
      "--no-acl",
      "--file",
      target,
    ];
    let backupPassword = this.config.password;
    if (this.config.connectionString) {
      const url = new URL(this.config.connectionString);
      backupPassword = decodeURIComponent(url.password);
      args.push(
        "--host",
        url.hostname,
        "--port",
        url.port || "5432",
        "--username",
        decodeURIComponent(url.username),
        "--dbname",
        url.pathname.slice(1),
      );
    } else
      args.push(
        "--host",
        this.config.host,
        "--port",
        String(this.config.port),
        "--username",
        this.config.user,
        "--dbname",
        this.config.database,
      );
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          ...(backupPassword ? { PGPASSWORD: backupPassword } : {}),
        },
      });
      let errorOutput = "";
      child.stderr.on("data", (chunk) => {
        errorOutput += chunk;
        if (errorOutput.length > 20_000)
          errorOutput = errorOutput.slice(-20_000);
      });
      child.once("error", reject);
      child.once("close", async (code) => {
        if (code !== 0)
          return reject(
            new Error(
              `PostgreSQLバックアップに失敗しました: ${errorOutput.trim() || `exit ${code}`}`,
            ),
          );
        for (
          let attempt = 0;
          attempt < 50 && !(await exists(target));
          attempt += 1
        )
          await new Promise((done) => setTimeout(done, 100));
        return (await exists(target))
          ? resolve()
          : reject(
              new Error(
                "pg_dumpは完了しましたが、バックアップファイルを確認できません。",
              ),
            );
      });
    });
    const stats = await fs.stat(target);
    return {
      path: target,
      bytes: stats.size,
      createdAt: new Date().toISOString(),
    };
  }

  async close() {
    await this.pool.end();
  }
}

export async function createPostgresRepository(
  directory,
  environment = process.env,
) {
  const config = await postgresConfiguration(directory, environment);
  return config ? new PostgresWorkspaceRepository(config) : null;
}
