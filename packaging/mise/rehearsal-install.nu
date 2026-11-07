#!/usr/bin/env nu
# Install-test the mise routes against one published Release, in isolated
# mise dirs (never ~/.config/mise or ~/.local/share/mise). TEO-1342.
#
# Defaults target the rehearsal fork's first rc. `--api-url` points the github
# backend at a mock Releases API; it skips attestations and the packslip step,
# so it proves asset selection and SHA256SUMS only.

def isolated-env [dir: string] {
	{
		MISE_DATA_DIR: $"($dir)/data"
		MISE_CONFIG_DIR: $"($dir)/config"
		MISE_CACHE_DIR: $"($dir)/cache"
		MISE_STATE_DIR: $"($dir)/state"
		MISE_GLOBAL_CONFIG_FILE: $"($dir)/config/config.toml"
	}
}

def step [label: string, cmd: closure] {
	let r = do $cmd | complete
	print $"=== ($label) exit=($r.exit_code)"
	print ($r.stdout | str trim)
	print ($r.stderr | lines | where {|l| $l !~ "self-update|available$" } | str join "\n")
	$r
}

# One backend: write a project mise.toml, install, and check what `zt` resolves to.
def try-backend [root: string, name: string, tool: string, opts: string, version: string] {
	let dir = $"($root)/($name)"
	rm -rf $dir
	mkdir $"($dir)/proj"
	with-env (isolated-env $dir) {
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
			zt_in_isolated_dir: ($which.stdout | str trim | str starts-with $data)
			version_ok: (($ver.stdout | str trim) == $"zt ($version)")
		}
	}
}

def main [
	--repo: string = "CellKinetica/z3store-release-rehearsal"
	--version: string = "0.4.0-rc.1"  # Release version without the leading v
	--root: string = "/Volumes/Crucial/tmp/z3store-release/fixtures/rehearsal-mise"
	--api-url: string = ""            # mock Releases API; github backend only
] {
	let gh_opts = if $api_url == "" { "" } else { $", api_url = \"($api_url)\"" }
	mut rows = [(try-backend $root "github" $"github:($repo)" $gh_opts $version)]
	if $api_url == "" {
		$rows = ($rows | append (try-backend $root "packslip" $"packslip:github.com/($repo)" ", workflow = \"release.yml\"" $version))
		with-env (isolated-env $"($root)/packslip") { step "packslip: pins" { ^mise packslip pins } | ignore }
	}
	print "=== which -a zt (host PATH; mise's zt must come first after activation, else TEO-980 class)"
	print (which -a zt)
	$rows
}
