import { REJECTION_REASONS, type RejectionReason } from './human-review.ts';

export interface ParsedHumanReviewArgs {
  decision: 'approved' | 'rejected';
  json: boolean;
  notes: string | null;
  reasons: RejectionReason[];
  runId: number;
}

const REJECTION_REASON_SET = new Set<string>(REJECTION_REASONS);

function optionValue(argv: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];
  return undefined;
}

function repeatedOptionValues(argv: string[], name: string): string[] {
  const values: string[] = [];
  const prefix = `${name}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === name && argv[i + 1]) values.push(argv[i + 1]);
    else if (arg.startsWith(prefix)) values.push(arg.slice(prefix.length));
  }
  return values;
}

function parseReason(value: string): RejectionReason {
  if (!REJECTION_REASON_SET.has(value)) {
    throw new Error(
      `Unknown rejection reason: ${value}. Known reasons: ${REJECTION_REASONS.join(', ')}`,
    );
  }
  return value as RejectionReason;
}

export function parseHumanReviewArgs(argv: string[]): ParsedHumanReviewArgs {
  const runIdRaw = optionValue(argv, '--run-id');
  const runId = Number(runIdRaw);
  if (!Number.isInteger(runId) || runId <= 0) {
    throw new Error('Missing or invalid --run-id <positive integer>.');
  }

  const decisionRaw = optionValue(argv, '--decision');
  const decision = argv.includes('--approve')
    ? 'approved'
    : argv.includes('--reject')
      ? 'rejected'
      : decisionRaw;
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new Error('Pass --approve, --reject, or --decision approved|rejected.');
  }

  const reasonValues = [
    ...repeatedOptionValues(argv, '--reason'),
    ...(optionValue(argv, '--reasons') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  ];
  const reasons = decision === 'rejected' ? reasonValues.map(parseReason) : [];

  return {
    decision,
    json: argv.includes('--json'),
    notes: optionValue(argv, '--notes') ?? null,
    reasons,
    runId,
  };
}

export function humanReviewUsage(): string {
  return [
    'Usage: tsx apply-human-review.ts --run-id <id> (--approve|--reject) [--reason <label> ...] [--notes <text>] [--json]',
    `Known rejection reasons: ${REJECTION_REASONS.join(', ')}`,
  ].join('\n');
}
