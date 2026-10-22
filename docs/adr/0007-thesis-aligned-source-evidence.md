# ADR 0007: Ground research eligibility in thesis-aligned evidence

- Status: Accepted
- Adopted: 2026-07-18
- Recorded retrospectively: 2026-10-22

## Context

Distinct source rows were not necessarily independent, relevant buyer evidence.
Generic pain words, crossposts, promotion, and unrelated willingness-to-pay
claims could pass the earlier gate.

## Decision

Evaluate source-to-thesis evidence cards with grounded source quotes. Deduplicate
source content, handle competing candidates in the current cohort, and keep
quality-adjusted automation scores separate from raw market scores. Use the
same production evaluator for draft revalidation and normal processing.

## Consequences

Research eligibility depends on support for the specific thesis, not only source
count or wording. The stricter gate can reduce discovery recall. A later
proposal to relax incomplete-evidence handling remains unimplemented and is
kept outside the accepted ADR sequence.

## Implementation history

- [Evidence alignment and duplicate handling (`ec5d50f`)](https://github.com/bknstn/idea-maze-engine/commit/ec5d50f)
- [Production evaluator for revalidation (`a91b952`)](https://github.com/bknstn/idea-maze-engine/commit/a91b952)
