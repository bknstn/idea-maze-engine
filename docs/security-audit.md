# Publication audit — 2026-10-22

## Scope and method

The public repository was mirrored for inspection before publication cleanup.
The original audit covered all eight public branches and seven advertised pull-request
refs: 54 reachable commits and 270 unique file versions. Both Git patches and
every reachable file version were scanned with Gitleaks 8.30.1 using its default
rules and full redaction. The scanner archive was checked against the official
release checksum. No finding suppressions were added.

Additional checks covered credential assignments, private keys, token formats,
credential-bearing URLs, personal email addresses, names, host paths, sensitive
filenames, and commit author/committer/trailer metadata. Test credentials were
reviewed as synthetic values. The review also included all six public PR/issue
records, the issue/review comment endpoints (both empty), the release list
(empty), and both downloadable CI SARIF artifacts.

The publication tree was checked separately, including new documentation,
configuration examples, and CI. Runtime data, local credentials, and ignored
personal files are outside the publication scan and were not copied into it.

## Findings and preparation changes

- **No credentials, passwords, API tokens, or private keys were detected** in
  the audited Git content, public PR metadata, or CI artifacts.
- No environment credential files, session files, or runtime databases were
  present in the reachable tracked filename history.
- Old implementation plans included a personal reviewer name and deployment
  paths. They have been replaced by dated ADRs, current
  usage guides, and a separate unimplemented proposal.
- The default human-review actor was owner-specific. The prepared code uses
  `user`; explicit identities supplied by library callers remain supported.
- Ignore rules now cover environment overrides, common credential/session
  formats, database copies, and logs. The public environment template contains
  empty credential fields.
- CI verifies the project and scans Git history using checksum-verified,
  version-pinned Gitleaks. GitHub Actions are pinned to commit SHAs and receive
  read-only repository permissions.

## Authorized history cleanup

The original history contained personal information: fifty reachable commits
used personal email addresses for authorship. Names and email addresses also
occurred in commit metadata/trailers; one historical implementation plan included
an email in a commit example. Older file versions retained a reviewer name and
deployment paths.

With the repository owner's explicit approval, all eight public branch histories
were rewritten. Human identities now use a public handle or neutral contributor
label with no-reply addresses. Personal metadata and historical file content
were sanitized, and ADR commit references were updated to the rewritten IDs.
Every reachable file version and commit metadata in the replacement history
was checked again before publishing with explicit branch leases.

**Existing clones must be resynchronized with the rewritten branches.** Avoid
merging an old branch history back into the public repository. Commit IDs have
changed; the removed personal values are not reproduced in this report.

GitHub-controlled PR refs and cached old commits cannot be replaced by a branch
push. They may retain the original content and need separate GitHub-side
follow-up. Forks and existing third-party copies can also retain earlier data;
editing or rewriting branch history cannot make those copies private.

## Validation

The lockfile was updated with compatible fixes for five reported development
dependency vulnerabilities. A clean `npm ci` reports zero known vulnerabilities,
and `npm run verify` passes all 198 tests in 32 files. The README configuration
snippet, empty database initialization, heuristic extraction/refresh on synthetic
data, JSON inspection commands, and deterministic quote evaluation were checked
with provider credentials disabled.

## Limits

This is a point-in-time review of repository content and the listed public
surfaces, not a guarantee that every possible secret or personal datum is
detectable. Secret scanning does not enforce privacy of Git author metadata.
Generated research and live run logs require review before being shared.

Temporary mirrors, scanner binaries, extracted artifacts, and raw audit reports
are not repository deliverables and are removed after validation. See
[SECURITY.md](../SECURITY.md) for ongoing handling and reporting guidance.
