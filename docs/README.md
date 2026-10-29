# Documentation

Start with the [project README](../README.md) for purpose, supported sources,
installation, and the first run.

| Document | Use it for |
| --- | --- |
| [Configuration](configuration.md) | Environment variables, subreddit setup, storage, and provider data flow |
| [CLI guide](cli.md) | Research, review, exploration, inspection, and maintenance commands |
| [Hypothesis research quickstart](guides/hypothesis-research-quickstart.md) | Start a user-led case and hypothesis through the shared application |
| [Hypothesis research workflow example](examples/hypothesis-research-workflow.md) | Follow a synthetic case through the CLI, HTTP MCP, and stdio MCP interfaces |
| [MCP service guide](guides/hypothesis-research-mcp.md) | Authenticated HTTP and local stdio setup, lifecycle, and privacy boundaries |
| [Self-hosted MCP service](guides/self-hosting.md) | Pinned Compose package, local state volume, backup, and restore |
| [Release verification](guides/release-verification.md) | Clean install, runtime compatibility, dependency licenses, evaluation limits |
| [Hypothesis research evaluation](evaluations/hypothesis-research-v1.md) | Frozen mocked-provider results and their limitations |
| [Architecture decisions](adr/README.md) | Implemented design decisions ordered by adoption date |
| [Quote evaluation](evidence-quote-evaluation-2026-09-24.md) | Reproducing the synthetic evidence-grounding evaluation |
| [Publication audit](security-audit.md) | Audit scope, findings, and historical privacy follow-up |
| [Security guidance](../SECURITY.md) | Credentials, private runtime data, and vulnerability reports |

## Proposals

[User-led hypothesis research and MCP delivery plan](proposals/hypothesis-research-mcp-plan.md)
tracks the roadmap and remaining release work. Implemented interfaces are documented
in the [CLI guide](cli.md#case-first-hypothesis-research-cli),
[MCP guide](guides/hypothesis-research-mcp.md), and accepted ADRs.

[Discovery-gate recalibration](proposals/discovery-gate-recalibration.md) is an
unimplemented historical proposal. It is kept separately from accepted ADRs so
it cannot be mistaken for current behavior.

The former `docs/plans/` implementation checklists have been replaced by concise
decision records and current usage instructions. Commit references in the ADRs
preserve the implementation timeline without deployment transcripts, personal
reviewer details, or private host paths.
