# ADR 0015: Assess claims from verified evidence and bound report pages

- Status: Accepted
- Adopted: 2026-10-29

## Context

A research result must distinguish a lack of evidence from unavailable
collection, retain counterevidence, and remain useful without a numerical market
score. Agent clients also need report pages that fit the transport's byte limit.

## Decision

Assess the immutable run hypotheses using persisted, source-bound excerpts.
Reverify each excerpt against its exact original-source version and recompute
source dependency groups over all run evidence. Search snippets remain retrieval
leads. Relationship classifications are interpretations, not proof of market
prevalence or independent authorship.

Return claim-level outcomes and evidence IDs, collection gaps, missing evidence,
caller-provided alternatives labeled as unverified, and a next experiment. Keep
the aggregate outcome insufficient when a claim lacks direct evidence, while
preserving mixed supporting and challenging findings.

Render JSON and Markdown from the same page model. Bind continuation cursors to
the run and a digest of the complete result. Reject stale cursors after partial
results change. Shrink evidence pages to satisfy both the Markdown character
limit and a conservative byte budget for duplicated MCP text/structured output.
If the repeated assessment and gaps cannot fit, return a safe bounded failure.

## Consequences

Reports retain uncertainty and traceable evidence without equating a verified
quotation with a true interpretation. Different URLs do not establish distinct
authors. Reading a result triggers no providers or filesystem writes. A client
reading changing partial results may need to restart pagination.

These services are library components. Research-loop orchestration and CLI/MCP
application wiring are integrated separately. Synthetic regression tests do not
constitute a live product-usefulness evaluation.

## Implementation references

- `src/idea-maze/research/assessment.ts` and its tests
- `src/idea-maze/research/report-renderer.ts` and its tests
- [Assessment and report task](https://github.com/bknstn/idea-maze-engine/issues/17)
