# ADR 0019: Expose hypothesis research through a shared-application CLI

- Status: Accepted
- Adopted: 2026-10-29

## Context

Operators need a local interface to the same cases, plans, runs, and evidence
used by agent clients. Private ideas should not need shell arguments, and a
short-lived CLI cannot safely detach work that belongs to its own process.

## Decision

Add an import-safe CLI dispatcher over the shared application and a thin runtime
entrypoint. Read one bounded UTF-8 JSON object from stdin, return a versioned
envelope on stdout, and keep diagnostics on stderr. Retain the frozen application
error vocabulary and stable CLI exit statuses. Help works without creating a
workspace. Document silent npm invocation for machine-readable stdout.

Start waits for terminal state and returns a bounded result page. Ctrl-C and a
wait deadline explicitly request cancellation, wait within a cleanup bound, and
report the last observed state if completion cannot be confirmed. Obtain the
accepted run ID before shutting down the CLI-owned runtime. Do not offer detach.
Bound pending calls as well as polling delays, and close abandoned stdin input.

## Consequences

The existing discovery commands retain their behavior. JSON and Markdown result
views use the shared renderer and pagination. The CLI can inspect work owned by
another process in the same canonical workspace. Interrupted cleanup does not
claim that a remote request was rolled back or cancelled successfully.

Synthetic tests exercise the real runtime, process help, stdin bounds, workflow,
signals, and provider stubs. They do not constitute live research validation.

## Implementation references

- `src/idea-maze/scripts/research-cli.ts`
- `src/idea-maze/scripts/research-cli-main.ts`
- `src/idea-maze/scripts/research-cli.test.ts`
- `docs/cli.md`
- [CLI task](https://github.com/bknstn/idea-maze-engine/issues/20)
