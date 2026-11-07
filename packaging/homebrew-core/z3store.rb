# Draft for a future Homebrew/homebrew-core submission. Not submitted.
# Readiness and blockers: packaging/homebrew-core/READINESS.md (TEO-1342).
# Ruby by necessity: Homebrew formulae can only be Ruby. This file is a
# reference draft, not executed by any z3store gate.
class Z3store < Formula
  desc "Workspace control plane that keeps Git/JJ databases out of working trees"
  homepage "https://github.com/Eugene3dotdev/z3store"
  url "https://github.com/Eugene3dotdev/z3store/archive/refs/tags/v0.3.1.tar.gz"
  sha256 "4e612fb24f0d1b10e9904a360e3163d7a0f46af5d5837fe351149405d36293aa"
  # Placeholder: the repository has no LICENSE yet (TEO-809). Replace with
  # the SPDX id of the licence that lands; core rejects a formula without one.
  license "MIT"
  head "https://github.com/Eugene3dotdev/z3store.git", branch: "main"

  # Core prefers the current `zig`. z3store pins Zig 0.16, so this needs
  # either a 0.17-compatible release (switch to `depends_on "zig" => :build`)
  # or a reviewer exception; zig@0.16 is deprecated from 2027-10-01.
  depends_on "zig@0.16" => :build

  def install
    system "zig", "build", *std_zig_args(release_mode: :safe)
  end

  test do
    ENV["Z3STORE_ROOT"] = (testpath/"ghq").to_s
    assert_equal (testpath/"ghq").to_s, shell_output("#{bin}/zt root").strip
    assert_match "Usage: zt", shell_output("#{bin}/zt --help 2>&1")
    # From 0.4.0:
    #   assert_equal "zt #{version}", shell_output("#{bin}/zt --version").strip
  end
end
