#!/usr/bin/env nu
# Install-test the mise routes against one published Release, in isolated
# mise dirs (never ~/.config/mise or ~/.local/share/mise). TEO-1342.
#
# Defaults target the rehearsal fork's first rc. `--root` is required and
# absolute; each backend runs in `<root>/rehearsal-mise-<backend>`, which the
# script marks as its own and is the only thing it ever deletes. `--api-url`
# points the github backend at a mock Releases API; it skips attestations and
# the packslip step, so it proves asset selection and SHA256SUMS only, and
# `attested` is false there.

def isolated-env [dir: string, age: string] {
	let dirs = {
		MISE_DATA_DIR: $"($dir)/data"
		MISE_CONFIG_DIR: $"($dir)/config"
		MISE_CACHE_DIR: $"($dir)/cache"
		MISE_STATE_DIR: $"($dir)/state"
		MISE_GLOBAL_CONFIG_FILE: $"($dir)/config/config.toml"
	}
	if $age == "" { $dirs } else { $dirs | insert MISE_MINIMUM_RELEASE_AGE $age }
}

def step [label: string, cmd: closure] {
	let r = do $cmd | complete
	print $"=== ($label) exit=($r.exit_code)"
	print ($r.stdout | str trim)
	print ($r.stderr | lines | where {|l| $l !~ "self-update|available$" } | str join "\n")
	$r
}

const MARKER = ".z3store-rehearsal-mise"

def run-dir [root: string, name: string] {
	$root | path join $"rehearsal-mise-($name)"
}

# Empty the run directory, but only one this script made: it deletes nothing
# that lacks the marker file it writes.
def fresh-run-dir [dir: string] {
	if ($dir | path exists) {
		if not ($dir | path join $MARKER | path exists) {
			error make {msg: $"refusing to delete ($dir): no ($MARKER) marker, so this script did not create it"}
		}
		rm -rf $dir
	}
	mkdir $"($dir)/proj"
	"" | save ($dir | path join $MARKER)
}

# One backend: write a project mise.toml, install, and check what `zt` resolves to.
# `proof` is the install-log line that shows the provenance check passed.
def try-backend [root: string, name: string, tool: string, opts: string, version: string, age: string, proof: string] {
	let dir = run-dir $root $name
	fresh-run-dir $dir
	with-env (isolated-env $dir $age) {
		cd $"($dir)/proj"
		$"[tools]\n\"($tool)\" = { version = \"($version)\", prerelease = true($opts) }\n" | save -f mise.toml
		^mise trust mise.toml
		let listed = step $"($name): ls-remote --prerelease" { ^mise ls-remote --prerelease $tool }
		let inst = step $"($name): install" { with-env {MISE_VERBOSE: "1"} { ^mise install } }
		$inst.stderr | save -f install.log
		let which = step $"($name): mise x -- which zt" { ^mise x -- which zt }
		let ver = step $"($name): mise x -- zt --version" { ^mise x -- zt --version }
		let data = $"($dir)/data/installs/"
		{
			backend: $name
			listed: ($listed.stdout | lines | any {|l| $l == $version })
			installed: ($inst.exit_code == 0)
			attested: ($inst.stderr | str contains $proof)
			zt_in_isolated_dir: ($which.stdout | str trim | str starts-with $data)
			version_ok: (($ver.stdout | str trim) == $"zt ($version)")
		}
	}
}

def main [
	--repo: string = "CellKinetica/z3store-release-rehearsal"
	--version: string = "0.4.0-rc.1"  # Release version without the leading v
	--root: string = ""               # required: absolute directory that holds the run directories
	--api-url: string = ""            # mock Releases API; github backend only
	--minimum-release-age: string = "" # e.g. 0s for a Release under a day old; empty keeps mise's default (24h)
] {
	if not ($root | str starts-with "/") {
		error make {msg: $"--root must be an absolute path, got '($root)'"}
	}
	let age = $minimum_release_age
	let gh_opts = if $api_url == "" { "" } else { $", api_url = \"($api_url)\"" }
	let gh_proof = "✓ GitHub artifact attestations verified"
	let ps_proof = $"packslip signed by https://github.com/($repo)/.github/workflows/release.yml@refs/tags/v($version) \(sigstore-oidc\)"
	mut rows = [(try-backend $root "github" $"github:($repo)" $gh_opts $version $age $gh_proof)]
	if $api_url == "" {
		$rows = ($rows | append (try-backend $root "packslip" $"packslip:github.com/($repo)" ", workflow = \"release.yml\"" $version $age $ps_proof))
		with-env (isolated-env (run-dir $root "packslip") $age) { step "packslip: pins" { ^mise packslip pins } | ignore }
	}
	print "=== which -a zt (host PATH; mise's zt must come first after activation, else TEO-980 class)"
	print (which -a zt)
	$rows
}
