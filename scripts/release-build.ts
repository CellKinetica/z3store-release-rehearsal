#!/usr/bin/env bun
/**
 * release-build.ts — reproducible release artifacts (TEO-1342).
 *
 *   bun scripts/release-build.ts [--out <dir>]     (default: dist)
 *
 * Builds every RELEASE_TARGETS entry through BUILD_ADAPTER, each into its
 * own install prefix so targets never overwrite each other, checks every
 * binary with file(1), packs deterministic tar.gz archives, emits the SBOM
 * and writes SHA256SUMS. The output directory ends up holding exactly
 * buildAssetNames(version) and nothing else.
 *
 * SOURCE_DATE_EPOCH comes from the environment, else from the HEAD commit
 * time; it is exported to the build and used as every archive member's
 * mtime.
 *
 * LICENSE is a required archive member. A tree without it fails here, on
 * purpose: that is the licence gate, and there is no bypass.
 *
 * Exit codes: 0 pass; 1 any failure; 2 usage error.
 */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { mkdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
	ARCHIVE_MEMBERS,
	archiveName,
	BINARY_NAME,
	BUILD_ADAPTER,
	buildAssetNames,
	CHECKSUM_FILE,
	OPTIONAL_ARCHIVE_DIR,
	RELEASE_TARGETS,
	type ReleaseTarget,
	sbomName,
	VERSION_SOURCE,
} from "./lib/release-manifest.ts";
import { spawnSync, tail } from "./lib/runtime.ts";
import {
	gzipDeterministic,
	sortByteWise,
	type TarEntry,
	writeTar,
} from "./lib/tar.ts";

/** Toolchain that runs scripts/emit-sbom.zig; independent of the build adapter. */
const SBOM_TOOLCHAIN = "zig@0.16.0";

export class ReleaseBuildError extends Error {}

function fail(msg: string): never {
	throw new ReleaseBuildError(msg);
}

/** Formats `<hex>  <name>\n` lines sorted byte-wise by name (sha256sum -c format). */
export function formatSha256Sums(
	sums: ReadonlyArray<{ readonly name: string; readonly sha256: string }>,
): string {
	const byName = new Map<string, string>();
	for (const s of sums) {
		if (!/^[0-9a-f]{64}$/.test(s.sha256)) {
			throw new Error(`SHA256SUMS: bad digest for ${s.name}`);
		}
		if (s.name.length === 0 || /[\s/\\]/.test(s.name)) {
			throw new Error(`SHA256SUMS: bad file name ${JSON.stringify(s.name)}`);
		}
		if (byName.has(s.name)) throw new Error(`SHA256SUMS: duplicate ${s.name}`);
		byName.set(s.name, s.sha256);
	}
	return sortByteWise([...byName.keys()])
		.map((n) => `${byName.get(n)}  ${n}\n`)
		.join("");
}

export function sha256Hex(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** SOURCE_DATE_EPOCH from env (validated), else the HEAD commit time. */
export function resolveSourceDateEpoch(
	env: string | undefined,
	gitCommitTime: () => string,
): number {
	const raw = env !== undefined && env.length > 0 ? env : gitCommitTime();
	const text = raw.trim();
	if (!/^\d+$/.test(text)) {
		fail(`SOURCE_DATE_EPOCH must be a non-negative integer, got "${text}"`);
	}
	return Number(text);
}

/**
 * Checks `file -b` output against the target. musl targets must also be
 * statically linked. Returns null when acceptable, else the reason.
 */
export function checkFileSignature(
	fileOutput: string,
	target: ReleaseTarget,
): string | null {
	if (!fileOutput.includes(target.fileSignature)) {
		return `expected "${target.fileSignature}", file(1) said "${fileOutput.trim()}"`;
	}
	if (target.libc === "musl" && !fileOutput.includes("statically linked")) {
		return `musl target is not statically linked: "${fileOutput.trim()}"`;
	}
	return null;
}

/** Archive member list: required members plus every regular file under OPTIONAL_ARCHIVE_DIR. */
export function archiveMemberNames(root: string): string[] {
	const names: string[] = [...ARCHIVE_MEMBERS];
	const optRoot = join(root, OPTIONAL_ARCHIVE_DIR);
	if (existsSync(optRoot)) {
		const walk = (dir: string): void => {
			for (const ent of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, ent.name);
				const rel = relative(root, full).replaceAll("\\", "/");
				if (ent.isDirectory()) walk(full);
				else if (ent.isFile()) names.push(rel);
				else fail(`${rel}: only regular files may be archived`);
			}
		};
		walk(optRoot);
	}
	return sortByteWise(names);
}

/** Reads the archive inputs for one target. `binary` is the built `zt`. */
export async function collectEntries(
	root: string,
	binary: string,
): Promise<TarEntry[]> {
	const entries: TarEntry[] = [];
	for (const name of archiveMemberNames(root)) {
		const path = name === BINARY_NAME ? binary : join(root, name);
		if (!existsSync(path) || !lstatSync(path).isFile()) {
			fail(`required archive member missing: ${name} (${path})`);
		}
		entries.push({
			name,
			data: new Uint8Array(await Bun.file(path).arrayBuffer()),
			mode: name === BINARY_NAME ? 0o755 : 0o644,
		});
	}
	return entries;
}

function binaryPath(prefix: string, target: ReleaseTarget): string {
	// outputPath is relative to the default `zig-out` prefix; re-root it.
	const rel = relative("zig-out", BUILD_ADAPTER.outputPath(target));
	if (rel.startsWith("..")) {
		fail(
			`build adapter output ${BUILD_ADAPTER.outputPath(target)} is not under zig-out`,
		);
	}
	return join(prefix, rel);
}

function childEnv(root: string, epoch: number): Record<string, string> {
	const trusted = [process.env.MISE_TRUSTED_CONFIG_PATHS, root]
		.filter((s): s is string => !!s && s.length > 0)
		.join(":");
	return {
		SOURCE_DATE_EPOCH: String(epoch),
		MISE_TRUSTED_CONFIG_PATHS: trusted,
	};
}

function buildTarget(
	root: string,
	target: ReleaseTarget,
	epoch: number,
): string {
	if (BUILD_ADAPTER.kind !== "zig") {
		fail(`release-build: no prefix strategy for adapter ${BUILD_ADAPTER.kind}`);
	}
	const prefix = resolve(root, "zig-out", "release", target.zigTriple);
	const cmd = [...BUILD_ADAPTER.buildCommand(target), "--prefix", prefix];
	console.log(`release-build: ${cmd.join(" ")}`);
	const r = spawnSync(cmd, { cwd: root, env: childEnv(root, epoch) });
	if (r.code !== 0) {
		fail(
			`build failed for ${target.zigTriple} (exit ${r.code})\n${tail(r.stderr)}`,
		);
	}
	const bin = binaryPath(prefix, target);
	if (!existsSync(bin)) fail(`build produced no binary at ${bin}`);
	const f = spawnSync(["file", "-b", bin], { cwd: root });
	if (f.code !== 0) fail(`file(1) failed on ${bin}: ${f.stderr.trim()}`);
	const why = checkFileSignature(f.stdout, target);
	if (why !== null) fail(`${target.zigTriple}: ${why}`);
	console.log(`release-build: ${target.zigTriple}: ${f.stdout.trim()}`);
	return bin;
}

function emitSbom(root: string, epoch: number): Uint8Array {
	const r = spawnSync(
		[
			"mise",
			"x",
			SBOM_TOOLCHAIN,
			"--",
			"zig",
			"run",
			"scripts/emit-sbom.zig",
			"--",
			VERSION_SOURCE.path,
		],
		{ cwd: root, env: childEnv(root, epoch) },
	);
	if (r.code !== 0)
		fail(`emit-sbom failed (exit ${r.code})\n${tail(r.stderr)}`);
	try {
		JSON.parse(r.stdout);
	} catch {
		fail("emit-sbom output is not JSON");
	}
	return new TextEncoder().encode(r.stdout);
}

function parseArgs(argv: string[]): { out: string } {
	let out = "dist";
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--out" && argv[i + 1] !== undefined) {
			out = argv[++i] as string;
		} else if (a?.startsWith("--out=")) {
			out = a.slice("--out=".length);
		} else {
			console.error("usage: bun scripts/release-build.ts [--out <dir>]");
			process.exit(2);
		}
	}
	if (out.length === 0) {
		console.error("release-build: --out must not be empty");
		process.exit(2);
	}
	return { out };
}

export async function releaseBuild(
	root: string,
	outArg: string,
): Promise<void> {
	const out = resolve(root, outArg);
	if (existsSync(out) && readdirSync(out).length > 0) {
		fail(`output directory ${out} is not empty; remove it first`);
	}
	const version = VERSION_SOURCE.read(
		await Bun.file(join(root, VERSION_SOURCE.path)).text(),
	);
	const epoch = resolveSourceDateEpoch(process.env.SOURCE_DATE_EPOCH, () => {
		const g = spawnSync(["git", "log", "-1", "--format=%ct", "HEAD"], {
			cwd: root,
		});
		if (g.code !== 0) fail(`git log failed: ${g.stderr.trim()}`);
		return g.stdout;
	});
	console.log(`release-build: version ${version}, SOURCE_DATE_EPOCH ${epoch}`);

	// Licence gate before any build time is spent: every non-binary member
	// must exist in the tree.
	for (const name of archiveMemberNames(root)) {
		if (name !== BINARY_NAME && !existsSync(join(root, name))) {
			fail(`required archive member missing: ${name}`);
		}
	}

	const staging = `${out}.partial-${process.pid}`;
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging, { recursive: true });
	try {
		const sums: { name: string; sha256: string }[] = [];
		for (const target of RELEASE_TARGETS) {
			const bin = buildTarget(root, target, epoch);
			const tgz = gzipDeterministic(
				writeTar(await collectEntries(root, bin), epoch),
			);
			const name = archiveName(version, target);
			await writeFile(join(staging, name), tgz);
			sums.push({ name, sha256: sha256Hex(tgz) });
		}
		const sbom = emitSbom(root, epoch);
		await writeFile(join(staging, sbomName(version)), sbom);
		sums.push({ name: sbomName(version), sha256: sha256Hex(sbom) });
		await writeFile(join(staging, CHECKSUM_FILE), formatSha256Sums(sums));

		const want = sortByteWise(buildAssetNames(version));
		const got = sortByteWise(readdirSync(staging));
		if (JSON.stringify(want) !== JSON.stringify(got)) {
			fail(`asset set mismatch: want ${want.join(",")} got ${got.join(",")}`);
		}
		if (existsSync(out)) await rmdir(out);
		await mkdir(dirname(out), { recursive: true });
		await rename(staging, out);
	} catch (err) {
		await rm(staging, { recursive: true, force: true });
		throw err;
	}
	console.log(`release-build: OK -> ${out}`);
	for (const n of sortByteWise(buildAssetNames(version))) console.log(`  ${n}`);
}

if (import.meta.main) {
	const { out } = parseArgs(process.argv.slice(2));
	try {
		await releaseBuild(resolve(import.meta.dir, ".."), out);
	} catch (err) {
		console.error(
			`release-build: FAIL: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(1);
	}
}
