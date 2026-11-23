//! Differential test: replays every case in `langs/differential/cases.json` against the
//! TypeScript reference implementation and this port, and requires identical stdout, stderr, and
//! exit codes. Durations are the only normalized values.
//!
//! Cases with a `bin` run this executable again through a link with that name, so the process
//! entry point [`incur::Cli::serve`] reads its real arguments, environment, and binary name.
//!
//! Requires Node.js and the repository's `pnpm install`.

mod fixtures;

use std::path::{Path, PathBuf};
use std::process::Command;

use incur::Io;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Case {
    argv: Vec<String>,
    #[serde(default)]
    bin: Option<String>,
    cli: String,
    #[serde(default)]
    env: serde_json::Map<String, Value>,
    #[serde(default)]
    tty: bool,
}

#[derive(Debug, Deserialize, PartialEq)]
struct Outcome {
    exit: i32,
    stderr: String,
    stdout: String,
}

/// Returns the repository root.
fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

/// Serves a case in a child process started through a link named `bin`, with only the case's
/// environment. Returns the exit code, stdout, and stderr.
fn spawn(links: &Path, bin: &str, case: &Case) -> (i32, Vec<u8>, Vec<u8>) {
    assert!(!case.tty, "cases with a `bin` cannot emulate a terminal");
    let link = links.join(bin);
    if !link.exists() {
        std::os::unix::fs::symlink(std::env::current_exe().unwrap(), &link).unwrap();
    }
    let mut command = Command::new(&link);
    command
        .args(&case.argv)
        .env_clear()
        .env("INCUR_FIXTURE", &case.cli);
    // Coverage runs collect profiles from child processes too.
    if let Ok(profile) = std::env::var("LLVM_PROFILE_FILE") {
        command.env("LLVM_PROFILE_FILE", profile);
    }
    for (key, value) in &case.env {
        command.env(key, value.as_str().unwrap());
    }
    let output = command.output().unwrap();
    (output.status.code().unwrap(), output.stdout, output.stderr)
}

/// Replaces durations such as `12ms` with `<n>ms`.
fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric()) {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if text[i..].starts_with("ms")
                && !text[i + 2..].starts_with(|c: char| c.is_ascii_alphanumeric())
            {
                out.push_str("<n>");
            } else {
                out.push_str(&text[start..i]);
            }
            continue;
        }
        let ch = text[i..].chars().next().unwrap_or_default();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn main() {
    if let Ok(name) = std::env::var("INCUR_FIXTURE") {
        fixtures::cli(&name).serve();
        return;
    }
    matches_typescript();
}

/// Runs every case and asserts that all match the reference.
fn matches_typescript() {
    let root = root();
    let dir = root.join("langs/differential");
    let cases: Vec<Case> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("cases.json")).unwrap()).unwrap();

    let output = Command::new("node")
        .args([
            "--no-warnings",
            "--import",
            "tsx",
            "langs/differential/run.ts",
        ])
        .current_dir(&root)
        .output()
        .expect("node runs the TypeScript reference");
    assert!(
        output.status.success(),
        "reference run failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<Outcome> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(expected.len(), cases.len());

    // Config fixtures use paths relative to the differential directory.
    std::env::set_current_dir(&dir).unwrap();
    let links = std::env::temp_dir().join(format!("incur-differential-{}", std::process::id()));
    std::fs::create_dir_all(&links).unwrap();

    let mut failures = Vec::new();
    for (index, (case, expected)) in cases.iter().zip(&expected).enumerate() {
        let (exit, stdout, stderr) = if let Some(bin) = &case.bin {
            spawn(&links, bin, case)
        } else {
            {
                let cli = fixtures::cli(&case.cli);
                let env = |key: &str| case.env.get(key).and_then(Value::as_str).map(str::to_owned);
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                let exit = cli.serve_with(
                    &case.argv,
                    &mut Io {
                        env: &env,
                        stderr: &mut stderr,
                        stdout: &mut stdout,
                        tty: case.tty,
                    },
                );
                (exit, stdout, stderr)
            }
        };
        let actual = Outcome {
            exit,
            stderr: normalize(&String::from_utf8(stderr).unwrap()),
            stdout: normalize(&String::from_utf8(stdout).unwrap()),
        };
        let expected = Outcome {
            exit: expected.exit,
            stderr: normalize(&expected.stderr),
            stdout: normalize(&expected.stdout),
        };
        if actual != expected {
            failures.push(format!(
                "case {index}: {} {:?} env={:?} tty={}\n--- expected (exit {})\n{}{}\n--- actual (exit {})\n{}{}",
                case.cli,
                case.argv,
                case.env,
                case.tty,
                expected.exit,
                expected.stdout,
                expected.stderr,
                actual.exit,
                actual.stdout,
                actual.stderr,
            ));
        }
    }
    std::fs::remove_dir_all(&links).unwrap();
    if let Ok(path) = std::env::var("INCUR_DIFFERENTIAL_DUMP") {
        std::fs::write(path, failures.join("\n\n=====\n\n")).unwrap();
    }
    let total = failures.len();
    let shown = failures
        .into_iter()
        .take(15)
        .collect::<Vec<_>>()
        .join("\n\n");
    assert!(
        total == 0,
        "{total} of {} cases differ:\n\n{shown}",
        cases.len()
    );
}
