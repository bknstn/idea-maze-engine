import { describe, expect, it } from "vitest";

import {
  createResearchMcpHttpEnvironmentConfiguration,
  DEFAULT_RESEARCH_MCP_HTTP_PORT,
  readResearchMcpTransport,
} from "./http-config.js";
import { isHttpSecurityConfiguration } from "./http-validation.js";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const TOKEN = "synthetic_owner_bearer_token_012345678901234567890123456789";
const EXPIRY = "2026-10-30T12:00:00.000Z";

function environment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    IDEA_MAZE_MCP_BEARER_TOKEN: TOKEN,
    IDEA_MAZE_MCP_BEARER_TOKEN_EXPIRES_AT: EXPIRY,
    ...overrides,
  };
}

describe("Research MCP environment security configuration", () => {
  it("defaults to primary loopback HTTP and creates a branded policy from explicit credentials", () => {
    expect(readResearchMcpTransport({})).toBe("http");
    expect(readResearchMcpTransport({ IDEA_MAZE_MCP_TRANSPORT: "stdio" })).toBe("stdio");
    expect(readResearchMcpTransport({ IDEA_MAZE_MCP_TRANSPORT: "http" })).toBe("http");

    const config = createResearchMcpHttpEnvironmentConfiguration(environment(), () => NOW);
    expect(config).toMatchObject({ host: "127.0.0.1", port: DEFAULT_RESEARCH_MCP_HTTP_PORT });
    expect(isHttpSecurityConfiguration(config.security)).toBe(true);
    expect(config.security.allowedHosts).toEqual(["127.0.0.1", "localhost", "::1"]);
    expect(config.security.allowedOrigins).toEqual([]);
    expect(config.security.trustedProxyPeers).toEqual([]);
    expect(JSON.stringify(config.security)).not.toContain(TOKEN);
  });

  it("requires an environment-only bearer value and an explicit future expiry", () => {
    expect(() => createResearchMcpHttpEnvironmentConfiguration({}, () => NOW)).toThrow("IDEA_MAZE_MCP_BEARER_TOKEN");
    expect(() => createResearchMcpHttpEnvironmentConfiguration({
      IDEA_MAZE_MCP_BEARER_TOKEN: TOKEN,
    }, () => NOW)).toThrow("EXPIRES_AT");
    expect(() => createResearchMcpHttpEnvironmentConfiguration(environment({
      IDEA_MAZE_MCP_BEARER_TOKEN_EXPIRES_AT: "2026-10-30T12:00:00",
    }), () => NOW)).toThrow("ISO-8601");
    expect(() => createResearchMcpHttpEnvironmentConfiguration(environment({
      IDEA_MAZE_MCP_BEARER_TOKEN_EXPIRES_AT: "2026-02-30T12:00:00Z",
    }), () => NOW)).toThrow("is invalid");
    expect(() => createResearchMcpHttpEnvironmentConfiguration(environment({
      IDEA_MAZE_MCP_BEARER_TOKEN_EXPIRES_AT: "2026-10-29T11:59:59Z",
    }), () => NOW)).toThrow("future timestamp");
    expect(() => createResearchMcpHttpEnvironmentConfiguration(environment({
      IDEA_MAZE_MCP_BEARER_TOKEN: "short",
    }), () => NOW)).toThrow("32 to 512");
  });

  it("accepts only documented loopback binds and bounded integer settings", () => {
    const config = createResearchMcpHttpEnvironmentConfiguration(environment({
      IDEA_MAZE_MCP_HTTP_HOST: "::1",
      IDEA_MAZE_MCP_HTTP_PORT: "0",
      IDEA_MAZE_MCP_HTTP_MAX_BODY_BYTES: "1048576",
      IDEA_MAZE_MCP_HTTP_RATE_LIMIT_REQUESTS: "50",
      IDEA_MAZE_MCP_HTTP_RATE_LIMIT_WINDOW_MS: "30000",
      IDEA_MAZE_MCP_HTTP_RATE_LIMIT_MAX_TRACKED_PEERS: "12",
    }), () => NOW);
    expect(config.host).toBe("::1");
    expect(config.port).toBe(0);
    expect(config.security.maxRequestBodyBytes).toBe(1_048_576);
    expect(config.security.rateLimit).toEqual({ requests: 50, windowMilliseconds: 30_000, maxTrackedPeers: 12 });

    expect(() => createResearchMcpHttpEnvironmentConfiguration(environment({
      IDEA_MAZE_MCP_HTTP_HOST: "0.0.0.0",
    }), () => NOW)).toThrow("loopback");
    expect(() => createResearchMcpHttpEnvironmentConfiguration(environment({
      IDEA_MAZE_MCP_HTTP_PORT: "65536",
    }), () => NOW)).toThrow("between 0 and 65535");
    expect(() => createResearchMcpHttpEnvironmentConfiguration(environment({
      IDEA_MAZE_MCP_HTTP_MAX_BODY_BYTES: "1",
    }), () => NOW)).toThrow("between 1024 and 1048576");
    expect(() => readResearchMcpTransport({ IDEA_MAZE_MCP_TRANSPORT: "tcp" })).toThrow("http");
  });

  it("uses bounded JSON arrays for Host, Origin, and trusted proxy policy", () => {
    const config = createResearchMcpHttpEnvironmentConfiguration(environment({
      IDEA_MAZE_MCP_ALLOWED_HOSTS: '["research.example.test","127.0.0.1"]',
      IDEA_MAZE_MCP_ALLOWED_ORIGINS: '["https://client.example.test"]',
      IDEA_MAZE_MCP_TRUSTED_PROXY_PEERS: '["127.0.0.1"]',
    }), () => NOW);
    expect(config.security.allowedHosts).toEqual(["research.example.test", "127.0.0.1"]);
    expect(config.security.allowedOrigins).toEqual(["https://client.example.test"]);
    expect(config.security.trustedProxyPeers).toEqual(["127.0.0.1"]);

    expect(() => createResearchMcpHttpEnvironmentConfiguration(environment({
      IDEA_MAZE_MCP_ALLOWED_HOSTS: "localhost,127.0.0.1",
    }), () => NOW)).toThrow("JSON array");
    expect(() => createResearchMcpHttpEnvironmentConfiguration(environment({
      IDEA_MAZE_MCP_ALLOWED_ORIGINS: '["null"]',
    }), () => NOW)).toThrow("HTTP(S) origins");
    expect(() => createResearchMcpHttpEnvironmentConfiguration(environment({
      IDEA_MAZE_MCP_TRUSTED_PROXY_PEERS: '["proxy.example.test"]',
    }), () => NOW)).toThrow("IP literals");
  });
});
