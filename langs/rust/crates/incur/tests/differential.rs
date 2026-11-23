//! Differential test: replays every case in `langs/_differential/cases.json` against the
//! TypeScript reference implementation and this port, and requires identical stdout, stderr, and
//! exit codes. Durations are the only normalized values outside sandboxed cases.
//!
//! Cases with a `bin` run this executable again through a link with that name, once through each
//! process entry point, [`incur::Cli::serve`] and [`incur::Cli::serve_async`], so they read their
//! real arguments, environment, and binary name.
//!
//! Sandboxed cases (see `langs/README.md`) also run this executable again, with the program path
//! `<sandbox>/<bin>`, a cleared environment, the sandbox as `HOME` and working directory, and stub
//! package-manager runners on `PATH`. Cases with `stdin` are fed one line at a time, waiting for
//! each request's response. Cases with `requests` send them to [`incur::Cli::fetch`] in the child.
//!
//! Requires Node.js and the repository's `pnpm install`.

mod fixtures;

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use incur::Io;
use serde::Deserialize;
use serde_json::{Map, Value};

#[derive(Deserialize)]
struct Case {
    argv: Vec<String>,
    #[serde(default)]
    bin: Option<String>,
    cli: String,
    #[serde(default)]
    env: Map<String, Value>,
    #[serde(default)]
    requests: Option<Vec<Value>>,
    #[serde(default)]
    sandbox: Option<Map<String, Value>>,
    #[serde(default)]
    stdin: Option<Vec<Value>>,
    #[serde(default)]
    tty: bool,
}

#[derive(Debug, Deserialize, PartialEq)]
struct Outcome {
    exit: i32,
    #[serde(default)]
    files: Option<Map<String, Value>>,
    stderr: String,
    stdout: String,
}

/// Returns the repository root.
fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

/// Passes the coverage profile path to a child process.
fn profile(command: &mut Command) {
    if let Ok(profile) = std::env::var("LLVM_PROFILE_FILE") {
        command.env("LLVM_PROFILE_FILE", profile);
    }
}

/// Serves a case in a child process started through a link named `bin`, with only the case's
/// environment, through [`incur::Cli::serve_async`] when `asynchronous` is set and
/// [`incur::Cli::serve`] otherwise. Returns the exit code, stdout, and stderr.
fn spawn(links: &Path, bin: &str, case: &Case, asynchronous: bool) -> (i32, Vec<u8>, Vec<u8>) {
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
    if asynchronous {
        command.env("INCUR_ASYNC", "1");
    }
    profile(&mut command);
    for (key, value) in &case.env {
        command.env(key, value.as_str().unwrap());
    }
    let output = command.output().unwrap();
    (output.status.code().unwrap(), output.stdout, output.stderr)
}

/// The directories sandboxed cases share: `home` (the sandbox), `bin` (stub runners), and `tmp`.
struct Sandbox {
    /// The root directory.
    root: PathBuf,
    /// The sandbox: `HOME` and working directory.
    home: PathBuf,
}

/// Each stub appends its name and arguments to `$HOME/stub.log`, then prints `STUB_STDERR` and
/// `STUB_STDOUT` and exits with `STUB_EXIT` (default 0).
const STUB: &str = r#"#!/bin/sh
{ printf '%s' "${0##*/}"; for a in "$@"; do printf ' %s' "$a"; done; printf '\n'; } >> "$HOME/stub.log"
printf '%s' "$STUB_STDERR" >&2
printf '%s' "$STUB_STDOUT"
exit "${STUB_EXIT:-0}"
"#;

impl Sandbox {
    /// Creates the root with stub runners.
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("incur-sandbox-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::create_dir_all(dir.join("tmp")).unwrap();
        let root = std::fs::canonicalize(&dir).unwrap();
        for name in ["bun", "bunx", "npm", "npx", "pnpm", "pnpx"] {
            let path = root.join("bin").join(name);
            std::fs::write(&path, STUB).unwrap();
            std::os::unix::fs::PermissionsExt::set_mode(
                &mut std::fs::metadata(&path).unwrap().permissions(),
                0o755,
            );
            let mut permissions = std::fs::metadata(&path).unwrap().permissions();
            std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o755);
            std::fs::set_permissions(&path, permissions).unwrap();
        }
        let home = root.join("home");
        Self { root, home }
    }

    /// Replaces `<sandbox>` and `<root>` placeholders with real paths.
    fn expand(&self, text: &str) -> String {
        text.replace("<sandbox>", self.home.to_str().unwrap())
            .replace("<root>", self.root.to_str().unwrap())
    }

    /// Replaces real paths and timestamps with placeholders.
    fn normalize(&self, text: &str) -> String {
        let text = text
            .replace(self.home.to_str().unwrap(), "<sandbox>")
            .replace(self.root.to_str().unwrap(), "<root>");
        checked_at(&timestamps(&text))
    }

    /// Empties and seeds the sandbox.
    fn seed(&self, entries: &Map<String, Value>) {
        if self.home.exists() {
            std::fs::remove_dir_all(&self.home).unwrap();
        }
        std::fs::create_dir_all(&self.home).unwrap();
        for (name, value) in entries {
            let target = self.home.join(name);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            match value {
                Value::Null => std::fs::create_dir_all(&target).unwrap(),
                Value::String(contents) => std::fs::write(&target, self.expand(contents)).unwrap(),
                Value::Object(link) => std::os::unix::fs::symlink(
                    self.expand(link["symlink"].as_str().unwrap()),
                    &target,
                )
                .unwrap(),
                other => panic!("invalid sandbox entry: {other}"),
            }
        }
    }

    /// Lists every entry under the sandbox, sorted by path, with normalized contents.
    fn tree(&self) -> Map<String, Value> {
        fn visit(sandbox: &Sandbox, relative: &str, out: &mut Vec<(String, Value)>) {
            for entry in std::fs::read_dir(sandbox.home.join(relative)).unwrap() {
                let name = entry.unwrap().file_name().into_string().unwrap();
                let child = if relative.is_empty() {
                    name
                } else {
                    format!("{relative}/{name}")
                };
                let path = sandbox.home.join(&child);
                let meta = std::fs::symlink_metadata(&path).unwrap();
                if meta.is_symlink() {
                    let target = std::fs::read_link(&path).unwrap();
                    let mut link = Map::new();
                    link.insert(
                        "symlink".into(),
                        sandbox.normalize(target.to_str().unwrap()).into(),
                    );
                    out.push((child, Value::Object(link)));
                } else if meta.is_dir() {
                    out.push((child.clone(), Value::Null));
                    visit(sandbox, &child, out);
                } else {
                    let text = String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned();
                    out.push((child, metadata(&sandbox.normalize(&text)).into()));
                }
            }
        }
        let mut entries = Vec::new();
        visit(self, "", &mut entries);
        entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
        entries.into_iter().collect()
    }

    /// Runs a sandboxed case in a child process. Returns the outcome before normalization of
    /// stdout and stderr.
    fn run(&self, case: &Case) -> Outcome {
        self.seed(case.sandbox.as_ref().unwrap());
        let bin = case.bin.as_deref().unwrap_or("cli");
        let mut command = Command::new(std::env::current_exe().unwrap());
        std::os::unix::process::CommandExt::arg0(&mut command, self.home.join(bin));
        command
            .args(&case.argv)
            .current_dir(&self.home)
            .env_clear()
            .env("HOME", &self.home)
            .env("PATH", self.root.join("bin"))
            .env("TMPDIR", self.root.join("tmp"))
            .env("INCUR_FIXTURE", &case.cli)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if case.tty {
            command.env("INCUR_TTY", "1");
        }
        if let Some(requests) = &case.requests {
            command.env("INCUR_REQUESTS", serde_json::to_string(requests).unwrap());
        }
        profile(&mut command);
        for (key, value) in &case.env {
            command.env(key, self.expand(value.as_str().unwrap()));
        }
        let mut child = command.spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let errors = std::thread::spawn(move || {
            let mut out = Vec::new();
            std::io::Read::read_to_end(&mut stderr, &mut out).unwrap();
            out
        });
        let (tx, rx) = mpsc::channel::<String>();
        let reader = std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut all = Vec::new();
            loop {
                let mut line = Vec::new();
                if reader.read_until(b'\n', &mut line).unwrap() == 0 {
                    break;
                }
                let _ = tx.send(String::from_utf8_lossy(&line).into_owned());
                all.extend(line);
            }
            all
        });
        for line in case.stdin.iter().flatten() {
            let text = match line {
                Value::String(text) => text.clone(),
                other => serde_json::to_string(other).unwrap(),
            };
            if writeln!(stdin, "{text}").is_err() {
                break;
            }
            let _ = stdin.flush();
            let Some(id) = request_id(&text) else {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            };
            let deadline = Instant::now() + Duration::from_secs(5);
            while let Some(left) = deadline.checked_duration_since(Instant::now()) {
                match rx.recv_timeout(left) {
                    Ok(line) if responds(&line, &id) => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        }
        drop(stdin);
        let stdout = reader.join().unwrap();
        let stderr = errors.join().unwrap();
        let status = child.wait().unwrap();
        Outcome {
            exit: status.code().unwrap(),
            files: Some(self.tree()),
            stderr: self.normalize(&String::from_utf8(stderr).unwrap()),
            stdout: self.normalize(&String::from_utf8(stdout).unwrap()),
        }
    }
}

/// Returns the id of a JSON-RPC request line.
fn request_id(text: &str) -> Option<Value> {
    let message: Value = serde_json::from_str(text).ok()?;
    let object = message.as_object()?;
    if object.contains_key("method") {
        object.get("id").cloned()
    } else {
        None
    }
}

/// Returns whether a line is a JSON-RPC response with `id`.
fn responds(line: &str, id: &Value) -> bool {
    serde_json::from_str::<Value>(line).is_ok_and(|message| {
        message.get("id") == Some(id)
            && (message.get("result").is_some() || message.get("error").is_some())
    })
}

/// Replaces timestamps such as `2026-01-02T03:04:05.678Z` with `<time>`.
fn timestamps(text: &str) -> String {
    const PATTERN: &[u8] = b"dddd-dd-ddTdd:dd:dd.dddZ";
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        let matches = bytes.len() - i >= PATTERN.len()
            && PATTERN.iter().enumerate().all(|(j, p)| match p {
                b'd' => bytes[i + j].is_ascii_digit(),
                p => bytes[i + j] == *p,
            });
        if matches {
            out.push_str("<time>");
            i += PATTERN.len();
        } else {
            let ch = text[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// Replaces `"checkedAt":<digits>` with `"checkedAt":0`.
fn checked_at(text: &str) -> String {
    const KEY: &str = "\"checkedAt\":";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find(KEY) {
        out.push_str(&rest[..index + KEY.len()]);
        rest = &rest[index + KEY.len()..];
        let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        if digits > 0 {
            out.push('0');
            rest = &rest[digits..];
        }
    }
    out.push_str(rest);
    out
}

/// Sorts the `skills` and `paths` of a skills metadata file and rewrites it as compact JSON.
fn metadata(text: &str) -> String {
    let Ok(Value::Object(mut value)) = serde_json::from_str::<Value>(text) else {
        return text.to_owned();
    };
    if !value.get("hash").is_some_and(Value::is_string)
        || !value.get("skills").is_some_and(Value::is_array)
    {
        return text.to_owned();
    }
    for key in ["skills", "paths"] {
        if let Some(Value::Array(items)) = value.get_mut(key) {
            items.sort_by_key(ToString::to_string);
        }
    }
    format!("{}\n", Value::Object(value))
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

/// Sends requests to the CLI's HTTP handler and prints each response, as `run.ts` does.
fn send(cli: &incur::Cli, requests: &str) {
    let requests: Vec<Value> = serde_json::from_str(requests).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut out = String::new();
    runtime.block_on(async {
        let mut session: Option<String> = None;
        for request in requests {
            let url = request["url"].as_str().unwrap();
            let url = if url.starts_with("http") {
                url.to_owned()
            } else {
                format!("http://localhost{url}")
            };
            let mut builder = http::Request::builder()
                .method(request["method"].as_str().unwrap_or("GET"))
                .uri(url);
            let mut typed = false;
            for (key, value) in request["headers"].as_object().into_iter().flatten() {
                let value = match value.as_str().unwrap() {
                    "<session>" => session.clone().unwrap_or_default(),
                    value => value.to_owned(),
                };
                typed |= key.eq_ignore_ascii_case("content-type");
                builder = builder.header(key.as_str(), value);
            }
            let body = match &request["body"] {
                Value::Null => None,
                Value::String(body) => Some(body.clone()),
                other => Some(other.to_string()),
            };
            if body.is_some() && !typed {
                builder = builder.header("content-type", "text/plain;charset=UTF-8");
            }
            let request = builder
                .body(incur::Body::from(body.unwrap_or_default()))
                .unwrap();
            let response = cli.fetch(request).await;
            if let Some(id) = response.headers().get("mcp-session-id") {
                session = Some(id.to_str().unwrap().to_owned());
            }
            let _ = writeln!(out, "HTTP {}", response.status().as_u16());
            let mut headers = response
                .headers()
                .iter()
                .map(|(key, value)| (key.as_str().to_owned(), value.to_str().unwrap().to_owned()))
                .collect::<Vec<_>>();
            headers.sort_by(|a, b| a.0.cmp(&b.0));
            for (key, value) in headers {
                let value = if key == "mcp-session-id" {
                    "<session>".to_owned()
                } else {
                    value
                };
                let _ = writeln!(out, "{key}: {value}");
            }
            let body = response.into_body().text().await;
            let _ = write!(out, "\n{body}\n");
        }
    });
    std::io::stdout().write_all(out.as_bytes()).unwrap();
}

fn main() {
    if let Ok(name) = std::env::var("INCUR_FIXTURE") {
        let cli = fixtures::cli(&name);
        if let Ok(requests) = std::env::var("INCUR_REQUESTS") {
            send(&cli, &requests);
            return;
        }
        if std::env::var_os("INCUR_TTY").is_some() {
            let argv = std::env::args().skip(1).collect::<Vec<_>>();
            let env = |key: &str| std::env::var(key).ok();
            let mut io = incur::Io {
                env: &env,
                stderr: &mut std::io::stderr(),
                stdin: &mut futures::stream::empty(),
                stdout: &mut std::io::stdout(),
                tty: true,
            };
            std::process::exit(cli.serve_with(&argv, &mut io));
        }
        // The async entry runs on any executor; fixtures await no tokio IO.
        if std::env::var_os("INCUR_ASYNC").is_some() {
            futures::executor::block_on(cli.serve_async());
        } else {
            cli.serve();
        }
        return;
    }
    matches_typescript();
}

/// Loads the reference results: from `INCUR_REFERENCE` when set, otherwise by running Node.
fn reference(root: &Path) -> Vec<Outcome> {
    if let Ok(path) = std::env::var("INCUR_REFERENCE") {
        return serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    }
    let output = Command::new("node")
        .args([
            "--no-warnings",
            "--import",
            "tsx",
            "langs/_differential/run.ts",
        ])
        .current_dir(root)
        .output()
        .expect("node runs the TypeScript reference");
    assert!(
        output.status.success(),
        "reference run failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

/// Whether a case index is selected by `INCUR_CASES`, a comma-separated list of indices,
/// `start-end` ranges, and fixture names. Every case runs when it is unset.
fn selected(index: usize, case: &Case) -> bool {
    let Ok(filter) = std::env::var("INCUR_CASES") else {
        return true;
    };
    filter.split(',').any(|part| match part.split_once('-') {
        Some((start, end)) if start.parse::<usize>().is_ok() => {
            (start.parse().unwrap()..=end.parse().unwrap()).contains(&index)
        }
        _ => part
            .parse::<usize>()
            .map_or(part == case.cli, |n| n == index),
    })
}

/// Runs every case and asserts that all match the reference.
fn matches_typescript() {
    let root = root();
    let dir = root.join("langs/_differential");
    let cases: Vec<Case> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("cases.json")).unwrap()).unwrap();
    let expected = reference(&root);
    assert_eq!(expected.len(), cases.len());

    // Config fixtures use paths relative to the differential directory.
    std::env::set_current_dir(&dir).unwrap();
    let links = std::env::temp_dir().join(format!("incur-differential-{}", std::process::id()));
    std::fs::create_dir_all(&links).unwrap();
    let sandbox = Sandbox::new();

    let mut failures = Vec::new();
    for (index, (case, expected)) in cases.iter().zip(expected).enumerate() {
        if !selected(index, case) {
            continue;
        }
        let runs = if case.sandbox.is_some() {
            vec![("sandbox", sandbox.run(case))]
        } else if let Some(bin) = &case.bin {
            [("serve", false), ("serve_async", true)]
                .into_iter()
                .map(|(entry, asynchronous)| {
                    let (exit, stdout, stderr) = spawn(&links, bin, case, asynchronous);
                    let outcome = Outcome {
                        exit,
                        files: None,
                        stderr: String::from_utf8(stderr).unwrap(),
                        stdout: String::from_utf8(stdout).unwrap(),
                    };
                    (entry, outcome)
                })
                .collect()
        } else {
            let cli = fixtures::cli(&case.cli);
            let env = |key: &str| case.env.get(key).and_then(Value::as_str).map(str::to_owned);
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let exit = cli.serve_with(
                &case.argv,
                &mut Io {
                    env: &env,
                    stderr: &mut stderr,
                    stdin: &mut futures::stream::empty(),
                    stdout: &mut stdout,
                    tty: case.tty,
                },
            );
            let outcome = Outcome {
                exit,
                files: None,
                stderr: String::from_utf8(stderr).unwrap(),
                stdout: String::from_utf8(stdout).unwrap(),
            };
            vec![("serve_with", outcome)]
        };
        let expected = Outcome {
            exit: expected.exit,
            files: expected.files,
            stderr: normalize(&expected.stderr),
            stdout: normalize(&expected.stdout),
        };
        for (entry, actual) in runs {
            let actual = Outcome {
                stderr: normalize(&actual.stderr),
                stdout: normalize(&actual.stdout),
                ..actual
            };
            if actual != expected {
                let files = |outcome: &Outcome| {
                    outcome
                        .files
                        .as_ref()
                        .map(|files| serde_json::to_string_pretty(files).unwrap())
                        .unwrap_or_default()
                };
                failures.push(format!(
                    "case {index} ({entry}): {} {:?} env={:?} tty={} stdin={:?} requests={:?}\n--- expected (exit {})\n{}{}{}\n--- actual (exit {})\n{}{}{}",
                    case.cli,
                    case.argv,
                    case.env,
                    case.tty,
                    case.stdin,
                    case.requests,
                    expected.exit,
                    expected.stdout,
                    expected.stderr,
                    files(&expected),
                    actual.exit,
                    actual.stdout,
                    actual.stderr,
                    files(&actual),
                ));
            }
        }
    }
    std::fs::remove_dir_all(&links).unwrap();
    std::fs::remove_dir_all(&sandbox.root).unwrap();
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
