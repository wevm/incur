const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const incur = b.addModule("incur", .{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
    });

    const tests = testArtifacts(b, incur, false);
    const test_step = b.step("test", "Run API, README, compile-error, and differential tests");
    for ([_]*std.Build.Step.Compile{ tests.api, tests.readme }) |artifact| {
        test_step.dependOn(&b.addRunArtifact(artifact).step);
    }

    const run_differential = b.addRunArtifact(tests.differential);
    run_differential.setCwd(b.path("."));
    run_differential.has_side_effects = true;
    const differential_step = b.step("differential", "Compare every shared case with the TypeScript reference");
    differential_step.dependOn(&run_differential.step);
    test_step.dependOn(&run_differential.step);

    const compile_errors = b.step("compile-errors", "Check that invalid schema metadata fails to compile");
    addCompileErrorChecks(b, compile_errors);
    test_step.dependOn(compile_errors);

    // kcov reads LLVM's debug line tables, so coverage builds use the LLVM backend.
    const covered = testArtifacts(b, incur, true);
    const coverage = b.addSystemCommand(&.{ "sh", "scripts/coverage.sh" });
    coverage.setCwd(b.path("."));
    coverage.has_side_effects = true;
    coverage.addDirectoryArg(b.path("src"));
    for ([_]*std.Build.Step.Compile{ covered.api, covered.readme, covered.differential }) |artifact| {
        coverage.addArtifactArg(artifact);
    }
    const coverage_step = b.step("coverage", "Require 100% line coverage of src/ under kcov");
    coverage_step.dependOn(&coverage.step);
}

/// The test binaries.
const Tests = struct {
    api: *std.Build.Step.Compile,
    readme: *std.Build.Step.Compile,
    differential: *std.Build.Step.Compile,
};

/// Builds the test binaries, optionally with the LLVM backend.
fn testArtifacts(b: *std.Build, incur: *std.Build.Module, llvm: bool) Tests {
    const suffix = if (llvm) "-llvm" else "";
    return .{
        .api = b.addTest(.{ .name = b.fmt("api{s}", .{suffix}), .root_module = testModule(b, b.path("tests/api.zig"), incur), .use_llvm = llvm }),
        // The README examples compile, and running this program checks their documented output.
        .readme = b.addExecutable(.{ .name = b.fmt("readme{s}", .{suffix}), .root_module = testModule(b, readmeExample(b), incur), .use_llvm = llvm }),
        .differential = b.addExecutable(.{
            .name = b.fmt("differential{s}", .{suffix}),
            .root_module = testModule(b, b.path("tests/differential.zig"), incur),
            .use_llvm = llvm,
        }),
    };
}

/// Creates a test module that imports `incur`.
fn testModule(b: *std.Build, path: std.Build.LazyPath, incur: *std.Build.Module) *std.Build.Module {
    return b.createModule(.{
        .root_source_file = path,
        .target = incur.resolved_target,
        .optimize = incur.optimize,
        .imports = &.{.{ .name = "incur", .module = incur }},
    });
}

/// Builds a host tool from `tools/`.
fn tool(b: *std.Build, name: []const u8) *std.Build.Step.Compile {
    return b.addExecutable(.{ .name = name, .root_module = b.createModule(.{
        .root_source_file = b.path(b.fmt("tools/{s}.zig", .{name})),
        .target = b.graph.host,
    }) });
}

/// Extracts the first `zig` code block of the README into a test file.
fn readmeExample(b: *std.Build) std.Build.LazyPath {
    const run = b.addRunArtifact(tool(b, "readme_example"));
    run.addFileArg(b.path("README.md"));
    return run.addOutputFileArg("readme.zig");
}

/// Schema metadata fixtures that must fail to compile. Each starts with `// error: <text>`.
const compile_error_fixtures = [_][]const u8{
    "alias_not_char",
    "count_on_string",
    "min_on_bool",
    "unknown_field",
    "unknown_field_option",
    "unknown_rename_all",
    "unknown_struct_option",
    "unsupported_type",
};

/// Compiles each compile-error fixture and expects the error it names.
fn addCompileErrorChecks(b: *std.Build, step: *std.Build.Step) void {
    const checker = tool(b, "compile_error");
    for (compile_error_fixtures) |name| {
        const run = b.addRunArtifact(checker);
        run.setName(b.fmt("compile error {s}", .{name}));
        run.addArg(b.graph.zig_exe);
        run.addFileArg(b.path(b.fmt("tests/compile_errors/{s}.zig", .{name})));
        run.addFileArg(b.path("src/root.zig"));
        // The checked compilation reads every library source file.
        run.addDirectoryArg(b.path("src"));
        step.dependOn(&run.step);
    }
}
