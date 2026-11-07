# Homebrew core readiness: z3store

Status: **not eligible yet. Do not submit.** This is a gap list for a future
`Homebrew/homebrew-core` pull request (TEO-1342). The draft formula is
[`z3store.rb`](z3store.rb). The supported install path today is the tap,
`brew install eugene3dotdev/tap/z3store`.

Measured on 2026-11-07 on himalayas (macOS 27.0.1, arm64), Homebrew
7.0.12-126-g86f1f0c, and in the `homebrew/brew` container (Homebrew 7.0.12,
aarch64 Linux). Labels: **M** measured, **I** inferred, **G** guess.

## Blockers, in order

1. **Notability.** A self-submission needs 90 forks, 90 watchers or 225
   stars. The repository has 0 stars, 1 fork and 0 watchers. (M)
2. **Licence.** The formula needs a DFSG-compatible licence. The repository
   has no `LICENSE` file, and GitHub reports `license: null`. TEO-809 owns
   the fix. The draft's `license "MIT"` is a placeholder. (M)
3. **Zig version.** Core prefers the current `zig` (0.17.1). z3store pins
   Zig 0.16.0, so the draft uses `zig@0.16`, which is deprecated from
   2027-10-01. On 0.17.1 the build fails on a single build-API change; see
   "Zig 0.17 measurement" below. (M)
4. **Release with assets.** v0.3.1 is a tag with no GitHub Release. Releases
   v0.2.0 through v0.3.0 exist but have 0 assets each. The source archive is
   enough for core, but the formula should track a published release. (M)

## Acceptance rules

Rules come from <https://docs.brew.sh/Acceptable-Formulae>, the pages it
links (<https://docs.brew.sh/Package-Acceptance-Policy>,
<https://docs.brew.sh/Versions>), and the rule text fetched on 2026-11-07.

| Rule | Status | Evidence |
|---|---|---|
| Notability, self-submission: at least 90 forks, 90 watchers or 225 stars | BLOCK | `gh api repos/Eugene3dotdev/z3store`: `stargazers_count` 0, `forks_count` 1 (the rehearsal fork CellKinetica/z3store-release-rehearsal), `subscribers_count` 0 (M) |
| Notability, third-party submission: at least 30 forks, 30 watchers or 75 stars | BLOCK | same numbers (M) |
| Metrics come from the canonical repository | PASS | Eugene3dotdev/z3store, id 1204361838; the former owner slug redirects to it (M) |
| Repository at least 30 days old | PASS | `created_at` 2026-04-08T00:07:20Z, about 213 days before 2026-11-07 (M) |
| Public presence and a homepage that explains the project | PARTIAL | the homepage is the GitHub README. Its description still reads "Separate .git and .jj databases from working trees for cloud-synced folders" and does not mention the ghq-replacement half (M) |
| Actively maintained, no known unpatched vulnerabilities | PASS | `pushed_at` 2026-10-28; no advisories known (M for push date, I for advisories) |
| Working `livecheck` without `skip` | PASS | `brew livecheck --formula`: `z3store: 0.3.1 ==> 0.3.1`. The git-tag regex ignores the `archive/*` and `v2026.07-final-stage` tags (M) |
| Builds and tests on the current macOS and Linux CI matrix | UNTESTED | `brew install` is blocked for agents. On macOS arm64, `zig build` with the exact `std_zig_args(release_mode: :safe)` flags from Zig 0.16.0 succeeds, and the binary prints `Usage: zt` (M). Linux: not run (see the hand-off commands) |
| Versioned, checksummed, immutable source | PASS | tag archive `v0.3.1.tar.gz`, sha256 `4e612fb2…93aa`, identical through `brew fetch` (canonical URL) and through the former-owner redirect (M) |
| Open source under a DFSG-compatible licence | BLOCK | no LICENSE on `main`, `dev`, `v0.3.1` or `release-dist/contract`; GitHub `license: null` (M). TEO-809 |
| Builds from source; no binaries, casks or proprietary dependencies | PASS | build dependency `zig@0.16` only (M) |
| Stable release marked by upstream, archive preferred | PASS with caveat | SemVer tags `v0.2.0`..`v0.3.1`; v0.3.1 has no GitHub Release object; no release is marked prerelease (M) |
| No downstream-only patches | PASS | the draft has no `patch` block (M) |
| Not a `.app`; CLI primary | PASS | the formula installs one CLI, `zt` (M) |
| Self-update disabled | PASS | no self-update command in `zt` (I, from the command list in `src/main.zig`) |
| Compiler support (Apple Clang unless declared) | PASS | Zig toolchain is the declared build dependency (I) |
| Installation automated, no manual steps | PASS | `zig build --prefix` installs `bin/zt`; no post-install step (M) |
| Vendored dependencies | PASS | `build.zig.zon` declares no dependencies (I, from reading `build.zig.zon`) |
| Versioned dependency policy | BLOCK until the 0.17 port | Versions.md: dependents "must not depend on the same formulae at two different versions" in their recursive tree, and versions "should not be used to 'pin' formulae to your personal requirements". `zig@0.16` is a build-only dependency with no `zig` in the tree, so the first clause holds (I). Core's auditor also fails new dependents of a deprecated formula (`Homebrew/formula_auditor.rb`, deprecated-dependency check), and `zig@0.16` is deprecated from 2027-10-01, so a core submission must build with current `zig` (M for the deprecation date, I for the auditor behaviour from its source) |
| Meaningful `test do` | PASS (draft) | the draft runs `zt root` against `$Z3STORE_ROOT` and checks `--help`. A local v0.3.1 build printed the root it was given (M) |
| `brew audit --strict --online` / `brew style` | PASS | the draft, in a scratch tap: `brew audit --strict --online` exit 0, `brew audit --new --strict --online` exit 0, `brew style --fix` no changes (M). Notability is enforced only for homebrew/core, so `--new` in a tap does not exercise it (I) |
| Bottle block | N/A | omitted. BrewTestBot adds bottles on merge (I) |

## Zig 0.17 measurement (no port)

This is a measurement only. Nothing was changed. The copy is a throwaway
clone of `release-dist/L5-homebrew-core` at acff652 under
`/Volumes/Crucial/tmp/z3store-release/fixtures/L5/zig017-copy`, plus an
extract of tag v0.3.1 under `fixtures/L5/v031-copy`.

```
mise install zig@0.17.1
mise x zig@0.17.1 -- zig version
# 0.17.1
mise x zig@0.17.1 -- zig build 2>&1 | tee ../zig017-build.log            # exit 1
mise x zig@0.17.1 -- zig build-exe -fno-emit-bin -freference-trace=0 src/main.zig   # exit 0
mise x zig@0.17.1 -- zig test -fno-emit-bin -freference-trace=0 src/lib.zig         # exit 0
mise x zig@0.17.1 -- zig test -fno-emit-bin -freference-trace=0 src/exec.zig        # exit 0
```

| Error kind (message pattern) | Count | Where |
|---|---|---|
| `expected type 'Build.LazyPath', found '*const [9:0]u8'` | 1 | `build.zig:11:22` (`b.addFmt` `.paths`; `build.zig:8:22` on v0.3.1) |
| `b.args` removed (use `run_cmd.addPassthruArgs()`) | 1 | `build.zig`, surfaces only after the first error is fixed (M, measured by the first-run lane on the `main` tree in a scratch copy) |
| `no field named` | 0 | |
| `deprecated` | 0 | |
| any other `error:` in `src/` (exe and lib/exec test roots) | 0 | |

With both `build.zig` edits applied in a scratch copy of the `main` tree,
`zig build test` under 0.17.1 passed 345/349; the four non-passes were two
skips and the two Lore e2e tests that fail on that tree under 0.16.0 too (M,
first-run lane). Nothing was committed.

What this shows (I): the build runner stops at the first `build.zig`
error, so more build-API changes may surface once that line is fixed. The
source passes semantic analysis on 0.17.1 for the `zt` executable root and
the `lib.zig` and `exec.zig` test roots. Code that Zig's lazy analysis does
not reach from those roots, and `src/tests.zig` (it needs the
`build_options` module from `build.zig`), was not measured. The port looks
small (G).

## Draft notes

- The draft differs from the tap formula in four ways: it has no
  `conflicts_with "gitstore"` (gitstore is tap-only), a different `desc`,
  a stronger `test do`, and a licence placeholder comment.
- `std_zig_args` exists in Homebrew 7.0.12:
  `brew ruby -e 'puts Formula.method_defined?(:std_zig_args)'` printed
  `true`. On this host it expands to `--prefix <p> --release=safe
  -Doptimize=ReleaseSafe --summary all -Dcpu=apple_m1 -fno-rosetta` (M).
- At 0.4.0, switch the test to `zt --version`, which prints `zt <version>`
  (the L1 interface).
