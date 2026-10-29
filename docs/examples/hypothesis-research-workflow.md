# Hypothesis research across the CLI and MCP

The CLI and MCP adapters use the same research application and workspace. If both processes use the same `IDEA_MAZE_HOME` (or the same current directory when it is unset), either interface can read the cases, plans, runs, and results created by the other.

Use synthetic data when trying the flow below. The idea text stays on standard input for the CLI and in tool arguments for MCP; do not put it in shell arguments. Provider configuration may send selected case details, queries, retrieved text, and excerpts to the configured providers.

## Create and plan a case with the CLI

```sh
npm run --silent idea:research:cli -- case-create <<'JSON'
{
  "idempotencyKey": "example-case-create-0001",
  "intake": {
    "ideaSummary": "A sample weekly inventory reconciliation helper",
    "targetUser": "Small operations teams",
    "problem": "Teams repeat a manual stock reconciliation each week",
    "proposedSolution": "A compact checklist for recurring stock reconciliation",
    "currentAlternatives": ["A shared tally sheet"]
  },
  "hypotheses": [
    { "claim": "Small operations teams repeat a weekly inventory reconciliation." }
  ]
}
JSON
```

Use the returned `caseId`, revision, and active `hypothesisId` to save a supporting and a challenging query. The example limits are intentionally small.

```json
{
  "idempotencyKey": "example-plan-create-0001",
  "caseId": "case_from_create_response",
  "expectedCaseRevision": 1,
  "suppliedPlan": {
    "queries": [
      {
        "text": "weekly stock reconciliation workflow reports",
        "purpose": "problem_language",
        "evidenceIntent": "supporting",
        "hypothesisIds": ["hypothesis_from_create_response"],
        "sourceScopes": ["public_web"]
      },
      {
        "text": "small team monthly stock tally alternatives",
        "purpose": "counterevidence",
        "evidenceIntent": "challenging",
        "hypothesisIds": ["hypothesis_from_create_response"],
        "sourceScopes": ["community_discussions"]
      }
    ],
    "limits": {
      "maxQueries": 2,
      "maxFetchedPages": 2,
      "maxFollowUpRounds": 0,
      "maxWallTimeSeconds": 60,
      "maxModelInputTokens": 3000,
      "maxModelOutputTokens": 1000
    }
  }
}
```

Pass that object on standard input to `npm run --silent idea:research:cli -- plan`. The response contains the saved `planId`. Start with the exact case revision and plan:

```sh
npm run --silent idea:research:cli -- start --poll-interval-ms 500 <<'JSON'
{
  "idempotencyKey": "example-run-start-0001",
  "caseId": "case_from_create_response",
  "expectedCaseRevision": 1,
  "planId": "plan_from_plan_response"
}
JSON
```

The CLI waits for a terminal status and returns a result page. Its `runId` can also be used with the `status` and `result` commands.

## Continue through MCP

An MCP client can call `research_case_get`, `research_plan`, `research_start`, `research_status`, and `research_result` with the same IDs. MCP `research_start` returns a run receipt promptly; poll `research_status` until the run is terminal, then page through `research_result`. A later `research_case_update` appends a new case revision. Existing runs continue to refer to their saved case and plan snapshot.

The MCP tool argument schemas contain no workspace or filesystem path fields. The workspace is selected by service configuration. Budget limits and unknown fields are validated at the application boundary.

To stop active service-owned work, call `research_cancel` with its `runId` and an idempotency key. Closing an HTTP client leaves the run attached to the service; reconnect to the same endpoint and workspace to inspect it. Stdio EOF shuts down its process and marks any unfinished owned run interrupted.

HTTP requires a bearer credential with an explicit future expiry. Configure credentials and the local workspace through the service environment; do not put tokens in URLs, shell arguments, examples, or tool inputs. The [MCP service guide](../guides/hypothesis-research-mcp.md) describes the HTTP and stdio setup.

## Verification scope

`src/idea-maze/research/workflow-integration.test.ts` exercises equivalent synthetic evidence through the CLI dispatcher and official HTTP MCP client, then reads persisted results through a CLI process and an official stdio MCP client. Its mock providers are designed to check adapter and workspace integration; they do not measure research quality or market demand. The MCP runtime tests also cover HTTP reconnect behavior and the interruption recorded after stdio shutdown.
