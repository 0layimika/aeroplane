# Database regression tests

Run pure and isolated SQLite tests without Docker:

```sh
npm ci
npm test
```

The Docker suite is opt-in and requires an x86-64 Linux Docker host, Node.js, OpenSSL and a built Aeroplane checkout:

```sh
npm run build
npm run test:postgis:integration
```

It starts a separate control-plane process with a temporary SQLite database, owner account, encryption key, Caddy configuration, project and runtime network. A PATH wrapper forwards real Docker commands while replacing the test server's `0.0.0.0` bindings with `127.0.0.1`; it does not mock Docker results. Source databases contain generated credentials and sample spatial rows only.

Coverage includes fresh PostGIS provisioning, TLS, logical replication, spatial queries/indexes, persistence across redeployment, managed backup/restore, URL-import compatibility, existing read/write connections, encrypted storage, database-role permissions, API-key restrictions and registration removal without deleting the source database. New connections allocate distinct service records and do not create database data volumes or listening ports.

The suite tracks its created service IDs, containers, volumes and network and cleans only those resources. It never prunes Docker globally, accesses production connection URLs, or modifies an existing Aeroplane control-plane database. Keep artifacts for diagnosing a failure with `AEROPLANE_KEEP_TEST_ARTIFACTS=1`; the test still removes its Docker resources.
