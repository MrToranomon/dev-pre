import { workspaceDataDirectory } from "../src/workspace-store.mjs";
import { createPostgresRepository } from "../src/postgres-workspace.mjs";

const directory = workspaceDataDirectory();
const repository = await createPostgresRepository(directory);
if (!repository)
  throw new Error(
    `PostgreSQLは未設定です。npm run setup:postgres を実行してください。`,
  );
try {
  await repository.init();
  const status = await repository.status();
  process.stdout.write(
    `PerfectWork PostgreSQL: connected\nDatabase: ${status.database}\nSchema: ${status.schema}\nRole: ${status.user}\nServer: ${status.version}\nRevision: ${status.revision}\nIndexed entities: ${status.entities}\nJSON mirror: ${directory}\\workspace.json\n`,
  );
} finally {
  await repository.close();
}
