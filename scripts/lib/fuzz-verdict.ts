/**
 * Reads what `zig build fuzz --fuzz=<limit>` printed, because its exit code
 * cannot be trusted on Zig 0.16.0.
 *
 * `fuzzWorkerRun` in `lib/std/Build/Fuzz.zig` prints a failed fuzz run step and
 * returns. `lib/compiler/build_runner.zig` then exits with the failure count it
 * took before fuzzing began. A crash the fuzzer finds, or a fuzz process that
 * dies on startup, therefore ends in exit 0.
 */

const STEP_LINE = /^ *\+- .+$/;
const FAILED_STATUS =
	/ (?:failure|\d+ errors|\d+ (?:fail|crash|timeout|leaks|error logs)\b.*)$/;
const RERUN_FAILED = /^error: step '.+': failed to rerun in fuzz mode: /;
const REPORT_HEADER = "======= FUZZING REPORT =======";
const REPORT_TEST = /^Fuzz test: "(.+)" \([0-9a-f]+\)$/;
const REPORT_RUNS = /^Runs: (\d+) -> (\d+)$/;

/**
 * Lines in which the build runner reports a step that did not succeed.
 *
 * The build runner prints a step with only stderr output as `+- <step> w`.
 * That is not a failure.
 */
export function failedFuzzSteps(output: string): string[] {
	return output
		.split("\n")
		.filter(
			(line) =>
				(STEP_LINE.test(line) && FAILED_STATUS.test(line)) ||
				RERUN_FAILED.test(line),
		)
		.map((line) => line.trim());
}

/**
 * Reasons a finished run does not prove that fuzzing happened. Empty when the
 * fuzzing report lists at least one fuzz test and every listed test gained runs.
 *
 * A report this cannot read counts as missing, so a Zig that changes the report
 * format turns the gate red instead of hollow.
 */
export function missingFuzzEvidence(output: string): string[] {
	const lines = output.split("\n");
	const header = lines.indexOf(REPORT_HEADER);
	if (header === -1) return ["the build runner printed no fuzzing report"];

	const reasons: string[] = [];
	let test: string | undefined;
	let entries = 0;
	for (const line of lines.slice(header + 1)) {
		test = REPORT_TEST.exec(line)?.[1] ?? test;
		const runs = REPORT_RUNS.exec(line);
		if (!runs || test === undefined) continue;
		entries += 1;
		if (Number(runs[2]) <= Number(runs[1])) {
			reasons.push(`fuzz test "${test}" ran no iterations`);
		}
		test = undefined;
	}
	if (entries === 0) reasons.push("the fuzzing report lists no fuzz test");
	return reasons;
}
