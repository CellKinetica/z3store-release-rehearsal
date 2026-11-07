import { describe, expect, test } from "bun:test";
import {
	ARCHIVE_MEMBERS,
	archiveName,
	BUILD_ADAPTER,
	buildAssetNames,
	CHECKSUM_FILE,
	OPTIONAL_ARCHIVE_DIR,
	PACKSLIP_BUNDLE,
	parseReleaseTag,
	RELEASE_TARGETS,
	readZonVersion,
	releaseAssetNames,
	sbomName,
	targetByTriple,
	VERSION_SOURCE,
} from "../../scripts/lib/release-manifest.ts";

describe("release-manifest", () => {
	test("covers the four initial targets with unique mise os/arch pairs", () => {
		expect(RELEASE_TARGETS.map((t) => t.zigTriple)).toEqual([
			"x86_64-linux-musl",
			"aarch64-linux-musl",
			"x86_64-macos",
			"aarch64-macos",
		]);
		const pairs = new Set(
			RELEASE_TARGETS.map((t) => `${t.mise.os}-${t.mise.arch}`),
		);
		expect(pairs.size).toBe(RELEASE_TARGETS.length);
	});

	test("archive names follow z3store-<version>-<os>-<arch>.tar.gz", () => {
		expect(archiveName("0.4.0", targetByTriple("x86_64-linux-musl"))).toBe(
			"z3store-0.4.0-linux-x64.tar.gz",
		);
		expect(archiveName("0.4.0-rc.1", targetByTriple("aarch64-macos"))).toBe(
			"z3store-0.4.0-rc.1-macos-arm64.tar.gz",
		);
		expect(() =>
			archiveName("v0.4.0", targetByTriple("aarch64-macos")),
		).toThrow();
	});

	test("asset lists are complete and ordered", () => {
		expect(buildAssetNames("0.4.0")).toEqual([
			"z3store-0.4.0-linux-x64.tar.gz",
			"z3store-0.4.0-linux-arm64.tar.gz",
			"z3store-0.4.0-macos-x64.tar.gz",
			"z3store-0.4.0-macos-arm64.tar.gz",
			CHECKSUM_FILE,
			sbomName("0.4.0"),
		]);
		expect(releaseAssetNames("0.4.0").at(-1)).toBe(PACKSLIP_BUNDLE);
	});

	test("archive members are byte-wise sorted", () => {
		const sorted = [...ARCHIVE_MEMBERS].sort();
		expect([...ARCHIVE_MEMBERS]).toEqual(sorted);
	});

	test("only vX.Y.Z tags (with optional prerelease) are release tags", () => {
		expect(parseReleaseTag("v0.4.0")).toEqual({
			tag: "v0.4.0",
			version: "0.4.0",
			prerelease: null,
		});
		expect(parseReleaseTag("v0.4.0-rc.1")?.prerelease).toBe("rc.1");
		expect(parseReleaseTag("v2026.07-final-stage")).toBeNull();
		expect(parseReleaseTag("archive/2026.07/pr-33-stores-schema")).toBeNull();
		expect(parseReleaseTag("0.4.0")).toBeNull();
		expect(parseReleaseTag("v01.2.3")).toBeNull();
	});

	test("build adapter is zig 0.16.0 through mise with ReleaseSafe + strip", () => {
		expect(BUILD_ADAPTER.kind).toBe("zig");
		expect(BUILD_ADAPTER.toolchain).toBe("zig@0.16.0");
		const cmd = BUILD_ADAPTER.buildCommand(
			targetByTriple("aarch64-linux-musl"),
		);
		expect(cmd.slice(0, 4)).toEqual(["mise", "x", "zig@0.16.0", "--"]);
		expect(cmd).toContain("-Doptimize=ReleaseSafe");
		expect(cmd).toContain("-Dstrip=true");
		expect(cmd).toContain("-Dtarget=aarch64-linux-musl");
		expect(BUILD_ADAPTER.outputPath(targetByTriple("x86_64-macos"))).toBe(
			"zig-out/bin/zt",
		);
	});

	test("version source adapter reads build.zig.zon", () => {
		expect(VERSION_SOURCE.kind).toBe("build.zig.zon");
		expect(VERSION_SOURCE.path).toBe("build.zig.zon");
		expect(VERSION_SOURCE.read('.{\n    .version = "0.4.0",\n}')).toBe("0.4.0");
	});

	test("every target carries a rust triple for the migration", () => {
		for (const t of RELEASE_TARGETS) {
			expect(t.rustTriple).toMatch(
				/^(x86_64|aarch64)-(unknown-linux-musl|apple-darwin)$/,
			);
		}
		expect(OPTIONAL_ARCHIVE_DIR).toBe("completions");
	});

	test("reads .version from build.zig.zon text", () => {
		expect(
			readZonVersion('.{\n    .name = .z3store,\n    .version = "0.4.0",\n}'),
		).toBe("0.4.0");
		expect(() => readZonVersion(".{ .name = .z3store }")).toThrow();
		expect(() => readZonVersion('.{\n    .version = "dev",\n}')).toThrow();
	});
});
