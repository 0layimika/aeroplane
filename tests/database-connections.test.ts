import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "aeroplane-connection-test-"));
process.env.DATA_DIR = dir;
process.env.AEROPLANE_SECRET_KEY = randomBytes(32).toString("hex");
const { sqlite } = await import("../src/server/db.js");
const { assertManagedDatabase, externalDatabaseSummary, externalDatabaseUrl, isExternalDatabase, saveExternalDatabaseConnection } = await import("../src/server/database-connections.js");
const { enqueueDeployment } = await import("../src/server/deploy.js");
const { restoreDatabaseDump } = await import("../src/server/database-restore.js");
const { createDatabaseBackup } = await import("../src/server/database-backups.js");
const { importPostgresDataFromUrl } = await import("../src/server/postgres-data-import.js");
const { databaseConnectionEnvSuggestionsForProject, syncProjectDatabaseConnectionEnv } = await import("../src/server/database-service-linker.js");

sqlite.prepare("INSERT INTO project_groups (id,name,slug,created_at,updated_at) VALUES ('project','Test','test',datetime('now'),datetime('now'))").run();
sqlite.prepare("INSERT INTO project_environments (id,project_group_id,name,slug,is_default,created_at,updated_at) VALUES ('environment','project','Production','production',1,datetime('now'),datetime('now'))").run();
for (const [id, port] of [["existing", 49901], ["managed", 49902]] as const) {
  sqlite.prepare("INSERT INTO projects (id,project_group_id,environment_id,slug,name,repo_full_name,repo_url,branch,webhook_secret,internal_port,host_port,status,created_at,updated_at) VALUES (?,'project','environment',?,?,'database:postgis','database','main','test',5432,?,'active',datetime('now'),datetime('now'))").run(id,id,id,port);
}
const url = "postgresql://app:unit-test-password@database.example:5432/maps?sslmode=require";
saveExternalDatabaseConnection("existing", url);

after(() => { sqlite.close(); rmSync(dir, { recursive: true, force: true }); });

test("connection URLs are encrypted at rest and public summaries omit credentials", () => {
  const stored = sqlite.prepare("SELECT connection_url FROM database_connections WHERE service_id='existing'").get() as { connection_url: string };
  assert.match(stored.connection_url, /^enc:v1:/);
  assert.equal(stored.connection_url.includes("unit-test-password"), false);
  assert.equal(externalDatabaseUrl("existing"), url);
  assert.deepEqual(externalDatabaseSummary("existing"), { host: "database.example", port: 5432, database: "maps", user: "app", sslMode: "require" });
  assert.equal(isExternalDatabase("managed"), false);
});

test("explicit app-variable suggestions use the existing database URL, never a fabricated Docker alias", () => {
  const suggestion = databaseConnectionEnvSuggestionsForProject("project").find((row) => row.serviceId === "existing");
  assert.equal(suggestion?.value, url);
  syncProjectDatabaseConnectionEnv("project");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM env_vars WHERE project_id='existing'").get()?.count, 0);
});

test("deployment, replacement restore, backup provisioning and URL import reject connected databases before Docker is invoked", async () => {
  assert.throws(() => enqueueDeployment("existing", { trigger: "manual" }), /existing database connection/i);
  assert.doesNotThrow(() => assertManagedDatabase("managed"));
  await assert.rejects(restoreDatabaseDump({ serviceId: "existing", engine: "postgis", format: "pg_dump custom", path: "unused", sizeBytes: 0, checksum: "unused" }, "unused"), /existing database connection/i);
  await assert.rejects(createDatabaseBackup("existing", "disk"), /existing database connection/i);
  await assert.rejects(importPostgresDataFromUrl("existing", url), /existing database connection/i);
});

test("forgetting a connection removes only its registration; managed service metadata survives", () => {
  sqlite.prepare("DELETE FROM projects WHERE id='existing'").run();
  assert.equal(isExternalDatabase("existing"), false);
  assert.ok(sqlite.prepare("SELECT id FROM projects WHERE id='managed'").get());
});
