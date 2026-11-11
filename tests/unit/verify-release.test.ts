import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BuildAdapter,
	RELEASE_TARGETS,
} from "../../scripts/lib/release-manifest.ts";
import {
	cleanArtifacts,
	hashReleaseBuilds,
	reproducibilityDrift,
} from "../../scripts/verify-release.ts";

test("two passes with the same hash per target show no drift", () => {
	const pass = new Map([
		["x86_64-linux-musl", "4f00"],
		["aarch64-macos", "c859"],
	]);
	expect(reproducibilityDrift(pass, new Map(pass))).toEqual([]);
});

test("a target whose hash changed between passes is drift", () => {
	const drift = reproducibilityDrift(
		new Map([
			["x86_64-linux-musl", "1b39"],
			["aarch64-macos", "c859"],
		]),
		new Map([
			["x86_64-linux-musl", "e0dc"],
			["aarch64-macos", "c859"],
		]),
	);
	expect(drift).toEqual(["x86_64-linux-musl: first 1b39, second e0dc"]);
});

test("a target built in only one pass is drift", () => {
	const drift = reproducibilityDrift(
		new Map([["x86_64-macos", "b01c"]]),
		new Map(),
	);
	expect(drift).toEqual(["x86_64-macos: first b01c, second (not built)"]);
});

test("a target built only in the second pass is drift", () => {
	const drift = reproducibilityDrift(
		new Map([["aarch64-macos", "c859"]]),
		new Map([
			["aarch64-macos", "c859"],
			["x86_64-macos", "b01c"],
		]),
	);
	expect(drift).toEqual(["x86_64-macos: first (not built), second b01c"]);
});

test("two passes that built nothing prove nothing", () => {
	expect(reproducibilityDrift(new Map(), new Map())).toEqual([
		"no release target was built",
	]);
});

const TRIPLES = RELEASE_TARGETS.map((target) => target.zigTriple);

function newRoot(): string {
	return mkdtempSync(join(tmpdir(), "verify-release-"));
}

function sha256(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

// Stands in for the release build. The gate appends `--prefix <dir>`; the stub
// installs `bin/zt` there when told to, then exits with the given code.
function stubAdapter(behaviour: {
	install: boolean;
	exitCode: number;
}): BuildAdapter {
	const script = join(newRoot(), "stub-build.ts");
	writeFileSync(
		script,
		[
			'import { mkdirSync, writeFileSync } from "node:fs";',
			'import { join } from "node:path";',
			"const [triple, install, exitCode] = process.argv.slice(2);",
			'const prefix = process.argv[process.argv.indexOf("--prefix") + 1] ?? "";',
			'if (install === "install") {',
			'	mkdirSync(join(prefix, "bin"), { recursive: true });',
			'	writeFileSync(join(prefix, "bin", "zt"), "binary for " + triple);',
			"}",
			"process.exit(Number(exitCode));",
		].join("\n"),
	);
	return {
		kind: "zig",
		toolchain: "stub",
		buildCommand: (target) => [
			"bun",
			script,
			target.zigTriple,
			behaviour.install ? "install" : "skip",
			String(behaviour.exitCode),
		],
		outputPath: () => "zig-out/bin/zt",
	};
}

test("cleanArtifacts removes the project cache and the install tree", async () => {
	const root = newRoot();
	for (const dir of [".zig-cache", "zig-out"]) {
		mkdirSync(join(root, dir, "nested"), { recursive: true });
		writeFileSync(join(root, dir, "nested", "stale"), "stale");
	}
	writeFileSync(join(root, "build.zig"), "kept");

	await cleanArtifacts(root);
	await cleanArtifacts(root);

	expect(readdirSync(root)).toEqual(["build.zig"]);
});

test("hashReleaseBuilds hashes the binary each release target installed", async () => {
	const hashes = await hashReleaseBuilds(
		newRoot(),
		stubAdapter({ install: true, exitCode: 0 }),
	);
	expect([...hashes.keys()]).toEqual(TRIPLES);
	for (const triple of TRIPLES) {
		expect(hashes.get(triple)).toBe(sha256(`binary for ${triple}`));
	}
});

test("hashReleaseBuilds starts from an empty project cache", async () => {
	const root = newRoot();
	mkdirSync(join(root, ".zig-cache", "o"), { recursive: true });
	writeFileSync(join(root, ".zig-cache", "o", "stale"), "stale");
	mkdirSync(join(root, "zig-out", "bin"), { recursive: true });
	writeFileSync(join(root, "zig-out", "bin", "zt"), "native build");

	await hashReleaseBuilds(root, stubAdapter({ install: true, exitCode: 0 }));

	expect(existsSync(join(root, ".zig-cache"))).toBe(false);
	expect(readFileSync(join(root, "zig-out", "bin", "zt"), "utf8")).toBe(
		"native build",
	);
});

test("hashReleaseBuilds does not hash a binary an earlier pass left", async () => {
	const root = newRoot();
	for (const triple of TRIPLES) {
		const bin = join(root, "zig-out", "reproducibility", triple, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "zt"), "earlier pass");
	}
	const pass = hashReleaseBuilds(
		root,
		stubAdapter({ install: false, exitCode: 0 }),
	);
	await expect(pass).rejects.toThrow(`release build for ${TRIPLES[0]} left no`);
});

test("hashReleaseBuilds fails a build that exits non-zero, even with a binary", async () => {
	const pass = hashReleaseBuilds(
		newRoot(),
		stubAdapter({ install: true, exitCode: 1 }),
	);
	await expect(pass).rejects.toThrow(`release build failed for ${TRIPLES[0]}`);
});
