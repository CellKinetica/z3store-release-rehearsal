/**
 * Reads what `zig build fuzz --fuzz=<limit>` printed, because its exit code
 * cannot be trusted on Zig 0.16.0.
 *
 * `fuzzWorkerRun` in `lib/std/Build/Fuzz.zig` prints a failed fuzz run step and
 * returns. `lib/compiler/build_runner.zig` then exits with the failure count it
 * took before fuzzing began. A crash the fuzzer finds, or a fuzz process that
 * dies on startup, therefore ends in exit 0.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
 * format turns the gate red instead of hollow. That holds per entry: a listed
 * test whose run counter is absent or unreadable is a reason of its own, even
 * when every other entry gained runs.
 */
export function missingFuzzEvidence(output: string): string[] {
	const lines = output.split("\n");
	const header = lines.indexOf(REPORT_HEADER);
	if (header === -1) return ["the build runner printed no fuzzing report"];

	const reasons: string[] = [];
	const unread = (name: string) =>
		`fuzz test "${name}" has no readable run counter`;
	let pending: string | undefined;
	let entries = 0;
	for (const line of lines.slice(header + 1)) {
		const name = REPORT_TEST.exec(line)?.[1];
		if (name !== undefined) {
			if (pending !== undefined) reasons.push(unread(pending));
			pending = name;
			entries += 1;
			continue;
		}
		const runs = REPORT_RUNS.exec(line);
		if (!runs || pending === undefined) continue;
		if (Number(runs[2]) <= Number(runs[1])) {
			reasons.push(`fuzz test "${pending}" ran no iterations`);
		}
		pending = undefined;
	}
	if (pending !== undefined) reasons.push(unread(pending));
	if (entries === 0) reasons.push("the fuzzing report lists no fuzz test");
	return reasons;
}

/**
 * The counters the fuzzer keeps at the head of a coverage file: `n_runs` and
 * `pcs_len` of `SeenPcsHeader` in `lib/std/Build/abi.zig`.
 */
export type CoverageCounters = { runs: number; pcsLen: number };

/** How far one coverage file's run count rose during a fuzz run. */
export type CoverageGain = { id: string; runs: number; pcsLen: number };

const COVERAGE_HEADER_BYTES = 24;

/**
 * Counters of every coverage file in `dir` (`.zig-cache/v`), keyed by
 * coverage id. Empty when the directory does not exist.
 *
 * The fuzzer memory-maps each file and bumps `n_runs` on every iteration
 * (`lib/fuzzer.zig`), so the counters are current even after the run is
 * killed. That makes them the only fuzzing evidence a run leaves when its
 * budget elapses, because the build runner prints its report only on a
 * normal exit.
 */
export function readCoverageCounters(
	dir: string,
): Map<string, CoverageCounters> {
	const counters = new Map<string, CoverageCounters>();
	let ids: string[];
	try {
		ids = readdirSync(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return counters;
		throw err;
	}
	for (const id of ids.sort()) {
		const bytes = readFileSync(join(dir, id));
		if (bytes.byteLength < COVERAGE_HEADER_BYTES) continue;
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		counters.set(id, {
			runs: Number(view.getBigUint64(0, true)),
			pcsLen: Number(view.getBigUint64(16, true)),
		});
	}
	return counters;
}

/** Coverage files whose run count rose between two snapshots. */
export function coverageGains(
	before: ReadonlyMap<string, CoverageCounters>,
	after: ReadonlyMap<string, CoverageCounters>,
): CoverageGain[] {
	const gains: CoverageGain[] = [];
	for (const [id, { runs, pcsLen }] of after) {
		const gained = runs - (before.get(id)?.runs ?? 0);
		if (gained > 0) gains.push({ id, runs: gained, pcsLen });
	}
	return gains;
}

/**
 * Reasons a run that was stopped by its budget does not prove that fuzzing
 * happened. Empty when at least one coverage file gained runs and every file
 * that did covers instrumented code.
 *
 * A fuzz binary built without coverage instrumentation still counts runs, but
 * over zero program locations. The build runner rejects that only in its
 * final report, which a stopped run never prints.
 */
export function missingCoverageEvidence(gains: CoverageGain[]): string[] {
	if (gains.length === 0) {
		return ["no coverage file gained runs; the fuzzer ran no iterations"];
	}
	return gains
		.filter((gain) => gain.pcsLen === 0)
		.map(
			(gain) =>
				`coverage ${gain.id} gained ${gain.runs} runs over 0 instrumented locations; the fuzzer ran blind`,
		);
}
