/**
 * Release distribution contract for z3store.
 *
 * This module is the single source for release target mapping and every
 * published file name. Build scripts, workflows, install docs, and packaging
 * drafts derive names from here; none of them restate these strings.
 *
 * Contract rules:
 *   - Exported names and the shapes of exported values are frozen once a
 *     release has been published, because mise asset autodetection, packslip
 *     manifests and Homebrew formulae key on them.
 *   - Exactly two fields may change when the Rust migration lands:
 *     `BUILD_ADAPTER` and `VERSION_SOURCE`. Asset names, archive layout, the
 *     checksum file, the workflow path and the signer identity stay fixed.
 *   - The version comes from `VERSION_SOURCE` only (`build.zig.zon` today).
 */

export const PACKAGE_NAME = "z3store" as const;
export const BINARY_NAME = "zt" as const;

/** Canonical GitHub home. The former owner slug is a GitHub rename redirect to the same repository id. */
export const CANONICAL_REPO = "Eugene3dotdev/z3store" as const;
export const CANONICAL_REPO_ID = 1204361838 as const;
export const HOMEBREW_TAP_REPO = "Eugene3dotdev/homebrew-tap" as const;

/** packslip signer continuity pins the repository id and this exact workflow path. */
export const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml" as const;

export type MiseOs = "linux" | "macos";
export type MiseArch = "x64" | "arm64";
export type HomebrewOs = "linux" | "macos";
/** Matches Homebrew's `on_intel` / `on_arm` blocks. */
export type HomebrewArch = "intel" | "arm";

export type ReleaseTarget = {
	/** Value passed to `zig build -Dtarget=`. */
	readonly zigTriple: string;
	/** Equivalent `rustc` target, used by the Rust build adapter when it lands. */
	readonly rustTriple: string;
	/** Tokens used in the archive name; chosen to match mise's github-backend autodetect. */
	readonly mise: { readonly os: MiseOs; readonly arch: MiseArch };
	readonly homebrew: { readonly os: HomebrewOs; readonly arch: HomebrewArch };
	/** `musl` targets link statically, so one binary serves glibc and musl hosts. */
	readonly libc: "musl" | null;
	/** Substring `file(1)` must report for the built `zt` binary. */
	readonly fileSignature: string;
};

export const RELEASE_TARGETS: readonly ReleaseTarget[] = [
	{
		zigTriple: "x86_64-linux-musl",
		rustTriple: "x86_64-unknown-linux-musl",
		mise: { os: "linux", arch: "x64" },
		homebrew: { os: "linux", arch: "intel" },
		libc: "musl",
		fileSignature: "ELF 64-bit LSB executable, x86-64",
	},
	{
		zigTriple: "aarch64-linux-musl",
		rustTriple: "aarch64-unknown-linux-musl",
		mise: { os: "linux", arch: "arm64" },
		homebrew: { os: "linux", arch: "arm" },
		libc: "musl",
		fileSignature: "ELF 64-bit LSB executable, ARM aarch64",
	},
	{
		zigTriple: "x86_64-macos",
		rustTriple: "x86_64-apple-darwin",
		mise: { os: "macos", arch: "x64" },
		homebrew: { os: "macos", arch: "intel" },
		libc: null,
		fileSignature: "Mach-O 64-bit executable x86_64",
	},
	{
		zigTriple: "aarch64-macos",
		rustTriple: "aarch64-apple-darwin",
		mise: { os: "macos", arch: "arm64" },
		homebrew: { os: "macos", arch: "arm" },
		libc: null,
		fileSignature: "Mach-O 64-bit executable arm64",
	},
] as const;

/**
 * Required archive members, in the byte-wise sorted order the archive stores
 * them. Paths are flat (no top-level directory).
 *
 * LICENSE is required on purpose: the release build fails when the file is
 * absent, which makes the licensing decision a mechanical gate rather than a
 * documented promise.
 */
export const ARCHIVE_MEMBERS = ["LICENSE", "README.md", BINARY_NAME] as const;

/**
 * Optional archive members: shell completions, when the tree ships them.
 * `zt` has no completion files today; the build includes every file under
 * this directory that exists, under the same relative path, sorted.
 */
export const OPTIONAL_ARCHIVE_DIR = "completions" as const;

export const CHECKSUM_FILE = "SHA256SUMS" as const;
export const PACKSLIP_BUNDLE = "packslip.sigstore.json" as const;

/**
 * Build adapter: how one target's `zt` binary is produced. This is one of the
 * two fields the Rust migration may change. The toolchain resolves only
 * through mise and the repo's `.mise.toml`, never a bare binary on PATH.
 */
export type BuildAdapter = {
	readonly kind: "zig" | "cargo";
	/** mise tool spec, e.g. `zig@0.16.0`. Must match `.mise.toml`. */
	readonly toolchain: string;
	/** Command that builds `BINARY_NAME` for one target. */
	readonly buildCommand: (target: ReleaseTarget) => readonly string[];
	/** Repo-relative path of the built binary after `buildCommand` succeeds. */
	readonly outputPath: (target: ReleaseTarget) => string;
};

export const BUILD_ADAPTER: BuildAdapter = {
	kind: "zig",
	toolchain: "zig@0.16.0",
	buildCommand: (target) => [
		"mise",
		"x",
		"zig@0.16.0",
		"--",
		"zig",
		"build",
		"-Doptimize=ReleaseSafe",
		"-Dstrip=true",
		`-Dtarget=${target.zigTriple}`,
	],
	outputPath: () => `zig-out/bin/${BINARY_NAME}`,
};

/**
 * Version source adapter: where the single release version lives. This is the
 * other field the Rust migration may change (`Cargo.toml` `[package].version`).
 */
export type VersionSourceAdapter = {
	readonly kind: "build.zig.zon" | "Cargo.toml";
	/** Repo-relative path of the file holding the version. */
	readonly path: string;
	/** Parses the file text and returns the SemVer version without a leading `v`. */
	readonly read: (text: string) => string;
};

const PRERELEASE_ID = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`;

/** One grammar for the version source and the tag, so the two cannot disagree. */
const SEMVER_SOURCE = String.raw`(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(${PRERELEASE_ID}(?:\.${PRERELEASE_ID})*))?`;

/** Stable release tags only: `vX.Y.Z`, with an optional SemVer prerelease such as `-rc.1`. */
export const RELEASE_TAG_PATTERN = new RegExp(`^v${SEMVER_SOURCE}$`);

const SEMVER_PATTERN = new RegExp(`^${SEMVER_SOURCE}$`);

export type ReleaseTag = {
	readonly tag: string;
	/** Version without the leading `v`; this is what archive names carry. */
	readonly version: string;
	readonly prerelease: string | null;
};

/** Returns null for tags that never get a Release (`v2026.07-final-stage`, `archive/*`). */
export function parseReleaseTag(tag: string): ReleaseTag | null {
	const m = RELEASE_TAG_PATTERN.exec(tag);
	if (m === null) return null;
	return { tag, version: tag.slice(1), prerelease: m[4] ?? null };
}

/** Reads `.version` from the text of `build.zig.zon`. Throws when absent or not SemVer. */
export function readZonVersion(zonText: string): string {
	const m = /^\s*\.version\s*=\s*"([^"]+)"\s*,/m.exec(zonText);
	const version = m?.[1];
	if (version === undefined) {
		throw new Error("build.zig.zon: no .version field");
	}
	if (!SEMVER_PATTERN.test(version)) {
		throw new Error(`build.zig.zon: .version "${version}" is not SemVer`);
	}
	return version;
}

export const VERSION_SOURCE: VersionSourceAdapter = {
	kind: "build.zig.zon",
	path: "build.zig.zon",
	read: readZonVersion,
};

function assertVersion(version: string): void {
	if (!SEMVER_PATTERN.test(version)) {
		throw new Error(
			`release version "${version}" is not SemVer (no leading v)`,
		);
	}
}

export function archiveName(version: string, target: ReleaseTarget): string {
	assertVersion(version);
	return `${PACKAGE_NAME}-${version}-${target.mise.os}-${target.mise.arch}.tar.gz`;
}

export function sbomName(version: string): string {
	assertVersion(version);
	return `${PACKAGE_NAME}-${version}.cdx.json`;
}

/** Assets the build produces. The packslip bundle is added later by the signing job. */
export function buildAssetNames(version: string): string[] {
	return [
		...RELEASE_TARGETS.map((t) => archiveName(version, t)),
		CHECKSUM_FILE,
		sbomName(version),
	];
}

/** Every asset a complete published Release carries. */
export function releaseAssetNames(version: string): string[] {
	return [...buildAssetNames(version), PACKSLIP_BUNDLE];
}

export function targetByTriple(zigTriple: string): ReleaseTarget {
	const t = RELEASE_TARGETS.find((x) => x.zigTriple === zigTriple);
	if (t === undefined) throw new Error(`unknown release target ${zigTriple}`);
	return t;
}
