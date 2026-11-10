#!/usr/bin/env bun
/**
 * verify-release.ts — Tier 4 (hours).
 *
 * Pre-tag gate. Runs verify-pr first, then:
 *   1. Clean non-incremental rebuild
 *   2. Reproducibility check: every release target built twice from an
 *      empty project cache with the release build command; the sha256 of
 *      each binary must match across the two passes
 *   3. Deep fuzz (FUZZ_BUDGET_SECONDS, default 7200 = 2h), only when
 *      `fuzz` step exists and the platform supports it. An elapsed budget
 *      is a pass only with evidence of instrumented fuzzing; see `runFuzz`.
 *   4. SBOM via `zig run scripts/emit-sbom.zig`, falling back to `syft` if
 *      on PATH; otherwise a loud skip message pointing at the ADR.
 *   5. cosign signing — only when cosign is present AND COSIGN_ENABLED=1
 *      AND a CI environment is detected (CI=true). Otherwise logs a skip
 *      referencing doc/adr/0001 §0.12.
 *
 * Exit codes:
 *   0 — pass
 *   1 — real failure (build mismatch, fuzz crash, reproducibility drift)
 */
import { rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { BUILD_ADAPTER, RELEASE_TARGETS } from "./lib/release-manifest.ts";
import { appendJsonl, repoRoot, spawnSync, tail } from "./lib/runtime.ts";
import {
	miseTrustEnv,
	runFuzz,
	zig,
	zigFuzzSkipMessage,
	zigSupportsFuzz,
} from "./lib/zig.ts";

const TIER = "release" as const;

async function finish(code: number, startedAt: number): Promise<never> {
	const durationMs = Date.now() - startedAt;
	await appendJsonl(".claude/logs/verify.jsonl", {
		event: "verify",
		tier: TIER,
		code,
		durationMs,
	});
	process.exit(code);
}

function hasBuildStep(step: string): boolean {
	const listing = zig(["build", "-l"]);
	const text = `${listing.stdout}\n${listing.stderr}`;
	const escaped = step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`^[\\t ]*${escaped}(?:\\s|$)`, "m");
	return re.test(text);
}

async function cleanArtifacts(root: string): Promise<void> {
	await rm(resolve(root, ".zig-cache"), { recursive: true, force: true });
	await rm(resolve(root, "zig-out"), { recursive: true, force: true });
}

// Discover signable artifacts under `bin`. Returns an empty list if the
// directory is missing, so a project without a `zig-out/bin` (e.g.
// cargo-style layout) skips signing cleanly instead of aborting.
//
// Glob semantics (Bun.Glob): the pattern "*" matches TOP-LEVEL entries
// only — files (and directories, but Bun.Glob.scanSync only yields paths
// it can stat as files in this codepath) directly under `bin`. It does
// NOT recurse. That matches the canonical zig layout: `zig build` writes
// executables flat into `zig-out/bin/<exe>`, with no subdirectories. If
// a future build emits nested artifacts (e.g. per-arch subdirs), this
// pattern must change to a recursive globstar pattern and the caller's
// signing loop needs to handle directory entries explicitly.
//
// Covered by tests/unit/sign-glob.test.ts — the "subdir non-recursion"
// case is the regression boundary for this contract (R7-4).
export function listArtifacts(bin: string): string[] {
	// `"*"` = top-level entries only; intentionally non-recursive.
	const glob = new Bun.Glob("**/*");
	const out: string[] = [];
	try {
		for (const f of glob.scanSync({ cwd: bin, absolute: true })) out.push(f);
	} catch (err) {
		// ENOENT = missing bin/ → cargo-style layout, skip signing cleanly.
		// EACCES / IO must propagate so release signing aborts loudly
		// instead of silently producing an incomplete signed set.
		if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
			return [];
		throw err;
	}
	return out;
}

/**
 * Differences between two passes of release builds, each a map from zig
 * triple to the sha256 of that target's binary. Empty when both passes built
 * the same targets to the same bytes.
 */
export function reproducibilityDrift(
	first: ReadonlyMap<string, string>,
	second: ReadonlyMap<string, string>,
): string[] {
	if (first.size === 0 && second.size === 0) {
		return ["no release target was built"];
	}
	const drift: string[] = [];
	for (const triple of new Set([...first.keys(), ...second.keys()])) {
		const a = first.get(triple) ?? "(not built)";
		const b = second.get(triple) ?? "(not built)";
		if (a !== b) drift.push(`${triple}: first ${a}, second ${b}`);
	}
	return drift;
}

/**
 * Builds every release target from an empty project cache with the command
 * the release uses, and returns the sha256 of each binary by zig triple.
 * Zig's global cache is left alone, so the standard library objects it holds
 * are reused across passes.
 *
 * The hash covers the raw bytes, because those are the bytes that ship. The
 * builds install under `zig-out/reproducibility`, so `zig-out/bin` keeps the
 * native build for the stages that follow.
 *
 * Throws when a target fails to build or leaves no binary: a target that
 * was not built cannot be called reproducible.
 */
export async function hashReleaseBuilds(
	root: string,
): Promise<Map<string, string>> {
	const out = resolve(root, "zig-out", "reproducibility");
	await rm(resolve(root, ".zig-cache"), { recursive: true, force: true });
	await rm(out, { recursive: true, force: true });

	const hashes = new Map<string, string>();
	for (const target of RELEASE_TARGETS) {
		const prefix = resolve(out, target.zigTriple);
		const build = spawnSync(
			[...BUILD_ADAPTER.buildCommand(target), "--prefix", prefix],
			{ cwd: root, env: miseTrustEnv() },
		);
		if (build.code !== 0) {
			throw new Error(
				`release build failed for ${target.zigTriple}:\n${tail(build.stderr || build.stdout)}`,
			);
		}
		const binary = Bun.file(
			resolve(prefix, relative("zig-out", BUILD_ADAPTER.outputPath(target))),
		);
		if (!(await binary.exists())) {
			throw new Error(
				`release build for ${target.zigTriple} left no ${binary.name}`,
			);
		}
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(await binary.arrayBuffer());
		hashes.set(target.zigTriple, hasher.digest("hex"));
	}
	return hashes;
}

async function runFuzzBounded(
	limit: string,
	budgetSeconds: number,
): Promise<"pass" | "timeout" | number> {
	return runFuzz({ limit, timeoutMs: budgetSeconds * 1000 });
}

async function main(): Promise<void> {
	const startedAt = Date.now();
	const root = repoRoot();

	// Tag/version mismatch is cheap to detect, so it fails before the long tiers.
	const releaseTag =
		process.env.RELEASE_TAG ||
		(process.env.GITHUB_REF_TYPE === "tag"
			? process.env.GITHUB_REF_NAME
			: undefined);
	if (releaseTag) {
		console.log(`== check-version-tag ${releaseTag} ==`);
		const tagCheck = Bun.spawnSync(
			[process.execPath, "scripts/check-version-tag.ts", releaseTag],
			{ cwd: root, stdout: "inherit", stderr: "inherit", stdin: "ignore" },
		);
		if (tagCheck.exitCode !== 0) {
			await finish(tagCheck.exitCode ?? 1, startedAt);
		}
	}
	console.log("== verify-release -> verify-pr ==");
	const pr = Bun.spawnSync([process.execPath, "scripts/verify-pr.ts"], {
		cwd: root,
		stdout: "inherit",
		stderr: "inherit",
		stdin: "ignore",
	});
	if (pr.exitCode !== 0) await finish(pr.exitCode ?? 1, startedAt);

	console.log("== Clean non-incremental rebuild ==");
	await cleanArtifacts(root);
	const build1 = zig(["build", "--summary", "all"]);
	process.stdout.write(build1.stdout);
	process.stderr.write(build1.stderr);
	if (build1.code !== 0) {
		console.error("verify-release: clean rebuild failed");
		console.error(tail(build1.stderr || build1.stdout));
		await finish(build1.code ?? 1, startedAt);
	}

	console.log(
		"== Reproducibility check (release targets, two clean builds) ==",
	);
	const passes: Map<string, string>[] = [];
	try {
		passes.push(await hashReleaseBuilds(root));
		passes.push(await hashReleaseBuilds(root));
	} catch (err) {
		console.error(
			`verify-release: ${err instanceof Error ? err.message : String(err)}`,
		);
		await finish(1, startedAt);
	}
	const [first, second] = passes;
	const drift = reproducibilityDrift(first, second);
	if (drift.length > 0) {
		console.error(
			`verify-release: the release build is not reproducible:\n  ${drift.join("\n  ")}`,
		);
		await finish(1, startedAt);
	}
	for (const [triple, hash] of first) {
		console.log(`(reproducible: ${triple} ${hash})`);
	}

	if (hasBuildStep("fuzz")) {
		if (zigSupportsFuzz()) {
			const limit = process.env.RELEASE_FUZZ_LIMIT ?? "1G";
			const budget = Number(process.env.FUZZ_BUDGET_SECONDS ?? "7200");
			console.log(`== Deep fuzz (${budget}s, --fuzz=${limit}) ==`);
			const verdict = await runFuzzBounded(
				limit,
				Number.isFinite(budget) && budget > 0 ? budget : 7200,
			);
			if (verdict === "timeout") {
				console.log("(fuzz budget elapsed; no crashes)");
			} else if (verdict === "pass") {
				console.log("(fuzz completed within budget)");
			} else {
				// runFuzzBounded never returns 0 here (handled above as "pass").
				console.error(`verify-release: fuzz crashed (exit ${verdict})`);
				await finish(verdict, startedAt);
			}
		} else {
			console.log(zigFuzzSkipMessage());
		}
	} else {
		console.log("(no 'fuzz' build step — skipping fuzz gate)");
	}

	console.log("== SBOM (CycloneDX) ==");
	const sbomScript = resolve(root, "scripts/emit-sbom.zig");
	if (await Bun.file(sbomScript).exists()) {
		const sbom = zig(["run", "scripts/emit-sbom.zig", "--", "build.zig.zon"]);
		if (sbom.code === 0) {
			await Bun.write(resolve(root, "sbom.cdx.json"), sbom.stdout);
			console.log("(wrote sbom.cdx.json)");
		} else {
			console.error("verify-release: emit-sbom.zig failed");
			console.error(tail(sbom.stderr));
			await finish(sbom.code ?? 1, startedAt);
		}
	} else {
		// `command` is a shell builtin; use Bun.which for binary lookups.
		if (Bun.which("syft") !== null) {
			const syft = spawnSync(["syft", "dir:.", "-o", "cyclonedx-json"]);
			if (syft.code === 0) {
				await Bun.write(resolve(root, "sbom.cdx.json"), syft.stdout);
				console.log("(wrote sbom.cdx.json via syft fallback)");
			} else {
				console.error("verify-release: syft fallback failed");
				await finish(syft.code ?? 1, startedAt);
			}
		} else {
			console.log(
				"(no scripts/emit-sbom.zig and no syft on PATH — SBOM emission skipped)",
			);
		}
	}

	console.log("== cosign sign artifacts ==");
	// `command` is a shell builtin; use Bun.which for binary lookups.
	const hasCosign = Bun.which("cosign") !== null;
	const cosignEnabled = process.env.COSIGN_ENABLED === "1";
	const inCI = process.env.CI === "true" || process.env.CI === "1";
	if (hasCosign && cosignEnabled && inCI) {
		const bin = resolve(root, "zig-out", "bin");
		const artifacts = listArtifacts(bin);
		if (artifacts.length === 0) {
			console.log(
				"(no artifacts under zig-out/bin to sign; skipping cosign step)",
			);
		} else {
			for (const artifact of artifacts) {
				// `--output-signature` lets cosign write the .sig file directly so
				// we do not have to capture its stdout (which mixes status output
				// with the signature blob).
				const sig = spawnSync([
					"cosign",
					"sign-blob",
					"--yes",
					"--output-signature",
					`${artifact}.sig`,
					artifact,
				]);
				if (sig.code !== 0) {
					console.error(
						`verify-release: cosign sign-blob failed for ${artifact}`,
					);
					await finish(sig.code ?? 1, startedAt);
				}
				console.log(`(signed ${artifact})`);
			}
		}
	} else {
		console.log(
			"(cosign not configured; release signing skipped — see doc/adr/0001 + §0.12 release boundary)",
		);
	}

	console.log("verify-release: OK");
	await finish(0, startedAt);
}

// Only run as a CLI when invoked directly. Importing for unit tests must
// not trigger a full release verify pass.
if (import.meta.main) {
	await main();
}
