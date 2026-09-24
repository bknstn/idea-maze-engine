import { execFileSync } from 'node:child_process';

import { evaluateEvidenceQuoteFixtures } from './lib/evidence-quote-eval.ts';

let candidateRevision: string | null = null;
let candidateTreeDirty: boolean | null = null;
try {
  candidateRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  candidateTreeDirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
} catch {
  // Report the evaluation without a revision when run outside a Git checkout.
}

console.log(JSON.stringify(evaluateEvidenceQuoteFixtures({ candidateRevision, candidateTreeDirty }), null, 2));
