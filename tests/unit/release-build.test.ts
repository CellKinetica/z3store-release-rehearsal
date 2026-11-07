import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { targetByTriple } from "../../scripts/lib/release-manifest.ts";
import {
	gzipDeterministic,
	sortByteWise,
	writeTar,
} from "../../scripts/lib/tar.ts";
import {
	archiveMemberNames,
	checkFileSignature,
	collectEntries,
	formatSha256Sums,
	resolveSourceDateEpoch,
	sha256Hex,
} from "../../scripts/release-build.ts";

const enc = new TextEncoder();
const EPOCH = 1700000000;

function fixtureEntries() {
	// Deliberately unsorted input; the writer must store byte-wise order.
	return [
		{ name: "zt", data: enc.encode("#!/bin/sh\necho zt\n"), mode: 0o755 },
		{ name: "README.md", data: enc.encode("# z3store\n"), mode: 0o644 },
		{ name: "LICENSE", data: enc.encode("MIT\n"), mode: 0o644 },
		{
			name: "completions/zt.bash",
			data: enc.encode("complete -F _zt zt\n"),
			mode: 0o644,
		},
	];
}

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "release-build-test-"));
}

function run(cmd: string[], cwd?: string) {
	const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	return {
		code: p.exitCode,
		stdout: p.stdout.toString(),
		stderr: p.stderr.toString(),
	};
}

describe("tar writer", () => {
	test("fixed inputs produce fixed bytes", () => {
		const tar = writeTar(fixtureEntries(), EPOCH);
		expect(tar.byteLength).toBe(10240);
		expect(sha256Hex(tar)).toBe(
			"61871f6c5f6dd86003a10f60a99963fb057836966c1d6ea41bc9f6d86d0b544f",
		);
		const gz = gzipDeterministic(tar);
		expect(sha256Hex(gz)).toBe(
			"bc077af2b8ba9606212dab35ce1a6da705153dac277993593632cad6e52b75bc",
		);
		// gzip header: magic, deflate, no flags, mtime 0, OS = 3 (Unix).
		expect([...gz.slice(0, 4)]).toEqual([0x1f, 0x8b, 8, 0]);
		expect([...gz.slice(4, 8)]).toEqual([0, 0, 0, 0]);
		expect(gz[9]).toBe(3);
	});

	test("input order does not change the bytes", () => {
		const a = writeTar(fixtureEntries(), EPOCH);
		const b = writeTar([...fixtureEntries()].reverse(), EPOCH);
		expect(sha256Hex(a)).toBe(sha256Hex(b));
	});

	test("headers carry ustar magic, uid/gid 0, empty owner names", () => {
		const tar = writeTar(fixtureEntries(), EPOCH);
		const dec = new TextDecoder();
		const h = tar.slice(0, 512);
		expect(dec.decode(h.slice(0, 7))).toBe("LICENSE");
		expect(dec.decode(h.slice(100, 108))).toBe("0000644\0");
		expect(dec.decode(h.slice(108, 124))).toBe("0000000\x000000000\0");
		expect(dec.decode(h.slice(136, 148))).toBe(
			`${EPOCH.toString(8).padStart(11, "0")}\0`,
		);
		expect(dec.decode(h.slice(257, 265))).toBe("ustar\x0000");
		expect(h.slice(265, 329).every((b) => b === 0)).toBe(true);
		// typeflag '0': regular file, never a pax 'x' header.
		expect(h[156]).toBe(0x30);
	});

	test("bsdtar lists the expected members, modes and owners", () => {
		const dir = tmp();
		try {
			const path = join(dir, "fixture.tar.gz");
			writeFileSync(path, gzipDeterministic(writeTar(fixtureEntries(), EPOCH)));
			const r = run(["bsdtar", "-tvf", path]);
			expect(r.code).toBe(0);
			const rows = r.stdout
				.trim()
				.split("\n")
				.map((l) => l.trim().split(/\s+/));
			expect(rows.map((c) => c.at(-1))).toEqual([
				"LICENSE",
				"README.md",
				"completions/zt.bash",
				"zt",
			]);
			expect(rows.map((c) => c[0])).toEqual([
				"-rw-r--r--",
				"-rw-r--r--",
				"-rw-r--r--",
				"-rwxr-xr-x",
			]);
			for (const c of rows) expect([c[2], c[3]]).toEqual(["0", "0"]);
			const x = run(["bsdtar", "-xOf", path, "zt"]);
			expect(x.stdout).toBe("#!/bin/sh\necho zt\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects names ustar cannot hold without pax, and duplicates", () => {
		const data = new Uint8Array(0);
		expect(() =>
			writeTar([{ name: "x".repeat(101), data, mode: 0o644 }], EPOCH),
		).toThrow(/too long/);
		expect(() =>
			writeTar([{ name: "../zt", data, mode: 0o644 }], EPOCH),
		).toThrow();
		expect(() =>
			writeTar([{ name: "café", data, mode: 0o644 }], EPOCH),
		).toThrow(/ASCII/);
		expect(() =>
			writeTar(
				[
					{ name: "zt", data, mode: 0o755 },
					{ name: "zt", data, mode: 0o755 },
				],
				EPOCH,
			),
		).toThrow(/duplicate/);
	});

	test("sortByteWise is byte order, not locale order", () => {
		expect(
			sortByteWise(["zt", "completions/a", "README.md", "LICENSE"]),
		).toEqual(["LICENSE", "README.md", "completions/a", "zt"]);
	});
});

describe("SHA256SUMS", () => {
	test("format is '<hex>  <name>' sorted by name and shasum -c accepts it", () => {
		const dir = tmp();
		try {
			const files: Record<string, string> = {
				"z3store-0.4.0-macos-arm64.tar.gz": "arm",
				"z3store-0.4.0.cdx.json": "{}",
				"z3store-0.4.0-linux-x64.tar.gz": "x64",
			};
			const sums = Object.entries(files).map(([name, body]) => {
				writeFileSync(join(dir, name), body);
				return { name, sha256: sha256Hex(enc.encode(body)) };
			});
			const text = formatSha256Sums(sums);
			const lines = text.split("\n");
			expect(lines.at(-1)).toBe("");
			expect(lines.slice(0, -1).map((l) => l.slice(66))).toEqual([
				"z3store-0.4.0-linux-x64.tar.gz",
				"z3store-0.4.0-macos-arm64.tar.gz",
				"z3store-0.4.0.cdx.json",
			]);
			for (const l of lines.slice(0, -1)) {
				expect(l).toMatch(/^[0-9a-f]{64} {2}\S+$/);
			}
			writeFileSync(join(dir, "SHA256SUMS"), text);
			const r = run(["shasum", "-a", "256", "-c", "SHA256SUMS"], dir);
			expect(r.code).toBe(0);
			expect(r.stdout.match(/: OK$/gm)?.length).toBe(3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects bad digests, path-bearing names and duplicates", () => {
		const ok = "0".repeat(64);
		expect(() => formatSha256Sums([{ name: "a", sha256: "xyz" }])).toThrow();
		expect(() => formatSha256Sums([{ name: "d/a", sha256: ok }])).toThrow();
		expect(() =>
			formatSha256Sums([
				{ name: "a", sha256: ok },
				{ name: "a", sha256: ok },
			]),
		).toThrow(/duplicate/);
	});
});

describe("release-build helpers", () => {
	test("SOURCE_DATE_EPOCH prefers env, falls back to git, rejects junk", () => {
		expect(resolveSourceDateEpoch("42", () => "7")).toBe(42);
		expect(resolveSourceDateEpoch(undefined, () => "1700000000\n")).toBe(
			1700000000,
		);
		expect(resolveSourceDateEpoch("", () => "7")).toBe(7);
		expect(() => resolveSourceDateEpoch("-1", () => "7")).toThrow();
		expect(() => resolveSourceDateEpoch("1.5", () => "7")).toThrow();
	});

	test("file(1) signature check requires static linking for musl", () => {
		const musl = targetByTriple("x86_64-linux-musl");
		const mac = targetByTriple("aarch64-macos");
		expect(
			checkFileSignature(
				"ELF 64-bit LSB executable, x86-64, version 1 (SYSV), statically linked, stripped",
				musl,
			),
		).toBeNull();
		expect(
			checkFileSignature(
				"ELF 64-bit LSB executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /lib/ld-musl-x86_64.so.1",
				musl,
			),
		).toMatch(/statically linked/);
		expect(
			checkFileSignature("Mach-O 64-bit executable arm64", mac),
		).toBeNull();
		expect(checkFileSignature("Mach-O 64-bit executable x86_64", mac)).toMatch(
			/expected/,
		);
	});

	test("members include completions and the build fails without LICENSE", async () => {
		const root = tmp();
		try {
			writeFileSync(join(root, "README.md"), "# z3store\n");
			mkdirSync(join(root, "completions", "fish"), { recursive: true });
			writeFileSync(join(root, "completions", "zt.bash"), "b\n");
			writeFileSync(join(root, "completions", "fish", "zt.fish"), "f\n");
			writeFileSync(join(root, "zt-bin"), "bin\n");
			expect(archiveMemberNames(root)).toEqual([
				"LICENSE",
				"README.md",
				"completions/fish/zt.fish",
				"completions/zt.bash",
				"zt",
			]);
			await expect(collectEntries(root, join(root, "zt-bin"))).rejects.toThrow(
				/LICENSE/,
			);
			writeFileSync(join(root, "LICENSE"), "MIT\n");
			const entries = await collectEntries(root, join(root, "zt-bin"));
			expect(entries.map((e) => [e.name, e.mode])).toEqual([
				["LICENSE", 0o644],
				["README.md", 0o644],
				["completions/fish/zt.fish", 0o644],
				["completions/zt.bash", 0o644],
				["zt", 0o755],
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
