import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { createBearerCredentialStore, type HttpBearerCredential } from "./http-auth.js";
import { createHttpSecurityConfiguration } from "./http-validation.js";

const TOKEN_CURRENT = "synthetic_current_bearer_credential_00000000000000000000000000";
const TOKEN_EXPIRED = "synthetic_expired_bearer_credential_00000000000000000000000000";
const TOKEN_REVOKED = "synthetic_revoked_bearer_credential_00000000000000000000000000";
const TOKEN_NEXT = "synthetic_rotated_bearer_credential_00000000000000000000000000";

function makeRequest(headers: string[], overrides: { remoteAddress?: string; localPort?: number } = {}): IncomingMessage {
  return {
    rawHeaders: headers,
    headers: {},
    socket: {
      remoteAddress: overrides.remoteAddress ?? "192.0.2.20",
      localPort: overrides.localPort ?? 8080,
    },
  } as unknown as IncomingMessage;
}

function requiredHeaders(token = TOKEN_CURRENT): string[] {
  return ["Host", "api.example.com:8080", "Authorization", `Bearer ${token}`];
}

function createPolicy(options: {
  now?: () => number;
  credentials?: readonly HttpBearerCredential[];
  rateLimit?: { requests?: number; windowMilliseconds?: number; maxTrackedPeers?: number };
  trustedProxyPeers?: readonly string[];
  allowedOrigins?: readonly string[];
} = {}) {
  return createHttpSecurityConfiguration({
    credentials: options.credentials ?? [{ id: "current", token: TOKEN_CURRENT, expiresAt: 20_000 }],
    allowedHosts: ["api.example.com"],
    allowedOrigins: options.allowedOrigins ?? ["http://web.example.com:8080"],
    rateLimit: options.rateLimit,
    trustedProxyPeers: options.trustedProxyPeers,
    now: options.now ?? (() => 10_000),
  });
}

describe("single-owner HTTP security policy", () => {
  it("uses timing-safe digest checks and supports expiration, revocation, and rotation", () => {
    const store = createBearerCredentialStore([
      { id: "current", token: TOKEN_CURRENT, expiresAt: 20_000 },
      { id: "expired", token: TOKEN_EXPIRED, expiresAt: 9_999 },
      { id: "revoked", token: TOKEN_REVOKED, expiresAt: 20_000 },
    ]);

    expect(store.authenticate(TOKEN_CURRENT, 10_000)).toBe(true);
    expect(store.authenticate(TOKEN_EXPIRED, 10_000)).toBe(false);
    expect(store.revoke("revoked")).toBe(true);
    expect(store.authenticate(TOKEN_REVOKED, 10_000)).toBe(false);
    expect(store.authenticate("malformed", 10_000)).toBe(false);

    store.replaceCredentials([
      { id: "current", token: TOKEN_CURRENT, expiresAt: 20_000 },
      { id: "next", token: TOKEN_NEXT, expiresAt: 30_000 },
    ]);
    expect(store.authenticate(TOKEN_CURRENT, 10_000)).toBe(true);
    expect(store.authenticate(TOKEN_NEXT, 10_000)).toBe(true);
    store.replaceCredentials([{ id: "next", token: TOKEN_NEXT, expiresAt: 30_000 }]);
    expect(store.authenticate(TOKEN_CURRENT, 10_000)).toBe(false);
    expect(store.authenticate(TOKEN_NEXT, 10_000)).toBe(true);
  });

  it("fails closed on invalid credentials and keeps secrets out of policy serialization", () => {
    const policy = createPolicy();
    const base = requiredHeaders();
    expect(policy.authorize(makeRequest(base)).allowed).toBe(true);
    expect(policy.authorize(makeRequest(["Host", "api.example.com:8080"]))).toEqual({ allowed: false, status: 401 });
    expect(policy.authorize(makeRequest(requiredHeaders("x".repeat(40)))).allowed).toBe(false);
    expect(JSON.stringify(policy)).not.toContain(TOKEN_CURRENT);
    expect(JSON.stringify(policy)).not.toContain("authorization");
  });

  it("rejects duplicate or malformed security headers and blocks Host/Origin spoofing", () => {
    const policy = createPolicy();
    expect(policy.authorize(makeRequest([
      "Host", "api.example.com:8080", "Authorization", `Bearer ${TOKEN_CURRENT}`,
      "Authorization", `Bearer ${TOKEN_CURRENT}`,
    ])).status).toBe(400);
    expect(policy.authorize(makeRequest([
      "Host", "evil.example.com:8080", "Authorization", `Bearer ${TOKEN_CURRENT}`,
    ])).status).toBe(403);
    expect(policy.authorize(makeRequest([
      ...requiredHeaders(), "Origin", "null",
    ])).status).toBe(403);
    expect(policy.authorize(makeRequest([
      ...requiredHeaders(), "Origin", "https://web.example.com:8080",
    ])).status).toBe(403);
    expect(policy.authorize(makeRequest([
      ...requiredHeaders(), "Origin", "http://web.example.com:8080", "Origin", "http://web.example.com:8080",
    ])).status).toBe(400);
    expect(policy.authorize(makeRequest([
      ...requiredHeaders(), "X-Forwarded-Host", "api.example.com",
    ])).status).toBe(403);
    expect(policy.authorize(makeRequest([
      ...requiredHeaders(), "Forwarded", "host=api.example.com;proto=https",
    ])).status).toBe(403);
  });

  it("allows absent Origin for trusted non-browser clients and supports explicitly trusted TLS proxy peers", () => {
    const noOriginPolicy = createPolicy();
    expect(noOriginPolicy.authorize(makeRequest(requiredHeaders())).allowed).toBe(true);

    const crossPortPolicy = createPolicy({ allowedOrigins: ["https://web.example.com:9443"] });
    expect(crossPortPolicy.authorize(makeRequest([
      ...requiredHeaders(), "Origin", "https://web.example.com:9443",
    ])).allowed).toBe(true);

    const proxyPolicy = createHttpSecurityConfiguration({
      credentials: [{ id: "current", token: TOKEN_CURRENT, expiresAt: 20_000 }],
      allowedHosts: ["research.example.com"],
      allowedOrigins: ["https://client.example.net"],
      trustedProxyPeers: ["127.0.0.1"],
      now: () => 10_000,
    });
    const proxiedHeaders = [
      "Host", "research.example.com", "Origin", "https://client.example.net",
      "X-Forwarded-Proto", "https", "Authorization", `Bearer ${TOKEN_CURRENT}`,
    ];
    expect(proxyPolicy.authorize(makeRequest(proxiedHeaders, { remoteAddress: "127.0.0.1", localPort: 39123 })).allowed).toBe(true);
    expect(proxyPolicy.authorize(makeRequest([
      ...proxiedHeaders, "X-Forwarded-Host", "evil.example.net",
    ], { remoteAddress: "127.0.0.1", localPort: 39123 })).status).toBe(403);
    expect(proxyPolicy.authorize(makeRequest([
      "Host", "research.example.com", "X-Forwarded-Proto", "https", "Authorization", `Bearer ${TOKEN_CURRENT}`,
    ], { remoteAddress: "192.0.2.20", localPort: 39123 })).status).toBe(403);
    expect(proxyPolicy.authorize(makeRequest([
      "Host", "research.example.com", "Authorization", `Bearer ${TOKEN_CURRENT}`,
    ], { remoteAddress: "127.0.0.1", localPort: 39123 })).status).toBe(403);
  });

  it("rejects expired/revoked credentials and admits rotated credentials without rebuilding policy", () => {
    let now = 10_000;
    const policy = createPolicy({
      now: () => now,
      credentials: [
        { id: "active", token: TOKEN_CURRENT, expiresAt: 20_000 },
        { id: "expired", token: TOKEN_EXPIRED, expiresAt: 9_999 },
        { id: "revoked", token: TOKEN_REVOKED, expiresAt: 20_000 },
      ],
    });
    expect(policy.authorize(makeRequest(requiredHeaders(TOKEN_EXPIRED))).status).toBe(401);
    expect(policy.revokeCredential("revoked")).toBe(true);
    expect(policy.authorize(makeRequest(requiredHeaders(TOKEN_REVOKED))).status).toBe(401);
    expect(() => policy.rotateCredentials([{
      id: "invalid",
      token: "too_short",
      expiresAt: 30_000,
    }])).toThrow("bearer credentials");
    expect(policy.authorize(makeRequest(requiredHeaders(TOKEN_CURRENT))).allowed).toBe(true);

    policy.rotateCredentials([
      { id: "active", token: TOKEN_CURRENT, expiresAt: 20_000 },
      { id: "next", token: TOKEN_NEXT, expiresAt: 30_000 },
    ]);
    expect(policy.authorize(makeRequest(requiredHeaders(TOKEN_NEXT))).allowed).toBe(true);
    policy.rotateCredentials([{ id: "next", token: TOKEN_NEXT, expiresAt: 30_000 }]);
    expect(policy.authorize(makeRequest(requiredHeaders(TOKEN_CURRENT))).status).toBe(401);
    expect(policy.authorize(makeRequest(requiredHeaders(TOKEN_NEXT))).allowed).toBe(true);
    now = 30_000;
    expect(policy.authorize(makeRequest(requiredHeaders(TOKEN_NEXT))).status).toBe(401);
  });

  it("bounds per-peer rate state, returns retry timing, and resets through an injected clock", () => {
    let now = 10_000;
    const policy = createPolicy({
      now: () => now,
      rateLimit: { requests: 1, windowMilliseconds: 1000, maxTrackedPeers: 1 },
    });
    expect(policy.authorize(makeRequest(requiredHeaders())).allowed).toBe(true);
    expect(policy.authorize(makeRequest(requiredHeaders())).retryAfterSeconds).toBe(1);
    expect(policy.authorize(makeRequest(requiredHeaders(), { remoteAddress: "192.0.2.21" })).status).toBe(429);
    now += 1000;
    expect(policy.authorize(makeRequest(requiredHeaders())).allowed).toBe(true);
    now -= 2000;
    expect(policy.authorize(makeRequest(requiredHeaders())).status).toBe(429);
  });

  it("validates policy shape and refuses remote bind configuration", () => {
    const base = {
      credentials: [{ id: "current", token: TOKEN_CURRENT, expiresAt: 20_000 }],
      allowedHosts: ["api.example.com"],
      allowedOrigins: [],
      now: () => 10_000,
    };
    expect(() => createHttpSecurityConfiguration({ ...base, bindHost: "0.0.0.0" as "127.0.0.1" })).toThrow("loopback");
    expect(() => createHttpSecurityConfiguration({ ...base, allowedHosts: ["api.example.com:8080"] })).toThrow();
    expect(() => createHttpSecurityConfiguration({ ...base, allowedOrigins: ["null"] })).toThrow();
  });
});
