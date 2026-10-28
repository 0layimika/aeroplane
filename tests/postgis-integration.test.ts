import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { join } from "node:path";
import { containerNameForService } from "../src/server/docker-identifiers.js";
import { PostgisIntegrationFixture } from "./postgis-integration-fixture.js";

test("real PostGIS deployment, persistence, backups, imports and existing read/write connections", { skip: process.env.AEROPLANE_TEST_DOCKER !== "1", timeout: 900000 }, async (t) => {
  const fixture = new PostgisIntegrationFixture();
  t.after(() => fixture.cleanup());
  await fixture.start();
  let managed: { id: string; hostPort: number };
  let sourceUrl = "";
  let connected: { id: string; databaseConnection: { host: string } };

  await t.test("fresh PostgreSQL with PostGIS supports spatial queries, GiST indexes and TLS", async () => {
    managed = await fixture.createService("postgis", "managed-spatial");
    const container = await fixture.deploy(managed.id);
    assert.equal(container.Config.Image, "postgis/postgis:18-3.6");
    assert.ok(container.Mounts.some((mount: { Destination: string }) => mount.Destination === "/var/lib/postgresql"));
    const version = await fixture.query(managed.id, "SELECT PostGIS_Full_Version() AS version, current_setting('wal_level') AS wal");
    assert.match(version.rows[0].version, /POSTGIS=/);
    assert.equal(version.rows[0].wal, "logical");
    const tls = await fixture.request(`/api/services/${managed.id}/database/tls`);
    assert.equal(tls.tls.active, true);
    await fixture.query(managed.id, "CREATE TABLE public.places (id integer PRIMARY KEY, name text, point geometry(Point,4326)); INSERT INTO public.places VALUES (1,'Before backup',ST_SetSRID(ST_MakePoint(3.4,6.5),4326)); CREATE INDEX places_gist ON public.places USING gist(point);");
    const spatial = await fixture.query(managed.id, "SELECT ST_SRID(point) AS srid, ST_DWithin(point::geography,ST_SetSRID(ST_MakePoint(3.4001,6.5001),4326)::geography,100) AS nearby FROM public.places");
    assert.deepEqual(spatial.rows, [{ srid: 4326, nearby: true }]);
    const tables = await fixture.request(`/api/services/${managed.id}/database/tables`);
    assert.ok(tables.tables.some((table: { id: string }) => table.id === "public.places"));
  });

  await t.test("redeployment preserves the managed spatial rows", async () => {
    await fixture.deploy(managed.id);
    const result = await fixture.query(managed.id, "SELECT name, ST_X(point) AS lon FROM public.places");
    assert.deepEqual(result.rows, [{ name: "Before backup", lon: 3.4 }]);
  });

  await t.test("managed backup and restore preserve geometry and spatial indexes", async () => {
    const result = await fixture.request(`/api/services/${managed.id}/database/backups`, "POST", { storage: "disk" }, 201);
    await fixture.query(managed.id, "UPDATE public.places SET name='After backup'");
    await fixture.request(`/api/services/${managed.id}/database/backups/${result.backup.id}/restore`, "POST", {});
    const restored = await fixture.query(managed.id, "SELECT name,ST_SRID(point) AS srid FROM public.places");
    assert.deepEqual(restored.rows, [{ name: "Before backup", srid: 4326 }]);
    const indexes = await fixture.query(managed.id, "SELECT indexname FROM pg_indexes WHERE tablename='places'");
    assert.ok(indexes.rows.some((row: { indexname: string }) => row.indexname === "places_gist"));
  });

  await t.test("existing PostGIS registers without copying data and exposes table browsing", async () => {
    sourceUrl = await fixture.createSource();
    connected = await fixture.createService("postgis", "existing-spatial", sourceUrl);
    assert.equal(connected.databaseConnection.host, "127.0.0.1");
    assert.equal(JSON.stringify(connected).includes(fixture.password), false);
    const client = JSON.parse(fixture.docker(["inspect", containerNameForService(connected.id)]))[0];
    assert.equal(client.Config.Image, "postgres:18-alpine");
    assert.deepEqual(client.HostConfig.PortBindings, {});
    assert.equal(client.Mounts.some((mount: { Type: string }) => mount.Type === "volume" || mount.Type === "bind"), false);
    const db = new Database(join(fixture.dir, "data/deploy.db"), { readonly: true });
    const stored = db.prepare("SELECT connection_url FROM database_connections WHERE service_id=?").get(connected.id) as { connection_url: string };
    assert.match(stored.connection_url, /^enc:v1:/);
    assert.equal(stored.connection_url.includes(fixture.password), false);
    db.close();
    const tables = await fixture.request(`/api/services/${connected.id}/database/tables`);
    assert.equal(tables.editable, true);
    assert.ok(tables.tables.some((table: { id: string }) => table.id === "public.existing_points"));
  });

  await t.test("existing connections allow insert, update, delete and SQL against the live database", async () => {
    const base = `/api/services/${connected.id}/database`;
    await fixture.request(`${base}/rows`, "POST", { table: "public.existing_points", values: { id: 2, name: "Inserted", point: "SRID=4326;POINT(3.5 6.6)" } }, 201);
    assert.equal(fixture.sourceSql("SELECT name FROM public.existing_points WHERE id=2"), "Inserted");
    await fixture.request(`${base}/rows`, "PATCH", { table: "public.existing_points", primaryKey: { id: 2 }, values: { name: "Edited" } });
    assert.equal(fixture.sourceSql("SELECT name FROM public.existing_points WHERE id=2"), "Edited");
    await fixture.query(connected.id, "UPDATE public.existing_points SET name='SQL edit' WHERE id=2");
    await fixture.request(`${base}/query`, "POST", { sql: "\\! echo forbidden-client-command" }, 400);
    const rows = await fixture.request(`${base}/rows?table=public.existing_points&limit=1&offset=0&filters=${encodeURIComponent(JSON.stringify([{ column: "name", operator: "equals", value: "SQL edit" }]))}`);
    assert.equal(rows.rows[0].name, "SQL edit");
    assert.equal(rows.totalRows, 1);
    assert.equal(rows.columns.find((column: { name: string }) => column.name === "point").type, "geometry");
    assert.match(rows.rows[0].point, /^[0-9A-F]+$/i);
    await fixture.request(`${base}/rows`, "PATCH", { table: "public.existing_points", primaryKey: { id: 2 }, values: { point: rows.rows[0].point } });
    assert.equal(fixture.sourceSql("SELECT ST_AsEWKT(point) FROM public.existing_points WHERE id=2"), "SRID=4326;POINT(3.5 6.6)");
    await fixture.request(`${base}/rows`, "DELETE", { table: "public.existing_points", primaryKey: { id: 2 } });
    assert.equal(fixture.sourceSql("SELECT count(*) FROM public.existing_points WHERE id=2"), "0");
  });

  await t.test("connected database lifecycle guards prevent deployment, import and managed backup provisioning", async () => {
    await fixture.request(`/api/services/${connected.id}/deployments`, "POST", {}, 404);
    await fixture.request(`/api/services/${connected.id}/database/backups`, "POST", { storage: "disk" }, 400);
    await fixture.request(`/api/services/${connected.id}/database/import/postgres-url`, "POST", { sourceUrl }, 400);
    await fixture.request(`/api/services/${connected.id}`, "PATCH", { repoUrl: "database", repoFullName: "database:postgres" }, 400);
    await fixture.request(`/api/services/${connected.id}`, "PATCH", { name: "Existing spatial renamed" });
    await fixture.request(`/api/services/${connected.id}/database/connection/check`, "POST", {});
  });

  await t.test("multiple connections coexist; URL updates validate before replacing the saved connection", async () => {
    const another = await fixture.createService("postgres", "second-connection", sourceUrl);
    assert.ok(another.databaseConnection);
    const wrong = sourceUrl.replace(fixture.password, "wrong-integration-password");
    const result = await fixture.request(`/api/services/${connected.id}/database/connection`, "PATCH", { url: wrong }, 400);
    assert.equal(JSON.stringify(result).includes("wrong-integration-password"), false);
    const query = await fixture.query(connected.id, "SELECT count(*) AS count FROM public.existing_points");
    assert.equal(query.rows[0].count, 1);
    await fixture.request(`/api/services/${connected.id}/database/connection`, "PATCH", { url: sourceUrl });
  });

  await t.test("existing connections honor read-only roles and API-key permissions", async () => {
    fixture.sourceSql(`CREATE ROLE browser LOGIN PASSWORD '${fixture.password}'; GRANT CONNECT ON DATABASE spatial_source TO browser; GRANT USAGE ON SCHEMA public TO browser; GRANT SELECT ON public.existing_points TO browser;`);
    const readUrl = sourceUrl.replace("postgres:", "browser:");
    const browser = await fixture.createService("postgres", "read-only-role", readUrl);
    const rows = await fixture.request(`/api/services/${browser.id}/database/rows?table=public.existing_points`);
    assert.equal(rows.rows.length, 1);
    await fixture.request(`/api/services/${browser.id}/database/rows`, "POST", { table: "public.existing_points", values: { id: 99, name: "Denied" } }, 400);
    const key = await fixture.request("/api/system/api-keys", "POST", { name: "Read-only test", accessLevel: "read", projectScope: "selected", projectIds: [fixture.projectId], expiresInDays: 7 }, 201);
    await fixture.request(`/api/services/${connected.id}/database/tables`, "GET", undefined, 200, key.token);
    await fixture.request(`/api/services/${connected.id}/database/query`, "POST", { sql: "SELECT 1" }, 403, key.token);
    await fixture.request(`/api/services/${connected.id}/database/connection`, "PATCH", { url: sourceUrl }, 403, key.token);
  });

  await t.test("a spatial URL import succeeds and a plain PostgreSQL target fails before restore", async () => {
    await fixture.request(`/api/services/${managed.id}/database/import/postgres-url`, "POST", { sourceUrl });
    const imported = await fixture.query(managed.id, "SELECT name,ST_SRID(point) AS srid FROM public.existing_points");
    assert.deepEqual(imported.rows, [{ name: "Source", srid: 4326 }]);
    const plain = await fixture.createService("postgres", "plain-postgres");
    await fixture.deploy(plain.id);
    const result = await fixture.request(`/api/services/${plain.id}/database/import/postgres-url`, "POST", { sourceUrl }, 400);
    assert.match(result.error, /Include PostGIS/);
    const checked = await fixture.query(plain.id, "SELECT count(*) AS count FROM pg_extension WHERE extname='postgis'");
    assert.equal(checked.rows[0].count, 0);
  });

  await t.test("removing a registration leaves the original database container and data intact", async () => {
    const before = JSON.parse(fixture.docker(["inspect", `${fixture.runId}-source`]))[0].Id;
    await fixture.request(`/api/services/${connected.id}`, "DELETE");
    const after = JSON.parse(fixture.docker(["inspect", `${fixture.runId}-source`]))[0];
    assert.equal(after.Id, before);
    assert.equal(after.State.Running, true);
    assert.equal(fixture.sourceSql("SELECT count(*) FROM public.existing_points"), "1");
  });
});
