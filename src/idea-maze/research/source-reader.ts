import { lookup as nodeLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage, RequestOptions } from "node:http";

import type { CoverageGap, CoverageGapReason } from "./contracts.js";
import type {
  FetchedOriginal,
  OriginalSourceReader,
  OriginalSourceRequest,
  ProviderBinding,
} from "./ports.js";
import { hashSourceText } from "../scripts/lib/evidence-excerpts.js";

export type SourceReaderErrorCode =
  | "INVALID_REQUEST"
  | "SOURCE_ACCESS_BLOCKED"
  | "ORIGINAL_UNAVAILABLE"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "FETCH_FAILED"
  | "TIME_LIMIT"
  | "CANCELLED";

/** A bounded, safe failure that callers can turn directly into coverage. */
export class SourceReaderError extends Error {
  readonly code: SourceReaderErrorCode;
  readonly coverageGap: CoverageGap;

  constructor(code: SourceReaderErrorCode, reason: CoverageGapReason, detail: string) {
    super(detail);
    this.name = "SourceReaderError";
    this.code = code;
    this.coverageGap = Object.freeze({ reason, detail, queryId: null, hypothesisId: null });
  }
}

export interface SourceAddress {
  address: string;
  family: 4 | 6;
}

export interface SourceDnsResolver {
  /** Resolve every address so a mixed public/private answer fails closed. */
  resolve(hostname: string, signal: AbortSignal): Promise<readonly SourceAddress[]>;
}

export interface PinnedSourceRequest {
  /** The full original-host URL; the transport must connect to address below. */
  url: URL;
  address: string;
  family: 4 | 6;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface PinnedSourceResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: AsyncIterable<Uint8Array>;
  /** Destroy the active response/socket when a bound or cancellation is hit. */
  cancel(): void;
}

export interface SourceHttpTransport {
  request(request: PinnedSourceRequest): Promise<PinnedSourceResponse>;
}

export interface SourceReaderClock {
  now(): Date;
}

export interface SourceReaderConfig {
  timeoutMs: number;
  maxUrlChars: number;
  maxBodyBytes: number;
  maxTextChars: number;
  maxRedirects: number;
  maxDnsAddresses: number;
}

export interface SafeOriginalSourceReaderOptions {
  /** Explicit DNS and HTTP seams; neither falls back to global fetch or proxy settings. */
  dns: SourceDnsResolver;
  transport: SourceHttpTransport;
  clock: SourceReaderClock;
  config?: Partial<SourceReaderConfig>;
}

const DEFAULT_CONFIG: Readonly<SourceReaderConfig> = Object.freeze({
  timeoutMs: 10_000,
  maxUrlChars: 2_048,
  maxBodyBytes: 1_000_000,
  maxTextChars: 300_000,
  maxRedirects: 5,
  maxDnsAddresses: 32,
});

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REDIRECT_LIMIT = 8;
const RESPONSE_HEADER_LIMIT = 16_384;
const MAX_TITLE_CHARS = 500;
const SAFE_TEXT_CONTENT_TYPES = new Set(["text/html", "text/plain", "application/xhtml+xml"]);
const HTML_RAW_TEXT_TAGS = new Set(["script", "style", "noscript", "template"]);
const HTML_BLOCK_TAGS = new Set([
  "address", "article", "blockquote", "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "li", "main", "nav", "ol",
  "p", "pre", "section", "table", "tbody", "td", "th", "thead", "tr", "ul",
]);

const ERROR_DETAILS: Record<SourceReaderErrorCode, { reason: CoverageGapReason; detail: string }> = {
  INVALID_REQUEST: { reason: "source_access_blocked", detail: "The original source URL is invalid or outside the supported public web scope." },
  SOURCE_ACCESS_BLOCKED: { reason: "source_access_blocked", detail: "Original source access was blocked by the URL, network, or page access policy." },
  ORIGINAL_UNAVAILABLE: { reason: "original_unavailable", detail: "The original source was unavailable." },
  UNSUPPORTED_CONTENT_TYPE: { reason: "fetch_failed", detail: "The original source content type is unsupported." },
  FETCH_FAILED: { reason: "fetch_failed", detail: "The original source could not be retrieved or normalized." },
  TIME_LIMIT: { reason: "time_limit", detail: "Original source retrieval exceeded its time limit." },
  CANCELLED: { reason: "cancelled", detail: "Original source retrieval was cancelled." },
};

/**
 * Create an original-source reader with explicit DNS, pinned HTTP transport,
 * clock, and hard resource bounds. It fetches only public HTTP(S) HTML/text;
 * it does not execute scripts, load subresources, use cookies, or authenticate.
 */
export function createSafeOriginalSourceReaderBinding(
  options: SafeOriginalSourceReaderOptions,
): ProviderBinding<OriginalSourceReader> {
  if (!options || typeof options !== "object" || !options.dns || typeof options.dns.resolve !== "function" ||
      !options.transport || typeof options.transport.request !== "function" ||
      !options.clock || typeof options.clock.now !== "function") {
    throw new TypeError("explicit DNS, transport, and clock implementations are required");
  }
  const config = resolveConfig(options.config);
  const dns = Object.freeze({ resolve: options.dns.resolve.bind(options.dns) });
  const transport = Object.freeze({ request: options.transport.request.bind(options.transport) });
  const clock = Object.freeze({ now: options.clock.now.bind(options.clock) });
  const reader: OriginalSourceReader = Object.freeze({
    fetchOriginal: (request) => fetchOriginal(dns, transport, clock, config, request),
  });
  return Object.freeze({ availability: "available", adapter: "safe-http-source-reader", provider: reader });
}

/** Explicit native resolver for production wiring; cancellation is bounded by the reader deadline. */
export const systemSourceDnsResolver: SourceDnsResolver = Object.freeze({
  async resolve(hostname: string): Promise<readonly SourceAddress[]> {
    const result = await nodeLookup(hostname, { all: true, verbatim: true });
    return result.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
  },
});

/** Native, direct HTTP(S) transport. It never uses ambient proxy, cookie, or auth configuration. */
export const pinnedNodeHttpTransport: SourceHttpTransport = Object.freeze({
  request: requestPinnedNodeHttp,
});

function resolveConfig(input: Partial<SourceReaderConfig> | undefined): Readonly<SourceReaderConfig> {
  const config = { ...DEFAULT_CONFIG, ...input };
  const ranges: Record<keyof SourceReaderConfig, [number, number]> = {
    timeoutMs: [1, 120_000],
    maxUrlChars: [64, 8_192],
    maxBodyBytes: [1_024, 5_000_000],
    maxTextChars: [1_024, 1_500_000],
    maxRedirects: [0, 8],
    maxDnsAddresses: [1, 64],
  };
  for (const [key, [minimum, maximum]] of Object.entries(ranges) as Array<[keyof SourceReaderConfig, [number, number]]>) {
    const value = config[key];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(`${key} must be an integer between ${minimum} and ${maximum}`);
    }
  }
  return Object.freeze(config);
}

async function fetchOriginal(
  dns: SourceDnsResolver,
  transport: SourceHttpTransport,
  clock: SourceReaderClock,
  config: Readonly<SourceReaderConfig>,
  request: OriginalSourceRequest,
): Promise<FetchedOriginal> {
  if (!request || typeof request !== "object" || typeof request.url !== "string" ||
      !request.signal || typeof request.signal.aborted !== "boolean") {
    throw sourceError("INVALID_REQUEST");
  }
  if (request.signal.aborted) throw sourceError("CANCELLED");

  let current = parsePublicWebUrl(request.url, config.maxUrlChars);
  const scope = createOperationScope(request.signal, config.timeoutMs);
  const visited = new Set<string>();
  try {
    for (let redirectCount = 0; ; redirectCount++) {
      throwIfAborted(scope);
      const canonicalCurrent = current.toString();
      if (visited.has(canonicalCurrent)) throw sourceError("SOURCE_ACCESS_BLOCKED");
      visited.add(canonicalCurrent);

      const destination = await resolveAndPinDestination(dns, current, config, scope);
      throwIfAborted(scope);
      const transportPromise = Promise.resolve().then(() => transport.request({
          url: current,
          address: destination.address,
          family: destination.family,
          signal: scope.signal,
          timeoutMs: config.timeoutMs,
        })).then((lateResponse) => {
          // A test or host transport may ignore AbortSignal. If it eventually
          // returns after cancellation, release its body/socket immediately.
          if (scope.signal.aborted) safelyCancel(lateResponse);
          return lateResponse;
        });
      const response = await raceWithAbort(transportPromise, scope);

      if (header(response.headers, "cf-mitigated")?.trim().toLowerCase() === "challenge") {
        safelyCancel(response);
        throw sourceError("SOURCE_ACCESS_BLOCKED");
      }
      const location = header(response.headers, "location");
      if (REDIRECT_STATUSES.has(response.status)) {
        safelyCancel(response);
        if (redirectCount >= config.maxRedirects || !location || location.length > config.maxUrlChars) {
          throw sourceError("SOURCE_ACCESS_BLOCKED");
        }
        let redirectUrl: string;
        try {
          redirectUrl = new URL(location, current).toString();
        } catch {
          throw sourceError("SOURCE_ACCESS_BLOCKED");
        }
        current = parsePublicWebUrl(redirectUrl, config.maxUrlChars);
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        safelyCancel(response);
        throw sourceError("SOURCE_ACCESS_BLOCKED");
      }
      if (response.status === 404 || response.status === 410) {
        safelyCancel(response);
        throw sourceError("ORIGINAL_UNAVAILABLE");
      }
      if (response.status !== 200) {
        safelyCancel(response);
        throw sourceError("FETCH_FAILED");
      }

      const contentTypeHeader = header(response.headers, "content-type");
      const parsedContentType = parseContentType(contentTypeHeader);
      if (!parsedContentType || !SAFE_TEXT_CONTENT_TYPES.has(parsedContentType.mediaType)) {
        safelyCancel(response);
        throw sourceError("UNSUPPORTED_CONTENT_TYPE");
      }
      const contentEncoding = header(response.headers, "content-encoding");
      if (contentEncoding && contentEncoding.trim().toLowerCase() !== "identity") {
        safelyCancel(response);
        throw sourceError("FETCH_FAILED");
      }
      ensureDeclaredLengthWithinBound(response.headers, config.maxBodyBytes, response);
      const bytes = await readBoundedBody(response, config.maxBodyBytes, scope);
      const decoded = decodeText(bytes, parsedContentType.charset);
      if (decoded.length > config.maxTextChars) throw sourceError("FETCH_FAILED");
      const normalized = parsedContentType.mediaType === "text/plain"
        ? normalizePlainText(decoded)
        : normalizeHtml(decoded);
      if (normalized.text.length > config.maxTextChars) throw sourceError("FETCH_FAILED");
      if (normalized.text.length === 0) throw sourceError("ORIGINAL_UNAVAILABLE");
      const retrievedAt = clock.now();
      if (!(retrievedAt instanceof Date) || !Number.isFinite(retrievedAt.getTime())) throw sourceError("FETCH_FAILED");

      return Object.freeze({
        canonicalUrl: current.toString(),
        retrievedAt: retrievedAt.toISOString(),
        title: normalized.title,
        contentType: parsedContentType.mediaType,
        text: normalized.text,
        textHash: hashSourceText(normalized.text),
      });
    }
  } catch (error) {
    if (error instanceof SourceReaderError) throw error;
    if (scope.signal.aborted) throw scope.abortError();
    throw sourceError("FETCH_FAILED");
  } finally {
    scope.dispose();
  }
}

function parsePublicWebUrl(input: string, maxUrlChars: number): URL {
  if (input.length === 0 || input.length > maxUrlChars || input.trim() !== input || /[\u0000-\u0020\u007f\\]/u.test(input)) {
    throw sourceError("INVALID_REQUEST");
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw sourceError("INVALID_REQUEST");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "" ||
      url.hostname === "" || (url.port !== "" && url.port !== (url.protocol === "https:" ? "443" : "80"))) {
    throw sourceError("SOURCE_ACCESS_BLOCKED");
  }
  url.hash = "";
  if (url.toString().length > maxUrlChars) throw sourceError("INVALID_REQUEST");
  const host = hostWithoutBrackets(url.hostname).toLowerCase();
  const family = isIP(host);
  if (family !== 0) {
    if (!isPublicAddress(host)) throw sourceError("SOURCE_ACCESS_BLOCKED");
  } else {
    if (!host.includes(".") || host.endsWith(".") ||
        ["localhost", "local", "internal", "lan", "home", "home.arpa", "intranet", "private", "corp", "test", "invalid", "example"].some((suffix) =>
          host === suffix || host.endsWith(`.${suffix}`))) {
      throw sourceError("SOURCE_ACCESS_BLOCKED");
    }
  }
  return url;
}

async function resolveAndPinDestination(
  dns: SourceDnsResolver,
  url: URL,
  config: Readonly<SourceReaderConfig>,
  scope: OperationScope,
): Promise<SourceAddress> {
  const hostname = hostWithoutBrackets(url.hostname);
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!isPublicAddress(hostname)) throw sourceError("SOURCE_ACCESS_BLOCKED");
    return { address: hostname, family: literalFamily };
  }

  let addresses: readonly SourceAddress[];
  try {
    addresses = await raceWithAbort(dns.resolve(hostname, scope.signal), scope);
  } catch (error) {
    if (error instanceof SourceReaderError) throw error;
    if (scope.signal.aborted) throw scope.abortError();
    throw sourceError("FETCH_FAILED");
  }
  throwIfAborted(scope);
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > config.maxDnsAddresses) {
    throw sourceError("FETCH_FAILED");
  }
  const safeAddresses: SourceAddress[] = [];
  for (const candidate of addresses) {
    if (!candidate || typeof candidate.address !== "string" || (candidate.family !== 4 && candidate.family !== 6) ||
        isIP(candidate.address) !== candidate.family || !isPublicAddress(candidate.address)) {
      throw sourceError("SOURCE_ACCESS_BLOCKED");
    }
    safeAddresses.push({ address: candidate.address, family: candidate.family });
  }
  // One vetted destination is pinned for this socket. Every DNS answer was
  // checked first, so a mixed public/private response is rejected as a whole.
  return safeAddresses[0];
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const value = parts.reduce((out, part) => (out << 8n) | BigInt(part), 0n);
  // Exclude complete IANA special-use prefixes, including the globally
  // reachable exceptions within 192.0.0.0/24, for a conservative policy.
  const blocked: Array<[string, number]> = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
    ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
    ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  return !blocked.some(([network, prefix]) => ipv4InPrefix(value, network, prefix));
}

function ipv4InPrefix(addressValue: bigint, network: string, prefix: number): boolean {
  const networkValue = network.split(".").map(Number).reduce((out, part) => (out << 8n) | BigInt(part), 0n);
  const mask = prefix === 0 ? 0n : ((0xffff_ffffn << BigInt(32 - prefix)) & 0xffff_ffffn);
  return (addressValue & mask) === (networkValue & mask);
}

function isPublicIpv6(address: string): boolean {
  const value = ipv6ToBigInt(address);
  if (value === null) return false;
  // A conservative global-unicast allow-list (2000::/3), plus special-use
  // exclusions from the IANA IPv6 Special-Purpose Address Registry. Some
  // special-purpose anycast ranges can be globally reachable; this policy
  // intentionally rejects those when they fall in a reserved block.
  if (!ipv6InPrefix(value, "2000::", 3)) return false;
  const blocked: Array<[string, number]> = [
    ["2001::", 23],       // IETF protocol assignments, including documentation and transition uses
    ["2001:db8::", 32],    // documentation prefix is outside 2001::/23
    ["2002::", 16],       // 6to4 embeds IPv4 destinations
    ["3fff::", 20],       // documentation prefix
  ];
  return !blocked.some(([network, prefix]) => ipv6InPrefix(value, network, prefix));
}

function ipv6InPrefix(address: bigint, network: string, prefix: number): boolean {
  const networkValue = ipv6ToBigInt(network);
  if (networkValue === null) return false;
  const mask = ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - prefix)) - 1n);
  return (address & mask) === (networkValue & mask);
}

function ipv6ToBigInt(input: string): bigint | null {
  let address = hostWithoutBrackets(input).toLowerCase();
  if (address.includes("%") || isIP(address) !== 6) return null;
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    const ipv4 = address.slice(lastColon + 1).split(".").map(Number);
    if (ipv4.length !== 4 || ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    address = `${address.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((part) => !/^[\da-f]{1,4}$/u.test(part))) return null;
  return groups.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function hostWithoutBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function parseContentType(value: string | undefined): { mediaType: string; charset: string } | null {
  if (!value || value.length > 512) return null;
  const [rawMedia, ...parameters] = value.split(";");
  const mediaType = rawMedia.trim().toLowerCase();
  if (!SAFE_TEXT_CONTENT_TYPES.has(mediaType)) return null;
  let charset = "utf-8";
  for (const parameter of parameters) {
    const match = parameter.trim().match(/^charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s;]+))$/iu);
    if (match) charset = (match[1] ?? match[2] ?? match[3]).toLowerCase();
  }
  if (charset.length > 40 || /[^a-z0-9._-]/u.test(charset)) return null;
  return { mediaType, charset };
}

function ensureDeclaredLengthWithinBound(
  headers: Readonly<Record<string, string | undefined>>,
  maxBytes: number,
  response: PinnedSourceResponse,
): void {
  const rawLength = header(headers, "content-length");
  if (!rawLength) return;
  if (!/^\d{1,16}$/u.test(rawLength.trim()) || Number(rawLength) > maxBytes) {
    safelyCancel(response);
    throw sourceError("FETCH_FAILED");
  }
}

async function readBoundedBody(
  response: PinnedSourceResponse,
  maxBytes: number,
  scope: OperationScope,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    while (true) {
      throwIfAborted(scope);
      const part = await raceWithAbort(Promise.resolve(iterator.next()), scope);
      if (part.done) break;
      const chunk = part.value;
      if (!(chunk instanceof Uint8Array)) throw sourceError("FETCH_FAILED");
      total += chunk.byteLength;
      if (total > maxBytes) throw sourceError("FETCH_FAILED");
      chunks.push(chunk);
    }
  } catch (error) {
    safelyCancel(response);
    try {
      const cleanup = iterator.return?.();
      if (cleanup && typeof (cleanup as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(cleanup).catch(() => undefined);
      }
    } catch {
      // A source stream may not support early return after cancellation.
    }
    if (error instanceof SourceReaderError) throw error;
    if (scope.signal.aborted) throw scope.abortError();
    throw sourceError("FETCH_FAILED");
  }
  throwIfAborted(scope);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeText(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    throw sourceError("FETCH_FAILED");
  }
}

function normalizePlainText(input: string): { text: string; title: null } {
  return { text: normalizeWhitespace(input.replace(/\r\n?/gu, "\n").normalize("NFC")), title: null };
}

function normalizeHtml(input: string): { text: string; title: string | null } {
  const lowercase = input.toLowerCase();
  const visible: string[] = [];
  let title: string | null = null;
  let cursor = 0;

  while (cursor < input.length) {
    const tagStart = input.indexOf("<", cursor);
    if (tagStart < 0) {
      visible.push(input.slice(cursor));
      break;
    }
    if (tagStart > cursor) visible.push(input.slice(cursor, tagStart));

    if (input.startsWith("<!--", tagStart)) {
      const commentEnd = input.indexOf("-->", tagStart + 4);
      cursor = commentEnd < 0 ? input.length : commentEnd + 3;
      visible.push(" ");
      continue;
    }

    const tag = readHtmlTag(input, tagStart);
    if (tag.kind === "literal") {
      visible.push("<");
      cursor = tagStart + 1;
      continue;
    }
    if (tag.kind === "unterminated") {
      // A malformed start tag is not executed. Preserve the remaining bytes
      // as text in one step so repeated '<' characters cannot trigger rescans.
      visible.push(input.slice(tagStart));
      break;
    }
    cursor = tag.after;

    if (tag.name === "title" && !tag.closing && title === null) {
      const close = findRawElementClose(input, lowercase, tag.after, "title");
      const rawTitle = close ? input.slice(tag.after, close.start) : input.slice(tag.after);
      title = normalizeWhitespace(decodeHtmlEntities(rawTitle.normalize("NFC"))).slice(0, MAX_TITLE_CHARS) || null;
      visible.push(" ");
      cursor = close?.after ?? input.length;
      continue;
    }

    if (!tag.closing && HTML_RAW_TEXT_TAGS.has(tag.name)) {
      const close = findRawElementClose(input, lowercase, tag.after, tag.name);
      // Raw-text elements run to EOF when their close tag is absent; their
      // contents are dropped instead of leaking into page evidence.
      visible.push(" ");
      cursor = close?.after ?? input.length;
      continue;
    }

    if (tag.name === "br" || tag.name === "hr" || HTML_BLOCK_TAGS.has(tag.name)) {
      visible.push("\n");
    } else {
      visible.push(" ");
    }
  }

  const normalized = normalizeWhitespace(decodeHtmlEntities(visible.join("")).normalize("NFC"));
  return { text: normalized, title };
}

type HtmlTagRead =
  | { kind: "tag"; name: string; closing: boolean; after: number }
  | { kind: "literal" }
  | { kind: "unterminated" };

function readHtmlTag(input: string, start: number): HtmlTagRead {
  let cursor = start + 1;
  if (input[cursor] === "!" || input[cursor] === "?") {
    const after = scanHtmlTagEnd(input, cursor);
    return after === null ? { kind: "unterminated" } : { kind: "tag", name: "!", closing: false, after };
  }
  let closing = false;
  if (input[cursor] === "/") {
    closing = true;
    cursor++;
  }
  const nameStart = cursor;
  if (!isAsciiLetter(input.charCodeAt(cursor))) return { kind: "literal" };
  cursor++;
  while (cursor < input.length && isHtmlTagNameCode(input.charCodeAt(cursor))) cursor++;
  const name = input.slice(nameStart, cursor).toLowerCase();
  const after = scanHtmlTagEnd(input, cursor);
  return after === null ? { kind: "unterminated" } : { kind: "tag", name, closing, after };
}

function scanHtmlTagEnd(input: string, from: number): number | null {
  let quote = 0;
  for (let cursor = from; cursor < input.length; cursor++) {
    const code = input.charCodeAt(cursor);
    if (quote !== 0) {
      if (code === quote) quote = 0;
    } else if (code === 34 || code === 39) {
      quote = code;
    } else if (code === 62) {
      return cursor + 1;
    }
  }
  return null;
}

function findRawElementClose(
  input: string,
  lowercase: string,
  from: number,
  name: string,
): { start: number; after: number } | null {
  const needle = `</${name}`;
  let candidate = lowercase.indexOf(needle, from);
  while (candidate >= 0) {
    const afterName = lowercase.charCodeAt(candidate + needle.length);
    if (afterName === 62 || afterName === 47 || isAsciiWhitespace(afterName)) {
      const after = scanHtmlTagEnd(input, candidate + needle.length);
      if (after !== null) return { start: candidate, after };
      return null;
    }
    candidate = lowercase.indexOf(needle, candidate + 2);
  }
  return null;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isHtmlTagNameCode(code: number): boolean {
  return isAsciiLetter(code) || (code >= 48 && code <= 57) || code === 45 || code === 58;
}

function isAsciiWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
}

function normalizeWhitespace(input: string): string {
  return input
    .replace(/[\u00a0\u2007\u202f]/gu, " ")
    .replace(/[\t\f\v ]+/gu, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function decodeHtmlEntities(input: string): string {
  const named: Record<string, string> = {
    amp: "&", apos: "'", copy: "©", gt: ">", lt: "<", mdash: "—", nbsp: " ", ndash: "–",
    quot: '"', reg: "®", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", trade: "™",
  };
  return input.replace(/&(#(?:x[\da-f]+|\d+)|[a-z][a-z\d]+);/giu, (entity, token: string) => {
    if (token[0] !== "#") return named[token.toLowerCase()] ?? entity;
    const value = token[1]?.toLowerCase() === "x"
      ? Number.parseInt(token.slice(2), 16)
      : Number.parseInt(token.slice(1), 10);
    if (!Number.isInteger(value) || value < 1 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return "�";
    return String.fromCodePoint(value);
  });
}

function header(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const key = Object.keys(headers).find((entry) => entry.toLowerCase() === name);
  const value = key ? headers[key] : undefined;
  return typeof value === "string" ? value : undefined;
}

function safelyCancel(response: PinnedSourceResponse): void {
  try {
    response.cancel();
  } catch {
    // Resource cleanup is best-effort; the typed coverage result stays safe.
  }
}

function sourceError(code: SourceReaderErrorCode): SourceReaderError {
  const { reason, detail } = ERROR_DETAILS[code];
  return new SourceReaderError(code, reason, detail);
}

interface OperationScope {
  signal: AbortSignal;
  abortError(): SourceReaderError;
  dispose(): void;
}

function createOperationScope(callerSignal: AbortSignal, timeoutMs: number): OperationScope {
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    abortError: () => sourceError(callerSignal.aborted ? "CANCELLED" : timedOut ? "TIME_LIMIT" : "CANCELLED"),
    dispose: () => {
      clearTimeout(timer);
      callerSignal.removeEventListener("abort", onCallerAbort);
    },
  };
}

function throwIfAborted(scope: OperationScope): void {
  if (scope.signal.aborted) throw scope.abortError();
}

function raceWithAbort<T>(promise: Promise<T>, scope: OperationScope): Promise<T> {
  if (scope.signal.aborted) return Promise.reject(scope.abortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      scope.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(scope.abortError()));
    scope.signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function requestPinnedNodeHttp(input: PinnedSourceRequest): Promise<PinnedSourceResponse> {
  if (input.signal.aborted) throw sourceError("CANCELLED");
  const hostname = hostWithoutBrackets(input.url.hostname);
  const nativeRequest = input.url.protocol === "https:" ? httpsRequest : httpRequest;
  const options: RequestOptions = {
    protocol: input.url.protocol,
    hostname,
    port: input.url.port ? Number(input.url.port) : undefined,
    path: `${input.url.pathname}${input.url.search}`,
    method: "GET",
    headers: {
      Host: input.url.host,
      Accept: "text/html, text/plain, application/xhtml+xml;q=0.9",
      "Accept-Encoding": "identity",
      "User-Agent": "idea-maze-source-reader/1.0",
      Connection: "close",
    },
    agent: false,
    maxHeaderSize: RESPONSE_HEADER_LIMIT,
    signal: input.signal,
    family: input.family,
    // For DNS names, this callback pins the socket to the exact vetted record
    // even if DNS changes between validation and connect. hostname remains the
    // original authority for Host and TLS certificate/SNI checks.
    ...(isIP(hostname) === 0 ? {
      servername: input.url.protocol === "https:" ? hostname : undefined,
      lookup: (_hostname: string, _lookupOptions: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
        callback(null, input.address, input.family);
      },
    } : {}),
  };
  if (options.maxHeaderSize !== undefined && options.maxHeaderSize > RESPONSE_HEADER_LIMIT) {
    throw sourceError("FETCH_FAILED");
  }

  return new Promise<PinnedSourceResponse>((resolve, reject) => {
    const request = nativeRequest(options, (response: IncomingMessage) => {
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (typeof value === "string") headers[name] = value;
      }
      resolve({
        status: response.statusCode ?? 0,
        headers,
        body: response,
        cancel: () => {
          response.destroy();
          request.destroy();
        },
      });
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("request timeout")));
    request.once("error", reject);
    request.end();
  });
}
