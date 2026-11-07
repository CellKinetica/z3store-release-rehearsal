import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkVersionTag } from "../../scripts/check-version-tag.ts";

const SCRIPT = resolve(import.meta.dir, "../../scripts/check-version-tag.ts");

function zon(version: string): string {
	return `.{\n    .name = .z3store,\n    .version = "${version}",\n    .minimum_zig_version = "0.16.0",\n}\n`;
}

describe("checkVersionTag", () => {
	test("accepts a tag whose version equals the zon version", () => {
		expect(checkVersionTag("v0.4.0", zon("0.4.0"))).toEqual({
			ok: true,
			version: "0.4.0",
		});
	});

	test("rejects a version mismatch and names both versions", () => {
		const v = checkVersionTag("v0.3.9", zon("0.4.0"));
		expect(v.ok).toBe(false);
		if (!v.ok) {
			expect(v.message).toContain("0.3.9");
			expect(v.message).toContain("0.4.0");
		}
	});

	test("rejects tags that never get a Release", () => {
		for (const tag of [
			"v2026.07-final-stage",
			"archive/2026.07/pr-33-stores-schema",
			"0.4.0",
		]) {
			const v = checkVersionTag(tag, zon("0.4.0"));
			expect(v.ok).toBe(false);
			if (!v.ok) expect(v.message).toContain("not a release tag");
		}
	});

	test("prerelease tags compare the full version", () => {
		expect(checkVersionTag("v0.4.0-rc.1", zon("0.4.0")).ok).toBe(false);
		expect(checkVersionTag("v0.4.0-rc.1", zon("0.4.0-rc.1")).ok).toBe(true);
		expect(checkVersionTag("v0.4.0", zon("0.4.0-rc.1")).ok).toBe(false);
	});

	test("rejects a zon without a SemVer .version", () => {
		expect(checkVersionTag("v0.4.0", ".{ .name = .z3store }").ok).toBe(false);
		expect(checkVersionTag("v0.4.0", zon("dev")).ok).toBe(false);
	});
});

describe("check-version-tag CLI", () => {
	let dir = "";

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "check-version-tag-"));
		await writeFile(join(dir, "build.zig.zon"), zon("0.4.0"));
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	function run(...args: string[]) {
		return Bun.spawnSync([process.execPath, SCRIPT, ...args], {
			env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
			stdout: "pipe",
			stderr: "pipe",
		});
	}

	test("exit 0 on match", () => {
		const r = run("v0.4.0");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.toString()).toContain("matches");
	});

	test("exit 1 on mismatch, non-release tag, or missing argument", () => {
		for (const args of [["v0.3.9"], ["v2026.07-final-stage"], []]) {
			const r = run(...args);
			expect(r.exitCode).toBe(1);
			expect(r.stderr.toString().length).toBeGreaterThan(0);
		}
	});

	test("exit 1 when build.zig.zon is missing", async () => {
		const empty = await mkdtemp(join(tmpdir(), "check-version-tag-empty-"));
		try {
			const r = Bun.spawnSync([process.execPath, SCRIPT, "v0.4.0"], {
				env: { ...process.env, CLAUDE_PROJECT_DIR: empty },
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(r.exitCode).toBe(1);
			expect(r.stderr.toString()).toContain("not found");
		} finally {
			await rm(empty, { recursive: true, force: true });
		}
	});
});
