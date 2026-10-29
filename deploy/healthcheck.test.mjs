import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { checkHealth, createHealthProbe } from "./healthcheck.mjs";

test("uses the default loopback host directly without forwarded headers", async (context) => {
  const service = await listen(context, "127.0.0.1");
  const environment = {
    IDEA_MAZE_MCP_HTTP_HOST: "127.0.0.1",
    IDEA_MAZE_MCP_HTTP_PORT: String(service.port),
  };

  assert.equal(await checkHealth({ environment }), true);
  assert.deepEqual(service.requests[0], {
    path: "/healthz",
    host: `127.0.0.1:${service.port}`,
    forwardedProto: undefined,
  });
});

test("uses the first configured Host for a direct loopback probe", async (context) => {
  const service = await listen(context, "127.0.0.1");
  const environment = {
    IDEA_MAZE_MCP_HTTP_HOST: "127.0.0.1",
    IDEA_MAZE_MCP_HTTP_PORT: String(service.port),
    IDEA_MAZE_MCP_ALLOWED_HOSTS: '["mcp.example.test","other.example.test"]',
    IDEA_MAZE_MCP_TRUSTED_PROXY_PEERS: '["::1"]',
  };

  assert.equal(await checkHealth({ environment }), true);
  assert.deepEqual(service.requests[0], {
    path: "/healthz",
    host: `mcp.example.test:${service.port}`,
    forwardedProto: undefined,
  });
});

test("adds the HTTPS forwarded header only for a trusted loopback peer", async (context) => {
  const service = await listen(context, "127.0.0.1");
  const environment = {
    IDEA_MAZE_MCP_HTTP_HOST: "127.0.0.1",
    IDEA_MAZE_MCP_HTTP_PORT: String(service.port),
    IDEA_MAZE_MCP_ALLOWED_HOSTS: '["localhost"]',
    IDEA_MAZE_MCP_TRUSTED_PROXY_PEERS: '["127.0.0.1"]',
  };

  assert.equal(await checkHealth({ environment }), true);
  assert.deepEqual(service.requests[0], {
    path: "/healthz",
    host: `localhost:${service.port}`,
    forwardedProto: "https",
  });
});

test("formats IPv6 loopback URLs and IPv6 Host values with brackets", () => {
  const probe = createHealthProbe({
    IDEA_MAZE_MCP_HTTP_HOST: "::1",
    IDEA_MAZE_MCP_HTTP_PORT: "8787",
    IDEA_MAZE_MCP_ALLOWED_HOSTS: '["2001:db8::7"]',
  });

  assert.equal(probe.url, "http://[::1]:8787/healthz");
  assert.equal(probe.headers.host, "[2001:db8::7]:8787");
  assert.equal(probe.headers["x-forwarded-proto"], undefined);
});

test("returns unhealthy for invalid HTTP probe configuration without making a request", async () => {
  const invalidConfigurations = [
    { IDEA_MAZE_MCP_HTTP_HOST: "0.0.0.0" },
    { IDEA_MAZE_MCP_HTTP_PORT: "0" },
    { IDEA_MAZE_MCP_ALLOWED_HOSTS: "localhost" },
    { IDEA_MAZE_MCP_TRUSTED_PROXY_PEERS: '["localhost"]' },
  ];

  for (const environment of invalidConfigurations) {
    let called = false;
    const healthy = await checkHealth({
      environment,
      requestImplementation: () => {
        called = true;
        throw new Error("invalid configuration must not send a request");
      },
    });
    assert.equal(healthy, false);
    assert.equal(called, false);
  }
});

async function listen(context, host) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      path: request.url,
      host: request.headers.host,
      forwardedProto: request.headers["x-forwarded-proto"],
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}');
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { port: address.port, requests };
}
