# Documentation

Start with the [project README](../README.md) for purpose, supported sources,
installation, and the first run.

| Document | Use it for |
| --- | --- |
| [Configuration](configuration.md) | Environment variables, subreddit setup, storage, and provider data flow |
| [CLI guide](cli.md) | Research, review, exploration, inspection, and maintenance commands |
| [Architecture decisions](adr/README.md) | Implemented design decisions ordered by adoption date |
| [Quote evaluation](evidence-quote-evaluation-2026-09-24.md) | Reproducing the synthetic evidence-grounding evaluation |
| [Publication audit](security-audit.md) | Audit scope, findings, and historical privacy follow-up |
| [Security guidance](../SECURITY.md) | Credentials, private runtime data, and vulnerability reports |

## Proposals

[Discovery-gate recalibration](proposals/discovery-gate-recalibration.md) is an
unimplemented historical proposal. It is kept separately from accepted ADRs so
it cannot be mistaken for current behavior.

The former `docs/plans/` implementation checklists have been replaced by concise
decision records and current usage instructions. Commit references in the ADRs
preserve the implementation timeline without deployment transcripts, personal
reviewer details, or private host paths.
