import { createHash } from 'node:crypto';

export type EvidenceExcerptRole = 'pain' | 'workaround' | 'wtp' | 'time_loss';

/**
 * A quote grounded in the exact `source_items.text` value.
 * Offsets are zero-based, end-exclusive JavaScript UTF-16 code-unit offsets.
 */
export interface EvidenceExcerptV1 {
  version: 1;
  sourceItemId: number;
  role: EvidenceExcerptRole;
  quote: string;
  sourceTextHash: string;
  startUtf16: number;
  endUtf16: number;
}

export interface SourceTextWindow {
  startUtf16: number;
  endUtf16: number;
  text: string;
}

export interface SourceTextSample {
  complete: boolean;
  originalLengthUtf16: number;
  windows: SourceTextWindow[];
  formatted: string;
}

const EVIDENCE_ROLES = new Set<EvidenceExcerptRole>([
  'pain',
  'workaround',
  'wtp',
  'time_loss',
]);
const HTML_TAG = /^<\s*\/?\s*(?:a|abbr|b|blockquote|br|code|del|div|em|h[1-6]|hr|i|img|li|ol|p|pre|s|span|strong|sub|sup|table|tbody|td|th|thead|tr|u|ul)(?![\w:-])(?:\s+[^<>]*?)?\s*\/?>/i;

function decodeHtmlEntity(entity: string): string | null {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    mdash: '—',
    nbsp: ' ',
    ndash: '–',
    quot: '"',
    rsquo: '’',
    lsquo: '‘',
    rdquo: '”',
    ldquo: '“',
  };
  const body = entity.slice(1, -1);
  const lower = body.toLowerCase();
  if (lower in named) return named[lower];

  const numeric = body.match(/^#(?:x([\da-f]+)|(\d+))$/i);
  if (!numeric) return null;
  const codePoint = numeric[1]
    ? Number.parseInt(numeric[1], 16)
    : Number.parseInt(numeric[2], 10);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return null;
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return null;
  }
}

interface VisibleText {
  text: string;
  sourceStarts: number[];
  sourceEnds: number[];
}

/** Remove markup and decode common entities while retaining a map to source offsets. */
function toVisibleText(sourceText: string): VisibleText {
  let text = '';
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];

  const append = (value: string, start: number, end: number) => {
    text += value;
    for (let index = 0; index < value.length; index++) {
      sourceStarts.push(start);
      sourceEnds.push(end);
    }
  };

  for (let index = 0; index < sourceText.length;) {
    if (sourceText[index] === '<') {
      const tagMatch = sourceText.slice(index).match(HTML_TAG);
      if (tagMatch) {
        index += tagMatch[0].length;
        continue;
      }
    }

    if (sourceText[index] === '&') {
      const entityMatch = sourceText.slice(index).match(/^&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]+);/);
      if (entityMatch) {
        const entity = entityMatch[0];
        const decoded = decodeHtmlEntity(entity);
        if (decoded !== null) {
          append(decoded, index, index + entity.length);
          index += entity.length;
          continue;
        }
      }
    }

    const codePoint = sourceText.codePointAt(index);
    if (codePoint === undefined) break;
    const value = String.fromCodePoint(codePoint);
    append(value, index, index + value.length);
    index += value.length;
  }

  return { text, sourceStarts, sourceEnds };
}

interface NormalizedText {
  value: string;
  sourceStarts: number[];
  sourceEnds: number[];
}

function normalizeForGrounding(value: string, visible = toVisibleText(value)): NormalizedText {
  let normalized = '';
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];
  let pendingWhitespace: { start: number; end: number } | null = null;
  const append = (chunk: string, start: number, end: number) => {
    normalized += chunk;
    for (let index = 0; index < chunk.length; index++) {
      sourceStarts.push(start);
      sourceEnds.push(end);
    }
  };

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const segment of segmenter.segment(visible.text)) {
    const start = segment.index;
    const end = start + segment.segment.length;
    const sourceStart = visible.sourceStarts[start];
    const sourceEnd = visible.sourceEnds[end - 1];
    if (/^\s+$/u.test(segment.segment)) {
      if (normalized && normalized.at(-1) !== ' ') {
        pendingWhitespace = pendingWhitespace
          ? { start: pendingWhitespace.start, end: sourceEnd }
          : { start: sourceStart, end: sourceEnd };
      } else if (pendingWhitespace) {
        pendingWhitespace.end = sourceEnd;
      }
      continue;
    }

    if (pendingWhitespace) {
      append(' ', pendingWhitespace.start, pendingWhitespace.end);
      pendingWhitespace = null;
    }
    append(segment.segment.normalize('NFC').toLowerCase(), sourceStart, sourceEnd);
  }

  return { value: normalized.trim(), sourceStarts, sourceEnds };
}

function removeNormalizedTrimOffsetMap(value: NormalizedText): NormalizedText {
  const leading = value.value.length - value.value.trimStart().length;
  const trailing = value.value.length - value.value.trimEnd().length;
  return {
    value: value.value.trim(),
    sourceStarts: value.sourceStarts.slice(leading, value.sourceStarts.length - trailing),
    sourceEnds: value.sourceEnds.slice(leading, value.sourceEnds.length - trailing),
  };
}

export function hashSourceText(sourceText: string): string {
  return createHash('sha256').update(sourceText, 'utf8').digest('hex');
}

function isInsideRanges(
  startUtf16: number,
  endUtf16: number,
  ranges?: SourceTextWindow[],
): boolean {
  return !ranges || ranges.some(
    (range) => startUtf16 >= range.startUtf16 && endUtf16 <= range.endUtf16,
  );
}

/**
 * Recover the exact original substring matching a model-provided quote.
 * Normalization is only used to locate the quote; the returned value always
 * comes from `sourceText.slice(startUtf16, endUtf16)`.
 */
export function recoverEvidenceQuote(
  sourceText: string,
  candidate: string,
  options: { visibleRanges?: SourceTextWindow[]; maxQuoteLength?: number } = {},
): { quote: string; sourceTextHash: string; startUtf16: number; endUtf16: number } | null {
  const query = candidate.trim();
  if (!query || query.length > (options.maxQuoteLength ?? 800)) return null;
  const normalizedQuery = removeNormalizedTrimOffsetMap(normalizeForGrounding(query));
  if (!/[\p{L}\p{N}]/u.test(normalizedQuery.value)) return null;
  const normalizedSource = removeNormalizedTrimOffsetMap(normalizeForGrounding(sourceText));
  let index = normalizedSource.value.indexOf(normalizedQuery.value);
  while (index >= 0) {
    const end = index + normalizedQuery.value.length;
    const startUtf16 = normalizedSource.sourceStarts[index];
    const endUtf16 = normalizedSource.sourceEnds[end - 1];
    if (isInsideRanges(startUtf16, endUtf16, options.visibleRanges)) {
      return {
        quote: sourceText.slice(startUtf16, endUtf16),
        sourceTextHash: hashSourceText(sourceText),
        startUtf16,
        endUtf16,
      };
    }
    index = normalizedSource.value.indexOf(normalizedQuery.value, index + 1);
  }

  return null;
}

export function createEvidenceExcerpt(
  input: {
    sourceItemId: number;
    role: EvidenceExcerptRole;
    sourceText: string;
    candidate: string;
    visibleRanges?: SourceTextWindow[];
  },
): EvidenceExcerptV1 | null {
  if (!EVIDENCE_ROLES.has(input.role)) return null;
  const grounded = recoverEvidenceQuote(input.sourceText, input.candidate, {
    visibleRanges: input.visibleRanges,
  });
  if (!grounded) return null;
  return {
    version: 1,
    sourceItemId: input.sourceItemId,
    role: input.role,
    ...grounded,
  };
}

export function verifyEvidenceExcerpt(
  input: { sourceItemId: number; sourceText: string; excerpt: unknown },
): EvidenceExcerptV1 | null {
  if (!input.excerpt || typeof input.excerpt !== 'object' || Array.isArray(input.excerpt)) return null;
  const excerpt = input.excerpt as Partial<EvidenceExcerptV1>;
  if (
    excerpt.version !== 1 ||
    excerpt.sourceItemId !== input.sourceItemId ||
    typeof excerpt.role !== 'string' || !EVIDENCE_ROLES.has(excerpt.role as EvidenceExcerptRole) ||
    typeof excerpt.quote !== 'string' ||
    typeof excerpt.sourceTextHash !== 'string' ||
    !Number.isSafeInteger(excerpt.startUtf16) ||
    !Number.isSafeInteger(excerpt.endUtf16)
  ) return null;

  const startUtf16 = excerpt.startUtf16 as number;
  const endUtf16 = excerpt.endUtf16 as number;
  if (
    startUtf16 < 0 || endUtf16 <= startUtf16 || endUtf16 > input.sourceText.length ||
    excerpt.sourceTextHash !== hashSourceText(input.sourceText) ||
    input.sourceText.slice(startUtf16, endUtf16) !== excerpt.quote ||
    !/[\p{L}\p{N}]/u.test(removeNormalizedTrimOffsetMap(normalizeForGrounding(excerpt.quote)).value)
  ) return null;

  return excerpt as EvidenceExcerptV1;
}

function safeStartBoundary(text: string, index: number): number {
  if (index > 0 && index < text.length) {
    const before = text.charCodeAt(index - 1);
    const after = text.charCodeAt(index);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
      return index + 1;
    }
  }
  return index;
}

function safeEndBoundary(text: string, index: number): number {
  if (index > 0 && index < text.length) {
    const before = text.charCodeAt(index - 1);
    const after = text.charCodeAt(index);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
      return index - 1;
    }
  }
  return index;
}

function sliceWindow(text: string, start: number, end: number): SourceTextWindow {
  let safeStart = safeStartBoundary(text, start);
  let safeEnd = safeEndBoundary(text, end);
  safeEnd = Math.max(safeStart, safeEnd);
  return { startUtf16: safeStart, endUtf16: safeEnd, text: text.slice(safeStart, safeEnd) };
}

/** Select deterministic head/center/tail windows within a fixed text budget. */
export function sampleSourceText(sourceText: string, maxChars: number): SourceTextSample {
  const budget = Math.max(1, Math.floor(maxChars));
  if (budget < 3) throw new RangeError('Source text sample budget must be at least 3 UTF-16 code units.');
  if (sourceText.length <= budget) {
    const windows = [{ startUtf16: 0, endUtf16: sourceText.length, text: sourceText }];
    return {
      complete: true,
      originalLengthUtf16: sourceText.length,
      windows,
      formatted: `[complete source text; UTF-16 range 0..${sourceText.length}]\n${sourceText}`,
    };
  }

  const windowCount = sourceText.length >= budget * 2 ? 3 : 2;
  const baseSize = Math.floor(budget / windowCount);
  const sizes = Array.from({ length: windowCount }, (_, index) =>
    baseSize + (index < budget % windowCount ? 1 : 0),
  );
  const starts = windowCount === 2
    ? [0, sourceText.length - sizes[1]]
    : [0, Math.floor((sourceText.length - sizes[1]) / 2), sourceText.length - sizes[2]];
  const windows = starts.map((start, index) =>
    sliceWindow(sourceText, start, start + sizes[index]),
  ).filter((window) => window.text.length > 0);

  const formatted = [
    `[partial source sample; ${sourceText.length} UTF-16 code units total; showing ${windows.length} window(s)]`,
    ...windows.map((window) => `[UTF-16 ${window.startUtf16}..${window.endUtf16}]\n${window.text}`),
  ].join('\n… omitted source text …\n');
  return { complete: false, originalLengthUtf16: sourceText.length, windows, formatted };
}
