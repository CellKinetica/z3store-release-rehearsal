/**
 * Repo-owned Zig toolchain wrapper. Semantics match the validated
 * `scripts/zig-tool.sh` in z3store:
 *
 *   1. If ZIG env var is set, honor it (escape hatch for CI/local overrides)
 *   2. Otherwise, if `mise` is available, resolve through
 *      `mise x zig@0.16.0 -- zig` with the repo root in
 *      MISE_TRUSTED_CONFIG_PATHS so the local .mise.toml is trusted
 *   3. Otherwise, fall through to bare `zig` on PATH (last resort)
 *
 * Never trust bare PATH `zig` silently: §0.7 non-negotiable.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
	coverageGains,
	failedFuzzSteps,
	missingCoverageEvidence,
	missingFuzzEvidence,
	readCoverageCounters,
} from "./fuzz-verdict.ts";
import { cpuCount, repoRoot, type SpawnResult, spawnSync } from "./runtime.ts";

const TARGET_VERSION = "0.16.0";

type Invocation = { cmd: string[]; env: Record<string, string> };

/**
 * Environment that makes `mise` trust this repo's `.mise.toml` for one
 * command, without changing the user's global trust.
 */
export function miseTrustEnv(): Record<string, string> {
	const trusted = [process.env.MISE_TRUSTED_CONFIG_PATHS, repoRoot()]
		.filter((s): s is string => !!s && s.length > 0)
		.join(":");
	return { MISE_TRUSTED_CONFIG_PATHS: trusted };
}

function zigInvocation(args: string[]): Invocation {
	const envZig = process.env.ZIG;
	if (envZig && envZig.length > 0) {
		return { cmd: [envZig, ...args], env: {} };
	}
	// `command` is a shell builtin and cannot be exec'd by Bun.spawnSync;
	// use Bun.which for binary lookups (CodeRabbit finding).
	if (Bun.which("mise") !== null) {
		return {
			cmd: ["mise", "x", `zig@${TARGET_VERSION}`, "--", "zig", ...args],
			env: miseTrustEnv(),
		};
	}
	console.error(
		"WARN: falling back to bare-PATH zig because neither $ZIG nor mise was available",
	);
	return { cmd: ["zig", ...args], env: {} };
}

export function zig(args: string[]): SpawnResult {
	const { cmd, env } = zigInvocation(args);
	return spawnSync(cmd, { env });
}

export function zigVersion(): string {
	const r = zig(["version"]);
	return (r.stdout || "").trim();
}

/**
 * Darwin + Zig 0.16.0 fuzz is upstream-broken (ziglang/zig#20986). The
 * green gate on macOS must degrade explicitly, never silently. Set
 * ZIG_QM_FORCE_FUZZ=1 to try anyway.
 */
export function zigSupportsFuzz(): boolean {
	if (process.env.ZIG_QM_FORCE_FUZZ === "1") return true;
	const os = process.platform;
	const v = zigVersion();
	if (os === "darwin" && v === TARGET_VERSION) return false;
	return true;
}

export function zigFuzzSkipMessage(): string {
	const v = zigVersion() || "unknown";
	return `(native \`zig build fuzz\` skipped on ${process.platform} with Zig ${v}; upstream macOS fuzz support is incomplete in ziglang/zig#20986. Set ZIG_QM_FORCE_FUZZ=1 to attempt anyway.)`;
}

const RELAYED_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

function killGroup(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// The group has already exited.
	}
}

/**
 * Run `zig build fuzz` under a wall-clock budget. Returns:
 *   "pass"    — the run finished, no step failed, and every entry of the
 *               fuzzing report (one per fuzz test binary) gained runs
 *   "timeout" — the budget elapsed with no failed step printed and a
 *               coverage file that gained instrumented runs; treated as a
 *               clean pass by callers
 *   number    — a real fuzz failure: the non-zero exit code, or 1 when a
 *               step failed or the run lacks fuzzing evidence
 *
 * Exit 0 alone is not a pass on Zig 0.16.0, and neither is an elapsed
 * budget: a run that never started fuzzing, or fuzzed a binary without
 * coverage instrumentation, also ends that way. See `fuzz-verdict.ts`.
 *
 * The build runs in its own process group. The fuzz processes are
 * grandchildren of this one and hold the corpus lock, so a budget that
 * stopped only the direct child would leave them running and make the
 * next fuzz stage fail on a corpus that is still in use.
 *
 * Shared between the per-PR (Tier 3) and per-release (Tier 4) gates so
 * the spawn shape, signal handling, and arg list stay identical.
 */
export async function runFuzz(opts: {
	limit: string;
	timeoutMs: number;
	/**
	 * Test seam: override the spawned argv. When omitted, `runFuzz`
	 * launches the real `zig build fuzz`. Tests inject a stub that prints
	 * canned build-runner output or outlives the budget.
	 */
	command?: string[];
	/**
	 * Test seam: the directory the fuzzer keeps its coverage files in.
	 * Defaults to `.zig-cache/v` in the repo.
	 */
	coverageDir?: string;
}): Promise<"pass" | "timeout" | number> {
	const coverageDir =
		opts.coverageDir ?? resolve(repoRoot(), ".zig-cache", "v");
	const coverageBefore = readCoverageCounters(coverageDir);
	const { cmd, env } = opts.command
		? { cmd: opts.command, env: {} }
		: zigInvocation([
				"build",
				"fuzz",
				"--summary",
				"failures",
				// The verdict reads the plain-text step tree.
				"--color",
				"off",
				`--fuzz=${opts.limit}`,
				`-j${cpuCount()}`,
			]);
	const [program, ...args] = cmd;
	if (program === undefined) throw new Error("runFuzz: empty command");

	const child = spawn(program, args, {
		cwd: repoRoot(),
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		process.stdout.write(chunk);
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		process.stderr.write(chunk);
		stderr += chunk;
	});

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		killGroup(child.pid);
	}, opts.timeoutMs);
	// A signal sent to this process does not reach the detached group.
	const relay = (signal: NodeJS.Signals) => {
		killGroup(child.pid);
		for (const s of RELAYED_SIGNALS) process.removeListener(s, relay);
		process.kill(process.pid, signal);
	};
	for (const s of RELAYED_SIGNALS) process.on(s, relay);

	let code: number | null;
	try {
		code = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
	} finally {
		clearTimeout(timer);
		for (const s of RELAYED_SIGNALS) process.removeListener(s, relay);
	}

	const output = `${stdout}\n${stderr}`;
	const failed = failedFuzzSteps(output);
	if (timedOut) {
		if (failed.length > 0) {
			console.error(
				`runFuzz: a fuzz step failed before the budget elapsed:\n  ${failed.join("\n  ")}`,
			);
			return 1;
		}
		const gains = coverageGains(
			coverageBefore,
			readCoverageCounters(coverageDir),
		);
		const missing = missingCoverageEvidence(gains);
		if (missing.length > 0) {
			console.error(
				`runFuzz: the budget elapsed but the run is not a pass:\n  ${missing.join("\n  ")}`,
			);
			return 1;
		}
		for (const gain of gains) {
			console.log(
				`runFuzz: coverage ${gain.id} gained ${gain.runs} runs over ${gain.pcsLen} instrumented locations before the budget elapsed`,
			);
		}
		return "timeout";
	}
	if (code !== 0) return code ?? 1;
	const reasons = [...failed, ...missingFuzzEvidence(output)];
	if (reasons.length === 0) return "pass";
	console.error(
		`runFuzz: zig build fuzz exited 0 but the run is not a pass:\n  ${reasons.join("\n  ")}`,
	);
	return 1;
}
