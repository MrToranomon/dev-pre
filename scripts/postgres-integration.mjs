import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import {
  workspaceDataDirectory,
  WorkspaceStore,
} from "../src/workspace-store.mjs";
import {
  postgresConfiguration,
  PostgresWorkspaceRepository,
} from "../src/postgres-workspace.mjs";

const config = await postgresConfiguration(workspaceDataDirectory());
if (!config)
  throw new Error(
    "PostgreSQLは未設定です。npm run setup:postgres を実行してください。",
  );
const schema = `perfectwork_test_${process.pid}_${Date.now()}`;
const directoryA = await fs.mkdtemp(
  path.join(os.tmpdir(), "perfectwork-pg-a-"),
);
const directoryB = await fs.mkdtemp(
  path.join(os.tmpdir(), "perfectwork-pg-b-"),
);
const repositoryA = new PostgresWorkspaceRepository({ ...config, schema });
const repositoryB = new PostgresWorkspaceRepository({ ...config, schema });
let storeA, storeB;
try {
  storeA = await new WorkspaceStore(directoryA, {
    repository: repositoryA,
  }).init();
  const project = await storeA.createProject({
    name: "PostgreSQL integration",
  });
  await storeA.createTask({
    title: "Persist transaction",
    projectId: project.id,
    scheduledDate: new Date().toLocaleDateString("sv-SE"),
  });
  storeB = await new WorkspaceStore(directoryB, {
    repository: repositoryB,
  }).init();
  assert.equal(storeB.data.projects[0].name, "PostgreSQL integration");
  assert.equal(storeB.data.tasks[0].projectId, storeB.data.projects[0].id);
  assert.equal(
    JSON.parse(await fs.readFile(storeA.file, "utf8")).tasks.length,
    1,
  );
  await storeA.saveHabit({ name: "Verify transaction" });
  await assert.rejects(
    storeB.saveHabit({ name: "Detect conflict" }),
    /別の接続/,
  );
  const status = await storeA.storageStatus();
  assert.equal(status.backend, "postgresql");
  assert.equal(status.entities, 6);
  process.stdout.write(
    `PostgreSQL integration passed: revision ${status.revision}, ${status.entities} projected entities, conflict protection verified.\n`,
  );
} finally {
  await storeA?.close().catch(() => {});
  await storeB?.close().catch(() => {});
  const client = new pg.Client(config);
  try {
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end().catch(() => {});
  }
  await fs.rm(directoryA, { recursive: true, force: true });
  await fs.rm(directoryB, { recursive: true, force: true });
}
