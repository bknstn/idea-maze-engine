# ADR 0010: Route model work by task behind provider adapters

- Status: Accepted
- Adopted: 2026-08-15
- Recorded retrospectively: 2026-10-22

## Context

Vendor-specific calls and implicit cross-provider fallback coupled pipeline
stages to authentication, model naming, and response formats.

## Decision

Route extraction, research, and exploration through LlmProviderAdapter. Register
adapters centrally; select the provider and each task model explicitly through
environment variables. Use OpenAI as the built-in adapter and remove implicit
cross-provider fallback. Request JSON mode for structured OpenAI responses.

## Consequences

Pipeline stages do not translate vendor model identifiers or branch on vendors.
New adapters own their authentication, HTTP formats, parsing, and errors.
Extraction's heuristic fallback and research's quarantined template fallback
are separate from cross-provider routing.

## Implementation history

- [Portable provider boundary and model routing (`1b2c89d`)](https://github.com/bknstn/idea-maze-engine/commit/1b2c89d)
- [Structured JSON response mode (`1921fdb`)](https://github.com/bknstn/idea-maze-engine/commit/1921fdb)
