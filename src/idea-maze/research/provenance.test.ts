import { describe, expect, it } from "vitest";

import { hashSourceText } from "../scripts/lib/evidence-excerpts.ts";
import { verifyResearchExcerpt } from "./provenance.ts";

describe("research excerpt provenance", () => {
  const sourceText = "The build process runs on a small local device.";
  const quote = "build process runs";
  const startUtf16 = sourceText.indexOf(quote);

  function excerpt(role: "claim" | "pain" = "claim") {
    return {
      version: 1,
      sourceItemId: 4,
      role,
      quote,
      sourceTextHash: hashSourceText(sourceText),
      startUtf16,
      endUtf16: startUtf16 + quote.length,
    };
  }

  it("grounds a generic claim without changing it into a legacy pain role", () => {
    expect(verifyResearchExcerpt({ sourceItemId: 4, sourceText, excerpt: excerpt("claim") })).toEqual(excerpt("claim"));
  });

  it("continues to verify legacy research-compatible roles", () => {
    expect(verifyResearchExcerpt({ sourceItemId: 4, sourceText, excerpt: excerpt("pain") })).toMatchObject({ role: "pain" });
  });

  it.each([
    (value: ReturnType<typeof excerpt>) => ({ ...value, startUtf16: value.startUtf16 + 0.5 }),
    (value: ReturnType<typeof excerpt>) => ({ ...value, quote: "a fabricated quotation" }),
    (value: ReturnType<typeof excerpt>) => ({ ...value, sourceTextHash: "0".repeat(64) }),
    (value: ReturnType<typeof excerpt>) => ({ ...value, unexpected: true }),
  ])("rejects excerpts that do not exactly ground in the original", (corrupt) => {
    expect(verifyResearchExcerpt({ sourceItemId: 4, sourceText, excerpt: corrupt(excerpt()) })).toBeNull();
  });
});
