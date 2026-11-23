//! Rust-only behavior that the differential suite cannot compare with TypeScript: trait
//! implementations, typed handler failures, built-ins this port does not implement, and inputs
//! the TypeScript reference treats differently by design.

use std::collections::BTreeMap;

use incur::schema::{Field, Type};
use incur::{Cli, Command, Context, CtaBlock, Error, Format, Io, Outcome, Schema, Vars};
use insta::assert_snapshot;
use serde::Deserialize;
use serde_json::{Value, json};

/// Serves `argv` without a terminal or environment and returns the exit code and output.
fn serve(cli: &Cli, argv: &[&str]) -> (i32, String) {
    let argv = argv.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
    let env = |_: &str| None;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let exit = cli.serve_with(
        &argv,
        &mut Io {
            env: &env,
            stderr: &mut stderr,
            stdout: &mut stdout,
            tty: false,
        },
    );
    (
        exit,
        String::from_utf8(stdout).unwrap() + &String::from_utf8(stderr).unwrap(),
    )
}

#[test]
fn reports_unsupported_builtins() {
    let cli = Cli::new("tool").version("1.0.0");
    assert_eq!(cli.name(), "tool");
    let outputs = [&["--mcp"][..], &["skills", "add"], &["mcp", "add"]]
        .iter()
        .map(|argv| format!("{argv:?} {:?}", serve(&cli, argv)))
        .collect::<Vec<_>>();
    assert_snapshot!(outputs.join("\n"), @r#"
    ["--mcp"] (1, "code: UNSUPPORTED\nmessage: '--mcp' is not supported by the Rust port of incur yet.\n")
    ["skills", "add"] (1, "code: UNSUPPORTED\nmessage: 'skills add' is not supported by the Rust port of incur yet.\n")
    ["mcp", "add"] (1, "code: UNSUPPORTED\nmessage: 'mcp add' is not supported by the Rust port of incur yet.\n")
    "#);
}

#[test]
fn runs_commands_without_handlers() {
    let cli = Cli::new("tool").command("noop", Command::new().description("Does nothing"));
    assert_snapshot!(format!("{:?}", serve(&cli, &["noop"])), @r#"(0, "")"#);
}

#[derive(Deserialize)]
struct Small {
    #[expect(dead_code, reason = "Deserialization fails first.")]
    n: u8,
}

/// Describes `n` as a string while deserialization expects a number.
impl Schema for Small {
    fn schema() -> Type {
        Type::object(vec![Field::new("n", String::schema())])
    }
}

#[test]
fn reports_handler_input_that_fails_to_deserialize() {
    let cli = Cli::new("tool").command(
        "small",
        Command::new().run(|_: Context<Small>| incur::ok(1)),
    );
    assert_snapshot!(format!("{:?}", serve(&cli, &["small", "abc"])), @r#"(1, "code: UNKNOWN\nmessage: \"invalid type: string \\\"abc\\\", expected u8\"\n")"#);
}

#[test]
fn reports_data_that_fails_to_serialize() {
    let cli = Cli::new("tool").command(
        "pairs",
        Command::new().run(|_: Context| {
            incur::ok(BTreeMap::from([((1, 2), 3)])).cta(CtaBlock::new(["tool status"]))
        }),
    );
    assert_snapshot!(format!("{:?}", serve(&cli, &["pairs"])), @r#"(1, "code: UNKNOWN\nmessage: key must be a string\ncta:\n  description: \"Suggested command:\"\n  commands[1]{command}:\n    tool status\n")"#);
}

#[test]
fn formats_debug_and_display() {
    let mut vars = Vars::default();
    vars.set(1_u8);
    let outcomes = [
        incur::ok(json!({ "a": 1 })),
        Outcome::from(Error::new("CODE", "failed")),
        incur::stream([Ok::<_, Error>(1)]),
    ];
    let lines = [
        format!("{vars:?}"),
        format!("{:?}", Command::new().description("Described")),
        outcomes
            .iter()
            .map(|o| format!("{o:?}"))
            .collect::<Vec<_>>()
            .join(" "),
        Error::new("CODE", "failed").to_string(),
        Format::Yaml.to_string(),
        incur::completions::Shell::Fish.to_string(),
    ];
    assert_snapshot!(lines.join("\n"), @r#"
    Vars { len: 1 }
    Command { description: Some("Described"), .. }
    Data(Some(Object {"a": Number(1)})) Error(Error { code: "CODE", cta: None, exit_code: None, field_errors: None, hint: None, message: "failed", retryable: None }) Stream
    failed
    yaml
    fish
    "#);
}

#[test]
fn converts_errors() {
    let errors = [
        Error::from(String::from("owned message")),
        Error::from(std::io::Error::other("disk full")),
        Error::from(serde_json::from_str::<Value>("{").unwrap_err()),
    ];
    let lines = errors
        .iter()
        .map(|e| format!("{}: {e}", e.code))
        .collect::<Vec<_>>();
    assert_snapshot!(lines.join("\n"), @"
    UNKNOWN: owned message
    UNKNOWN: disk full
    UNKNOWN: EOF while parsing an object at line 1 column 1
    ");
}

#[test]
fn formats_and_filters_values_directly() {
    let data = json!({ "a": [1, 2] });
    assert_eq!(incur::formatter::format(&Value::Null, Format::Json), "");
    assert_eq!(incur::filter::apply(&data, &[]), Some(data));
    assert!(String::schema().fields().is_empty());
}

/// V8 parses numbers beyond the double range as `Infinity`; `serde_json` rejects them, and the
/// port reports its message.
#[test]
fn reports_config_numbers_out_of_range() {
    let dir = std::env::temp_dir().join(format!("incur-api-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("tool.json");
    std::fs::write(
        &file,
        r#"{"commands": {"echo": {"options": {"n": 1e400}}}}"#,
    )
    .unwrap();
    let cli = Cli::new("tool")
        .config(incur::Config {
            files: vec![file.to_string_lossy().into_owned()],
            ..incur::Config::default()
        })
        .command("echo", Command::new().run(|_: Context| incur::ok(1)));
    let (exit, output) = serve(&cli, &["echo"]);
    std::fs::remove_dir_all(&dir).unwrap();
    assert_snapshot!(format!("{exit} {}", output.replace(&*file.to_string_lossy(), "<file>")), @r#"
    1 code: UNKNOWN
    message: "Invalid JSON config file: <file>\n\nDetails: number out of range at line 1 column 45"
    "#);
}
