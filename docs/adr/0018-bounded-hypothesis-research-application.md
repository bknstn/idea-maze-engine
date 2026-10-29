# ADR 0018: Compose a bounded hypothesis research application

- Status: Accepted
- Adopted: 2026-10-29

## Context

The case, planning, collection, evidence, assessment, and coordination libraries
need one application boundary shared by CLI and MCP. Collection failures and
omitted source text must remain visible without becoming claims of absent demand.

## Decision

Compose the nine frozen application methods over an explicit workspace context.
The runtime factory snapshots configuration, derives workspace identity from the
canonical filesystem root, initializes the owned database, and drains service
work before disposal. Diagnostics failures cannot skip run cleanup. Imports do
not open a workspace or call providers.

Execute the immutable plan through guarded search, retrieval, model mapping, and
deterministic assessment. Follow-ups address named gaps using unused previewed
queries and remain inside the assess phase of the four-step run contract.
Persist completed evidence and coverage incrementally; save the assessment once
after bounded collection. Cancellation before assessment can leave a null
assessment alongside retained partial evidence.

Treat snippets and URL-only leads as discovery data. Fetch each discovered URL
at most once per run. Record lead caps, omitted originals, bounded text windows,
unavailable providers, and exhausted budgets explicitly. Model candidates must
reference text actually submitted for classification and then pass verification
against the immutable full original. Bound source memory to the active/latest
run; clear it after assessment, at next-run startup, and on shutdown.

Keep model routing behind registered provider adapters. Explicit runtime
bindings require adapters that honor the supplied environment and input-token
admission. Legacy wrappers retain their defaults. The built-in adapter uses a
conservative serialized UTF-8 byte bound plus a framing reserve for its fixed
two-message shape; changes to that shape/tokenizer require re-review. Actual
usage and cost remain unknown when the adapter does not report them.

Mark new original-source rows as hypothesis-research data and exclude that
marker from the legacy extraction feed. Preserve legacy rows and discovery gates.

## Consequences

CLI and MCP share evidence policy, revision checks, budgets, and cancellation.
Missing or failed collection produces a limited result rather than fabricated
evidence. Unknown model usage can prevent further classification within the
reserved budget. Source windows and follow-up bounds limit completeness and are
reported as coverage gaps.

Synthetic end-to-end tests exercise the actual composed application with mocked
providers. They do not validate live providers, market demand, or usefulness to
human participants. Deployment and the human pilot remain separate work.

## Implementation references

- `src/idea-maze/research/{orchestrator,runtime,model-adapter}.ts` and their tests
- `src/idea-maze/research/ports.ts`
- `src/idea-maze/scripts/lib/{llm,queries}.ts` and their tests
- [Research-loop task](https://github.com/bknstn/idea-maze-engine/issues/19)
