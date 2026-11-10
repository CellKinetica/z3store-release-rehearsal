import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	coverageGains,
	failedFuzzSteps,
	missingCoverageEvidence,
	missingFuzzEvidence,
	readCoverageCounters,
} from "../../scripts/lib/fuzz-verdict.ts";
import { runFuzz } from "../../scripts/lib/zig.ts";

// Excerpts of what Zig 0.16.0 printed on Linux arm64 for `zig build fuzz
// --summary failures --fuzz=<limit>`. The build runner exited 0 in all three.

const CLEAN = `fuzz
+- run test w
warn: could not rewrite jj git_target at /tmp/t/repo/store/git_target: FileNotFound
error: refusing to adopt with insecure gitstore_root: /
failed command: ./.zig-cache/o/174a11fe0e1d4f7757d242f9e063ca78/test --cache-dir=./.zig-cache --seed=0xcdbfb28d --listen=-

======= FUZZING REPORT =======
Step: run test
Fuzz test: "tests.test.config: fuzz resolvePrecedence is total" (efb9f4a8dcdcc4b0)
Runs: 0 -> 410115
Unique runs: 0 -> 797
Coverage: 0/20371 -> 1059/20371 (5.20%)
------------------------------
Values are accumulated across multiple runs when preserving the cache.
==============================
`;

const FUZZER_FOUND_CRASH = `fuzz
+- run test failure
thread 58 panic: fuzzer found the planted crash
/tmp/work/src/crash.zig:6:24: 0x12579d3 in one (test)
error: test 'crash.test.planted crash' terminated with signal ABRT; input saved to '.zig-cache/f/crash'
failed command: ./.zig-cache/o/c8d8b3e2caa0cb366f9383ae0e5c9ab6/test --cache-dir=./.zig-cache --seed=0x2ba49d21 --listen=-

======= FUZZING REPORT =======
Step: run test
Fuzz test: "crash.test.planted crash" (c0058272d1668fc5)
Runs: 0 -> 197
Unique runs: 0 -> 1
Coverage: 0/10029 -> 23/10029 (0.23%)
------------------------------
Values are accumulated across multiple runs when preserving the cache.
==============================
`;

const CORPUS_CONTENDED = `fuzz
+- run test w
error: refusing to adopt with insecure gitstore_root: /
failed command: ./.zig-cache/o/174a11fe0e1d4f7757d242f9e063ca78/test --cache-dir=./.zig-cache --seed=0xe799144b --listen=-

fuzz
+- run test failure
thread 1373 panic: corpus of 'url.test.url: fuzz — parse must not crash on any input' is in use by another fuzzer
error: test 'tests.test.config: fuzz resolvePrecedence is total' terminated with signal ABRT; input saved to '.zig-cache/f/crash'
failed command: ./.zig-cache/o/6a723cfa91170bcc733b84afb940752f/test --cache-dir=./.zig-cache --seed=0xe799144b --listen=-

======= FUZZING REPORT =======
Step: run test
Fuzz test: "tests.test.config: fuzz resolvePrecedence is total" (efb9f4a8dcdcc4b0)
Runs: 0 -> 0
Unique runs: 0 -> 0
Coverage: 0/20371 -> 0/20371 (0.00%)
------------------------------
Step: run test
Fuzz test: "url.test.url: fuzz — parse must not crash on any input" (e5bccf278e358234)
Runs: 0 -> 104288
Unique runs: 0 -> 422
Coverage: 0/10802 -> 507/10802 (4.69%)
------------------------------
Values are accumulated across multiple runs when preserving the cache.
==============================
`;

test("a clean fuzz run has no failed step and full evidence", () => {
	expect(failedFuzzSteps(CLEAN)).toEqual([]);
	expect(missingFuzzEvidence(CLEAN)).toEqual([]);
});

test("a crash the fuzzer found is a failed step", () => {
	expect(failedFuzzSteps(FUZZER_FOUND_CRASH)).toEqual(["+- run test failure"]);
});

test("a fuzz process that died before fuzzing leaves a test with no runs", () => {
	expect(failedFuzzSteps(CORPUS_CONTENDED)).toEqual(["+- run test failure"]);
	expect(missingFuzzEvidence(CORPUS_CONTENDED)).toEqual([
		'fuzz test "tests.test.config: fuzz resolvePrecedence is total" ran no iterations',
	]);
});

test("failing test counts and compile errors are failed steps", () => {
	const output = [
		"fuzz",
		"+- run test 3 pass, 1 fail (4 total)",
		"   +- compile test Debug native 2 errors",
		"+- run test 4 pass (4 total); 1 leaks",
		"error: step 'run test': failed to rerun in fuzz mode: Unexpected",
	].join("\n");
	expect(failedFuzzSteps(output)).toHaveLength(4);
});

test("a run that printed no report is not evidence of fuzzing", () => {
	expect(missingFuzzEvidence("fuzz\n+- run test w\n")).toEqual([
		"the build runner printed no fuzzing report",
	]);
	expect(
		missingFuzzEvidence(
			"======= FUZZING REPORT =======\n==============================\n",
		),
	).toEqual(["the fuzzing report lists no fuzz test"]);
});

function printThenExit(text: string, code: number): string[] {
	return [
		"bun",
		"-e",
		"process.stderr.write(process.argv[1] ?? '');" +
			"process.exit(Number(process.argv[2]));",
		text,
		String(code),
	];
}

test("runFuzz fails a crashed fuzz run that exits 0", async () => {
	const verdict = await runFuzz({
		limit: "1",
		timeoutMs: 30_000,
		command: printThenExit(FUZZER_FOUND_CRASH, 0),
	});
	expect(verdict).toBe(1);
});

test("runFuzz passes a clean fuzz run", async () => {
	const verdict = await runFuzz({
		limit: "1",
		timeoutMs: 30_000,
		command: printThenExit(CLEAN, 0),
	});
	expect(verdict).toBe("pass");
});

test("runFuzz keeps a non-zero exit code", async () => {
	const verdict = await runFuzz({
		limit: "1",
		timeoutMs: 30_000,
		command: printThenExit("", 3),
	});
	expect(verdict).toBe(3);
});

test("runFuzz fails a run that reported a failed step before the budget elapsed", async () => {
	const verdict = await runFuzz({
		limit: "1",
		timeoutMs: 1_500,
		command: [
			"bun",
			"-e",
			"process.stderr.write(process.argv[1] ?? ''); await Bun.sleep(60_000);",
			"fuzz\n+- run test failure\n",
		],
	});
	expect(verdict).toBe(1);
});

// The head of a `.zig-cache/v/<coverage id>` file: `SeenPcsHeader` in
// `lib/std/Build/abi.zig`, three native-endian usize fields.
function coverageHeader(counters: {
	runs: number;
	pcsLen: number;
}): Uint8Array {
	const bytes = new Uint8Array(24 + 64);
	const view = new DataView(bytes.buffer);
	view.setBigUint64(0, BigInt(counters.runs), true);
	view.setBigUint64(8, 1n, true);
	view.setBigUint64(16, BigInt(counters.pcsLen), true);
	return bytes;
}

function newCoverageDir(): string {
	return mkdtempSync(join(tmpdir(), "fuzz-coverage-"));
}

test("readCoverageCounters reads the header the fuzzer keeps", () => {
	const dir = newCoverageDir();
	writeFileSync(
		join(dir, "efb9f4a8dcdcc4b0"),
		coverageHeader({ runs: 410_115, pcsLen: 20_371 }),
	);
	writeFileSync(join(dir, "truncated"), new Uint8Array(8));
	expect(readCoverageCounters(dir)).toEqual(
		new Map([["efb9f4a8dcdcc4b0", { runs: 410_115, pcsLen: 20_371 }]]),
	);
	expect(readCoverageCounters(join(dir, "absent"))).toEqual(new Map());
});

test("coverage that gained instrumented runs is evidence of fuzzing", () => {
	const gains = coverageGains(
		new Map([
			["aaaa", { runs: 100, pcsLen: 20_371 }],
			["stale", { runs: 7, pcsLen: 9 }],
		]),
		new Map([
			["aaaa", { runs: 350, pcsLen: 20_371 }],
			["stale", { runs: 7, pcsLen: 9 }],
		]),
	);
	expect(gains).toEqual([{ id: "aaaa", runs: 250, pcsLen: 20_371 }]);
	expect(missingCoverageEvidence(gains)).toEqual([]);
});

test("no coverage file gaining runs means the fuzzer never ran", () => {
	const idle = new Map([["aaaa", { runs: 100, pcsLen: 20_371 }]]);
	expect(missingCoverageEvidence(coverageGains(new Map(), new Map()))).toEqual([
		"no coverage file gained runs; the fuzzer ran no iterations",
	]);
	expect(missingCoverageEvidence(coverageGains(idle, idle))).toHaveLength(1);
});

test("runs over zero instrumented locations mean the fuzzer ran blind", () => {
	const gains = coverageGains(
		new Map(),
		new Map([["bbbb", { runs: 5_000, pcsLen: 0 }]]),
	);
	expect(missingCoverageEvidence(gains)).toEqual([
		"coverage bbbb gained 5000 runs over 0 instrumented locations; the fuzzer ran blind",
	]);
});

// Stands in for a `zig build fuzz` that outlives its budget: optionally
// records fuzzing in a coverage file, then keeps running.
function fuzzesPastTheBudget(coverage?: {
	dir: string;
	runs: number;
	pcsLen: number;
}): string[] {
	return [
		"bun",
		"-e",
		"const [file, hex] = process.argv.slice(1);" +
			"if (file) await Bun.write(file, Buffer.from(hex ?? '', 'hex'));" +
			"await Bun.sleep(60_000);",
		...(coverage
			? [
					join(coverage.dir, "efb9f4a8dcdcc4b0"),
					Buffer.from(coverageHeader(coverage)).toString("hex"),
				]
			: []),
	];
}

test("runFuzz fails an elapsed budget that recorded no fuzzing", async () => {
	const verdict = await runFuzz({
		limit: "1",
		timeoutMs: 1_500,
		command: fuzzesPastTheBudget(),
		coverageDir: newCoverageDir(),
	});
	expect(verdict).toBe(1);
});

test("runFuzz fails an elapsed budget spent fuzzing blind", async () => {
	const dir = newCoverageDir();
	const verdict = await runFuzz({
		limit: "1",
		timeoutMs: 1_500,
		command: fuzzesPastTheBudget({ dir, runs: 5_000, pcsLen: 0 }),
		coverageDir: dir,
	});
	expect(verdict).toBe(1);
});

test("runFuzz accepts an elapsed budget spent on instrumented fuzzing", async () => {
	const dir = newCoverageDir();
	const verdict = await runFuzz({
		limit: "1",
		timeoutMs: 1_500,
		command: fuzzesPastTheBudget({ dir, runs: 5_000, pcsLen: 20_371 }),
		coverageDir: dir,
	});
	expect(verdict).toBe("timeout");
});

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function newPidFile(): string {
	return join(mkdtempSync(join(tmpdir(), "fuzz-verdict-")), "pid");
}

// Stands in for `zig build fuzz`: starts a long-lived process of its own,
// records that process's pid, and outlives any test budget.
function startsALongLivedProcess(pidFile: string): string[] {
	return [
		"bun",
		"-e",
		"const child = Bun.spawn(['sleep', '60']);" +
			"await Bun.write(process.argv[1] ?? '', String(child.pid));" +
			"await Bun.sleep(60_000);",
		pidFile,
	];
}

async function expectGone(pid: number): Promise<void> {
	expect(pid).toBeGreaterThan(0);
	for (let waited = 0; waited < 2_000 && isAlive(pid); waited += 50) {
		await Bun.sleep(50);
	}
	expect(isAlive(pid)).toBe(false);
}

test("runFuzz stops the processes its command started when the budget elapses", async () => {
	const pidFile = newPidFile();
	await runFuzz({
		limit: "1",
		timeoutMs: 1_500,
		command: startsALongLivedProcess(pidFile),
		coverageDir: newCoverageDir(),
	});
	await expectGone(Number(readFileSync(pidFile, "utf8")));
});

test("runFuzz stops the processes its command started when the gate is terminated", async () => {
	const pidFile = newPidFile();
	const gate = Bun.spawn(
		[
			"bun",
			"-e",
			"import { runFuzz } from './scripts/lib/zig.ts';" +
				"await runFuzz({ limit: '1', timeoutMs: 60_000," +
				" command: JSON.parse(process.argv[1] ?? '[]') });",
			JSON.stringify(startsALongLivedProcess(pidFile)),
		],
		{
			cwd: join(import.meta.dir, "../.."),
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	for (let waited = 0; waited < 5_000 && !existsSync(pidFile); waited += 50) {
		await Bun.sleep(50);
	}
	const grandchild = Number(readFileSync(pidFile, "utf8"));
	gate.kill("SIGTERM");
	await gate.exited;
	expect(gate.signalCode).toBe("SIGTERM");
	await expectGone(grandchild);
});
