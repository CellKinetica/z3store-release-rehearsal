# Installing `zt`

z3store ships one binary, `zt`, as signed, checksummed and attested archives on
GitHub Releases. Pick one install route:

```nu
mise use -g github:Eugene3dotdev/z3store
mise use -g packslip:github.com/Eugene3dotdev/z3store
brew install eugene3dotdev/tap/z3store
```

The two `mise use` lines resolve `latest`, which mise holds back for the first
24 hours after a release (see [`minimum_release_age`](#minimum_release_age)).
On release day the `github:` route takes an exact version, for example
`mise use -g github:Eugene3dotdev/z3store@0.4.0` **[run, mock; run, rehearsal]**.
The `packslip:` route refuses a release under 24 hours old even by exact
version, unless that command lowers the age **[run, rehearsal]**.

Status (2026-11-07): no Release carries assets yet. Releases v0.2.0 to v0.3.0
exist with zero assets, so all three routes fail today; the first release the
workflow publishes is 0.4.0. See [Current state](#current-state-measured).

Every file name on this page comes from
[`scripts/lib/release-manifest.ts`](../scripts/lib/release-manifest.ts), the
release contract. It is not a second definition: if this page and the manifest
disagree, the manifest wins. Print the names for a version with:

```nu
bun -e 'import {releaseAssetNames} from "./scripts/lib/release-manifest.ts"; console.log(releaseAssetNames("0.4.0").join("\n"))'
```

For 0.4.0 that prints four archives (`z3store-0.4.0-{linux,macos}-{x64,arm64}.tar.gz`),
`SHA256SUMS`, the CycloneDX SBOM and `packslip.sigstore.json`. Each archive is
flat: `LICENSE`, `README.md`, `zt` at the root, no top-level directory.

Each claim below carries its source in brackets: **[run]** a command executed
on 2026-11-07 with mise 2026.9.9, **[src]** mise source at tag v2026.9.9,
**[doc]** a mise or GitHub documentation page. **[run, rehearsal]** is a
command executed on 2026-11-10 with mise 2026.9.9 against the `v0.4.0-rc.1`
Release that this workflow published on the rehearsal fork
`CellKinetica/z3store-release-rehearsal`, within five minutes of publishing.

## What each route verifies

### `github:` backend

- Asset selection is automatic; no `asset_pattern` is needed. mise scores each
  asset name for OS and architecture tokens. Its regexes accept `darwin`, `mac`,
  `macos`, `macosx`, `osx` for macOS, `linux` for Linux, `x86_64`/`x86-64`/`x64`/`amd64`
  for x64 and `aarch64`/`arm64` for arm64 **[src: `src/backend/asset_matcher.rs`]**.
  Against a local mock of the GitHub Releases API serving the manifest's names,
  `mise install` chose `z3store-0.4.0-macos-arm64.tar.gz` on this Mac and
  `mise lock --platform linux-x64,linux-arm64,macos-x64,macos-arm64` resolved
  one archive per platform **[run]**.
- Checksum: when the GitHub API reports a per-asset `digest` (real GitHub
  Releases do), mise verifies the download against that digest and never reads
  `SHA256SUMS` **[run: with a digest present, a deliberately wrong `SHA256SUMS`
  was ignored and the mock logged no request for it]**. Only when the API has no
  digest does mise fall back to a global checksum file named `SHA256SUMS`
  **[src; run, mock]**. The digest proves the bytes were not changed after
  upload; it cannot tell a genuine archive from a wrong one uploaded in its
  place. That is what the attestation and packslip checks are for.
- GitHub artifact attestations: "mise checks GitHub artifact attestations when
  a release asset has them" **[doc]**. It queries the attestation API with the
  asset's digest **[src]**. It is on by default and runs only when the
  `github_attestations` setting, `github.github_attestations` setting and the
  tool's `github_attestations` option are all true; never with a custom
  `api_url` **[doc]**. If the attestation API call itself fails, mise warns and
  skips provenance unless `provenance_api_failures_fatal` is set **[src]**.
  Once `mise.lock` records attestation provenance, a later install that cannot
  satisfy it fails **[doc]**.
- Verify the same attestation by hand with the GitHub CLI (flags from
  `gh attestation verify --help`, gh 2.83.2) **[run]**:

  ```nu
  gh attestation verify z3store-0.4.0-macos-arm64.tar.gz --repo Eugene3dotdev/z3store --signer-workflow Eugene3dotdev/z3store/.github/workflows/release.yml
  ```

  The workflow path is the manifest's `RELEASE_WORKFLOW_PATH`.

### `packslip:` backend

- mise installs only from a Release that carries the bundle
  `packslip.sigstore.json` (the manifest's `PACKSLIP_BUNDLE`); it "does not
  guess at release assets" **[run: error text quoted below]**.
- It verifies the bundle's Sigstore signature, certificate and
  transparency-log evidence against the repository's identity, then the
  selected archive's digest and size against the signed manifest **[doc:
  packslip verification]**.
- Signer pin: mise pins GitHub projects "by the forge's repository ID, not
  only by name" **[doc]**; the ID is 1204361838 (the manifest's
  `CANONICAL_REPO_ID`). By default any workflow of the repository may sign; to
  require the release workflow, set the tool option `workflow = "release.yml"`
  **[doc: packslip backend]**:

  ```toml
  [tools]
  "packslip:github.com/Eugene3dotdev/z3store" = { version = "0.4.0", workflow = "release.yml" }
  ```

- Continuity is trust on first use: the first install accepts whoever owns the
  name then; a new workflow path or key afterwards needs an explicit decision
  **[doc]**. Inspect or reset pins with `mise packslip pins` and
  `mise packslip forget github.com/Eugene3dotdev/z3store` **[run: `mise packslip --help`]**.

### Homebrew tap

`brew install eugene3dotdev/tap/z3store` installs from the tap formula, which
pins each archive by sha256. The formula lives in the tap repository, not
here. (This page did not run `brew install`; it is a blocked command on the
authoring host.)

## Verify `SHA256SUMS` by hand

`SHA256SUMS` lists every archive and the SBOM in `sha256sum -c` format. If you
downloaded only one archive, ignore the missing lines; without
`--ignore-missing`, `shasum` exits 1 for each file you did not download **[run]**:

```nu
gh release download v0.4.0 --repo Eugene3dotdev/z3store --pattern SHA256SUMS --pattern z3store-0.4.0-macos-arm64.tar.gz
shasum -a 256 --ignore-missing -c SHA256SUMS
# z3store-0.4.0-macos-arm64.tar.gz: OK
```

`SHA256SUMS` itself is only as trustworthy as where you got it; pair it with
the attestation check above.

## Pin a version

```nu
mise use -g github:Eugene3dotdev/z3store@0.4.0
mise use -g packslip:github.com/Eugene3dotdev/z3store@0.4.0
```

Commit `mise.lock` (`mise lock`, then `mise install --locked`) to pin the
archive URL and checksum per platform **[doc; `mise lock` output run against
the mock]**. Tags are `vX.Y.Z`; mise reports the version without the `v`
**[run: `mise ls-remote` printed `0.4.0` for tag `v0.4.0`]**.

## `minimum_release_age`

mise skips versions published more recently than `minimum_release_age`,
default `"24h"`, env `MISE_MINIMUM_RELEASE_AGE` **[doc: settings]**. It filters
fuzzy requests (`latest`, `0.4`), not exact versions (`@0.4.0`) or versions
pinned in `mise.lock` **[doc]**. Against the mock, whose release is dated
2026-11-01: `@latest --minimum-release-age 30d` failed with `no versions found
... matching date filter`, `@0.4.0 --minimum-release-age 30d` installed, and
`@latest --minimum-release-age 1d` resolved to 0.4.0 **[run]**. So `mise use -g github:Eugene3dotdev/z3store`
resolves to a release only once it is a day old; ask for the exact version, or
pass `--minimum-release-age 0s` for one command, to take a fresh one.

The exact-version exemption holds for `github:` only. The `packslip:` backend
compares the bundle's transparency-log time with the cutoff on every install
**[src: `check_verified_age` in `src/backend/packslip.rs`]**. With the default
age, `mise install` of the exact rc through `github:` succeeded, and through
`packslip:` it failed after the signature had verified **[run, rehearsal]**:

```text
packslip release was recorded by the transparency log at 2026-11-10T22:39:31Z,
after the allowed cutoff 2026-11-09T22:41:53Z; refusing to bypass minimum_release_age
```

`mise ls-remote` printed no version for either backend and warned `1 newer ...
release hidden by minimum_release_age`. With `MISE_MINIMUM_RELEASE_AGE=0s` both
backends listed the rc, installed it and ran `zt --version` **[run,
rehearsal]**. To take a release in its first day through packslip, lower the
age for that one command and leave the setting alone:

```nu
mise use -g --minimum-release-age 0s packslip:github.com/Eugene3dotdev/z3store@0.4.0
```

The flag is listed by `mise use --help` and `mise install --help`; the
rehearsal set the environment variable, not the flag.

Prereleases (`-rc.N`) are excluded from `latest` and `ls-remote` unless the tool
option `prerelease = true` is set **[doc; run against the mock: `ls-remote`
listed `0.4.0`, with `prerelease=true` it listed `0.4.0-rc.1` and `0.4.0`]**.

## PATH shadow (TEO-980 class)

An older `zt` earlier on `PATH` hides the one mise installed: a stale
`~/.local/bin/zt`, or a Homebrew `zt` ahead of mise's shims. The agent rule in
[`docs/product/AX.md`](product/AX.md) is to stop and report, not to pick one
silently. Check:

```nu
mise which zt               # the binary mise resolves
which -a zt                 # every zt on PATH, in order
zt --version
```

`mise which zt` should print a path under mise's installs directory (for
example `.../installs/github-eugene3dotdev-z3store/0.4.0/zt` **[run, mock]**),
and the first row of `which -a zt` should be that file or mise's shim. If
another `zt` comes first, remove it or reorder `PATH`, then re-check. Do not
rely on `mise x -- which zt` or `mise x -- zt --version` for this: the first
still reports the shadowing binary, and the second runs the right binary and so
hides the shadow **[run: Homebrew 0.3.1 `zt` placed ahead of mise's shims;
`which zt` and `mise x -- which zt` returned the Homebrew copy, `mise x -- zt
--version` printed `zt 0.4.0`, `mise doctor` reported nothing]**.

## Known issue: linux-x64 under Rosetta

The linux-x64 binary runs on real x86_64 Linux hosts and containers
**[run: ubuntu:22.04, ubuntu:24.04, alpine on an x86_64 host]**, but inside
`linux/amd64` containers run through Rosetta on an Apple Silicon Mac it exits
133 with `rosetta error: bss_size overflow` **[run: OrbStack, same three
images]**. QEMU runs it. Use the linux-arm64 archive in arm64 containers on a
Mac, or a real x86_64 host.

## Current state (measured)

All runs used an isolated `MISE_DATA_DIR`, `MISE_CONFIG_DIR`, `MISE_CACHE_DIR`
and `MISE_STATE_DIR` **[run, 2026-11-07, mise 2026.9.9]**:

| Command | Result |
|---|---|
| `mise ls-remote github:Eugene3dotdev/z3store` | exit 0, `WARN No versions found` (mise lists only releases that have assets **[src]**) |
| `mise install github:Eugene3dotdev/z3store@v0.3.0` | exit 1, `No matching asset found for platform macos-arm64` / `Available assets:` (empty) |
| `mise ls-remote packslip:github.com/Eugene3dotdev/z3store` | exit 0, no output |
| `mise install packslip:github.com/Eugene3dotdev/z3store@0.3.0` | exit 1, `has no release 0.3.0 carrying packslip.sigstore.json; mise installs from a packslip and does not guess at release assets` |

The former owner slug of the repository redirects to the same repository and
gives the same `No versions found` result **[run]**.

The mise registry shorthand (`mise use -g z3store`) and an aqua recipe exist
only as unsubmitted drafts under [`packaging/`](../packaging/): the registry
bar is "normally thousands of GitHub stars" **[doc: contributing/registry]**
and the repository has 0.
