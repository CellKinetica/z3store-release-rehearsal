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
import { failedFuzzSteps, missingFuzzEvidence } from "./fuzz-verdict.ts";
import { cpuCount, repoRoot, type SpawnResult, spawnSync } from "./runtime.ts";

const TARGET_VERSION = "0.16.0";

export function zig(args: string[]): SpawnResult {
	const envZig = process.env.ZIG;
	if (envZig && envZig.length > 0) {
		return spawnSync([envZig, ...args]);
	}
	// `command` is a shell builtin and cannot be exec'd by Bun.spawnSync;
	// use Bun.which for binary lookups (CodeRabbit finding).
	if (Bun.which("mise") !== null) {
		const root = repoRoot();
		const trusted = [process.env.MISE_TRUSTED_CONFIG_PATHS, root]
			.filter((s): s is string => !!s && s.length > 0)
			.join(":");
		return spawnSync(
			["mise", "x", `zig@${TARGET_VERSION}`, "--", "zig", ...args],
			{
				env: { MISE_TRUSTED_CONFIG_PATHS: trusted },
			},
		);
	}
	console.error(
		"WARN: falling back to bare-PATH zig because neither $ZIG nor mise was available",
	);
	return spawnSync(["zig", ...args]);
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

async function forward(
	stream: ReadableStream<Uint8Array>,
	sink: NodeJS.WriteStream,
): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	for await (const chunk of stream) {
		sink.write(chunk);
		text += decoder.decode(chunk, { stream: true });
	}
	return text + decoder.decode();
}

/**
 * Run `zig build fuzz` under a wall-clock budget. Returns:
 *   "pass"    — the run finished, no step failed, and the fuzzing report
 *               shows every listed fuzz test gained runs
 *   "timeout" — the budget elapsed first; treated as a clean pass by callers
 *   number    — a real fuzz failure: the non-zero exit code, or 1 when the
 *               build runner exited 0 after a failed or absent fuzz run
 *
 * Exit 0 alone is not a pass on Zig 0.16.0; see `fuzz-verdict.ts`.
 *
 * Shared between the per-PR (Tier 3) and per-release (Tier 4) gates so
 * the spawn shape, signal handling, and arg list stay identical.
 */
export async function runFuzz(opts: {
	limit: string;
	timeoutMs: number;
	/**
	 * Test seam: override the spawned argv. When omitted, the production
	 * "bun -e <inline> -- <json args>" form is used so `runFuzz` always
	 * launches the real `zig build fuzz` worker. Tests inject a slow stub
	 * (e.g. `["sleep", "5"]`) so timeout detection can be exercised
	 * deterministically in milliseconds, not multi-second budgets.
	 */
	command?: string[];
}): Promise<"pass" | "timeout" | number> {
	const root = repoRoot();
	const controller = new AbortController();
	// `timedOut` is the source of truth: the timer callback both aborts
	// the child *and* marks our intent. After `proc.exited` resolves we
	// check this flag (plus `signal.aborted` as a belt-and-suspenders
	// guard) so a SIGTERM exit (typically code 143) is correctly mapped
	// to "timeout" instead of bubbling up as a fuzz failure.
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, opts.timeoutMs);
	const cmd = opts.command ?? [
		"bun",
		"-e",
		"import { zig } from './scripts/lib/zig.ts';" +
			"const args = JSON.parse(process.argv[1] ?? '[]');" +
			"const r = zig(args);" +
			"process.stdout.write(r.stdout);" +
			"process.stderr.write(r.stderr);" +
			"process.exit(r.code ?? 1);",
		JSON.stringify([
			"build",
			"fuzz",
			"--summary",
			"failures",
			// The verdict reads the plain-text step tree.
			"--color",
			"off",
			`--fuzz=${opts.limit}`,
			`-j${cpuCount()}`,
		]),
	];
	try {
		const proc = Bun.spawn(cmd, {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			signal: controller.signal,
		});
		const printed = Promise.all([
			forward(proc.stdout, process.stdout),
			forward(proc.stderr, process.stderr),
		]);
		// A timeout or a non-zero exit returns without reading the streams.
		printed.catch(() => {});
		try {
			const code = await proc.exited;
			if (timedOut || controller.signal.aborted) return "timeout";
			if (code !== 0) return code;
			const output = (await printed).join("\n");
			const reasons = [
				...failedFuzzSteps(output),
				...missingFuzzEvidence(output),
			];
			if (reasons.length === 0) return "pass";
			console.error(
				`runFuzz: zig build fuzz exited 0 but the run is not a pass:\n  ${reasons.join("\n  ")}`,
			);
			return 1;
		} catch {
			// Older Bun builds reject `proc.exited` when the abort fires.
			// Either branch funnels into the same "timeout" verdict so the
			// caller's contract holds across runtime versions.
			if (timedOut || controller.signal.aborted) return "timeout";
			throw new Error("runFuzz: child process rejected without timeout");
		}
	} finally {
		// Guarantee timer cleanup so a late-resolving `proc.exited` cannot
		// leave a dangling AbortController callback in the event loop.
		clearTimeout(timer);
	}
}
