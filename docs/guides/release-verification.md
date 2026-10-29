# Release verification and limits

This record separates software installation and interface checks from
validation of research quality. The checks here use synthetic inputs and
isolated workspaces; they do not make live-provider, market-demand, or human
usefulness claims.

## Clean install and runtime compatibility

Reproduce the install from a clean copy of the tracked source at the revision
under review:

```bash
(
  VERIFY_DIR="$(mktemp -d)"
  trap 'rm -rf "$VERIFY_DIR"' EXIT
  git archive --format=tar HEAD | tar -x -C "$VERIFY_DIR"
  cd "$VERIFY_DIR"
  npm ci
  npm run verify
)
```

On 2026-10-29, a clean tracked-source archive of commit
`45be6465006d6af44b4a81e9b414498403ab4207` installed with Node.js 22.22.2 and
npm 10.9.7. `npm ci` added 106 packages, audited 107, and reported no known
vulnerabilities. The package declares Node.js 20 or newer, but this run did not
verify Node 20. For this release, Node.js 22.x is the verified baseline.

The installed native module was `better-sqlite3` 11.10.0, using SQLite
3.49.2. An in-memory native smoke check created and queried an FTS5 virtual
table. The lockfile uses MCP SDK v2 packages:
`@modelcontextprotocol/node` 2.1.2,
`@modelcontextprotocol/server` 2.4.0, and the development client
`@modelcontextprotocol/client` 2.4.0. See package.json and
package-lock.json for the complete pinned versions.

The full verification command passed TypeScript checking, the Vitest suite
(55 files and 453 tests), and the deployment data-transfer suite (3 tests).
The MCP runtime tests use the official SDK client against the real local HTTP
and stdio transports with injected synthetic providers. They verify protocol
and application wiring; they do not validate a live provider account.

## Interface smoke checks

Run the CLI capabilities check with a fresh workspace and no provider
credentials:

```bash
(
  SMOKE_HOME="$(mktemp -d)"
  trap 'rm -rf "$SMOKE_HOME"' EXIT
  IDEA_MAZE_HOME="$SMOKE_HOME" OPENAI_API_KEY= TAVILY_API_KEY= npm run --silent idea:research:cli -- capabilities
)
```

The response should show model and search as not configured, report the
resource ceilings, and still return successfully. The
[hypothesis research quickstart](hypothesis-research-quickstart.md) contains a
synthetic case-create request. The no-provider path can validate a supplied
plan or create a bounded local plan, but a run without available
collection/model providers returns `insufficient_evidence` with
`provider_unavailable` coverage gaps. Do not interpret that result as
support for or against the case.

The focused SDK client/server smoke suite can be run with:

```bash
npm test -- src/idea-maze/mcp/runtime.test.ts
```

Those tests bind HTTP only to loopback and use synthetic credentials and
injected provider implementations. The provider test doubles fail if an
unexpected external operation occurs. No live provider calls or recruitment
are part of release verification.

The self-hosted deployment's data-transfer tests are run with:

```bash
npm run test:deployment
```

The original data-transfer check passed 3 tests. The final command passes 8
tests including the HTTP health probe. It covers a consistent SQLite WAL snapshot,
artifact backup and restore, rejection of stale WAL/SHM files and collisions,
corrupt databases, and symlinks. `npm run verify` includes this deployment test
command.

The packaging configuration pins Node.js `22.23.4-bookworm-slim` at digest
`sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da` and
the Nginx `1.30.4-alpine3.24` proxy at digest
`sha256:dc5069ad14f19660b141b21236140b91656bf89bbc3e2417c70ae650cd66104c`.
The app image bundles application code, prunes development dependencies, and
retains unmodified production packages and their license files. See the
[self-hosting guide](self-hosting.md) for the single-owner workspace, UID/GID
`10001`, volume permissions, and restore procedure.

The opt-in container acceptance command is `npm run test:container`; it builds
the app image and runs a synthetic Compose smoke. The data-transfer unit tests
do not stand in for this container check. On 2026-10-29, the standard pinned
path passed in [CI run 40887419313](https://github.com/bknstn/idea-maze-engine/actions/runs/40887419313)
at commit `5dd91ef4dd9eafe63224575670319ba7887ead97`. All three jobs—container,
verification, and secret scanning—passed. The run checked native SQLite and the
non-root/read-only app, TLS authentication, disconnect/reconnect, graceful
interruption, persistence after restart, no repeated provider work, and a
synthetic backup/restore round trip. Verification passed 453 Vitest tests and
8 deployment tests. The smoke removes its task containers, images and synthetic
state; cleanup errors fail the check. This is engineering acceptance with
offline provider doubles, not a live deployment or usefulness result.

## Operating boundaries

The case-first service uses one local SQLite workspace owner. One MCP service
instance may share its database with CLI reads; do not run independent
replicated MCP service instances against a shared workspace. The lease and
fencing logic coordinates active runs and prevents stale writes, but it does
not provide multi-tenant isolation, a network database, or exactly-once remote
provider billing.

Back up the workspace before changing versions or starting schema migrations.
SQLite uses WAL mode, so a consistent backup must include WAL state or use a
SQLite backup mechanism; copying only the main database file while a writer is
active is unsafe. Test restoration into a fresh private workspace before
upgrading a valuable database. Keep workspace ownership and directory
permissions intact when restoring a self-hosted volume.

Provider calls may send selected case context, planned queries, fetched source
text, and excerpts outside the workspace. Model and search usage is recorded
when the provider reports it. Unknown token or cost values remain null, and the
query/page/time/token ceilings are not a hard monetary cap. Apply provider-side
spending limits when a hard cost ceiling is needed.

See the [MCP service guide](hypothesis-research-mcp.md) for bearer-token,
loopback, reverse-proxy, and transport configuration. See the
[self-hosting guide](self-hosting.md) for the packaged service, state volume,
permissions, and restore checks.

## Offline evaluation results are not a quality claim

The frozen hypothesis-research v1 evaluation used synthetic cases and mocked
search, original-source, and model providers. It does not measure model
accuracy, real-world discovery usefulness, market demand, or release quality.
The full results are in the
[evaluation report](../evaluations/hypothesis-research-v1.md).

The holdout was not a clean pass: 7 cases completed, 2 did not start, and 1 was
cancelled. The budget-boundary fixture h07 failed during planning because its
one-query limit conflicted with its two-query supplied plan; the report treats
that as a harness planning failure, not a successful engine result. Outcome
agreement was 1/8 cases where an assessment was expected; seven of those eight
assessments were observed, and h07 has no observed assessment. Expected-citation
recall and expected-evidence emission were each 0/8 expected citation IDs.
Eight of eight emitted verified-evidence links failed exact gold matching by
relationship and quotation; this is a link count, not eight cases or a count
of fabricated quotations. Manual unsupported-conclusion review also remains
pending for seven cases.

These numbers must not be compressed into an overall pass rate or usefulness
score. The report records the frozen inputs, case-level observations, and
limitations. The holdout was run once and is not a tuning target; preserve its
report rather than rerunning it to generate a more favorable result. A separate
consented human pilot has only a prepared protocol and has not been recruited
or executed.

## Dependency license inventory

The inventory was read from the installed package manifests after `npm ci`,
then cross-checked against package license files and lockfile metadata. There
were 106 installed package manifests and all declared license metadata; 103
package roots contained a named license or notice file. The three without a
separately named file were `@esbuild/darwin-arm64` 0.28.1,
`@rolldown/binding-darwin-arm64` 1.2.15, and `stackback` 0.0.2. They are
development-only dependencies and are excluded by `npm prune --omit=dev`.
That prune retained 44 production packages, each with declared license metadata
and a named license or notice file. The lockfile had 155 dependency entries;
49 optional packages for other platforms were not installed on this host, and
each still had license metadata in the lockfile. No dependency entry lacked
license metadata.

| Installed license metadata | Packages |
| --- | ---: |
| `MIT` | 82 |
| `ISC` | 10 |
| `Apache-2.0` | 8 |
| `BSD-3-Clause` | 2 |
| `MPL-2.0` | 2 |
| `BSD-2-Clause OR MIT OR Apache-2.0` | 1 |
| `MIT OR WTFPL` | 1 |

Direct runtime dependencies are `better-sqlite3` 11.10.0 (`MIT`),
`@modelcontextprotocol/node` 2.1.2 (`Apache-2.0`), and
`@modelcontextprotocol/server` 2.4.0 (`Apache-2.0`). The development
client `@modelcontextprotocol/client` 2.4.0 is `Apache-2.0`. The
installed Apache-2.0 packages contain LICENSE files; better-sqlite3 also
contains its MIT license.

The two MPL-2.0 packages are `lightningcss` 1.33.0 and
`lightningcss-darwin-arm64` 1.33.0, both in the development dependency
graph through Vitest and Vite. Each installed package contains its MPL license.
If a distribution includes either package, keep its license notices and make
the corresponding source form available as required by the
[MPL 2.0](https://www.mozilla.org/en-US/MPL/2.0/), including sections 3.1–3.4.
The packaging configuration prunes development dependencies, and the local
production-pruned inventory retained no MPL package. Verify the actual image
contents before distribution.

The two multi-license dependencies are transitive dependencies of
`better-sqlite3`'s prebuild-install path. `rc` 1.2.8 declares
`BSD-2-Clause OR MIT OR Apache-2.0` and includes all three license texts.
`expand-template` 2.0.3 declares `MIT OR WTFPL` and includes an MIT
license file. Preserve the selected license text and other package notices
when packaging these dependencies. Apache-2.0 package redistribution
conditions are in
[section 4 of the Apache License](https://www.apache.org/licenses/LICENSE-2.0).

This is a package-metadata and file-presence audit, not a legal opinion or a
determination that every possible redistribution configuration is compliant.
This documentation change adds no dependencies. Recheck the lockfile and the
contents of the actual release image whenever dependency versions or packaging
rules change.
