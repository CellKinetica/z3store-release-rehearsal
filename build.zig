const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    // Release archives build with -Dstrip=true so embedded debug paths cannot
    // make artifacts depend on the build machine's checkout location.
    const strip = b.option(bool, "strip", "Strip debug info from zt") orelse false;

    const fmt = b.addFmt(.{
        .paths = &.{ "build.zig", "build.zig.zon", "src" },
        .check = true,
    });
    const fmt_step = b.step("fmt", "Check formatting");
    fmt_step.dependOn(&fmt.step);

    // Public library module: consumers depend on this and import it as
    // `@import("z3store")`.
    const z3store_mod = b.addModule("z3store", .{
        .root_source_file = b.path("src/lib.zig"),
        .target = target,
        .optimize = optimize,
    });

    const exe_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .strip = strip,
    });

    const exe = b.addExecutable(.{
        .name = "zt",
        .root_module = exe_mod,
    });
    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| {
        run_cmd.addArgs(args);
    }
    const run_step = b.step("run", "Run zt");
    run_step.dependOn(&run_cmd.step);

    // Unit tests: exec.zig (standalone, fast)
    const unit_mod = b.createModule(.{
        .root_source_file = b.path("src/exec.zig"),
        .target = target,
        .optimize = optimize,
    });
    const unit_tests = b.addTest(.{ .root_module = unit_mod });
    const run_unit = b.addRunArtifact(unit_tests);

    // Integration tests: tests.zig (imports all modules, e2e tests)
    const integration_mod = b.createModule(.{
        .root_source_file = b.path("src/tests.zig"),
        .target = target,
        .optimize = optimize,
    });
    const integration_tests = b.addTest(.{ .root_module = integration_mod });

    // The integration suite includes e2e tests that spawn the real `zt`
    // binary, so it must be built first. `dependOn(&exe.step)` guarantees the
    // artifact exists before the test binary runs.
    integration_tests.step.dependOn(&exe.step);

    // Bake the zt binary path into `@import("build_options").zt_bin`.
    // The emitted-bin path is a LazyPath that is only resolvable after `exe`'s
    // make() runs, so it CANNOT be eagerly resolved with getPath2() during
    // build-graph construction (that panics with "misconfigured build script").
    // `addOptionPath` takes the LazyPath and resolves it lazily inside the
    // Options step's own make() — writing the absolute path into the generated
    // options module, where it surfaces as a plain `[]const u8` field. It also
    // wires the produced dependency edge so the binary is built first.
    const e2e_opts = b.addOptions();
    e2e_opts.addOptionPath("zt_bin", exe.getEmittedBin());
    integration_mod.addOptions("build_options", e2e_opts);

    const run_integration = b.addRunArtifact(integration_tests);

    // Public module smoke: catches regressions in the package surface that
    // external consumers import as `@import("z3store")`.
    const lib_tests = b.addTest(.{ .root_module = z3store_mod });
    const run_lib = b.addRunArtifact(lib_tests);

    const test_step = b.step("test", "Run all tests");
    test_step.dependOn(&run_unit.step);
    test_step.dependOn(&run_lib.step);
    test_step.dependOn(&run_integration.step);

    // Separate steps for targeted testing
    const unit_step = b.step("test-unit", "Run unit tests only");
    unit_step.dependOn(&run_unit.step);

    const lib_step = b.step("test-lib", "Run public library smoke tests");
    lib_step.dependOn(&run_lib.step);

    const integration_step = b.step("test-integration", "Run integration/e2e tests");
    integration_step.dependOn(&run_integration.step);

    // Fuzzing in Zig 0.16 is driven by the build runner's `--fuzz` flag, which
    // fuzzes every test binary under this step at once. A fuzz test compiled
    // into two binaries makes both lock the same corpus and the loser panics,
    // so this step runs one binary. `src/tests.zig` imports every module, so
    // the integration binary holds every fuzz test.
    const fuzz_step = b.step("fuzz", "Prepare the fuzz-capable test run");
    fuzz_step.dependOn(&b.addRunArtifact(addFuzzTests(b, integration_tests)).step);

    const docs_install = b.addInstallDirectory(.{
        .source_dir = lib_tests.getEmittedDocs(),
        .install_dir = .prefix,
        .install_subdir = "docs",
    });
    const docs_step = b.step("docs", "Install generated API docs");
    docs_step.dependOn(&docs_install.step);
}

/// Returns a copy of `tests` with error tracing off, for the `fuzz` step only.
///
/// Zig 0.16.0 cannot compile a `std.testing.fuzz` target in fuzz mode while
/// error tracing is on: `lib/compiler/test_runner.zig:566` hands the
/// `*std.builtin.StackTrace` from `@errorReturnTrace()` to
/// `std.debug.writeStackTrace`, which takes `*const std.debug.StackTrace`.
/// Upstream master calls `writeErrorReturnTrace` there. `zig build test` keeps
/// tracing. Delete this and wire the plain test runs into `fuzz` once the
/// pinned Zig carries that fix.
fn addFuzzTests(b: *std.Build, tests: *std.Build.Step.Compile) *std.Build.Step.Compile {
    const source = tests.root_module;
    const mod = b.createModule(.{
        .root_source_file = source.root_source_file,
        .target = source.resolved_target,
        .optimize = source.optimize,
        .error_tracing = false,
    });
    for (source.import_table.keys(), source.import_table.values()) |name, import| {
        mod.addImport(name, import);
    }
    const fuzz_tests = b.addTest(.{ .root_module = mod });
    // Explicit edges only, such as the `zt` binary the e2e tests spawn.
    for (tests.step.dependencies.items) |dependency| {
        fuzz_tests.step.dependOn(dependency);
    }
    return fuzz_tests;
}
