import { readFileSync } from 'node:fs';

import { getOption, getPositional, hasFlag, writeJson } from './lib/cli.ts';
import { exploreOpportunity, finalizeExploration, prepareExploration } from './lib/exploration.ts';

function loggerFor(json: boolean) {
  return json
    ? { log: (...args: any[]) => console.error(...args), warn: (...args: any[]) => console.error(...args) }
    : console;
}

function usage(): string {
  return 'Usage: tsx explore-opportunity.ts <slug-or-id> [--json] [--force] [--prepare-only] OR --run-id <id> --brief-file <path> [--json]';
}

async function main() {
  const json = hasFlag('--json');
  const runIdRaw = getOption('--run-id');
  const briefFile = getOption('--brief-file');

  if (runIdRaw && briefFile) {
    const result = await finalizeExploration(Number(runIdRaw), {
      brief: JSON.parse(readFileSync(briefFile, 'utf-8')),
      logger: loggerFor(json),
      providerMetadata: JSON.parse(getOption('--provider-metadata') ?? '{}'),
      requestedBy: 'hermes',
    });
    if (json) writeJson(result);
    else console.log(`Exploration ${result.status} for ${result.opportunitySlug}`);
    return;
  }

  const target = getOption('--id') ?? getOption('--slug') ?? getPositional(0);
  if (!target) {
    console.error(usage());
    process.exit(1);
  }

  const result = hasFlag('--prepare-only')
    ? await prepareExploration(target, {
        force: hasFlag('--force'),
        logger: loggerFor(json),
        requestedBy: 'user',
      })
    : await exploreOpportunity(target, {
        force: hasFlag('--force'),
        logger: loggerFor(json),
        requestedBy: 'user',
      });

  if (json) writeJson(result);
  else console.log(`Exploration ${result.status} for ${result.opportunitySlug}`);
}

main().catch((err) => {
  console.error('Explore failed:', err);
  process.exit(1);
});
