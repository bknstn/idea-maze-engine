import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const deploymentDirectory = dirname(fileURLToPath(import.meta.url));
const composeFile = join(deploymentDirectory, "compose.yaml");
const smokeOverride = join(deploymentDirectory, "smoke.override.yaml");
const providerFixture = join(deploymentDirectory, "smoke-provider.mjs");
const localImageOptions = parseLocalImageOptions(process.argv.slice(2));
const nodeBaseImage = "node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da";
const proxyImage = "nginx:1.30.4-alpine3.24@sha256:dc5069ad14f19660b141b21236140b91656bf89bbc3e2417c70ae650cd66104c";
const healthPath = "/healthz";
const smokeToken = randomBytes(32).toString("hex");
const smokeSuffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
const projectName = `idea-maze-smoke-${process.pid}-${randomBytes(3).toString("hex")}`;
const imageTag = `idea-maze-engine:smoke-${smokeSuffix}`;
const buildNodeImage = localImageOptions.base?.reference ?? nodeBaseImage;
const composeProxyImage = localImageOptions.proxy?.reference ?? proxyImage;
const rootTemp = mkdtempSync(join(tmpdir(), "idea-maze-container-smoke-"));
const appClients = new Set();
let composeEnvFile;
let localImagesOverride;
let dockerCompose;
let appMayHaveWrittenState = false;
let nodeBaseWasPresent = false;
let proxyWasPresent = false;
let smokePort;

chmodSync(rootTemp, 0o755);

try {
  const stateDirectory = join(rootTemp, "state");
  const backupDirectory = join(rootTemp, "backups");
  const restoredDirectory = join(rootTemp, "restored-state");
  const certificateDirectory = join(rootTemp, "certs");
  const fixtureDirectory = join(rootTemp, "fixture");
  for (const directory of [stateDirectory, backupDirectory, restoredDirectory, certificateDirectory, fixtureDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o777 });
    chmodSync(directory, 0o777);
  }

  const certificate = join(certificateDirectory, "tls.crt");
  const privateKey = join(certificateDirectory, "tls.key");
  run("openssl", [
    "req", "-x509", "-nodes", "-newkey", "rsa:2048", "-keyout", privateKey,
    "-out", certificate, "-subj", "/CN=127.0.0.1", "-days", "1",
  ], { quiet: true });
  writeFileSync(join(fixtureDirectory, "provider-mode"), "block\n", { mode: 0o666 });
  chmodSync(join(fixtureDirectory, "provider-mode"), 0o666);
  writeFileSync(join(fixtureDirectory, "provider-calls"), "", { mode: 0o666 });
  chmodSync(join(fixtureDirectory, "provider-calls"), 0o666);

  const appEnvironment = join(rootTemp, "app.env");
  const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString().replace(".000Z", "Z");
  writeFileSync(appEnvironment, [
    `IDEA_MAZE_MCP_BEARER_TOKEN=${smokeToken}`,
    `IDEA_MAZE_MCP_BEARER_TOKEN_EXPIRES_AT=${expiry}`,
    'IDEA_MAZE_MCP_ALLOWED_HOSTS=["127.0.0.1"]',
    "IDEA_MAZE_MCP_ALLOWED_ORIGINS=[]",
    'IDEA_MAZE_MCP_TRUSTED_PROXY_PEERS=["127.0.0.1"]',
    "",
  ].join("\n"), { mode: 0o600 });

  smokePort = await availablePort();
  composeEnvFile = join(rootTemp, "compose.env");
  writeComposeEnvironment(composeEnvFile, {
    IDEA_MAZE_IMAGE: imageTag,
    IDEA_MAZE_ENV_FILE: appEnvironment,
    IDEA_MAZE_STATE_DIR: stateDirectory,
    IDEA_MAZE_BACKUP_DIR: backupDirectory,
    IDEA_MAZE_CERT_DIR: certificateDirectory,
    SMOKE_PROVIDER_FIXTURE: providerFixture,
    SMOKE_FILES_DIR: fixtureDirectory,
    HTTPS_BIND: "127.0.0.1",
    HTTPS_PORT: String(smokePort),
  });
  if (localImageOptions.proxy) {
    localImagesOverride = join(rootTemp, "local-images.override.yaml");
    writeFileSync(localImagesOverride, `services:\n  tls-proxy:\n    image: ${JSON.stringify(composeProxyImage)}\n`);
  }
  dockerCompose = [
    "compose", "--project-name", projectName,
    "--project-directory", deploymentDirectory,
    "--env-file", composeEnvFile,
    "-f", composeFile,
    "-f", smokeOverride,
    ...(localImagesOverride ? ["-f", localImagesOverride] : []),
    "--profile", "proxy",
  ];

  nodeBaseWasPresent = imageExists(buildNodeImage);
  proxyWasPresent = imageExists(composeProxyImage);
  if (localImageOptions.base) assertLocalImage(localImageOptions.base, "Node base");
  if (localImageOptions.proxy) assertLocalImage(localImageOptions.proxy, "TLS proxy");
  runDocker([...dockerCompose, "config", "--quiet"], { quiet: true });
  runDocker([
    ...dockerCompose,
    "build",
    ...(localImageOptions.base ? ["--build-arg", `NODE_IMAGE=${buildNodeImage}`] : ["--pull"]),
  ], { inherit: true });
  appMayHaveWrittenState = true;
  runDocker([...dockerCompose, "up", "-d", "--wait"], { inherit: true });

  const serviceUrl = new URL(`https://127.0.0.1:${smokePort}/mcp`);
  let lastReadinessObservation = "no response";
  try {
    await waitFor(async () => {
      try {
        const response = await fetchOverHttps(new URL(healthPath, serviceUrl));
        lastReadinessObservation = `HTTP ${response.status}`;
        return response.status === 200;
      } catch (error) {
        const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : "";
        lastReadinessObservation = code ? `request error ${code}` : "request error";
        return false;
      }
    }, 30_000, "TLS proxy and loopback service to become ready");
  } catch (error) {
    throw new Error(`${error.message} Last readiness probe: ${lastReadinessObservation}.`);
  }

  const appContainer = composeValue(["ps", "-q", "idea-maze"]);
  const userAndRootMode = runDocker(["inspect", "--format", "{{.Config.User}} {{.HostConfig.ReadonlyRootfs}}", appContainer], { capture: true }).stdout.trim();
  assert.equal(userAndRootMode, "10001:10001 true", "the application must run as its dedicated UID with a read-only root filesystem");
  const uid = composeValue(["exec", "-T", "idea-maze", "node", "-e", "process.stdout.write(String(process.getuid()))"]).trim();
  assert.equal(uid, "10001", "the application entrypoint must run as the non-root image user");
  const nodeVersion = composeValue(["exec", "-T", "idea-maze", "node", "-p", "process.version"]).trim();
  assert.equal(nodeVersion, "v22.23.4", "the runtime must match the pinned Node image version");
  runCompose([...dockerCompose, "exec", "-T", "idea-maze", "node", "--input-type=module", "-e", "import Database from 'better-sqlite3'; const db = new Database(':memory:'); if (db.prepare('SELECT 1 AS value').get().value !== 1) process.exit(1); db.close();"], { quiet: true });

  const health = await fetchOverHttps(new URL(healthPath, serviceUrl));
  assert.equal(health.status, 200, "the liveness/readiness endpoint must be reachable without a bearer token");
  const anonymous = await fetchOverHttps(serviceUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(anonymous.status, 401, "protected MCP requests must require a bearer token");

  const firstClient = await connectClient(serviceUrl, smokeToken);
  const completedFixture = await createCaseAndPlan(firstClient.client, "complete");
  const callsBeforeFirstRun = providerCallCount(fixtureDirectory);
  const completedReceipt = await startRun(firstClient.client, completedFixture, "complete");
  await waitFor(() => providerCallCount(fixtureDirectory) > callsBeforeFirstRun, 10_000, "the synthetic provider to receive the first run");
  const blockedCallCount = providerCallCount(fixtureDirectory);

  await closeClient(firstClient);
  const reconnectClient = await connectClient(serviceUrl, smokeToken);
  const runningStatus = await readStatus(reconnectClient.client, completedReceipt.runId);
  assert.ok(["queued", "running"].includes(runningStatus.status), "disconnecting a client must leave service-owned work running");
  assert.equal(providerCallCount(fixtureDirectory), blockedCallCount, "reconnect/status reads must not re-dispatch the synthetic provider call");

  writeFileSync(join(fixtureDirectory, "provider-mode"), "release\n");
  const completedStatus = await waitForTerminal(reconnectClient.client, completedReceipt.runId);
  assert.equal(completedStatus.status, "completed", "the mocked research run should complete after the fixture is released");
  const completedResult = responseData(await reconnectClient.client.callTool({
    name: "research_result",
    arguments: { runId: completedReceipt.runId, limit: 10 },
  }));
  assert.equal(completedResult.runId, completedReceipt.runId);

  const interruptedFixture = await createCaseAndPlan(reconnectClient.client, "interrupt");
  const callsBeforeInterrupt = providerCallCount(fixtureDirectory);
  writeFileSync(join(fixtureDirectory, "provider-mode"), "block\n");
  const interruptedReceipt = await startRun(reconnectClient.client, interruptedFixture, "interrupt");
  await waitFor(() => providerCallCount(fixtureDirectory) > callsBeforeInterrupt, 10_000, "the synthetic provider to receive the second run");
  const callCountAtShutdown = providerCallCount(fixtureDirectory);

  runCompose([...dockerCompose, "kill", "--signal", "SIGTERM", "idea-maze"], { quiet: true });
  const shutdownProbe = await tryMcpPost(serviceUrl, smokeToken, {
    jsonrpc: "2.0",
    id: 9001,
    method: "tools/call",
    params: { name: "research_status", arguments: { runId: interruptedReceipt.runId } },
  });
  assert.ok(shutdownProbe.error || [502, 503].includes(shutdownProbe.status), "shutdown must reject new authenticated MCP requests while the TLS proxy remains available");
  await waitFor(() => composeValue(["ps", "-a", "--format", "{{.State}}", "idea-maze"]).trim() !== "running", 10_000, "the service container to finish graceful shutdown");
  assert.equal(providerCallCount(fixtureDirectory), callCountAtShutdown, "shutdown must not retry interrupted external work");
  runCompose([...dockerCompose, "stop", "tls-proxy"], { quiet: true });
  await closeClient(reconnectClient);

  runCompose([...dockerCompose, "rm", "-f", "idea-maze", "tls-proxy"], { quiet: true });
  runCompose([...dockerCompose, "up", "-d", "--wait", "idea-maze", "tls-proxy"], { inherit: true });
  await waitFor(async () => (await fetchOverHttps(new URL(healthPath, serviceUrl))).status === 200, 30_000, "the restarted service to become ready");

  const restartedClient = await connectClient(serviceUrl, smokeToken);
  const interruptedStatus = await readStatus(restartedClient.client, interruptedReceipt.runId);
  assert.equal(interruptedStatus.status, "interrupted", "shutdown should persist the interrupted run state");
  assert.equal(interruptedStatus.stoppingReason, "service_shutdown");
  const readAfterRestart = responseData(await restartedClient.client.callTool({
    name: "research_result",
    arguments: { runId: completedReceipt.runId, limit: 10 },
  }));
  assert.equal(readAfterRestart.runId, completedReceipt.runId, "completed state should remain readable after restart");
  assert.equal(providerCallCount(fixtureDirectory), callCountAtShutdown, "restart and persisted reads must not repeat provider work");

  const backupName = "synthetic-smoke-backup";
  runCompose([...dockerCompose, "exec", "-T", "idea-maze", "node", "/opt/idea-maze-engine/data-transfer.mjs", "backup", backupName], { quiet: true });
  await closeClient(restartedClient);
  runCompose([...dockerCompose, "stop", "tls-proxy", "idea-maze"], { quiet: true });
  runCompose([...dockerCompose, "rm", "-f", "idea-maze", "tls-proxy"], { quiet: true });

  writeComposeEnvironment(composeEnvFile, {
    IDEA_MAZE_IMAGE: imageTag,
    IDEA_MAZE_ENV_FILE: appEnvironment,
    IDEA_MAZE_STATE_DIR: restoredDirectory,
    IDEA_MAZE_BACKUP_DIR: backupDirectory,
    IDEA_MAZE_CERT_DIR: certificateDirectory,
    SMOKE_PROVIDER_FIXTURE: providerFixture,
    SMOKE_FILES_DIR: fixtureDirectory,
    HTTPS_BIND: "127.0.0.1",
    HTTPS_PORT: String(smokePort),
  });
  runCompose([...dockerCompose, "run", "--rm", "--no-deps", "--entrypoint", "node", "idea-maze", "/opt/idea-maze-engine/data-transfer.mjs", "restore", backupName], { quiet: true });
  runCompose([...dockerCompose, "up", "-d", "--wait", "idea-maze", "tls-proxy"], { inherit: true });
  await waitFor(async () => (await fetchOverHttps(new URL(healthPath, serviceUrl))).status === 200, 30_000, "the restored service to become ready");

  const restoredClient = await connectClient(serviceUrl, smokeToken);
  const restoredCompletedCase = await readCase(restoredClient.client, completedFixture.case.caseId);
  assert.equal(restoredCompletedCase.caseId, completedFixture.case.caseId, "a synthetic case must survive backup and restore");
  const restoredInterruptedStatus = await readStatus(restoredClient.client, interruptedReceipt.runId);
  assert.equal(restoredInterruptedStatus.status, "interrupted", "the restored backup must retain shutdown state");
  const restoredCompletedResult = responseData(await restoredClient.client.callTool({
    name: "research_result",
    arguments: { runId: completedReceipt.runId, limit: 10 },
  }));
  assert.equal(restoredCompletedResult.runId, completedReceipt.runId, "the restored backup must return a persisted result");
  assert.equal(providerCallCount(fixtureDirectory), callCountAtShutdown, "restore and reads must not call providers");

  process.stdout.write("Packaging smoke passed: non-root native-SQLite image, TLS/auth, disconnect/reconnect, graceful interruption, restart persistence, and synthetic backup/restore.\n");
} catch (error) {
  if (appMayHaveWrittenState) emitFailureDiagnostics();
  throw error;
} finally {
  for (const entry of appClients) await closeClient(entry);
  const cleanupErrors = [];
  let composeStopped = true;
  if (dockerCompose) {
    try {
      const result = runDocker([...dockerCompose, "down", "--volumes", "--remove-orphans"], { quiet: true, allowFailure: true });
      composeStopped = result.status === 0;
      if (!composeStopped) cleanupErrors.push("the temporary Compose project did not stop cleanly");
    } catch {
      composeStopped = false;
      cleanupErrors.push("the temporary Compose project could not be stopped");
    }
  }

  let rootTempRemoved = false;
  if (appMayHaveWrittenState && composeStopped) {
    try {
      const cleanupImage = [imageTag, buildNodeImage].find(imageExists);
      if (!cleanupImage) throw new Error("no local Node cleanup image is available");
      const cleanupTargets = ["/tmp/state", "/tmp/backups", "/tmp/restored-state"];
      const cleanupScript = [
        "const { readdirSync, rmSync } = require('node:fs');",
        "const { join } = require('node:path');",
        `for (const root of ${JSON.stringify(cleanupTargets)}) {`,
        "  for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true });",
        "}",
      ].join("\n");
      const result = runDocker([
        "run", "--rm", "--user", "0:0", "--network", "none", "--read-only",
        "--mount", `type=bind,source=${rootTemp},target=/tmp`,
        "--entrypoint", "node", cleanupImage, "-e", cleanupScript,
      ], { quiet: true, allowFailure: true });
      if (result.status !== 0) throw new Error("the mounted state cleanup container failed");
    } catch {
      cleanupErrors.push("mounted state cleanup failed");
    }
  } else if (appMayHaveWrittenState) {
    cleanupErrors.push("mounted state cleanup was skipped because the service may still be running");
  }

  if (!appMayHaveWrittenState || composeStopped) {
    try {
      rmSync(rootTemp, { recursive: true, force: true });
      rootTempRemoved = true;
    } catch {
      cleanupErrors.push("the temporary smoke workspace could not be removed");
    }
  } else {
    cleanupErrors.push("the temporary smoke workspace was retained to avoid racing a running service");
  }

  if (rootTempRemoved) {
    try {
      const taskImages = [
        ...(imageExists(imageTag) ? [imageTag] : []),
        ...(!nodeBaseWasPresent && imageExists(buildNodeImage) ? [buildNodeImage] : []),
        ...(!proxyWasPresent && imageExists(composeProxyImage) ? [composeProxyImage] : []),
      ];
      for (const image of new Set(taskImages)) {
        const result = runDocker(["image", "rm", "-f", image], { quiet: true, allowFailure: true });
        if (result.status !== 0) cleanupErrors.push("a task-created image could not be removed");
      }
    } catch {
      cleanupErrors.push("task image availability could not be checked safely");
    }
  } else {
    cleanupErrors.push("task images were retained because the temporary workspace remains");
  }

  if (cleanupErrors.length > 0) {
    process.stderr.write(`Packaging smoke cleanup needs attention: ${cleanupErrors.join("; ")}.\n`);
    process.exitCode = 1;
  }
}

function parseLocalImageOptions(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const option = argumentsList[index];
    if (option !== "--local-base-image" && option !== "--local-proxy-image") {
      throw new Error(`Unknown smoke-test option: ${option}`);
    }
    const value = argumentsList[index + 1];
    if (!value) throw new Error(`${option} requires IMAGE_REF=sha256:CONFIG_ID.`);
    index += 1;
    const separator = value.lastIndexOf("=sha256:");
    const reference = separator > 0 ? value.slice(0, separator) : "";
    const configId = separator > 0 ? `sha256:${value.slice(separator + "=sha256:".length)}` : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(reference) || !/^sha256:[a-f0-9]{64}$/.test(configId)) {
      throw new Error(`${option} must be IMAGE_REF=sha256:CONFIG_ID using a local image reference and full config digest.`);
    }
    const key = option === "--local-base-image" ? "base" : "proxy";
    if (options[key]) throw new Error(`${option} may be specified only once.`);
    options[key] = { reference, configId };
  }
  return options;
}

function assertLocalImage(image, description) {
  const actualId = runDocker(["image", "inspect", "--format", "{{.Id}}", image.reference], { capture: true }).stdout.trim();
  assert.equal(actualId, image.configId, `${description} local image must match the supplied verified config digest`);
}

function writeComposeEnvironment(path, values) {
  const content = Object.entries(values).map(([key, value]) => `${key}=${String(value)}`).join("\n");
  writeFileSync(path, `${content}\n`, { mode: 0o600 });
}

function emitFailureDiagnostics() {
  process.stderr.write("Packaging smoke failure diagnostics (container environment omitted):\n");
  for (const service of ["idea-maze", "tls-proxy"]) {
    let containerId = "";
    try {
      const result = runDocker([...dockerCompose, "ps", "--all", "--quiet", service], {
        capture: true,
        allowFailure: true,
        timeoutMilliseconds: 5_000,
      });
      if (result.status === 0) containerId = String(result.stdout ?? "").trim().split(/\s+/u)[0] ?? "";
    } catch {
      // Diagnostics must not hide the original smoke failure.
    }
    if (!containerId) {
      process.stderr.write(`${service} state/logs: unavailable\n`);
      continue;
    }

    try {
      const state = runDocker([
        "inspect", "--format", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}", containerId,
      ], { capture: true, allowFailure: true, timeoutMilliseconds: 5_000 });
      const stateText = state.status === 0 ? String(state.stdout ?? "").trim().slice(0, 160) : "unavailable";
      process.stderr.write(`${service} state: ${stateText || "unavailable"}\n`);
    } catch {
      process.stderr.write(`${service} state: unavailable\n`);
    }

    try {
      const logs = runDocker(["logs", "--tail", "30", containerId], {
        capture: true,
        allowFailure: true,
        timeoutMilliseconds: 5_000,
      });
      const text = sanitizeDiagnosticLogs(`${logs.stdout ?? ""}\n${logs.stderr ?? ""}`);
      if (text) process.stderr.write(`${service} logs (tail):\n${text}\n`);
    } catch {
      process.stderr.write(`${service} logs: unavailable\n`);
    }
  }
}

function sanitizeDiagnosticLogs(value) {
  return String(value).split(/\r?\n/u).slice(-30).map((line) => line
    .replaceAll(smokeToken, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [redacted]")
    .replace(/\b(OPENAI_API_KEY|TAVILY_API_KEY|IDEA_MAZE_MCP_BEARER_TOKEN)\s*[:=]\s*[^,\s;]+/giu, "$1=[redacted]")
    .slice(0, 300))
    .filter(Boolean)
    .join("\n");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : options.quiet ? "ignore" : ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
    ...(options.timeoutMilliseconds ? { timeout: options.timeoutMilliseconds } : {}),
    env: options.sanitizeComposeEnvironment ? sanitizedComposeEnvironment() : process.env,
  });
  if (result.error) throw new Error(`${command} could not run (${result.error.message}).`);
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.quiet ? "" : ` ${String(result.stderr ?? "").slice(-2000)}`;
    throw new Error(`${command} ${args[0] ?? ""} failed with status ${result.status}.${detail}`);
  }
  return result;
}

function runDocker(args, options = {}) {
  return run("docker", args, { ...options, sanitizeComposeEnvironment: args[0] === "compose" });
}

function runCompose(args, options = {}) {
  return runDocker(args, options);
}

function runComposeValue(args) {
  const result = runCompose(args, { capture: true });
  return result.stdout ?? "";
}

function composeValue(args) {
  return runComposeValue([...dockerCompose, ...args]);
}

function imageExists(image) {
  const result = runDocker(["image", "inspect", "--format", "{{.Id}}", image], { capture: true, allowFailure: true });
  if (result.status === 0) return true;
  if (String(result.stderr ?? "").toLowerCase().includes("no such image")) return false;
  throw new Error("Docker image availability could not be determined safely.");
}

function sanitizedComposeEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("IDEA_MAZE_") || name.startsWith("SMOKE_") || name === "HTTPS_BIND" || name === "HTTPS_PORT" ||
        name === "OPENAI_API_KEY" || name === "TAVILY_API_KEY") {
      delete environment[name];
    }
  }
  return environment;
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local smoke-test port.");
  const port = address.port;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

function fetchOverHttps(input, init = {}, agent = undefined) {
  const url = input instanceof Request ? new URL(input.url) : input instanceof URL ? input : new URL(String(input));
  const method = init.method ?? (input instanceof Request ? input.method : "GET");
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init.headers) new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  const requestHeaders = Object.fromEntries(headers.entries());
  const body = init.body ?? (input instanceof Request ? input.body : undefined);
  return new Promise((resolveResponse, reject) => {
    const request = httpsRequest({
      hostname: url.hostname,
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method,
      headers: requestHeaders,
      rejectUnauthorized: false,
      servername: "localhost",
      agent,
      ...(init.signal ? { signal: init.signal } : {}),
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) responseHeaders.set(name, value.join(", "));
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        const status = response.statusCode ?? 500;
        const responseBody = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
        resolveResponse(new Response(responseBody, { status, headers: responseHeaders }));
      });
    });
    request.setTimeout(10_000, () => request.destroy(new Error("The packaging smoke request timed out.")));
    request.on("error", reject);
    if (body === undefined || body === null) request.end();
    else if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) request.end(body);
    else request.destroy(new TypeError("The smoke client received an unsupported request body."));
  });
}

async function connectClient(url, token) {
  const agent = new HttpsAgent({ keepAlive: true, maxSockets: 4, rejectUnauthorized: false });
  const client = new Client({ name: "idea-maze-packaging-smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: (input, init) => fetchOverHttps(input, init, agent),
  });
  const entry = { client, agent };
  appClients.add(entry);
  await client.connect(transport);
  return entry;
}

async function closeClient(entry) {
  if (!entry || !appClients.has(entry)) return;
  appClients.delete(entry);
  try { await entry.client.close(); } catch { /* A stopped service already closed its stateless transport. */ }
  entry.agent.destroy();
}

function responseData(result) {
  const response = result?.structuredContent;
  if (result?.isError || !response || typeof response !== "object" || !("data" in response)) {
    throw new Error(response?.error?.message ?? "The smoke test expected a successful structured MCP response.");
  }
  return response.data;
}

async function createCaseAndPlan(client, suffix) {
  const created = responseData(await client.callTool({
    name: "research_case_create",
    arguments: {
      idempotencyKey: `package-${suffix}-${randomBytes(6).toString("hex")}`,
      intake: {
        ideaSummary: "A synthetic helper for a repeated team workflow.",
        targetUser: "Small operations teams.",
        problem: "A recurring manual review takes too much time each week.",
        proposedSolution: "A focused workflow helper.",
      },
      hypotheses: [{ claim: "Small operations teams repeat this manual review each week." }],
    },
  }));
  const researchCase = created.case;
  const hypothesisId = researchCase.hypotheses[0]?.hypothesisId;
  assert.ok(hypothesisId, "the synthetic case should include an active hypothesis");
  const planned = responseData(await client.callTool({
    name: "research_plan",
    arguments: {
      idempotencyKey: `plan-${suffix}-${randomBytes(6).toString("hex")}`,
      caseId: researchCase.caseId,
      expectedCaseRevision: researchCase.revision,
      suppliedPlan: {
        queries: [
          {
            text: "How do small teams describe this repeated workflow problem?",
            purpose: "problem_language",
            evidenceIntent: "supporting",
            hypothesisIds: [hypothesisId],
            sourceScopes: ["public_web"],
          },
          {
            text: "What counterexamples challenge this repeated workflow problem?",
            purpose: "counterevidence",
            evidenceIntent: "challenging",
            hypothesisIds: [hypothesisId],
            sourceScopes: ["community_discussions"],
          },
        ],
        limits: {
          maxQueries: 2,
          maxFetchedPages: 2,
          maxFollowUpRounds: 0,
          maxWallTimeSeconds: 30,
          maxModelInputTokens: 1_000,
          maxModelOutputTokens: 500,
        },
      },
    },
  }));
  assert.equal(planned.status, "ready", "the caller-supplied synthetic plan should be ready without model credentials");
  assert.ok(planned.plan);
  return { case: researchCase, plan: planned.plan };
}

async function startRun(client, fixture, suffix) {
  return responseData(await client.callTool({
    name: "research_start",
    arguments: {
      idempotencyKey: `start-${suffix}-${randomBytes(6).toString("hex")}`,
      caseId: fixture.case.caseId,
      expectedCaseRevision: fixture.case.revision,
      planId: fixture.plan.planId,
    },
  }));
}

async function readStatus(client, runId) {
  return responseData(await client.callTool({ name: "research_status", arguments: { runId } }));
}

async function readCase(client, caseId) {
  return responseData(await client.callTool({ name: "research_case_get", arguments: { caseId } }));
}

async function waitForTerminal(client, runId) {
  let status;
  await waitFor(async () => {
    status = await readStatus(client, runId);
    return ["completed", "failed", "cancelled", "interrupted"].includes(status.status);
  }, 15_000, "a synthetic research run to reach terminal state");
  return status;
}

function providerCallCount(directory) {
  try {
    return readFileSync(join(directory, "provider-calls"), "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function tryMcpPost(url, token, body) {
  try {
    const response = await fetchOverHttps(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    return { error };
  }
}

async function waitFor(predicate, timeoutMilliseconds, description) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {
      // Startup, shutdown, and polling races are retried until their deadline.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}
