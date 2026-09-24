export interface EvidenceQuoteEvalFixture {
  id: string;
  split: 'tuning' | 'holdout';
  scenario: string;
  sourceText: string;
  sourceTitle: string | null;
  candidateQuote: string | null;
  role: 'pain' | 'workaround' | 'wtp' | 'time_loss';
  expectedGrounded: boolean;
  expectedProblemId: string | null;
  independentGroupId: string;
  storedSourceText?: string;
}

function tailText(quote: string): string {
  return `Opening sentence. ${'Unrelated discussion from the middle. '.repeat(180)}${quote}`;
}

function hiddenMiddleText(quote: string): string {
  return `${'Head text that is not relevant. '.repeat(35)}${quote} ${'Middle filler to leave this quote between shown windows. '.repeat(70)}${'Tail context. '.repeat(90)}`;
}

const tuning: Omit<EvidenceQuoteEvalFixture, 'id' | 'split'>[] = [
  { scenario: 'specific_buyer_pain', sourceText: 'I manually match invoices every Friday and hate the rework.', sourceTitle: null, candidateQuote: 'I manually match invoices every Friday', role: 'pain', expectedGrounded: true, expectedProblemId: 'invoice_matching', independentGroupId: 'buyer-a' },
  { scenario: 'manual_workaround', sourceText: 'I copy receipts into a spreadsheet before sending each report.', sourceTitle: null, candidateQuote: 'I copy receipts into a spreadsheet', role: 'workaround', expectedGrounded: true, expectedProblemId: 'receipt_reporting', independentGroupId: 'buyer-b' },
  { scenario: 'willingness_to_pay', sourceText: 'I would pay $30 per month to stop reconciling these bills.', sourceTitle: null, candidateQuote: 'I would pay $30 per month', role: 'wtp', expectedGrounded: true, expectedProblemId: 'invoice_matching', independentGroupId: 'buyer-c' },
  { scenario: 'time_loss', sourceText: 'This wastes three hours every week on duplicate entry.', sourceTitle: null, candidateQuote: 'wastes three hours every week', role: 'time_loss', expectedGrounded: true, expectedProblemId: 'duplicate_entry', independentGroupId: 'buyer-d' },
  { scenario: 'advertising_quote_is_still_exact', sourceText: 'We built ReceiptHero; try my app and join the waitlist.', sourceTitle: 'Launch', candidateQuote: 'We built ReceiptHero', role: 'pain', expectedGrounded: true, expectedProblemId: 'receipt_app_promo', independentGroupId: 'founder-a' },
  { scenario: 'contradicting_evidence_quote', sourceText: 'I stopped looking because the current report is already good enough.', sourceTitle: null, candidateQuote: 'the current report is already good enough', role: 'workaround', expectedGrounded: true, expectedProblemId: 'reporting_sufficiency', independentGroupId: 'buyer-e' },
  { scenario: 'duplicate_source_first_copy', sourceText: 'I spend an hour chasing missing supplier receipts.', sourceTitle: null, candidateQuote: 'spend an hour chasing missing supplier receipts', role: 'pain', expectedGrounded: true, expectedProblemId: 'supplier_receipts', independentGroupId: 'crosspost-1' },
  { scenario: 'duplicate_source_second_copy', sourceText: 'I spend an hour chasing missing supplier receipts.', sourceTitle: null, candidateQuote: 'spend an hour chasing missing supplier receipts', role: 'pain', expectedGrounded: true, expectedProblemId: 'supplier_receipts', independentGroupId: 'crosspost-1' },
  { scenario: 'same_words_different_problem', sourceText: 'Our students spend hours matching flashcards to lecture notes.', sourceTitle: null, candidateQuote: 'matching flashcards to lecture notes', role: 'pain', expectedGrounded: true, expectedProblemId: 'study_materials', independentGroupId: 'student-a' },
  { scenario: 'same_problem_different_lexicon', sourceText: 'Every month I reconcile bank transfers against vendor bills by hand.', sourceTitle: null, candidateQuote: 'reconcile bank transfers against vendor bills by hand', role: 'pain', expectedGrounded: true, expectedProblemId: 'invoice_matching', independentGroupId: 'buyer-f' },
  { scenario: 'insufficient_data_no_quote', sourceText: 'Maybe there is an opportunity in finance someday.', sourceTitle: null, candidateQuote: null, role: 'pain', expectedGrounded: false, expectedProblemId: null, independentGroupId: 'unknown-a' },
  { scenario: 'unicode_cyrillic_exact', sourceText: 'Я каждую пятницу вручную сверяю платежи.', sourceTitle: null, candidateQuote: 'каждую пятницу вручную сверяю платежи', role: 'pain', expectedGrounded: true, expectedProblemId: 'invoice_matching', independentGroupId: 'buyer-g' },
  { scenario: 'unicode_cyrillic_fabrication', sourceText: 'Команда вручную сверяет счета каждую неделю.', sourceTitle: null, candidateQuote: 'пользователи готовы платить за решение', role: 'wtp', expectedGrounded: false, expectedProblemId: null, independentGroupId: 'fabrication-a' },
  { scenario: 'html_entity_display_transform', sourceText: '<p>I lose time reconciling receipts &amp; payments.</p>', sourceTitle: null, candidateQuote: 'I lose time reconciling receipts & payments', role: 'pain', expectedGrounded: true, expectedProblemId: 'receipt_reconciliation', independentGroupId: 'buyer-h' },
  { scenario: 'punctuation_language_mismatch', sourceText: 'We use C# every day to process supplier records.', sourceTitle: null, candidateQuote: 'We use C++ every day to process supplier records.', role: 'pain', expectedGrounded: false, expectedProblemId: null, independentGroupId: 'fabrication-b' },
  { scenario: 'numeric_separator_mismatch', sourceText: 'The monthly fee is 1.50 per account.', sourceTitle: null, candidateQuote: 'The monthly fee is 1,50 per account.', role: 'wtp', expectedGrounded: false, expectedProblemId: null, independentGroupId: 'fabrication-c' },
  { scenario: 'whitespace_canonicalization', sourceText: 'I manually\ncopy client names into our tracker.', sourceTitle: null, candidateQuote: 'manually copy client names into our tracker', role: 'workaround', expectedGrounded: true, expectedProblemId: 'client_tracking', independentGroupId: 'buyer-i' },
  { scenario: 'unicode_combining_mark', sourceText: 'Cafe\u0301 owners lose time matching receipts.', sourceTitle: null, candidateQuote: 'Café owners lose time matching receipts', role: 'pain', expectedGrounded: true, expectedProblemId: 'receipt_matching', independentGroupId: 'buyer-j' },
  { scenario: 'tail_quote_visible_after_sampling', sourceText: tailText('At the end, reconciling these payments wastes two hours each Friday.'), sourceTitle: null, candidateQuote: 'reconciling these payments wastes two hours each Friday', role: 'time_loss', expectedGrounded: true, expectedProblemId: 'invoice_matching', independentGroupId: 'buyer-k' },
  { scenario: 'tail_workaround_visible_after_sampling', sourceText: tailText('At the end, I paste every receipt into a spreadsheet by hand.'), sourceTitle: null, candidateQuote: 'I paste every receipt into a spreadsheet by hand', role: 'workaround', expectedGrounded: true, expectedProblemId: 'receipt_reporting', independentGroupId: 'buyer-l' },
  { scenario: 'hidden_middle_quote_not_shown', sourceText: hiddenMiddleText('MIDDLE_ONLY users would pay $400 a month.'), sourceTitle: null, candidateQuote: 'MIDDLE_ONLY users would pay $400 a month', role: 'wtp', expectedGrounded: false, expectedProblemId: null, independentGroupId: 'fabrication-d' },
  { scenario: 'title_only_is_not_body_quote', sourceText: 'Body text describes a general bookkeeping discussion.', sourceTitle: 'I hate matching invoices manually every Friday', candidateQuote: 'I hate matching invoices manually every Friday', role: 'pain', expectedGrounded: false, expectedProblemId: null, independentGroupId: 'title-only-a' },
  { scenario: 'empty_normalized_punctuation', sourceText: 'We reconcile payments every Friday.', sourceTitle: null, candidateQuote: '— <br> &nbsp;', role: 'pain', expectedGrounded: false, expectedProblemId: null, independentGroupId: 'fabrication-e' },
  { scenario: 'stale_excerpt_same_quote_after_edit', sourceText: 'I waste an hour reconciling supplier invoices. Edited body version two.', sourceTitle: null, storedSourceText: 'I waste an hour reconciling supplier invoices.', candidateQuote: 'waste an hour reconciling supplier invoices', role: 'time_loss', expectedGrounded: false, expectedProblemId: null, independentGroupId: 'stale-a' },
];

const holdout: Omit<EvidenceQuoteEvalFixture, 'id' | 'split'>[] = [
  { scenario: 'exact_workflow_pain', sourceText: 'Our team spends all Monday copying payouts into the ledger.', sourceTitle: null, candidateQuote: 'spends all Monday copying payouts into the ledger', role: 'pain', expectedGrounded: true, expectedProblemId: 'payout_ledger', independentGroupId: 'buyer-m' },
  { scenario: 'exact_workaround', sourceText: 'Currently we export three CSV files and merge them by hand.', sourceTitle: null, candidateQuote: 'export three CSV files and merge them by hand', role: 'workaround', expectedGrounded: true, expectedProblemId: 'csv_merge', independentGroupId: 'buyer-n' },
  { scenario: 'exact_budget', sourceText: 'We already pay an assistant $200 monthly to reconcile the vendor bills.', sourceTitle: null, candidateQuote: 'pay an assistant $200 monthly', role: 'wtp', expectedGrounded: true, expectedProblemId: 'vendor_bills', independentGroupId: 'buyer-o' },
  { scenario: 'exact_time_loss', sourceText: 'Reviewing these receipts costs us six hours per month.', sourceTitle: null, candidateQuote: 'costs us six hours per month', role: 'time_loss', expectedGrounded: true, expectedProblemId: 'receipt_review', independentGroupId: 'buyer-p' },
  { scenario: 'promo_is_not_buyer_pain_but_quote_is_exact', sourceText: 'I launched my AI invoice bot; check out the waitlist.', sourceTitle: null, candidateQuote: 'I launched my AI invoice bot', role: 'pain', expectedGrounded: true, expectedProblemId: 'invoice_bot_promo', independentGroupId: 'founder-b' },
  { scenario: 'contradiction_is_exact_quote', sourceText: 'I do not need automation; the spreadsheet works fine.', sourceTitle: null, candidateQuote: 'the spreadsheet works fine', role: 'workaround', expectedGrounded: true, expectedProblemId: 'spreadsheet_sufficiency', independentGroupId: 'buyer-q' },
  { scenario: 'duplicate_group_copy_a', sourceText: 'We manually email every client for a missing document.', sourceTitle: null, candidateQuote: 'manually email every client for a missing document', role: 'pain', expectedGrounded: true, expectedProblemId: 'client_documents', independentGroupId: 'crosspost-2' },
  { scenario: 'duplicate_group_copy_b', sourceText: 'We manually email every client for a missing document.', sourceTitle: null, candidateQuote: 'manually email every client for a missing document', role: 'pain', expectedGrounded: true, expectedProblemId: 'client_documents', independentGroupId: 'crosspost-2' },
  { scenario: 'lexical_overlap_different_problem', sourceText: 'I match exercise sets to my recovery plan every morning.', sourceTitle: null, candidateQuote: 'match exercise sets to my recovery plan', role: 'pain', expectedGrounded: true, expectedProblemId: 'training_recovery', independentGroupId: 'athlete-a' },
  { scenario: 'same_invoice_pain_new_words', sourceText: 'Reconciling supplier transfers against bills eats my Friday.', sourceTitle: null, candidateQuote: 'supplier transfers against bills eats my Friday', role: 'pain', expectedGrounded: true, expectedProblemId: 'invoice_matching', independentGroupId: 'buyer-r' },
  { scenario: 'russian_fabrication', sourceText: 'Я трачу два часа на сверку счетов вручную.', sourceTitle: null, candidateQuote: 'клиенты готовы платить тысячу рублей', role: 'wtp', expectedGrounded: false, expectedProblemId: null, independentGroupId: 'fabrication-f' },
  { scenario: 'punctuation_mismatch_holdout', sourceText: 'Our daily reports use C# scripts and cost $1.50 per user.', sourceTitle: null, candidateQuote: 'Our daily reports use C++ scripts and cost $1,50 per user.', role: 'pain', expectedGrounded: false, expectedProblemId: null, independentGroupId: 'fabrication-g' },
  { scenario: 'tail_quote_visible_holdout', sourceText: tailText('Near the end, this workflow takes five hours every week.'), sourceTitle: null, candidateQuote: 'this workflow takes five hours every week', role: 'time_loss', expectedGrounded: true, expectedProblemId: 'weekly_reporting', independentGroupId: 'buyer-s' },
  { scenario: 'hidden_middle_holdout', sourceText: hiddenMiddleText('MIDDLE_ONLY We are actively seeking a vendor.'), sourceTitle: null, candidateQuote: 'We are actively seeking a vendor', role: 'wtp', expectedGrounded: false, expectedProblemId: null, independentGroupId: 'fabrication-h' },
  { scenario: 'title_only_holdout', sourceText: 'No relevant claim appears in the post body.', sourceTitle: 'I spend hours chasing payment receipts', candidateQuote: 'I spend hours chasing payment receipts', role: 'time_loss', expectedGrounded: false, expectedProblemId: null, independentGroupId: 'title-only-b' },
  { scenario: 'stale_excerpt_holdout', sourceText: 'The quoted statement still appears, but source body has been edited.', sourceTitle: null, storedSourceText: 'The quoted statement still appears.', candidateQuote: 'quoted statement still appears', role: 'pain', expectedGrounded: false, expectedProblemId: null, independentGroupId: 'stale-b' },
];

export const EVIDENCE_QUOTE_EVAL_VERSION = 'idea-maze-evidence-quotes-v1';
export const EVIDENCE_QUOTE_EVAL_FIXTURES: EvidenceQuoteEvalFixture[] = [
  ...tuning.map((fixture, index) => ({ ...fixture, id: `tune-${String(index + 1).padStart(2, '0')}`, split: 'tuning' as const })),
  ...holdout.map((fixture, index) => ({ ...fixture, id: `holdout-${String(index + 1).padStart(2, '0')}`, split: 'holdout' as const })),
];
