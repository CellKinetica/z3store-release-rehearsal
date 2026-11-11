# packaging/mise

`z3store.toml` is a DRAFT of a mise registry entry (`registry/z3store.toml` in
jdx/mise). It is not submitted: the registry bar is "normally thousands of
GitHub stars, active maintenance, and real use outside the author's own
projects" (mise docs, contributing/registry) and the repository has 0. Users
install with the backend identifier instead; see [`docs/INSTALL.md`](../../docs/INSTALL.md).

## Re-running the install tests against the rehearsal release

Run this once the rehearsal fork `CellKinetica/z3store-release-rehearsal`
(repository id 1449589913) has a published `v0.4.0-rc.1` Release carrying every
`releaseAssetNames("0.4.0-rc.1")` asset:

```nu
let root = "/absolute/path/to/a/scratch/directory"
nu packaging/mise/rehearsal-install.nu --root $root
# same as:
nu packaging/mise/rehearsal-install.nu --root $root --repo CellKinetica/z3store-release-rehearsal --version 0.4.0-rc.1
# for a Release published less than a day ago:
nu packaging/mise/rehearsal-install.nu --root $root --minimum-release-age 0s
```

`--root` is required and must be absolute. For each of
`github:CellKinetica/z3store-release-rehearsal` and
`packslip:github.com/CellKinetica/z3store-release-rehearsal`, the script makes
a fresh run directory `<root>/rehearsal-mise-<backend>` with its own
`MISE_DATA_DIR`, `MISE_CONFIG_DIR`, `MISE_CACHE_DIR`, `MISE_STATE_DIR` and
`MISE_GLOBAL_CONFIG_FILE` (nothing touches `~/.config/mise` or
`~/.local/share/mise`). It writes a marker file `.z3store-rehearsal-mise` into
each run directory and empties a run directory on the next run only when that
marker is there; a directory of that name without the marker stops the script.
Nothing else under `--root` is deleted. It writes a project `mise.toml`, then
runs `mise ls-remote --prerelease`, `mise install` (verbose, saved to
`proj/install.log`), `mise x -- which zt` and `mise x -- zt --version`. It
ends with `mise packslip pins`, the host's `which -a zt`, and one row per
backend:

| column | PASS means |
|---|---|
| `listed` | `ls-remote --prerelease` printed the exact version (never within 24h of publishing unless `--minimum-release-age` lowers the age) |
| `installed` | `mise install` exited 0 |
| `attested` | the install log has the provenance line: `✓ GitHub artifact attestations verified` for github, `packslip signed by https://github.com/<repo>/.github/workflows/release.yml@refs/tags/v<version> (sigstore-oidc)` for packslip. False with `--api-url`, where mise skips attestations |
| `zt_in_isolated_dir` | `mise x -- which zt` is under `<root>/rehearsal-mise-<backend>/data/installs/` |
| `version_ok` | `zt --version` printed `zt <version>` (needs L1's `--version`) |

The tool entry it writes is
`{ version = "0.4.0-rc.1", prerelease = true }`, plus
`workflow = "release.yml"` for packslip. Three things matter for an rc
published minutes ago:

- `prerelease = true`: GitHub flags the rc as a prerelease, and mise leaves
  prereleases out of listing and `latest` without it (mise docs; measured
  against a mock API: `ls-remote` listed only `0.4.0`, with the option it also
  listed `0.4.0-rc.1`).
- An exact version: `minimum_release_age` defaults to 24h and filters `latest`
  and `ls-remote`. The `github:` backend still installs an exact version. The
  `packslip:` backend does not: it refuses any release whose transparency-log
  time is inside the window (measured on the rehearsal Release, below). mise's
  source exempts an install resolved from a committed `mise.lock`, and applies
  the window again on `mise lock` (read in `src/backend/packslip.rs` at
  v2026.9.9, not run). The script writes no lockfile, so it always meets the
  window.
- `--minimum-release-age 0s`: sets `MISE_MINIMUM_RELEASE_AGE` for the isolated
  runs only, so a Release under a day old can be listed and installed through
  packslip. Leave it off once the Release is a day old; the run then also
  proves the default age.

The `attested` column reads its two provenance lines from
`<root>/rehearsal-mise-<backend>/proj/install.log` (the github string is from
mise `src/backend/github.rs` at v2026.9.9; the packslip string is the debug
line mise printed in the rehearsal). Also check by hand that
`mise packslip pins` names the fork and its `release.yml` workflow as the
signer.

## What already passed, and what did not

On 2026-11-07 (mise 2026.9.9) the script ran against a local mock of the
GitHub Releases API that serves the manifest's names for 0.4.0:

```nu
nu packaging/mise/rehearsal-install.nu --root $root --repo Eugene3dotdev/z3store --version 0.4.0 --api-url http://127.0.0.1:18774
```

Result: `listed`, `installed`, `zt_in_isolated_dir`, `version_ok` all true for
the github backend. With `--api-url` set, mise skips attestations and the
script skips packslip, so those two checks run for the first time in the
rehearsal. That run predates the `attested` column and the required `--root`.

On 2026-11-10 (mise 2026.9.9) the script ran twice against the rehearsal
fork's `v0.4.0-rc.1` Release, within five minutes of publishing it:

| run | backend | `listed` | `installed` | `zt_in_isolated_dir` | `version_ok` |
|---|---|---|---|---|---|
| default age | github | false | true | true | true |
| default age | packslip | false | false | false | false |
| `--minimum-release-age 0s` | github | true | true | true | true |
| `--minimum-release-age 0s` | packslip | true | true | true | true |

Both github installs logged `✓ GitHub artifact attestations verified`. Both
packslip runs logged the signer
`https://github.com/CellKinetica/z3store-release-rehearsal/.github/workflows/release.yml@refs/tags/v0.4.0-rc.1 (sigstore-oidc)`;
the default-age run then stopped at `refusing to bypass minimum_release_age`.
After the second run `mise packslip pins` named
`github.com/CellKinetica/z3store-release-rehearsal`, the `release.yml`
workflow and `vendor yes`, held in the isolated state directory; the host's
own pin list stayed empty. Neither the table nor `--json` output shows a
repository id. Not run: the default age against a Release more than a day
old.

On 2026-11-11 (mise 2026.9.9) the script, now with the run-directory marker
and the `attested` column, ran twice in a row with `--minimum-release-age 0s`
against the same Release. All five columns were true for both backends in
both runs. Two decoy directories named `github` and `packslip` under `--root`
were untouched. Run without `--root`, with a relative `--root`, and with an
unmarked `rehearsal-mise-github` directory, the script stopped with exit 1
before it deleted or installed anything.

The registry draft can be tried only from a mise checkout
(`registry/z3store.toml`), which is out of scope here. Its two backend
identifiers are the ones the script tests.
