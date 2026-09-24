# Evidence quote evaluation, 2026-09-24

This deterministic evaluation covers the T3 body-grounding, visible-window, and
source-version contract. It contains 40 synthetic cases: 24 fixed tuning cases
and 16 held-out cases. Fixture version is `idea-maze-evidence-quotes-v1`, with
SHA-256 `2c75a697993c0c071d9256e5e1e1214356fd66adca7b249cc4373a3fd5b588c5`.
The comparator is the frozen quote-validation rule from base
`675ef394c2a1157700be0930c2d05714ad4f1a32`; the candidate algorithm is
`evidence-excerpts-v1`. The CLI captures the actual Git revision and dirty-tree
state on every run. This report was generated at revision
`8fcd382afd56b3ae942340a33a411e986422a44b` with a dirty working tree because
the evaluation files were being added. No model was called, and the held-out
split was not used for tuning.

The legacy validator normalized the full title plus source body to lowercase
ASCII words, then used substring inclusion. Its prompt showed only the first
1,500 source-text code units during batch extraction. T3 samples head, middle,
and tail windows within the same 1,500-code-unit body budget, then requires a
nonempty punctuation-sensitive quote to fall inside a shown window. Stored
excerpts also need the current source ID, hash, range, and exact substring.

| Split | Method | Contract pass accuracy | Synthetic contract precision | False accepts | Missed valid quotes |
| --- | --- | ---: | ---: | ---: | ---: |
| Tuning (24) | Base `675ef39` | 66.7% | 68.2% (15/22) | 7 | 1 |
| Tuning (24) | T3 `evidence-excerpts-v1` | 100% | 100% (16/16) | 0 | 0 |
| Holdout (16) | Base `675ef39` | 68.8% | 68.8% (11/16) | 5 | 0 |
| Holdout (16) | T3 `evidence-excerpts-v1` | 100% | 100% (11/11) | 0 | 0 |
| All (40) | Base `675ef39` | 67.5% | 68.4% (26/38) | 12 | 1 |
| All (40) | T3 `evidence-excerpts-v1` | 100% | 100% (27/27) | 0 | 0 |

The 12 legacy contract false accepts split into six fabricated or punctuation
mismatches, two title-only quotes, two exact quotes from omitted middle text,
and two stale excerpts whose text still appeared after a source edit. Those
categories are reported separately because title-only and hidden-middle text
can be literally present while still violating the new body/window contract.
The one legacy miss was a canonically equivalent decomposed Unicode quote.

All three tail fixtures were invisible in the legacy 1,500-character prefix
and visible in T3's declared windows: 0/3 versus 3/3 overall, 0/2 versus 2/2
on tuning, and 0/1 versus 1/1 on holdout. T3 rejected both stale stored
excerpts; the baseline rejected 0/2.

The fixtures are a synthetic regression suite created after the candidate
implementation, not independent real-world validation. Their expected labels
were authored for this implementation and are not human judgments. These
measurements are limited to deterministic quote contract behavior; they do not
estimate the quality of model-generated ideas.
Human-labeled top-candidate/opportunity precision, problem overmerge and
oversplit rates, repeated opportunity rate, cost per useful candidate,
user-approved opportunity quality versus automatic gate decisions, and
missed-post rate are unavailable. There were no paid calls, production runs,
or independent complete post inventories in this evaluation.

Reproduce the machine-readable metrics with `npm run idea:eval:evidence-quotes`.
