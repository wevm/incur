//! Rust-only behavior that the differential suite cannot compare with TypeScript: trait
//! implementations, typed handler failures, built-ins this port does not implement, and inputs
//! the TypeScript reference treats differently by design.

mod fixtures;

use std::collections::BTreeMap;
use std::future::poll_fn;
use std::pin::pin;
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::Duration;

use futures::{StreamExt, stream};
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
        incur::stream(stream::iter([Ok::<_, Error>(1)])),
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

/// TypeScript reports Node's `fs` message for an unreadable config path, which varies by Node
/// version; the port reports the operating system's.
#[test]
fn reports_unreadable_config_files() {
    let dir = std::env::temp_dir();
    let cli = Cli::new("tool")
        .config(incur::Config {
            files: vec![dir.to_string_lossy().into_owned()],
            ..incur::Config::default()
        })
        .command("echo", Command::new().run(|_: Context| incur::ok(1)));
    assert_snapshot!(format!("{:?}", serve(&cli, &["echo"])), @r#"(1, "code: UNKNOWN\nmessage: Is a directory (os error 21)\n")"#);
}

/// Serves each argv and joins the outputs, one block per invocation, with durations replaced by
/// `<n>ms`.
fn serve_all(cli: &Cli, argvs: &[&[&str]]) -> String {
    argvs
        .iter()
        .map(|argv| {
            let (exit, output) = serve(cli, argv);
            let output = output
                .split("\"duration\":\"")
                .enumerate()
                .map(|(index, part)| match part.split_once("ms\"") {
                    Some((_, rest)) if index > 0 => format!("\"duration\":\"<n>ms\"{rest}"),
                    _ => part.to_owned(),
                })
                .collect::<String>();
            format!("$ {} (exit {exit})\n{output}", argv.join(" "))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Data with integers beyond the doubles' exact range, returned and streamed.
fn integers() -> Cli {
    let data = json!({
        "big": 9_007_199_254_740_993_u64,
        "max": u64::MAX,
        "min": i64::MIN,
        "float": 0.1,
        "list": [9_007_199_254_740_993_u64, -9_007_199_254_740_993_i64],
    });
    let chunks = [data.clone(), json!(u64::MAX)];
    Cli::new("ints")
        .command(
            "show",
            Command::new().run(move |_: Context| Ok::<_, Error>(data.clone())),
        )
        .command(
            "text",
            Command::new().run(|_: Context| {
                incur::ok(concat!(
                    "[9007199254740993, -9223372036854775808, 18446744073709551615,",
                    r#" 123456789012345678901234567890, -0, 1e400, "\b\f\n\r\t\"\\\/\u00e9"]"#,
                ))
            }),
        )
        .command(
            "watch",
            Command::new().run(move |_: Context| {
                incur::stream(stream::iter(chunks.clone().map(Ok::<_, Error>)))
            }),
        )
}

/// Integers keep their exact value in every format, filters, token counts, and streams; floats
/// print as JavaScript prints them. JSON text data reformats with exact integers too, while
/// integers beyond 64 bits are doubles and infinities print as `null`.
#[test]
fn prints_exact_integers() {
    let cli = integers();
    let formats = ["toon", "json", "yaml", "md", "jsonl"];
    let mut argvs = formats
        .iter()
        .map(|format| vec!["show", "--format", format])
        .collect::<Vec<_>>();
    argvs.extend([
        vec!["show", "--filter-output", "max,list[1,2]"],
        vec!["show", "--token-count"],
        vec!["show", "--format", "json", "--token-limit", "8"],
        vec!["text", "--json"],
        vec!["watch"],
        vec!["watch", "--format", "jsonl"],
    ]);
    let argvs = argvs.iter().map(Vec::as_slice).collect::<Vec<_>>();
    assert_snapshot!(serve_all(&cli, &argvs), @r#"
    $ show --format toon (exit 0)
    big: 9007199254740993
    max: 18446744073709551615
    min: -9223372036854775808
    float: 0.1
    list[2]: 9007199254740993,-9007199254740993

    $ show --format json (exit 0)
    {
      "big": 9007199254740993,
      "max": 18446744073709551615,
      "min": -9223372036854775808,
      "float": 0.1,
      "list": [
        9007199254740993,
        -9007199254740993
      ]
    }

    $ show --format yaml (exit 0)
    big: 9007199254740993
    max: 18446744073709551615
    min: -9223372036854775808
    float: 0.1
    list:
      - 9007199254740993
      - -9007199254740993

    $ show --format md (exit 0)
    ## big

    9007199254740993

    ## max

    18446744073709551615

    ## min

    -9223372036854775808

    ## float

    0.1

    ## list

    9007199254740993,-9007199254740993

    $ show --format jsonl (exit 0)
    {"big":9007199254740993,"max":18446744073709551615,"min":-9223372036854775808,"float":0.1,"list":[9007199254740993,-9007199254740993]}

    $ show --filter-output max,list[1,2] (exit 0)
    max: 18446744073709551615
    list[1]: -9007199254740993

    $ show --token-count (exit 0)
    22

    $ show --format json --token-limit 8 (exit 0)
    {
      "big": 9007199254740993,
      "max": 18446744073709551615
    [truncated: showing tokens 0–8 of 30]

    $ text --json (exit 0)
    [
      9007199254740993,
      -9223372036854775808,
      18446744073709551615,
      1.2345678901234568e+29,
      0,
      null,
      "\b\f\n\r\t\"\\/é"
    ]

    $ watch (exit 0)
    big: 9007199254740993
    max: 18446744073709551615
    min: -9223372036854775808
    float: 0.1
    list[2]: 9007199254740993,-9007199254740993
    18446744073709551615

    $ watch --format jsonl (exit 0)
    {"type":"chunk","data":{"big":9007199254740993,"max":18446744073709551615,"min":-9223372036854775808,"float":0.1,"list":[9007199254740993,-9007199254740993]}}
    {"type":"chunk","data":18446744073709551615}
    {"type":"done","ok":true,"meta":{"command":"watch","duration":"<n>ms"}}
    "#);
}

/// Config files that V8's `JSON.parse` accepts but `serde_json` rejects load as they do in
/// TypeScript: numbers beyond the double range are infinities, which options reject as Zod does,
/// unpaired surrogates and invalid UTF-8 print as U+FFFD, and a repeated key keeps its last value.
/// The expected output is the TypeScript reference's.
#[test]
fn loads_config_files_as_v8_parses_them() {
    let dir = std::env::temp_dir().join(format!("incur-api-config-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let list = ["project", "list"];
    let echo = ["echo", "hi"];
    let cases: [(&str, &[u8], &[&str]); 13] = [
        ("limit-inf", br#"{"commands":{"project":{"commands":{"list":{"options":{"limit":1e400}}}}}}"#, &list),
        ("limit-neginf", br#"{"commands":{"project":{"commands":{"list":{"options":{"limit":-1e400}}}}}}"#, &list),
        ("limit-big", br#"{"commands":{"project":{"commands":{"list":{"options":{"limit":9007199254740993}}}}}}"#, &list),
        ("limit-tiny", br#"{"commands":{"project":{"commands":{"list":{"options":{"limit":-1e-400}}}}}}"#, &["project", "list", "--json"]),
        ("prefix-inf", br#"{"commands":{"echo":{"options":{"prefix":1e400}}}}"#, &echo),
        ("tags-inf", br#"{"commands":{"echo":{"options":{"tags":[1e400]}}}}"#, &echo),
        ("meta-inf", br#"{"commands":{"echo":{"options":{"meta":{"a":1e400}}}}}"#, &echo),
        ("upper-inf", br#"{"commands":{"echo":{"options":{"upper":1e400}}}}"#, &echo),
        ("extra-inf", br#"{"commands":{"echo":{"options":{"extra":[1e400,{"x":-1e400}]}}}}"#, &echo),
        ("surrogate", br#"{"commands":{"echo":{"options":{"prefix":"\ud800\udc00\udc00x\ud83d"}}}}"#, &echo),
        ("utf8", b"{\"commands\":{\"echo\":{\"options\":{\"prefix\":\"\xff\xc3\"}}}}", &echo),
        ("inf-top", b"1e400", &echo),
        ("dup", br#"{"commands":{"echo":{"options":{"prefix":"a","upper":true,"prefix":"b"}}}}"#, &echo),
    ];
    let cli = fixtures::cli("cfg");
    let output = cases
        .map(|(name, text, argv)| {
            let file = dir.join(format!("{name}.json"));
            std::fs::write(&file, text).unwrap();
            let file = file.to_string_lossy().into_owned();
            let mut argv = argv.to_vec();
            argv.extend(["--config", &file]);
            let (exit, stdout) = serve(&cli, &argv);
            format!(
                "== {name} (exit {exit})\n{}",
                stdout.replace(&file, "<file>")
            )
        })
        .concat();
    std::fs::remove_dir_all(&dir).unwrap();
    assert_snapshot!(output, @r#"
    == limit-inf (exit 1)
    code: VALIDATION_ERROR
    message: "Invalid input: expected number, received number\n\nDetails: [\n  {\n    \"expected\": \"number\",\n    \"code\": \"invalid_type\",\n    \"received\": \"Infinity\",\n    \"path\": [\n      \"limit\"\n    ],\n    \"message\": \"Invalid input: expected number, received number\"\n  }\n]"
    fieldErrors[1]{code,missing,path,expected,received,message}:
      invalid_type,false,limit,number,Infinity,"Invalid input: expected number, received number"
    == limit-neginf (exit 1)
    code: VALIDATION_ERROR
    message: "Invalid input: expected number, received number\n\nDetails: [\n  {\n    \"expected\": \"number\",\n    \"code\": \"invalid_type\",\n    \"received\": \"Infinity\",\n    \"path\": [\n      \"limit\"\n    ],\n    \"message\": \"Invalid input: expected number, received number\"\n  }\n]"
    fieldErrors[1]{code,missing,path,expected,received,message}:
      invalid_type,false,limit,number,Infinity,"Invalid input: expected number, received number"
    == limit-big (exit 0)
    limit: 9007199254740992
    == limit-tiny (exit 0)
    {
      "limit": 0
    }
    == prefix-inf (exit 1)
    code: VALIDATION_ERROR
    message: "Invalid input: expected string, received number\n\nDetails: [\n  {\n    \"expected\": \"string\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"prefix\"\n    ],\n    \"message\": \"Invalid input: expected string, received number\"\n  }\n]"
    fieldErrors[1]{code,missing,path,expected,received,message}:
      invalid_type,false,prefix,string,"","Invalid input: expected string, received number"
    == tags-inf (exit 1)
    code: VALIDATION_ERROR
    message: "Invalid input: expected string, received number\n\nDetails: [\n  {\n    \"expected\": \"string\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"tags\",\n      0\n    ],\n    \"message\": \"Invalid input: expected string, received number\"\n  }\n]"
    fieldErrors[1]{code,missing,path,expected,received,message}:
      invalid_type,false,tags.0,string,"","Invalid input: expected string, received number"
    == meta-inf (exit 1)
    code: VALIDATION_ERROR
    message: "Invalid input: expected string, received number\n\nDetails: [\n  {\n    \"expected\": \"string\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"meta\",\n      \"a\"\n    ],\n    \"message\": \"Invalid input: expected string, received number\"\n  }\n]"
    fieldErrors[1]{code,missing,path,expected,received,message}:
      invalid_type,false,meta.a,string,"","Invalid input: expected string, received number"
    == upper-inf (exit 1)
    code: VALIDATION_ERROR
    message: "Invalid input: expected boolean, received number\n\nDetails: [\n  {\n    \"expected\": \"boolean\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"upper\"\n    ],\n    \"message\": \"Invalid input: expected boolean, received number\"\n  }\n]"
    fieldErrors[1]{code,missing,path,expected,received,message}:
      invalid_type,false,upper,boolean,"","Invalid input: expected boolean, received number"
    == extra-inf (exit 0)
    out: > hi
    == surrogate (exit 0)
    out: 𐀀�x� hi
    == utf8 (exit 0)
    out: �� hi
    == inf-top (exit 1)
    code: UNKNOWN
    message: "Invalid config file: expected a top-level object in <file>"
    == dup (exit 0)
    out: b HI
    "#);
}

#[derive(Deserialize, Schema)]
struct ExtraOptions {
    /// Any value
    extra: Option<Value>,
}

/// Options that accept any value receive config infinities as `null`, as `JSON.stringify` writes
/// them.
#[test]
fn passes_config_infinities_to_unknown_options_as_null() {
    let dir = std::env::temp_dir().join(format!("incur-api-extra-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("tool.json");
    std::fs::write(
        &file,
        r#"{"commands":{"echo":{"options":{"extra":[1e400,{"x":-1e400},-12]}}}}"#,
    )
    .unwrap();
    let cli = Cli::new("tool")
        .config(incur::Config {
            files: vec![file.to_string_lossy().into_owned()],
            ..incur::Config::default()
        })
        .command(
            "echo",
            Command::new().run(|c: Context<(), ExtraOptions>| incur::ok(c.options.extra)),
        );
    let output = serve(&cli, &["echo", "--json"]);
    std::fs::remove_dir_all(&dir).unwrap();
    assert_snapshot!(format!("{output:?}"), @r#"(0, "[\n  null,\n  {\n    \"x\": null\n  },\n  -12\n]\n")"#);
}

#[derive(Deserialize, Schema)]
struct DelayOptions {
    /// Milliseconds to wait
    ms: u64,
}

/// A CLI whose handler awaits a tokio timer.
fn sleeper() -> Cli {
    Cli::new("sleeper").command(
        "wait",
        Command::new().run(|c: Context<(), DelayOptions>| async move {
            tokio::time::sleep(Duration::from_millis(c.options.ms)).await;
            Ok::<_, Error>(json!({ "waited": c.options.ms }))
        }),
    )
}

/// The blocking entry runs handlers on a tokio runtime with timers enabled.
#[test]
fn blocking_entry_runs_tokio_handlers() {
    assert_snapshot!(format!("{:?}", serve(&sleeper(), &["wait", "--ms", "1"])), @r#"(0, "waited: 1\n")"#);
}

/// `run` is a `Send` future, so it runs inside a caller's runtime and on spawned tasks.
#[tokio::test]
async fn runs_inside_a_runtime() {
    let task = tokio::spawn(async {
        let argv = ["wait", "--ms", "1"].map(str::to_owned);
        let env = |_: &str| None;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let exit = sleeper()
            .run(
                &argv,
                &mut Io {
                    env: &env,
                    stderr: &mut stderr,
                    stdout: &mut stdout,
                    tty: false,
                },
            )
            .await;
        (exit, String::from_utf8(stdout).unwrap())
    });
    assert_snapshot!(format!("{:?}", task.await.unwrap()), @r#"(0, "waited: 1\n")"#);
}

/// Middleware code after `next.run(c)` runs after a streamed result is written, and a middleware
/// error then follows the stream.
#[test]
fn runs_middleware_around_streams() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let (handler_log, middleware_log) = (log.clone(), log.clone());
    let cli = Cli::new("tool")
        .middleware(move |c, next| {
            let log = middleware_log.clone();
            async move {
                log.lock().unwrap().push(format!("before {next:?}"));
                let result = next.run(c).await;
                log.lock().unwrap().push("after".into());
                result?;
                Err(Error::new("AFTER", "failed after the stream"))
            }
        })
        .command(
            "logs",
            Command::new().run(move |_: Context| {
                let log = handler_log.clone();
                incur::stream(stream::iter([1, 2]).map(move |n| {
                    log.lock().unwrap().push(format!("chunk {n}"));
                    Ok::<_, Error>(n)
                }))
            }),
        );
    let output = serve(&cli, &["logs"]);
    assert_snapshot!(format!("{output:?}\n{:?}", log.lock().unwrap()), @r#"
    (1, "1\n2\ncode: AFTER\nmessage: failed after the stream\n")
    ["before Next { remaining: 0, .. }", "chunk 1", "chunk 2", "after"]
    "#);
}

/// Middleware that returns without running the rest of the chain leaves no output, and a stream
/// handed over before middleware abandons the chain is still written.
#[test]
fn handles_middleware_that_skips_or_abandons_the_chain() {
    let skip = Cli::new("tool")
        .middleware(|_, _| async { Ok(()) })
        .command("noop", Command::new().run(|_: Context| incur::ok(1)));
    let abandon = Cli::new("tool")
        .middleware(|c, next| async move {
            let mut run = pin!(next.run(c));
            // Poll once: the handler hands over its stream, then the chain waits for it.
            poll_fn(|cx| {
                let _ = run.as_mut().poll(cx);
                Poll::Ready(())
            })
            .await;
            Ok(())
        })
        .command(
            "logs",
            Command::new().run(|_: Context| incur::stream(stream::iter([Ok::<_, Error>(1)]))),
        );
    assert_snapshot!(format!("{:?} {:?}", serve(&skip, &["noop"]), serve(&abandon, &["logs"])), @r#"(0, "") (0, "1\n")"#);
}
