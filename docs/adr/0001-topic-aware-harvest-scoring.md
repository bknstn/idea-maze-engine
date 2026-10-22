# ADR 0001: Topic-aware deterministic harvest scoring

- Status: Accepted
- Adopted: 2026-05-28
- Recorded retrospectively: 2026-10-22

## Context

Generic business terms and HTML noise could outweigh concrete problems in
health, learning, productivity, and travel discussions. Adding global keywords
alone increased unrelated matches.

## Decision

Normalize feed text and apply deterministic signal weights with subreddit/topic
context. Downweight promotional and generic matches. Keep scoring metadata
inspectable and use regression fixtures plus a harvest inspection command to
review behavior.

## Consequences

Scoring remains inexpensive and reproducible, but keyword lists and topic
weights require maintenance. A harvest score prioritizes material for analysis;
it is not evidence that an opportunity has paying customers.

## Implementation history

- [Daily-routine signals (`49adc00`)](https://github.com/bknstn/idea-maze-engine/commit/49adc00)
- [False-positive reduction (`a97d9b1`)](https://github.com/bknstn/idea-maze-engine/commit/a97d9b1)
- [Topic weighting (`8a41956`)](https://github.com/bknstn/idea-maze-engine/commit/8a41956)
