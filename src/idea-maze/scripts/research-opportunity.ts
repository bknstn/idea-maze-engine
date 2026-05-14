/**
 * Research drafting — creates an automated research artifact for an opportunity.
 *
 * Loads the opportunity and linked source items, optionally enriches
 * with Tavily web search, builds a draft, and writes the artifact.
 *
 * Usage: tsx research-opportunity.ts <slug-or-topic>
 */

import { researchOpportunity } from './lib/research.ts';
import { getOption, getPositional, hasFlag, writeJson } from './lib/cli.ts';

async function main() {
  const target = getOption('--id') ?? getOption('--slug') ?? getPositional(0);
  if (!target) {
    console.error(
      'Usage: tsx research-opportunity.ts <slug-or-topic> [--json]',
    );
    process.exit(1);
  }
  const json = hasFlag('--json');
  const result = await researchOpportunity(target, {
    logger: json
      ? {
          log: (...args: any[]) => console.error(...args),
          warn: (...args: any[]) => console.error(...args),
        }
      : console,
    requestedBy: 'user',
  });
  if (json) {
    writeJson(result);
  }
}

main().catch((err) => {
  console.error('Research failed:', err);
  process.exit(1);
});
