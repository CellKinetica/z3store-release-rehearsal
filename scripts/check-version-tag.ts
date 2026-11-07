#!/usr/bin/env bun
/**
 * check-version-tag.ts — release tag vs version source guard.
 *
 * Usage: bun scripts/check-version-tag.ts <tag>
 *
 * Exits 0 when `<tag>` is a release tag (`vX.Y.Z`, optional SemVer
 * prerelease) whose version equals the version read from `VERSION_SOURCE`
 * (`build.zig.zon` `.version` today) at the repo root. Exits 1 with a message
 * on stderr otherwise: a version mismatch, a tag that never gets a Release
 * (e.g. `v2026.07-final-stage`, `archive/...`), or an unreadable / non-SemVer
 * source version.
 *
 * Prerelease tags compare the full version string. Tagging `v0.4.0-rc.1`
 * therefore requires `.version = "0.4.0-rc.1"`; a rehearsal tag needs its own
 * version bump commit before it is tagged.
 *
 * The repo root comes from `repoRoot()` (honours CLAUDE_PROJECT_DIR, then
 * jj/git), so tests can point the check at a temporary directory.
 */
import { resolve } from "node:path";
import { parseReleaseTag, VERSION_SOURCE } from "./lib/release-manifest.ts";
import { repoRoot } from "./lib/runtime.ts";

export type VersionTagVerdict =
	| { readonly ok: true; readonly version: string }
	| { readonly ok: false; readonly message: string };

/** Compares a release tag against the text of the `VERSION_SOURCE` file. */
export function checkVersionTag(
	tag: string,
	sourceText: string,
): VersionTagVerdict {
	const parsed = parseReleaseTag(tag);
	if (parsed === null) {
		return {
			ok: false,
			message: `check-version-tag: "${tag}" is not a release tag (expected vX.Y.Z or vX.Y.Z-<prerelease>)`,
		};
	}
	let sourceVersion: string;
	try {
		sourceVersion = VERSION_SOURCE.read(sourceText);
	} catch (err) {
		return {
			ok: false,
			message: `check-version-tag: ${(err as Error).message}`,
		};
	}
	if (parsed.version !== sourceVersion) {
		return {
			ok: false,
			message: `check-version-tag: tag ${tag} has version ${parsed.version}, but ${VERSION_SOURCE.path} has version ${sourceVersion}`,
		};
	}
	return { ok: true, version: sourceVersion };
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const tag = args[0];
	if (args.length !== 1 || tag === undefined || tag.length === 0) {
		console.error("usage: bun scripts/check-version-tag.ts <tag>");
		process.exit(1);
	}
	const sourcePath = resolve(repoRoot(), VERSION_SOURCE.path);
	const sourceFile = Bun.file(sourcePath);
	if (!(await sourceFile.exists())) {
		console.error(`check-version-tag: ${sourcePath} not found`);
		process.exit(1);
	}
	const verdict = checkVersionTag(tag, await sourceFile.text());
	if (!verdict.ok) {
		console.error(verdict.message);
		process.exit(1);
	}
	console.log(
		`check-version-tag: ${tag} matches ${VERSION_SOURCE.path} ${verdict.version}`,
	);
}

if (import.meta.main) {
	await main();
}
