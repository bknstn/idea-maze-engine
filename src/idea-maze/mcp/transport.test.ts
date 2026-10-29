import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { request as httpRequest } from "node:http";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

import { createFakeResearchApplication } from "./fixtures/fake-application.js";
import { startStdioResearchServer } from "./stdio.js";
import {
  DEFAULT_MCP_HTTP_HEALTH_PATH,
  listenStreamableHttpResearchServer,
  type StreamableHttpResearchOptions,
} from "./transports/streamable-http.js";
import { createHttpSecurityConfiguration } from "./security/http-validation.js";
import { RESEARCH_TOOL_DEFINITIONS } from "../research/tools.js";

const stdioChild = fileURLToPath(new URL("./fixtures/stdio-child.ts", import.meta.url));
const activeClients: Client[] = [];
const activeServices: Array<{ close(): Promise<void> }> = [];
const TEST_HTTP_TOKEN = "synthetic_test_bearer_credential_000000000000000000000000000000";
const ROTATED_HTTP_TOKEN = "synthetic_next_bearer_credential_000000000000000000000000000000";

function createTestHttpSecurity(maxRequestBodyBytes = 256 * 1024) {
  return createHttpSecurityConfiguration({
    credentials: [{ id: "synthetic-owner", token: TEST_HTTP_TOKEN, expiresAt: Date.now() + 60 * 60 * 1000 }],
    allowedHosts: ["127.0.0.1", "localhost", "::1"],
    allowedOrigins: [],
    maxRequestBodyBytes,
  });
}

afterEach(async () => {
  for (const client of activeClients.splice(0)) await client.close().catch(() => undefined);
  for (const service of activeServices.splice(0)) await service.close().catch(() => undefined);
});

function createClient(): Client {
  const client = new Client({ name: "synthetic-transport-test", version: "1.0.0" });
  activeClients.push(client);
  return client;
}

function createHttpTransport(url: URL): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${TEST_HTTP_TOKEN}` } },
  });
}

function sendChunked(url: URL, token: string, body: string, extraHeaders: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: Number(url.port),
      path: url.pathname,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
        ...extraHeaders,
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
    });
    request.on("error", reject);
    request.write(body.slice(0, Math.ceil(body.length / 2)));
    request.end(body.slice(Math.ceil(body.length / 2)));
  });
}

function startInput(key = "test-start-0001") {
  return {
    idempotencyKey: key,
    caseId: "fake-case-1",
    expectedCaseRevision: 1,
    planId: "fake-plan-1",
  };
}

function responseData<T>(result: { structuredContent?: unknown }): T {
  const response = result.structuredContent as { data?: T } | undefined;
  if (!response || !("data" in response)) throw new Error("Expected a structured MCP success response.");
  return response.data as T;
}

async function startHttp(app: ReturnType<typeof createFakeResearchApplication>["app"], extra: {
  additionalRequestGuard?: StreamableHttpResearchOptions["additionalRequestGuard"];
  maxRequestBodyBytes?: StreamableHttpResearchOptions["maxRequestBodyBytes"];
  security?: StreamableHttpResearchOptions["security"];
  shutdownTimeoutMilliseconds?: StreamableHttpResearchOptions["shutdownTimeoutMilliseconds"];
  onShutdown?: StreamableHttpResearchOptions["onShutdown"];
} = {}) {
  const security = extra.security ?? createTestHttpSecurity(extra.maxRequestBodyBytes);
  const service = await listenStreamableHttpResearchServer({
    app,
    port: 0,
    security,
    onShutdown: extra.onShutdown ?? (() => undefined),
    ...extra,
  });
  activeServices.push(service);
  return service;
}

describe("MCP adapters with injected synthetic research applications", () => {
  it("rejects remote bind addresses at runtime before opening a listener", async () => {
    const fake = createFakeResearchApplication();
    const base = { app: fake.app, port: 0, security: createTestHttpSecurity(), onShutdown: () => undefined };
    await expect(listenStreamableHttpResearchServer({
      ...base,
      host: "0.0.0.0" as StreamableHttpResearchOptions["host"],
    })).rejects.toThrow("loopback");
    await expect(listenStreamableHttpResearchServer({
      ...base,
      host: "192.0.2.10" as StreamableHttpResearchOptions["host"],
    })).rejects.toThrow("loopback");
    expect(fake.calls.capabilities ?? 0).toBe(0);
  });

  it("requires a policy created by the validated security configuration factory", async () => {
    const fake = createFakeResearchApplication();
    await expect(listenStreamableHttpResearchServer({
      app: fake.app,
      port: 0,
      security: {
        bindHost: "127.0.0.1",
        maxRequestBodyBytes: 4096,
        authorize: () => ({ allowed: true }),
      } as unknown as StreamableHttpResearchOptions["security"],
      onShutdown: () => undefined,
    })).rejects.toThrow("validated HTTP security policy");
    expect(fake.calls.capabilities ?? 0).toBe(0);
  });

  it("initializes, lists and calls tools through a real stdio child process", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", stdioChild],
      cwd: process.cwd(),
      stderr: "pipe",
      maxBufferSize: 256 * 1024,
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const client = createClient();

    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toEqual([
      "research_capabilities",
      "research_case_create",
      "research_case_get",
      "research_case_update",
      "research_plan",
      "research_start",
      "research_status",
      "research_result",
      "research_cancel",
    ]);
    for (const contract of RESEARCH_TOOL_DEFINITIONS) {
      const advertised = tools.tools.find(({ name }) => name === contract.name);
      expect(advertised?.annotations).toEqual(contract.annotations);
      expect(advertised?.inputSchema?.additionalProperties).toBe(false);
      expect(advertised?.outputSchema).toBeDefined();
    }

    const capabilities = await client.callTool({ name: "research_capabilities", arguments: {} });
    expect(responseData<{ storageMode: string }>(capabilities).storageMode).toBe("single_owner_workspace");
    const receipt = await client.callTool({ name: "research_start", arguments: startInput() });
    const runId = responseData<{ runId: string }>(receipt).runId;
    expect(runId).toBe("fake-run-1");
    const status = await client.callTool({ name: "research_status", arguments: { runId } });
    expect(responseData<{ status: string }>(status).status).toBe("running");
    expect(stderr).toBe("");
  });

  it("removes the stdio EOF listener on explicit close and calls shutdown once", async () => {
    const fake = createFakeResearchApplication();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const initialEndListeners = stdin.listenerCount("end");
    let shutdownCalls = 0;
    const handle = await startStdioResearchServer(fake.app, {
      stdin,
      stdout,
      onShutdown: () => { shutdownCalls += 1; },
    });

    expect(stdin.listenerCount("end")).toBe(initialEndListeners + 2);
    await handle.close();
    expect(stdin.listenerCount("end")).toBe(initialEndListeners);
    expect(shutdownCalls).toBe(1);
    await handle.close();
    expect(shutdownCalls).toBe(1);
    stdin.destroy();
    stdout.destroy();
  });

  it("serves HTTP statelessly, keeps app work responsive, and permits reconnect polling", async () => {
    const fake = createFakeResearchApplication({ workDelayMilliseconds: 500 });
    let shutdownCalls = 0;
    const service = await startHttp(fake.app, { onShutdown: () => { shutdownCalls += 1; } });
    const first = createClient();
    await first.connect(createHttpTransport(service.url));

    const listed = await first.listTools();
    expect(listed.tools).toHaveLength(9);
    expect(listed.tools.find(({ name }) => name === "research_start")?.annotations?.openWorldHint).toBe(true);
    expect(listed.tools.find(({ name }) => name === "research_status")?.annotations?.readOnlyHint).toBe(true);
    const caseResult = await first.callTool({ name: "research_case_get", arguments: { caseId: "fake-case-1" } });
    expect(responseData<{ caseId: string }>(caseResult).caseId).toBe("fake-case-1");
    expect(fake.calls.start ?? 0).toBe(0);

    const startResult = await first.callTool({ name: "research_start", arguments: startInput() });
    const runId = responseData<{ runId: string }>(startResult).runId;
    expect(runId).toBe("fake-run-1");
    expect(fake.calls.start).toBe(1);
    const statusWhileWorkContinues = await first.callTool({ name: "research_status", arguments: { runId } });
    expect(responseData<{ status: string }>(statusWhileWorkContinues).status).toBe("running");

    await first.close();
    const reconnect = createClient();
    await reconnect.connect(createHttpTransport(service.url));
    const statusAfterReconnect = await reconnect.callTool({ name: "research_status", arguments: { runId } });
    expect(responseData<{ status: string }>(statusAfterReconnect).status).toBe("running");
    const result = await reconnect.callTool({ name: "research_result", arguments: { runId, limit: 10 } });
    expect(responseData<{ runId: string }>(result).runId).toBe(runId);
    expect(shutdownCalls).toBe(0);
    await reconnect.close();
    await first.close();
    await service.close();
    expect(shutdownCalls).toBe(1);
    await service.close();
    expect(shutdownCalls).toBe(1);
  });

  it("authenticates every protected method and route while keeping health minimal", async () => {
    const fake = createFakeResearchApplication();
    const service = await startHttp(fake.app);
    const base = {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    };
    const noAuth = await fetch(service.url, base);
    expect(noAuth.status).toBe(401);
    const badAuth = await fetch(service.url, { ...base, headers: { ...base.headers, authorization: `Bearer ${"x".repeat(40)}` } });
    expect(badAuth.status).toBe(401);
    const queryToken = await fetch(new URL(`${service.url.pathname}?token=${TEST_HTTP_TOKEN}`, service.url), base);
    expect(queryToken.status).toBe(401);
    const sessionId = await fetch(new URL(`${service.url.pathname}?sessionId=synthetic-session&runId=fake-run-1`, service.url), {
      method: "GET",
      headers: { accept: "text/event-stream" },
    });
    expect(sessionId.status).toBe(401);
    const sessionHeader = await fetch(service.url, {
      method: "GET",
      headers: { accept: "text/event-stream", "mcp-session-id": "synthetic-session" },
    });
    expect(sessionHeader.status).toBe(401);
    const runIdBody = await fetch(service.url, {
      method: "POST",
      headers: { ...base.headers, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "research_status", arguments: { runId: "fake-run-1" } },
      }),
    });
    expect(runIdBody.status).toBe(401);
    const options = await fetch(service.url, { method: "OPTIONS" });
    expect(options.status).toBe(401);
    const unknownRoute = await fetch(new URL("/unknown", service.url));
    expect(unknownRoute.status).toBe(401);
    const healthWithQuery = await fetch(new URL(`${DEFAULT_MCP_HTTP_HEALTH_PATH}?token=${TEST_HTTP_TOKEN}`, service.url));
    expect(healthWithQuery.status).toBe(401);

    const invalidOrigin = await fetch(service.url, {
      ...base,
      headers: { ...base.headers, authorization: `Bearer ${TEST_HTTP_TOKEN}`, origin: "null" },
    });
    expect(invalidOrigin.status).toBe(403);
    const forwardedSpoof = await fetch(service.url, {
      ...base,
      headers: { ...base.headers, authorization: `Bearer ${TEST_HTTP_TOKEN}`, "x-forwarded-host": "evil.example" },
    });
    expect(forwardedSpoof.status).toBe(403);
    const spoofedHost = await sendChunked(service.url, TEST_HTTP_TOKEN, base.body, { Host: "evil.example" });
    expect(spoofedHost.status).toBe(403);
    expect(fake.calls.capabilities ?? 0).toBe(0);

    const healthUrl = new URL(DEFAULT_MCP_HTTP_HEALTH_PATH, service.url);
    const health = await fetch(healthUrl);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('{"status":"ok"}');
    const healthHead = await fetch(healthUrl, { method: "HEAD" });
    expect(healthHead.status).toBe(200);
    expect(await healthHead.text()).toBe("");
    expect(fake.calls.capabilities ?? 0).toBe(0);
  });

  it("applies credential rotation to live HTTP requests without restarting", async () => {
    const fake = createFakeResearchApplication();
    const security = createTestHttpSecurity();
    const service = await startHttp(fake.app, { security });
    const makeRequest = (token: string) => fetch(service.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{}",
    });

    const oldCredentialBeforeRotation = await makeRequest(TEST_HTTP_TOKEN);
    expect(oldCredentialBeforeRotation.status).not.toBe(401);
    security.rotateCredentials([{
      id: "synthetic-next-owner",
      token: ROTATED_HTTP_TOKEN,
      expiresAt: Date.now() + 60 * 60 * 1000,
    }]);
    const oldCredentialAfterRotation = await makeRequest(TEST_HTTP_TOKEN);
    const newCredential = await makeRequest(ROTATED_HTTP_TOKEN);
    expect(oldCredentialAfterRotation.status).toBe(401);
    expect(newCredential.status).not.toBe(401);
    expect(fake.calls.capabilities ?? 0).toBe(0);
    await service.close();
  });

  it("applies bounded live HTTP request rates with a safe Retry-After response", async () => {
    const fake = createFakeResearchApplication();
    const security = createHttpSecurityConfiguration({
      credentials: [{ id: "synthetic-owner", token: TEST_HTTP_TOKEN, expiresAt: Date.now() + 60 * 60 * 1000 }],
      allowedHosts: ["127.0.0.1"],
      allowedOrigins: [],
      rateLimit: { requests: 1, windowMilliseconds: 1000, maxTrackedPeers: 1 },
    });
    const service = await startHttp(fake.app, { security });
    const makeRequest = () => fetch(service.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_HTTP_TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{}",
    });
    await makeRequest();
    const limited = await makeRequest();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    const responseText = await limited.text();
    expect(responseText).toBe('{"error":"Too many requests."}');
    expect(responseText).not.toContain(TEST_HTTP_TOKEN);
    await service.close();
  });

  it("snapshots the injected app, guard, and shutdown hook when the service is created", async () => {
    const fake = createFakeResearchApplication();
    let guardCalls = 0;
    let shutdownCalls = 0;
    const options: StreamableHttpResearchOptions = {
      app: fake.app,
      port: 0,
      security: createTestHttpSecurity(),
      additionalRequestGuard: () => { guardCalls += 1; return true; },
      onShutdown: () => { shutdownCalls += 1; },
    };
    const service = await listenStreamableHttpResearchServer(options);
    activeServices.push(service);

    options.app.capabilities = async () => { throw new Error("mutated_app_must_not_be_called"); };
    options.additionalRequestGuard = () => false;
    options.onShutdown = () => { shutdownCalls += 100; };

    const client = createClient();
    await client.connect(createHttpTransport(service.url));
    const capabilities = await client.callTool({ name: "research_capabilities", arguments: {} });
    expect(responseData<{ storageMode: string }>(capabilities).storageMode).toBe("single_owner_workspace");
    expect(guardCalls).toBeGreaterThan(0);
    expect(fake.calls.capabilities).toBe(1);

    await client.close();
    await service.close();
    expect(shutdownCalls).toBe(1);
  });

  it("aborts a hanging request and closes HTTP within the shutdown bound", async () => {
    const fake = createFakeResearchApplication({ hangOnCapabilities: true });
    let shutdownCalls = 0;
    const timeoutMs = 250;
    const service = await startHttp(fake.app, {
      shutdownTimeoutMilliseconds: timeoutMs,
      onShutdown: () => { shutdownCalls += 1; },
    });
    const client = createClient();
    await client.connect(createHttpTransport(service.url));
    const hangingCall = client.callTool({ name: "research_capabilities", arguments: {} }).catch(() => undefined);
    const startedAt = Date.now();
    while ((fake.calls.capabilities ?? 0) === 0 && Date.now() - startedAt < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(fake.calls.capabilities).toBe(1);

    const closeStartedAt = Date.now();
    await service.close();
    expect(Date.now() - closeStartedAt).toBeLessThan(timeoutMs + 300);
    expect(shutdownCalls).toBe(1);
    await Promise.race([hangingCall, new Promise((resolve) => setTimeout(resolve, 200))]);
  });

  it("closes the listener even if the shutdown hook throws", async () => {
    const fake = createFakeResearchApplication();
    const service = await startHttp(fake.app, { onShutdown: () => { throw new Error("synthetic shutdown failure"); } });
    await expect(service.close()).rejects.toThrow("synthetic shutdown failure");
    await expect(fetch(service.url)).rejects.toThrow();
  });

  it("does not couple a disconnected HTTP request to queued service work", async () => {
    const fake = createFakeResearchApplication({ workDelayMilliseconds: 500 });
    fake.setNextStartReceiptDelay(250);
    const service = await startHttp(fake.app);
    const client = createClient();
    await client.connect(createHttpTransport(service.url));

    const controller = new AbortController();
    const call = client.callTool({ name: "research_start", arguments: startInput("disconnect-start-01") }, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    await call.catch(() => undefined);
    expect(fake.calls.start).toBe(1);
    const runId = fake.latestRunId;
    expect(runId).toBe("fake-run-1");

    const reconnect = createClient();
    await reconnect.connect(createHttpTransport(service.url));
    const status = await reconnect.callTool({ name: "research_status", arguments: { runId } });
    expect(responseData<{ status: string }>(status).status).toBe("running");
  });

  it("rejects malformed and path-bearing input before application dispatch", async () => {
    const fake = createFakeResearchApplication();
    const service = await startHttp(fake.app);
    const client = createClient();
    await client.connect(createHttpTransport(service.url));

    const pathAttempt = await client.callTool({
      name: "research_case_get",
      arguments: { caseId: "fake-case-1", workspaceRoot: "/tmp/outside-workspace" },
    });
    const missingCaseId = await client.callTool({ name: "research_case_get", arguments: {} });
    expect(pathAttempt.isError).toBe(true);
    expect(missingCaseId.isError).toBe(true);
    expect(JSON.stringify(pathAttempt)).not.toContain("/tmp/outside-workspace");
    expect(fake.calls.getCase ?? 0).toBe(0);
    expect(fake.calls.start ?? 0).toBe(0);
  });

  it("bounds oversized results and redacts unexpected exceptions", async () => {
    const oversized = createFakeResearchApplication({ oversizedResult: true });
    const service = await startHttp(oversized.app);
    const client = createClient();
    await client.connect(createHttpTransport(service.url));
    const result = await client.callTool({ name: "research_result", arguments: { runId: "fake-run-1" } });
    const response = result.structuredContent as { error?: { code: string; message: string } };
    expect(result.isError).toBe(true);
    expect(response.error?.code).toBe("INTERNAL_ERROR");
    expect(response.error?.message).toBe("The research request could not be completed.");
    expect(JSON.stringify(response)).not.toContain("Synthetic bounded-output fixture");
  });

  it("maps malformed application envelopes to a safe non-retryable internal error", async () => {
    const fake = createFakeResearchApplication({ malformedCapabilities: true });
    const service = await startHttp(fake.app);
    const client = createClient();
    await client.connect(createHttpTransport(service.url));
    const result = await client.callTool({ name: "research_capabilities", arguments: {} });
    const response = result.structuredContent as { error?: { code: string; retryable: boolean } };
    expect(result.isError).toBe(true);
    expect(response.error?.code).toBe("INTERNAL_ERROR");
    expect(response.error?.retryable).toBe(false);
  });

  it("validates app failure envelopes against the exact output schema before returning details", async () => {
    const fake = createFakeResearchApplication({ malformedFailureDetails: true });
    const service = await startHttp(fake.app);
    const client = createClient();
    await client.connect(createHttpTransport(service.url));
    const result = await client.callTool({ name: "research_capabilities", arguments: {} });
    const response = result.structuredContent as { error?: { code: string; message: string; details: unknown } };
    expect(result.isError).toBe(true);
    expect(response.error?.code).toBe("INTERNAL_ERROR");
    expect(response.error?.message).toBe("The research request could not be completed.");
    expect(JSON.stringify(response)).not.toContain("synthetic_raw_error_detail_should_not_escape");
    expect(JSON.stringify(response.error?.details)).toBe(JSON.stringify({ kind: "internal" }));
  });

  it("returns only a generic envelope for thrown app errors", async () => {
    const fake = createFakeResearchApplication({ throwOnCapabilities: true });
    const service = await startHttp(fake.app);
    const client = createClient();
    await client.connect(createHttpTransport(service.url));
    const result = await client.callTool({ name: "research_capabilities", arguments: {} });
    const response = result.structuredContent as { error?: { message: string; retryable: boolean } };
    expect(result.isError).toBe(true);
    expect(response.error?.message).toBe("The research request could not be completed.");
    expect(response.error?.retryable).toBe(false);
    expect(JSON.stringify(response)).not.toContain("synthetic_private_token_should_not_escape");
  });

  it("enforces a request body cap and exposes a T18 request-guard hook", async () => {
    const fake = createFakeResearchApplication();
    const service = await startHttp(fake.app, { maxRequestBodyBytes: 4096 });
    const body = await fetch(service.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TEST_HTTP_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }).padEnd(5000, " "),
    });
    expect(body.status).toBe(413);
    expect(fake.calls.capabilities ?? 0).toBe(0);
    const chunked = await sendChunked(
      service.url,
      TEST_HTTP_TOKEN,
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }).padEnd(5000, " "),
    );
    expect(chunked.status).toBe(413);
    expect(fake.calls.capabilities ?? 0).toBe(0);
    const rejectedOrigin = await fetch(service.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TEST_HTTP_TOKEN}`,
        origin: "https://untrusted.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(rejectedOrigin.status).toBe(403);
    expect(fake.calls.capabilities ?? 0).toBe(0);

    await service.close();
    const guarded = await listenStreamableHttpResearchServer({
      app: fake.app,
      port: 0,
      security: createTestHttpSecurity(),
      onShutdown: () => undefined,
      additionalRequestGuard: () => false,
    });
    activeServices.push(guarded);
    const denied = await fetch(guarded.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TEST_HTTP_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }),
    });
    expect(denied.status).toBe(403);
    expect(fake.calls.capabilities ?? 0).toBe(0);
  });
});
