import type { EvidenceSourceSummary } from './evidence-quality.ts';

export interface ReviewGateRegressionFixture {
  expectedReason: string;
  finalScore: number;
  slug: string;
  sources: EvidenceSourceSummary[];
  thesis: string;
  title: string;
}

function reddit(id: number, text: string, title: string | null = null): EvidenceSourceSummary {
  return { id, source: 'reddit', title, text, canonical_url: null, channel_or_label: null, content_hash: `fixture-${id}`, metadata_json: null };
}

export const REJECTED_REVIEW_GATE_FIXTURES: ReviewGateRegressionFixture[] = [
  { slug: 'anki-review', title: 'Automated Anki review planner', thesis: 'Students need an automated Anki review planner.', finalScore: 9.6, expectedReason: 'irrelevant_sources', sources: [reddit(1, 'I struggle to keep receipts organized for my bookkeeping workflow.'), reddit(2, 'My running workouts take hours each week.'), reddit(3, 'We manually export customer invoices every Friday.')] },
  { slug: 'actually-pdf', title: 'AI PDF understanding tool', thesis: 'Professionals need a better PDF understanding workflow.', finalScore: 9.5, expectedReason: 'weak_direct_pain', sources: [reddit(11, 'PDF tools are interesting.'), reddit(12, 'Here is a list of popular PDF applications.'), reddit(13, 'People discuss documents online.')] },
  { slug: 'account-business', title: 'Small-business account automation', thesis: 'Owners need automated business account reconciliation.', finalScore: 9.4, expectedReason: 'promo_only_support', sources: [reddit(21, 'I built a business account automation SaaS; join my waitlist.'), reddit(22, 'We launched our account reconciliation app on Product Hunt.'), reddit(23, 'Check out my new tool for business accounts.')] },
  { slug: 'data-oura', title: 'Oura data analysis assistant', thesis: 'Oura users need automated health-data analysis.', finalScore: 9.4, expectedReason: 'irrelevant_sources', sources: [reddit(31, 'I hate manually matching supplier invoices every month.'), reddit(32, 'My team loses hours reviewing sales CRM records.'), reddit(33, 'We use spreadsheets for agency client documents.')] },
  { slug: 'out-know', title: 'Addiction recovery knowledge companion', thesis: 'People in addiction recovery need a knowledge companion.', finalScore: 9.3, expectedReason: 'weak_direct_pain', sources: [reddit(41, 'Recovery is hard.'), reddit(42, 'This is a difficult problem.'), reddit(43, 'Many people struggle.')] },
  { slug: 'out-pipeline', title: 'Addiction recovery support pipeline', thesis: 'People in addiction recovery need an automated support pipeline.', finalScore: 9.3, expectedReason: 'irrelevant_sources', sources: [reddit(51, 'I spend hours updating my sales pipeline each week.'), reddit(52, 'We manually reconcile invoices in our pipeline.'), reddit(53, 'My data export workflow is frustrating.')] },
  { slug: 'first-time', title: 'First-time founder coach', thesis: 'First-time founders need an automated operating coach.', finalScore: 9.2, expectedReason: 'weak_direct_pain', sources: [reddit(61, 'Being a first-time founder is hard.'), reddit(62, 'Startups have problems.'), reddit(63, 'Building a business can be a struggle.')] },
  { slug: 'out-people', title: 'Addiction recovery people network', thesis: 'People in addiction recovery need a peer-support network.', finalScore: 9.2, expectedReason: 'promo_only_support', sources: [reddit(71, 'I built a recovery community; try my new app.'), reddit(72, 'We launched our peer support network.'), reddit(73, 'Join the waitlist for my recovery SaaS.')] },
  { slug: 'business-people', title: 'Business people matching network', thesis: 'Small-business owners need a matching network.', finalScore: 9.1, expectedReason: 'irrelevant_sources', sources: [reddit(81, 'I manually plan workout sessions every week.'), reddit(82, 'My PDF review takes two hours.'), reddit(83, 'We track sleep data in a spreadsheet.')] },
  { slug: 'workout-back', title: 'Back-safe workout planner', thesis: 'People with back pain need an adaptive workout planner.', finalScore: 9.1, expectedReason: 'weak_direct_pain', sources: [reddit(91, 'Back workouts are hard.'), reddit(92, 'Exercise can be a problem.'), reddit(93, 'People struggle with fitness.')] },
];

export const BOOKKEEPING_POSITIVE_FIXTURE: ReviewGateRegressionFixture = {
  slug: 'bookkeeping-client-documents',
  title: 'Bookkeeping client-document collector',
  thesis: 'Bookkeepers need a workflow to collect missing client documents.',
  finalScore: 9.7,
  expectedReason: '',
  sources: [
    reddit(101, 'I am a bookkeeper and spend three hours every Friday chasing missing client documents.'),
    reddit(102, 'Our bookkeeping team manually tracks client receipts in a spreadsheet and loses half a day monthly.'),
    reddit(103, 'As an accountant, I hate emailing clients repeatedly for missing bookkeeping documents.'),
  ],
};
