import { runHypothesisResearchEvaluation } from "../research/evaluation/runner.js";
import type { EvaluationSplit } from "../research/evaluation/types.js";

function parseArguments(arguments_: readonly string[]): { split: EvaluationSplit; freezeSha256?: string } {
  let split: EvaluationSplit = "tuning";
  let freezeSha256: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--split") {
      const value = arguments_[index + 1];
      if (value !== "tuning" && value !== "holdout") throw new TypeError("--split must be tuning or holdout.");
      split = value;
      index += 1;
    } else if (argument === "--freeze-sha256") {
      const value = arguments_[index + 1];
      if (!value || !/^[a-f0-9]{64}$/u.test(value)) throw new TypeError("--freeze-sha256 requires a 64-character lowercase SHA-256 value.");
      freezeSha256 = value;
      index += 1;
    } else {
      throw new TypeError(`Unknown evaluation argument: ${argument}`);
    }
  }
  return { split, freezeSha256 };
}

try {
  const arguments_ = parseArguments(process.argv.slice(2));
  const report = await runHypothesisResearchEvaluation({
    split: arguments_.split,
    ...(arguments_.freezeSha256 ? { reviewedFreezeSha256: arguments_.freezeSha256 } : {}),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.cases.some(({ harnessFailure }) => harnessFailure !== null)) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : "Evaluation could not be run.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
