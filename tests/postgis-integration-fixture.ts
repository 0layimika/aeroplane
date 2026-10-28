import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import { containerNameForService } from "../src/server/docker-identifiers.js";
import { databaseDataVolumeName } from "../src/server/database-runtime.js";
import { setTimeout as delay } from "node:timers/promises";

export class PostgisIntegrationFixture {
  readonly dir = mkdtempSync(join(tmpdir(), "aeroplane-postgis-integration-"));
  readonly runId = `aeroplane-postgis-test-${randomBytes(5).toString("hex")}`;
  readonly password = randomBytes(24).toString("base64url");
  readonly serviceIds = new Set<string>();
  readonly volumes = new Set<string>();
  readonly realDocker = execFileSync("which", ["docker"], { encoding: "utf8" }).trim();
  projectId = "";
  cookie = "";
  baseUrl = "";
  child: ChildProcess | null = null;
  serverLog = "";

  docker(args: string[]) {
    return execFileSync(this.realDocker, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000 }).trim();
  }

  async waitFor<T>(operation: () => Promise<T>, ready: (value: T) => boolean, timeout = 120000): Promise<T> {
    const deadline = Date.now() + timeout;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const result = await operation();
        if (ready(result)) return result;
      } catch (error) { if (error instanceof Error && error.message.startsWith("Deployment failed:")) throw error; lastError = error; }
      await delay(300);
    }
    throw new Error(`Integration operation timed out. ${lastError instanceof Error ? lastError.message : ""}\n${this.serverLog.slice(-4000)}`);
  }

  async request(path: string, method = "GET", body?: unknown, expected = 200, bearer?: string) {
    const response = await fetch(this.baseUrl + path, {
      method,
      headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(180000)
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    return text ? JSON.parse(text) : null;
  }

  async start() {
    assert.ok(existsSync(resolve("dist/server/index.js")), "Run npm run build before the Docker integration suite.");
    assert.ok(["x86_64", "amd64"].includes(this.docker(["info", "--format", "{{.Architecture}}"])), "The upstream PostGIS image requires an x86-64 Docker host.");
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.baseUrl = `http://127.0.0.1:${port}`;
    mkdirSync(join(this.dir, "bin"));
    // Exercise real Docker commands, but keep the test databases loopback-only.
    // This PATH override applies to the isolated test control plane only.
    writeFileSync(join(this.dir, "bin/docker"), `#!${process.execPath}\nconst {spawn}=require('node:child_process');\nconst args=process.argv.slice(2).map(arg=>arg.replace(/^0\\.0\\.0\\.0:(\\d+:\\d+)$/, '127.0.0.1:$1'));\nconst p=spawn(${JSON.stringify(this.realDocker)},args,{stdio:'inherit'});\np.on('error',()=>process.exit(1));p.on('exit',(code)=>process.exit(code??1));\n`, { mode: 0o700 });
    symlinkSync(resolve("dist"), join(this.dir, "dist"));
    this.child = spawn(process.execPath, [resolve("dist/server/index.js")], {
      cwd: this.dir,
      env: { ...process.env, NODE_ENV: "production", PORT: String(port), HOST: "127.0.0.1", PUBLIC_URL: this.baseUrl, DATA_DIR: join(this.dir, "data"), AEROPLANE_ENV_PATH: join(this.dir, ".env"), AEROPLANE_SECRET_KEY: randomBytes(32).toString("hex"), DEPLOY_DRY_RUN: "false", CADDY_CONFIG_PATH: join(this.dir, "Caddyfile"), CADDY_RELOAD_CMD: "true", AEROPLANE_RUNTIME_NETWORK: this.runId, PATH: `${join(this.dir, "bin")}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child.stdout?.on("data", (chunk) => { this.serverLog += chunk; });
    this.child.stderr?.on("data", (chunk) => { this.serverLog += chunk; });
    await this.waitFor(() => fetch(this.baseUrl + "/api/auth/status"), (response) => response.ok);
    const response = await fetch(this.baseUrl + "/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner: { name: "Integration Tester", email: "integration@example.invalid", password: this.password }, env: { dataDir: join(this.dir, "data"), port, publicUrl: this.baseUrl, caddyConfigPath: join(this.dir, "Caddyfile"), caddyDataDir: join(this.dir, "data"), caddyReloadCmd: "true", runtimeNetworkName: this.runId, deployDryRun: false }, r2: {}, databaseBackupsAutomaticEnabled: false }) });
    assert.equal(response.status, 201, await response.text());
    this.cookie = response.headers.get("set-cookie")!.split(";")[0];
    const result = await this.request("/api/projects", "POST", { name: this.runId }, 201);
    this.projectId = result.project.id;
  }

  async createService(type: "postgres" | "postgis", name: string, connectionUrl?: string) {
    const result = await this.request(`/api/projects/${this.projectId}/services`, "POST", { name, repoUrl: "database", repoFullName: `database:${type}`, branch: "main", internalPort: 5432, databaseConnectionUrl: connectionUrl, env: connectionUrl ? [] : [{ key: "POSTGRES_DB", value: "spatial_test" }, { key: "POSTGRES_USER", value: "postgres" }, { key: "POSTGRES_PASSWORD", value: this.password }] }, 201);
    this.serviceIds.add(result.service.id);
    return result.service;
  }

  async deploy(serviceId: string) {
    await this.request(`/api/services/${serviceId}/deployments`, "POST", {}, 201);
    await this.waitFor(async () => {
      const result = await this.request(`/api/services/${serviceId}/overview`);
      if (result.deployments[0]?.status === "failed") throw new Error(`Deployment failed: ${JSON.stringify(await this.request(`/api/deployments/${result.deployments[0].id}/logs`))}`);
      return result;
    }, (result) => result.deployments[0]?.status === "running");
    const container = JSON.parse(this.docker(["inspect", containerNameForService(serviceId)]))[0];
    for (const mount of container.Mounts) if (mount.Type === "volume") this.volumes.add(mount.Name);
    return container;
  }

  async query(serviceId: string, sql: string) {
    return this.request(`/api/services/${serviceId}/database/query`, "POST", { sql });
  }

  sourceSql(sql: string) {
    return this.docker(["exec", "--env", `PGPASSWORD=${this.password}`, `${this.runId}-source`, "psql", "-h", "127.0.0.1", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "spatial_source", "-At", "-c", sql]);
  }

  async createSource() {
    const name = `${this.runId}-source`;
    const volume = `${this.runId}-source-data`;
    this.volumes.add(volume);
    this.docker(["run", "-d", "--name", name, "--label", `aeroplane.test-run=${this.runId}`, "-p", "127.0.0.1::5432", "-v", `${volume}:/var/lib/postgresql`, "-e", `POSTGRES_PASSWORD=${this.password}`, "-e", "POSTGRES_DB=spatial_source", "postgis/postgis:18-3.6"]);
    await this.waitFor(async () => this.sourceSql("SELECT PostGIS_Version();"), (result) => result.startsWith("3."));
    this.sourceSql("CREATE TABLE public.existing_points (id integer PRIMARY KEY, name text NOT NULL, point geometry(Point,4326)); INSERT INTO public.existing_points VALUES (1,'Source',ST_SetSRID(ST_MakePoint(3.4,6.5),4326)); CREATE INDEX existing_points_gist ON public.existing_points USING gist(point);");
    const info = JSON.parse(this.docker(["inspect", name]))[0];
    const port = info.NetworkSettings.Ports["5432/tcp"][0].HostPort;
    return `postgresql://postgres:${this.password}@127.0.0.1:${port}/spatial_source?sslmode=disable`;
  }

  async cleanup() {
    this.child?.kill("SIGTERM");
    if (this.child && this.child.exitCode === null) await new Promise<void>((resolve) => { this.child!.once("exit", () => resolve()); setTimeout(resolve, 3000).unref(); });
    for (const id of this.serviceIds) {
      try {
        const info = JSON.parse(this.docker(["inspect", containerNameForService(id)]))[0];
        for (const mount of info.Mounts) if (mount.Type === "volume") this.volumes.add(mount.Name);
      } catch { /* A removal test may already have deleted this client. */ }
      try { this.docker(["rm", "-f", containerNameForService(id)]); } catch { /* absent */ }
      this.volumes.add(databaseDataVolumeName(id));
      const tlsId = createHash("sha256").update(id).digest("hex").slice(0, 16);
      this.volumes.add(`aeroplane-postgres-tls-${tlsId}`);
    }
    try { this.docker(["rm", "-f", `${this.runId}-source`]); } catch { /* absent */ }
    for (const volume of this.volumes) try { this.docker(["volume", "rm", volume]); } catch { /* absent or still in use: never force */ }
    if (this.projectId) try { this.docker(["network", "rm", `${this.runId}-${this.projectId.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "")}`]); } catch { /* absent */ }
    if (process.env.AEROPLANE_KEEP_TEST_ARTIFACTS !== "1") rmSync(this.dir, { recursive: true, force: true });
  }
}
