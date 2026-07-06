import { describe, expect, it } from 'vitest';

import { parseHumanReviewArgs } from './human-review-cli.ts';

describe('parseHumanReviewArgs', () => {
  it('parses rejected run decisions with repeated reason flags', () => {
    expect(
      parseHumanReviewArgs([
        '--reject',
        '--run-id',
        '123',
        '--reason',
        'weak_app_wrapper',
        '--reason',
        'trust_access_risk',
        '--notes',
        'Weak wrapper and trust risk.',
        '--json',
      ]),
    ).toEqual({
      decision: 'rejected',
      json: true,
      notes: 'Weak wrapper and trust risk.',
      reasons: ['weak_app_wrapper', 'trust_access_risk'],
      runId: 123,
    });
  });

  it('parses comma-separated rejection reasons', () => {
    expect(
      parseHumanReviewArgs([
        '--decision',
        'rejected',
        '--run-id=42',
        '--reasons',
        'thin_evidence,crowded_no_wedge',
      ]),
    ).toMatchObject({
      decision: 'rejected',
      reasons: ['thin_evidence', 'crowded_no_wedge'],
      runId: 42,
    });
  });

  it('rejects unknown rejection reasons', () => {
    expect(() =>
      parseHumanReviewArgs(['--reject', '--run-id', '123', '--reason', 'because_i_said_so']),
    ).toThrow('Unknown rejection reason: because_i_said_so');
  });
});
