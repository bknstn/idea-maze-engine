# Security and private data

Keep API credentials in exported environment variables or a local `.env` file.
The committed `.env.example` contains empty credential fields. Do not commit
database snapshots, raw posts, session files, generated research, or logs from
live runs. These can contain personal information even when the source is public.

Before sharing diagnostics, replace real source text, author identifiers,
absolute paths, provider responses, and review notes with synthetic examples.
Inspect the staged diff as well as ignored files before publishing changes.
Git ignore rules do not remove files that have already been committed.

CI runs Gitleaks against Git history. You can also run Gitleaks locally:

```bash
gitleaks git . --log-opts="--all" --redact=100
```

Secret scanning does not detect every kind of credential or personal data.
Review unfamiliar values and contributor metadata separately. Use a GitHub
no-reply address for new commits if you do not want to publish a personal email.

## Reporting a vulnerability

Use this repository's **Security → Report a vulnerability** option if private
reporting is available. If it is unavailable, open an issue asking the maintainer
to establish a private reporting channel, without including exploit details,
credentials, or personal data. Never post a live secret in an issue or PR.

If a credential has been published, revoke or rotate it before cleaning Git
history. Removing it in a new commit does not remove earlier copies. History
rewrites require coordination across branches, pull requests, and existing
clones; cached or copied public data may remain accessible.

The [publication audit](docs/security-audit.md) records the repository checks
and outstanding historical privacy work.
