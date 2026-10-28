import assert from "node:assert/strict";
import { test } from "node:test";
import { assertDatabasePlatform, databaseDataMountCandidates, databaseDataVolumeArg, databaseImage } from "../src/server/database-runtime.js";
import { isPostgresFamilyDatabase } from "../src/server/database-engine.js";
import { buildDatabaseConnectionUrl, generatedDatabaseEnvVars, normalizeDatabaseType, publicDatabaseUrlKey } from "../src/server/database-urls.js";
import { getDatabaseCredentialFields, getDatabaseOption, DATABASE_OPTIONS } from "../src/client/components/modals/database-service-options.js";
import { externalPostgresEnvironment, parseExternalPostgresUrl, publicExternalPostgresConnection } from "../src/server/external-postgres-url.js";
import { assertPostgisImportCompatible, skipPostgisExtensionEntry } from "../src/server/postgis-import.js";

test("PostGIS is a PostgreSQL variant with matching credentials and URLs, without another database card", () => {
  assert.equal(isPostgresFamilyDatabase("postgis"), true);
  assert.equal(normalizeDatabaseType("postgis/postgis:18-3.6"), "postgis");
  assert.equal(getDatabaseOption("postgis").defaultPort, 5432);
  assert.equal(DATABASE_OPTIONS.some((option) => option.key === "postgis"), false);
  assert.deepEqual(getDatabaseCredentialFields("postgis"), getDatabaseCredentialFields("postgres"));
  assert.equal(publicDatabaseUrlKey("postgis"), "POSTGRES_PUBLIC_URL");
  assert.deepEqual(Object.keys(generatedDatabaseEnvVars("postgis")).sort(), ["POSTGRES_DB", "POSTGRES_PASSWORD", "POSTGRES_USER"]);
  assert.deepEqual(buildDatabaseConnectionUrl({ dbType: "postgis", host: "spatial-db", port: 5432, envMap: new Map([["POSTGRES_USER", "app"], ["POSTGRES_PASSWORD", "test"], ["POSTGRES_DB", "maps"]]) }), { key: "DATABASE_URL", value: "postgresql://app:test@spatial-db:5432/maps" });
});

test("PostGIS uses the PostgreSQL 18 data layout and existing engines retain their images", () => {
  assert.equal(databaseImage("postgis"), "postgis/postgis:18-3.6");
  assert.match(databaseDataVolumeArg("spatial", "postgis"), /:\/var\/lib\/postgresql$/);
  assert.ok(databaseDataMountCandidates("postgis").includes("/var/lib/postgresql/18/docker"));
  assert.equal(databaseImage("postgres"), "postgres:18-alpine");
  assert.equal(databaseImage("timescale"), "timescale/timescaledb:latest-pg18");
  assert.doesNotThrow(() => assertDatabasePlatform("postgis", "x86_64\n"));
  assert.doesNotThrow(() => assertDatabasePlatform("postgres", "aarch64"));
  assert.throws(() => assertDatabasePlatform("postgis", "aarch64"), /x86-64/);
});

test("existing connection credentials are decoded into libpq environment, not shell commands", () => {
  const connection = parseExternalPostgresUrl("postgresql://app:p%40ss%3A%27%24%28x%29%3B@[::1]:18308/maps%20demo?sslmode=require");
  assert.deepEqual(connection, { host: "::1", port: 18308, database: "maps demo", user: "app", password: "p@ss:'$(x);", sslMode: "require" });
  const env = externalPostgresEnvironment(connection);
  assert.equal(env.PGPASSWORD, connection.password);
  assert.equal(env.PGSSLMODE, "require");
  assert.doesNotMatch(env.PGOPTIONS, /read_only/);
  assert.equal("password" in publicExternalPostgresConnection(connection), false);
});

for (const url of ["garbage", "mysql://u:p@host/db", "postgres://u:p@host/", "postgres://host/db", "postgres://u:p@host/db?sslmode=wrong", "postgres://u:p@host/db?options=-c%20role=admin", "postgres://u:p@host/db?sslrootcert=/etc/passwd", "postgres://u:p@host/db?service=local", "postgres://u:p@host/db#extra", "postgres://u:p%00@host/db", "postgres://u:p@host/db%ZZ"]) {
  test(`reject invalid or unsupported connection input: ${url}`, () => assert.throws(() => parseExternalPostgresUrl(url)));
}

test("spatial imports fail before restore when extensions are missing or older", () => {
  assert.throws(() => assertPostgisImportCompatible({ postgis: "3.6.4" }, {}), /Include PostGIS/);
  assert.throws(() => assertPostgisImportCompatible({ postgis: "3.6.4" }, { postgis: "3.5.9" }), /newer than target/);
  assert.doesNotThrow(() => assertPostgisImportCompatible({ postgis: "3.5.0" }, { postgis: "3.6.4" }));
  assert.doesNotThrow(() => assertPostgisImportCompatible({}, {}));
});

test("restore lists preserve spatial rows and configuration, while keeping installed extension dependencies intact", () => {
  assert.equal(skipPostgisExtensionEntry("2; 3079 1 EXTENSION - postgis "), true);
  assert.equal(skipPostgisExtensionEntry("3; 0 0 COMMENT - EXTENSION postgis "), true);
  assert.equal(skipPostgisExtensionEntry("4; 3079 2 EXTENSION - postgis_topology "), true);
  assert.equal(skipPostgisExtensionEntry("5; 0 1 TABLE DATA public spatial_ref_sys postgres"), false);
  assert.equal(skipPostgisExtensionEntry("6; 1259 2 TABLE public postgis_app_points postgres"), false);
  assert.equal(skipPostgisExtensionEntry("7; 3079 3 EXTENSION - timescaledb "), false);
  assert.equal(skipPostgisExtensionEntry("8; 3079 4 EXTENSION - fuzzystrmatch "), true);
  assert.equal(skipPostgisExtensionEntry("9; 2615 5 SCHEMA - topology postgres"), true);
  assert.equal(skipPostgisExtensionEntry("10; 2615 6 SCHEMA - tiger postgres"), true);
  assert.equal(skipPostgisExtensionEntry("11; 0 0 COMMENT - SCHEMA topology postgres"), true);
  assert.equal(skipPostgisExtensionEntry("12; 0 1 TABLE DATA tiger geocode_settings postgres"), false);
  assert.equal(skipPostgisExtensionEntry("13; 1259 2 TABLE topology custom_spatial_data postgres"), false);
  assert.equal(skipPostgisExtensionEntry("14; 2615 7 SCHEMA - public postgres"), false);
});
