# packaging/aqua

`registry.yaml` is a DRAFT aqua recipe (`type: github_release`). It is not
submitted to aquaproj/aqua-registry. Nothing in this repository points at it:
the mise registry draft in [`packaging/mise/z3store.toml`](../mise/z3store.toml)
lists the `packslip:` and `github:` backends only, and it is not submitted
either, because the mise registry bar is "normally thousands of GitHub stars"
and the repository has 0.

The asset template mirrors `archiveName()` in `scripts/lib/release-manifest.ts`
(aqua's `darwin`/`amd64` are replaced by the manifest's `macos`/`x64`), the
checksum file is `CHECKSUM_FILE`, and the attestation signer is
`RELEASE_WORKFLOW_PATH`. Releases before 0.4.0 have no assets, so the
fallback override sets `no_asset: true`.

## What was measured

On 2026-11-07, mise 2026.9.9 read the draft from a local registry
(`aqua.registries = ["file://.../packaging/aqua/registry.yaml"]`) in isolated
mise dirs:

- `mise ls-remote aqua:Eugene3dotdev/z3store`: parsed the registry, then
  `WARN No versions found` (no Release has assets).
- `mise install aqua:Eugene3dotdev/z3store@0.3.0`: `failed: no asset released`,
  the `no_asset` override.
- `mise install aqua:Eugene3dotdev/z3store@0.4.0`: 404 for
  `releases/tags/v0.4.0` (no such Release yet).

- The rehearsal block below, run before the fork has a Release: the install
  of `0.4.0-rc.1` got past the `no_asset` fallback to a 404 for
  `releases/tags/v0.4.0-rc.1`, so `semver(">= 0.4.0-0")` admits the rc.

Not yet measured: the asset template, `trimV`, the checksum lookup and
`github_artifact_attestations` against real assets.

## Re-running against the rehearsal release

The recipe names the canonical repository, so test a copy that names the fork.
In a login Nu session (`nu -l`), from the repo root:

```nu
let d = (mktemp -d)   # a new, empty scratch directory; nothing is deleted
mkdir $"($d)/proj"
open --raw packaging/aqua/registry.yaml
| str replace --all "repo_owner: Eugene3dotdev" "repo_owner: CellKinetica"
| str replace --all "repo_name: z3store" "repo_name: z3store-release-rehearsal"
| str replace --all "Eugene3dotdev/z3store/.github" "CellKinetica/z3store-release-rehearsal/.github"
| save -f $"($d)/registry.yaml"
with-env {
  MISE_DATA_DIR: $"($d)/data"
  MISE_CONFIG_DIR: $"($d)/config"
  MISE_CACHE_DIR: $"($d)/cache"
  MISE_STATE_DIR: $"($d)/state"
  MISE_GLOBAL_CONFIG_FILE: $"($d)/config/config.toml"
} {
  cd $"($d)/proj"
  $"[settings.aqua]\nregistries = [\"file://($d)/registry.yaml\"]\n\n[tools]\n\"aqua:CellKinetica/z3store-release-rehearsal\" = { version = \"0.4.0-rc.1\", prerelease = true }\n" | save -f mise.toml
  mise trust mise.toml
  mise ls-remote --prerelease aqua:CellKinetica/z3store-release-rehearsal   # expect 0.4.0-rc.1
  with-env {MISE_VERBOSE: "1"} { mise install }
  mise x -- which zt          # expect a path under $d/data/installs/
  mise x -- zt --version      # expect: zt 0.4.0-rc.1
}
```

PASS: the install exits 0, the verbose log shows the `SHA256SUMS` checksum and
the GitHub artifact attestation check, and `zt` resolves inside `$d`. A failure is a finding; record it rather than
loosening the recipe.
