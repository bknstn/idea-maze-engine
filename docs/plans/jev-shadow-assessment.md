# Optional Jev shadow assessment

Jev runs only on the existing research evidence path and cannot change source selection, the generated draft, or review-gate decisions. It is disabled unless all three runtime settings are present:

```dotenv
IDEA_MAZE_JEV_ENABLED=true
TYPESAFE_API_KEY=<account key>
IDEA_MAZE_JEV_MODEL=<model returned by this account's model inventory>
```

To disable it, unset `IDEA_MAZE_JEV_ENABLED` or set it to `false`. Do not put a guessed model alias in configuration. Before enabling, use the authenticated TypeSafe [`GET /v1/models`](https://docs.typesafe.ai/api) account inventory to select a model the account can access. No key or model is configured by this change.

The client sends one named-question request per eligible original source to [`POST /v1/systemone`](https://docs.typesafe.ai/api). It uses T3-verified excerpts and the existing bounded, explicitly labeled `formatSourceEvidence` context. Sources without a currently verified excerpt and search-discovery results are not assessed. The tailquote, workaround, and contradiction dimensions are diagnostic only; failures and malformed/missing answers remain unknown and retain the original research evidence.

The full source text hash, opportunity state, exact verified excerpts, named questions, rubric version, and requested model form the persistent cache key. Successful complete assessments are cached in the existing `app_state` table. Cache values store hashes, dimensions, model names, usage, and timings; they do not copy raw source text. Current-run token totals exclude cache hits and remain `null` when any attempted request omitted usage. Provider-reported input/output token counts and client latency are recorded per entry. The client makes no automatic retries and uses one bounded total assessment deadline and input-byte budget.

The assessment trace is written to the research run metadata and `research.jev_shadow` run event. It includes cache hits, unknown/error counts, scores, usage, latency, source hashes, cache keys, requested/returned models, and rubric version. Search snippets remain discovery/context only and are never passed as primary Jev candidates. Live validation requires account credentials and an enabled model; this change uses mocked responses only.
