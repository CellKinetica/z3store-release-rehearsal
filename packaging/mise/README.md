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
nu packaging/mise/rehearsal-install.nu
# same as:
nu packaging/mise/rehearsal-install.nu --repo CellKinetica/z3store-release-rehearsal --version 0.4.0-rc.1 --root /Volumes/Crucial/tmp/z3store-release/fixtures/rehearsal-mise
```

For each of `github:CellKinetica/z3store-release-rehearsal` and
`packslip:github.com/CellKinetica/z3store-release-rehearsal`, the script makes
a fresh directory under `--root` with its own `MISE_DATA_DIR`,
`MISE_CONFIG_DIR`, `MISE_CACHE_DIR`, `MISE_STATE_DIR` and
`MISE_GLOBAL_CONFIG_FILE` (nothing touches `~/.config/mise` or
`~/.local/share/mise`). It writes a project `mise.toml`, then runs
`mise ls-remote --prerelease`, `mise install` (verbose, saved to
`install.log`), `mise x -- which zt` and `mise x -- zt --version`. It ends
with `mise packslip pins`, the host's `which -a zt`, and one row per backend:

| column | PASS means |
|---|---|
| `listed` | `ls-remote --prerelease` printed the exact version |
| `installed` | `mise install` exited 0 |
| `zt_in_isolated_dir` | `mise x -- which zt` is under `<root>/<backend>/data/installs/` |
| `version_ok` | `zt --version` printed `zt <version>` (needs L1's `--version`) |

The tool entry it writes is
`{ version = "0.4.0-rc.1", prerelease = true }`, plus
`workflow = "release.yml"` for packslip. Both settings matter for an rc
published minutes ago:

- `prerelease = true`: GitHub flags the rc as a prerelease, and mise leaves
  prereleases out of listing and `latest` without it (mise docs; measured
  against a mock API: `ls-remote` listed only `0.4.0`, with the option it also
  listed `0.4.0-rc.1`).
- An exact version: `minimum_release_age` defaults to 24h and filters `latest`
  but not an exact version (mise docs; measured against the mock).

Also check by hand, in `<root>/github/install.log` or on the live progress
line: `verify GitHub artifact attestations`, then `✓ GitHub artifact
attestations verified` (strings from mise `src/backend/github.rs` at
v2026.9.9). For packslip, `verify packslip`, and `mise packslip pins` should
name the fork's repository id.

## What already passed, and what did not

On 2026-11-07 (mise 2026.9.9) the script ran against a local mock of the
GitHub Releases API that serves the manifest's names for 0.4.0:

```nu
nu packaging/mise/rehearsal-install.nu --repo Eugene3dotdev/z3store --version 0.4.0 --api-url http://127.0.0.1:18774
```

Result: `listed`, `installed`, `zt_in_isolated_dir`, `version_ok` all true for
the github backend. With `--api-url` set, mise skips attestations and the
script skips packslip, so those two checks run for the first time in the
rehearsal.

The registry draft can be tried only from a mise checkout
(`registry/z3store.toml`), which is out of scope here. Its two backend
identifiers are the ones the script tests.
