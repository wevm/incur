//! Rust-only behavior that the differential suite cannot compare with TypeScript: trait
//! implementations, typed handler failures, built-ins this port does not implement, and inputs
//! the TypeScript reference treats differently by design.

#![recursion_limit = "256"]

mod fixtures;

use std::collections::BTreeMap;
use std::future::poll_fn;
use std::pin::pin;
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::Duration;

use futures::{StreamExt, stream};
use incur::mcp::{Discovery, Mcp, Tool};
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
            stdin: &mut futures::stream::empty(),
            stdout: &mut stdout,
            tty: false,
        },
    );
    (
        exit,
        String::from_utf8(stdout).unwrap() + &String::from_utf8(stderr).unwrap(),
    )
}

/// `--mcp` serves JSON-RPC lines from the injected standard input.
#[test]
fn serves_mcp_over_injected_stdin() {
    let cli = Cli::new("tool")
        .version("1.0.0")
        .update(false)
        .sync(false)
        .mcp(Mcp::new().discovery(Discovery::Direct))
        .command(
            "ping",
            Command::new()
                .description("Ping")
                .run(|_: Context| incur::ok("pong")),
        );
    assert_eq!(cli.name(), "tool");
    let lines = [
        r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}"#,
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ping","arguments":{}}}"#,
    ]
    .map(str::to_owned);
    let env = |_: &str| None;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let exit = cli.serve_with(
        &["--mcp".to_owned()],
        &mut Io {
            env: &env,
            stderr: &mut stderr,
            stdin: &mut stream::iter(lines),
            stdout: &mut stdout,
            tty: false,
        },
    );
    assert_snapshot!(format!("{exit} {}", String::from_utf8(stdout).unwrap()), @r#"
    0 {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"tool","version":"1.0.0"}},"jsonrpc":"2.0","id":0}
    {"result":{"content":[{"type":"text","text":"\"pong\""}]},"jsonrpc":"2.0","id":1}
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
                    stdin: &mut futures::stream::empty(),
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
    let fail = Cli::new("tool")
        .middleware(|c, next| async move {
            let mut run = pin!(next.run(c));
            poll_fn(|cx| {
                let _ = run.as_mut().poll(cx);
                Poll::Ready(())
            })
            .await;
            Err(Error::new("ABANDONED", "left the chain"))
        })
        .command(
            "logs",
            Command::new().run(|_: Context| incur::stream(stream::iter([Ok::<_, Error>(1)]))),
        );
    assert_snapshot!(format!("{:?} {:?} {:?}", serve(&skip, &["noop"]), serve(&abandon, &["logs"]), serve(&fail, &["logs"])), @r#"(0, "") (0, "1\n") (1, "code: ABANDONED\nmessage: left the chain\n")"#);
}

/// With the `client` feature, hosted sources go through a real HTTP client: error statuses are
/// responses, and unreachable servers fail like `fetch`.
#[cfg(feature = "client")]
#[test]
fn sends_hosted_requests_with_the_real_client() {
    use std::io::{Read, Write};

    use incur::{Fetch, FetchCommand};

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/base/", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buffer = [0; 4096];
        let read = stream.read(&mut buffer).unwrap();
        let body = br#"{"error":{"code":"MISSING","message":"No such user"}}"#;
        let head = format!(
            "HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(head.as_bytes()).unwrap();
        stream.write_all(body).unwrap();
        let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
        request.lines().next().unwrap().to_owned()
    });
    let cli = Cli::new("tool")
        .update(false)
        .fetch_command("api", FetchCommand::new(Fetch::url(&base)))
        .fetch_command("down", FetchCommand::new(Fetch::url("http://127.0.0.1:1")));
    let found = serve(&cli, &["api", "users", "-X", "POST"]);
    assert_snapshot!(format!("{found:?}\n{}", server.join().unwrap()), @r#"
    (1, "code: MISSING\nmessage: No such user\n")
    POST /base/users HTTP/1.1
    "#);
    assert_snapshot!(format!("{:?}", serve(&cli, &["down"])), @r#"(1, "code: UNKNOWN\nmessage: fetch failed\n")"#);
}

/// Sends a request to a CLI's HTTP handler and renders the status, sorted headers, and body.
fn http(cli: &Cli, method: &str, url: &str, headers: &[(&str, &str)], body: &str) -> String {
    let mut builder = http::Request::builder()
        .method(method)
        .uri(format!("http://localhost{url}"));
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let request = builder.body(incur::Body::from(body.to_owned())).unwrap();
    let response = futures::executor::block_on(cli.fetch(request));
    let mut lines = vec![format!("HTTP {}", response.status().as_u16())];
    let mut names = response
        .headers()
        .iter()
        .map(|(name, value)| match name.as_str() {
            "mcp-session-id" => format!("{name}: <session>"),
            _ => format!("{name}: {}", value.to_str().unwrap()),
        })
        .collect::<Vec<_>>();
    names.sort();
    lines.extend(names);
    let mut body = futures::executor::block_on(response.into_body().text());
    if let Some(start) = body.find(r#""duration":""#).map(|index| index + 12) {
        let end = start + body[start..].find('"').unwrap();
        body.replace_range(start..end, "<n>");
    }
    lines.push(String::new());
    lines.push(body);
    lines.join("\n")
}

/// The JSON-RPC request that opens an MCP session.
const INITIALIZE: &str = r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}"#;

/// The headers MCP clients send.
const MCP: [(&str, &str); 2] = [
    ("accept", "application/json, text/event-stream"),
    ("content-type", "application/json"),
];

#[derive(Deserialize, Schema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
struct MissingEnv {
    /// A variable no environment sets
    #[expect(dead_code, reason = "Validation fails before the handler runs.")]
    incur_api_unset_variable: String,
}

/// Gives a CLI an HTTP client that fails every request, whether or not the `client` feature is
/// enabled.
fn offline(cli: Cli) -> Cli {
    cli.client(|_: http::Request<incur::Body>| async {
        Err::<http::Response<incur::Body>, _>(Error::from("fetch failed: offline"))
    })
}

/// Without the `client` feature or a custom client, hosted requests fail with a hint.
#[cfg(not(feature = "client"))]
#[test]
fn reports_a_missing_http_client() {
    let cli = Cli::new("tool").update(false).fetch_command(
        "api",
        incur::FetchCommand::new(incur::Fetch::url("http://offline.test")),
    );
    assert_snapshot!(format!("{:?}", serve(&cli, &["api"])), @r#"(1, "code: UNKNOWN\nmessage: \"fetch failed: no HTTP client is configured (enable the `client` feature of incur, or set `Cli::client`)\"\n")"#);
}

/// Over HTTP, failures to load generated commands, unreachable gateways, environment errors,
/// non-object JSON bodies, and global validation errors become error responses.
#[test]
fn reports_http_failures() {
    let spec = offline(Cli::new("spec")).fetch_command(
        "api",
        incur::FetchCommand::new(incur::Fetch::url("http://offline.test"))
            .openapi("http://offline.test/openapi.json"),
    );
    let offline = offline(Cli::new("offline")).fetch_command(
        "api",
        incur::FetchCommand::new(incur::Fetch::url("http://offline.test")),
    );
    let env = Cli::new("env")
        .env::<MissingEnv>()
        .command("show", Command::new().run(|_: Context| incur::ok(1)));
    let echo = Cli::new("echo").globals::<EchoGlobals>().command(
        "echo",
        Command::new().run(|c: Context| incur::ok(c.globals)),
    );
    let outputs = [
        http(&spec, "GET", "/api", &[], ""),
        http(&offline, "GET", "/api/users", &[], ""),
        http(&env, "GET", "/show", &[], ""),
        http(
            &echo,
            "POST",
            "/echo",
            &[("content-type", "application/json")],
            "[1]",
        ),
        http(&echo, "GET", "/echo?limit=x", &[], ""),
    ];
    assert_snapshot!(outputs.join("\n---\n"), @r#"
    HTTP 500
    content-type: application/json

    {"ok":false,"error":{"code":"UNKNOWN","message":"fetch failed: offline"},"meta":{"command":"/","duration":"<n>"}}
    ---
    HTTP 500
    content-type: application/json

    {"ok":false,"error":{"code":"UNKNOWN","message":"fetch failed: offline"},"meta":{"command":"/","duration":"<n>"}}
    ---
    HTTP 400
    content-type: application/json

    {"ok":false,"error":{"code":"VALIDATION_ERROR","message":"Invalid input: expected string, received undefined\n\nDetails: [\n  {\n    \"expected\": \"string\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"INCUR_API_UNSET_VARIABLE\"\n    ],\n    \"message\": \"Invalid input: expected string, received undefined\"\n  }\n]","fieldErrors":[{"code":"invalid_type","missing":true,"path":"INCUR_API_UNSET_VARIABLE","expected":"string","received":"","message":"Invalid input: expected string, received undefined"}]},"meta":{"command":"show","duration":"<n>"}}
    ---
    HTTP 200
    content-type: application/json

    {"ok":true,"data":{},"meta":{"command":"echo","duration":"<n>"}}
    ---
    HTTP 400
    content-type: application/json

    {"ok":false,"error":{"code":"VALIDATION_ERROR","message":"Invalid input: expected number, received string"},"meta":{"command":"echo","duration":"<n>"}}
    "#);
}

#[derive(Deserialize, Schema)]
struct EchoGlobals {
    /// Limit
    #[expect(dead_code, reason = "Handlers read raw globals.")]
    limit: Option<f64>,
}

/// Stateful MCP over HTTP validates sessions, accepts event streams and session deletion, and
/// rejects batched initialization and other methods. Stateless servers check protocol versions.
#[test]
fn serves_stateful_mcp_over_http() {
    let cli = Cli::new("web")
        .mcp(Mcp::new().stateless(false))
        .command("ping", Command::new().run(|_: Context| incur::ok("pong")));
    let stream = [("accept", "text/event-stream")];
    let batch = format!("[{INITIALIZE},{INITIALIZE}]");
    let mut outputs = vec![
        http(&cli, "GET", "/mcp", &stream, ""),
        http(&cli, "POST", "/mcp", &MCP, &batch),
        http(&cli, "POST", "/mcp", &MCP, INITIALIZE),
    ];
    let session = {
        let request = http::Request::post("http://localhost/mcp")
            .header("accept", MCP[0].1)
            .header("content-type", MCP[1].1)
            .body(incur::Body::from(INITIALIZE))
            .unwrap();
        let fresh = Cli::new("web").mcp(Mcp::new().stateless(false));
        let response = futures::executor::block_on(fresh.fetch(request));
        let id = response.headers()["mcp-session-id"]
            .to_str()
            .unwrap()
            .to_owned();
        (fresh, id)
    };
    let (fresh, id) = session;
    let with_session = [
        ("accept", "text/event-stream"),
        ("mcp-session-id", id.as_str()),
    ];
    outputs.push(http(
        &fresh,
        "GET",
        "/mcp",
        &[("accept", "application/json")],
        "",
    ));
    outputs.push(http(&fresh, "GET", "/mcp", &with_session, ""));
    outputs.push(http(
        &fresh,
        "DELETE",
        "/mcp",
        &[("mcp-session-id", "other")],
        "",
    ));
    outputs.push(http(
        &fresh,
        "DELETE",
        "/mcp",
        &[("mcp-session-id", id.as_str())],
        "",
    ));
    outputs.push(http(&fresh, "PUT", "/mcp", &[], ""));
    let stateless =
        Cli::new("plain").command("ping", Command::new().run(|_: Context| incur::ok(1)));
    let list = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
    let versioned = [MCP[0], MCP[1], ("mcp-protocol-version", "1999-01-01")];
    outputs.push(http(&stateless, "POST", "/mcp", &versioned, list));
    let dupe = Cli::new("dupe")
        .command("a_b", Command::new().run(|_: Context| incur::ok(1)))
        .group(Cli::new("a").command("b", Command::new().run(|_: Context| incur::ok(2))));
    outputs.push(http(&dupe, "POST", "/mcp", &MCP, list));
    assert_snapshot!(outputs.join("\n---\n"), @r#"
    HTTP 400
    content-type: application/json

    {"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Server not initialized"},"id":null}
    ---
    HTTP 400
    content-type: application/json

    {"jsonrpc":"2.0","error":{"code":-32600,"message":"Invalid Request: Only one initialization request is allowed"},"id":null}
    ---
    HTTP 200
    content-type: application/json
    mcp-session-id: <session>

    {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"web","version":"0.0.0"}},"jsonrpc":"2.0","id":0}
    ---
    HTTP 406
    content-type: application/json

    {"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable: Client must accept text/event-stream"},"id":null}
    ---
    HTTP 200
    cache-control: no-cache
    connection: keep-alive
    content-type: text/event-stream


    ---
    HTTP 404
    content-type: application/json

    {"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"},"id":null}
    ---
    HTTP 200


    ---
    HTTP 405
    allow: GET, POST, DELETE
    content-type: application/json

    {"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}
    ---
    HTTP 400
    content-type: application/json

    {"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Unsupported protocol version: 1999-01-01 (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)"},"id":null}
    ---
    HTTP 500
    content-type: application/json

    {"jsonrpc":"2.0","error":{"code":-32603,"message":"Duplicate MCP tool name: a_b"},"id":null}
    "#);
}

/// Serves `argv` with an environment and standard input lines, and returns the exit code and
/// output.
fn run(cli: &Cli, argv: &[&str], env: &[(&str, &str)], stdin: &[&str], tty: bool) -> (i32, String) {
    let argv = argv.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
    let vars = env
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect::<BTreeMap<_, _>>();
    let lookup = |key: &str| vars.get(key).cloned();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let lines = stdin
        .iter()
        .map(|line| (*line).to_owned())
        .collect::<Vec<_>>();
    let exit = cli.serve_with(
        &argv,
        &mut Io {
            env: &lookup,
            stderr: &mut stderr,
            stdin: &mut stream::iter(lines),
            stdout: &mut stdout,
            tty,
        },
    );
    (
        exit,
        String::from_utf8(stdout).unwrap() + &String::from_utf8(stderr).unwrap(),
    )
}

/// Wraps a tool call in a JSON-RPC request.
fn call(id: u32, name: &str, arguments: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":{id},"method":"tools/call","params":{{"name":"{name}","arguments":{arguments}}}}}"#
    )
}

/// Progressive MCP discovery validates catalog arguments, scores partial matches, and reports
/// tool instructions; malformed JSON-RPC messages are ignored.
#[test]
fn validates_progressive_mcp_calls() {
    let cli = Cli::new("cat")
        .update(false)
        .sync(false)
        .mcp(Mcp::new().include(["re*ed", "a*zz*b", "s*t*s"]))
        .command(
            "renamed",
            Command::new()
                .description("Renamed tool")
                .mcp(Tool::new().instructions("Call sparingly."))
                .run(|_: Context| incur::ok(1)),
        )
        .command(
            "status",
            Command::new()
                .description("Show status")
                .run(|_: Context| incur::ok(2)),
        )
        .command("ab", Command::new().run(|_: Context| incur::ok(3)));
    let lines = [
        INITIALIZE.to_owned(),
        r#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#.to_owned(),
        r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":[]}"#.to_owned(),
        r#"{"jsonrpc":"2.0","id":1.5,"method":"ping"}"#.to_owned(),
        r#"{"jsonrpc":"2.0","id":1,"error":{"code":1,"message":"m"}}"#.to_owned(),
        r#"{"jsonrpc":"2.0","id":1,"result":{}}"#.to_owned(),
        call(2, "search_tools", r#"{"query":"stat tus"}"#),
        call(3, "get_tool_details", r#"{"name":"renamed"}"#),
        call(4, "search_tools", "5"),
        call(5, "call_read_tool", r#"{"name":"status","arguments":[]}"#),
        call(6, "call_read_tool", r#"{"name":"status","arguments":true}"#),
        call(7, "call_read_tool", r#"{"name":"status","arguments":null}"#),
        call(8, "call_read_tool", r#"{"name":"status","arguments":1}"#),
        call(9, "call_read_tool", r#"{"arguments":"s"}"#),
    ];
    let lines = lines.iter().map(String::as_str).collect::<Vec<_>>();
    assert_snapshot!(run(&cli, &["--mcp"], &[], &lines, false).1, @r#"
    {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"cat","version":"0.0.0"}},"jsonrpc":"2.0","id":0}
    {"result":{"content":[{"type":"text","text":"{\"tools\":[{\"name\":\"status\",\"description\":\"Show status\"}]}"}]},"jsonrpc":"2.0","id":2}
    {"result":{"content":[{"type":"text","text":"{\"name\":\"renamed\",\"description\":\"Renamed tool\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}},\"instructions\":\"Call sparingly.\"}"}]},"jsonrpc":"2.0","id":3}
    {"result":{"content":[{"type":"text","text":"Input validation error: Invalid arguments for tool search_tools: Invalid input: expected object, received number"}],"isError":true},"jsonrpc":"2.0","id":4}
    {"result":{"content":[{"type":"text","text":"Input validation error: Invalid arguments for tool call_read_tool: arguments: Invalid input: expected record, received array"}],"isError":true},"jsonrpc":"2.0","id":5}
    {"result":{"content":[{"type":"text","text":"Input validation error: Invalid arguments for tool call_read_tool: arguments: Invalid input: expected record, received boolean"}],"isError":true},"jsonrpc":"2.0","id":6}
    {"result":{"content":[{"type":"text","text":"Input validation error: Invalid arguments for tool call_read_tool: arguments: Invalid input: expected record, received null"}],"isError":true},"jsonrpc":"2.0","id":7}
    {"result":{"content":[{"type":"text","text":"Input validation error: Invalid arguments for tool call_read_tool: arguments: Invalid input: expected record, received number"}],"isError":true},"jsonrpc":"2.0","id":8}
    {"result":{"content":[{"type":"text","text":"Input validation error: Invalid arguments for tool call_read_tool: name: Invalid input: expected string, received undefined, arguments: Invalid input: expected record, received string"}],"isError":true},"jsonrpc":"2.0","id":9}
    "#);
}

#[derive(Deserialize, Schema)]
struct Pair {
    /// Key
    #[expect(dead_code, reason = "Only the schema is used.")]
    key: String,
    /// Value
    #[expect(dead_code, reason = "Only the schema is used.")]
    value: Option<String>,
}

#[derive(Deserialize, Schema)]
struct PairOptions {
    /// Pairs
    #[expect(dead_code, reason = "Only the schema is used.")]
    pairs: Option<Vec<Pair>>,
}

/// MCP tool calls report CLI environment errors, and `--mcp` refuses duplicate tool names.
#[test]
fn reports_mcp_server_errors() {
    let env = Cli::new("env")
        .update(false)
        .sync(false)
        .mcp(Mcp::new().discovery(Discovery::Direct))
        .env::<MissingEnv>()
        .command(
            "show",
            Command::new().run(|_: Context<(), PairOptions>| incur::ok(1)),
        );
    let dupe = Cli::new("dupe")
        .update(false)
        .sync(false)
        .command("a_b", Command::new().run(|_: Context| incur::ok(1)))
        .group(Cli::new("a").command("b", Command::new().run(|_: Context| incur::ok(2))));
    let show = call(1, "show", "{}");
    let outputs = [
        run(
            &env,
            &["--mcp"],
            &[],
            &[
                INITIALIZE,
                r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
                &show,
            ],
            false,
        ),
        run(&dupe, &["--mcp"], &[], &[], false),
        run(&dupe, &["--mcp"], &[], &[], true),
    ];
    assert_snapshot!(format!("{outputs:#?}"), @r#"
    [
        (
            0,
            "{\"result\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{\"tools\":{\"listChanged\":true}},\"serverInfo\":{\"name\":\"env\",\"version\":\"0.0.0\"}},\"jsonrpc\":\"2.0\",\"id\":0}\n{\"result\":{\"tools\":[{\"name\":\"show\",\"inputSchema\":{\"type\":\"object\",\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"properties\":{\"pairs\":{\"description\":\"Pairs\",\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"key\":{\"type\":\"string\",\"description\":\"Key\"},\"value\":{\"description\":\"Value\",\"type\":\"string\"}},\"required\":[\"key\"]}}}}}]},\"jsonrpc\":\"2.0\",\"id\":2}\n{\"result\":{\"_meta\":{\"error\":{\"code\":\"VALIDATION_ERROR\"}},\"content\":[{\"type\":\"text\",\"text\":\"{\\\"code\\\":\\\"VALIDATION_ERROR\\\",\\\"message\\\":\\\"Invalid input: expected string, received undefined\\\\n\\\\nDetails: [\\\\n  {\\\\n    \\\\\\\"expected\\\\\\\": \\\\\\\"string\\\\\\\",\\\\n    \\\\\\\"code\\\\\\\": \\\\\\\"invalid_type\\\\\\\",\\\\n    \\\\\\\"path\\\\\\\": [\\\\n      \\\\\\\"INCUR_API_UNSET_VARIABLE\\\\\\\"\\\\n    ],\\\\n    \\\\\\\"message\\\\\\\": \\\\\\\"Invalid input: expected string, received undefined\\\\\\\"\\\\n  }\\\\n]\\\",\\\"fieldErrors\\\":[{\\\"code\\\":\\\"invalid_type\\\",\\\"missing\\\":true,\\\"path\\\":\\\"INCUR_API_UNSET_VARIABLE\\\",\\\"expected\\\":\\\"string\\\",\\\"received\\\":\\\"\\\",\\\"message\\\":\\\"Invalid input: expected string, received undefined\\\"}]}\"}],\"isError\":true},\"jsonrpc\":\"2.0\",\"id\":1}\n",
        ),
        (
            1,
            "code: UNKNOWN\nmessage: \"Duplicate MCP tool name: a_b\"\n",
        ),
        (
            1,
            "Error: Duplicate MCP tool name: a_b\n",
        ),
    ]
    "#);
}

/// A fresh directory for a test's files, removed when dropped.
struct Sandbox(std::path::PathBuf);

impl Sandbox {
    /// Creates an empty directory named after the test.
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("incur-api-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("tmp")).unwrap();
        Self(dir)
    }

    /// Returns a path inside the sandbox.
    fn path(&self, relative: &str) -> std::path::PathBuf {
        self.0.join(relative)
    }

    /// Writes a file, creating its parent directories.
    fn write(&self, relative: &str, content: &str) {
        let path = self.path(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    /// Writes an executable script.
    fn script(&self, relative: &str, content: &str) {
        use std::os::unix::fs::PermissionsExt;
        self.write(relative, content);
        std::fs::set_permissions(self.path(relative), std::fs::Permissions::from_mode(0o755))
            .unwrap();
    }

    /// Returns the sandbox path as text.
    fn root(&self) -> String {
        self.0.display().to_string()
    }

    /// Replaces the sandbox path in output.
    fn clean(&self, output: &str) -> String {
        output.replace(&self.root(), "<sandbox>")
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Builds a CLI that syncs skills from a sandbox.
fn kit(name: &str, sandbox: &Sandbox, commands: &[&str]) -> Cli {
    let sync = incur::SkillSync::new()
        .cwd(sandbox.path(""))
        .depth(1)
        .include(["skills/*", "missing/*", "notdir/*"]);
    commands.iter().fold(
        Cli::new(name).version("1.0.0").update(false).sync(sync),
        |cli, command| {
            cli.command(
                *command,
                Command::new()
                    .description("A command")
                    .run(|_: Context| incur::ok(true)),
            )
        },
    )
}

/// Skill sync copies nested included skills, links them for detected agents, replaces earlier
/// links, removes stale skills, and stops reporting staleness once installed. Missing globs
/// and unreadable skill files are skipped.
#[test]
fn syncs_skills_for_agents() {
    let sandbox = Sandbox::new("sync");
    std::fs::create_dir_all(sandbox.path(".claude")).unwrap();
    sandbox.write(
        "skills/nested/SKILL.md",
        "---\nname: nested\ndescription: Nested\n---\n",
    );
    sandbox.write("skills/nested/docs/extra.md", "extra\n");
    sandbox.write("skills/plain/SKILL.md", "# No frontmatter\n");
    std::fs::create_dir_all(sandbox.path("skills/broken/SKILL.md")).unwrap();
    sandbox.write("notdir", "");
    let home = sandbox.root();
    let tmp = sandbox.path("tmp").display().to_string();
    let env = [("HOME", home.as_str()), ("TMPDIR", tmp.as_str())];
    let first = kit("kit", &sandbox, &["old", "status"]);
    let second = kit("kit", &sandbox, &["status"]);
    let outputs = [
        run(&first, &["status"], &env, &[], false),
        run(&first, &["skills", "add"], &env, &[], false),
        run(&second, &["skills", "add"], &env, &[], false),
        run(&second, &["status"], &env, &[], false),
        run(&second, &["skills", "list"], &env, &[], false),
        run(&first, &["skills", "add", "--no-global"], &env, &[], false),
        run(&second, &["skills", "add", "--no-global"], &env, &[], false),
    ];
    let mut tree = walk(&sandbox.path(""), &sandbox);
    tree.retain(|line| !line.starts_with("tmp"));
    assert_snapshot!(sandbox.clean(&format!("{outputs:#?}\n{}", tree.join("\n"))), @r#"
    [
        (
            0,
            "true\n",
        ),
        (
            0,
            "Syncing...\r\u{1b}[K  ✓ kit-old     A command. Run `kit old --help` for usage details.\n  ✓ kit-status  A command. Run `kit status --help` for usage details.\n  ✓ nested      Nested\n  ✓ plain\n\n4 skills synced\n\nRun `kit --help` to see the full command reference.\n",
        ),
        (
            0,
            "Syncing...\r\u{1b}[K  ✓ kit-status  A command. Run `kit status --help` for usage details.\n  ✓ nested      Nested\n  ✓ plain\n\n3 skills synced\n\nRun `kit --help` to see the full command reference.\n",
        ),
        (
            0,
            "true\n",
        ),
        (
            0,
            "  ✓ kit-status  A command. Run `kit status --help` for usage details.\n  ✓ nested      Nested\n  ✓ plain\n\n3 skills (3 installed)\n",
        ),
        (
            0,
            "Syncing...\r\u{1b}[K  ✓ kit-old     A command. Run `kit old --help` for usage details.\n  ✓ kit-status  A command. Run `kit status --help` for usage details.\n  ✓ nested      Nested\n  ✓ plain\n\n4 skills synced\n\nRun `kit --help` to see the full command reference.\n",
        ),
        (
            0,
            "Syncing...\r\u{1b}[K  ✓ kit-status  A command. Run `kit status --help` for usage details.\n  ✓ nested      Nested\n  ✓ plain\n\n3 skills synced\n\nRun `kit --help` to see the full command reference.\n",
        ),
    ]
    .agents/
    .agents/skills/
    .agents/skills/kit-status/
    .agents/skills/kit-status/SKILL.md
    .agents/skills/nested/
    .agents/skills/nested/SKILL.md
    .agents/skills/plain/
    .agents/skills/plain/SKILL.md
    .claude/
    .claude/skills/
    .claude/skills/kit-status -> ../../.agents/skills/kit-status
    .claude/skills/nested -> ../../.agents/skills/nested
    .claude/skills/plain -> ../../.agents/skills/plain
    .local/
    .local/share/
    .local/share/incur/
    .local/share/incur/kit.json
    notdir
    skills/
    skills/broken/
    skills/broken/SKILL.md/
    skills/nested/
    skills/nested/SKILL.md
    skills/nested/docs/
    skills/nested/docs/extra.md
    skills/plain/
    skills/plain/SKILL.md
    "#);
}

/// Lists a sandbox's files and links, relative to its root.
fn walk(dir: &std::path::Path, sandbox: &Sandbox) -> Vec<String> {
    let mut entries = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    entries.sort();
    let mut out = Vec::new();
    for path in entries {
        let name = path.strip_prefix(&sandbox.0).unwrap().display().to_string();
        let meta = std::fs::symlink_metadata(&path).unwrap();
        if meta.file_type().is_symlink() {
            out.push(format!(
                "{name} -> {}",
                std::fs::read_link(&path).unwrap().display()
            ));
        } else if meta.is_dir() {
            out.push(format!("{name}/"));
            out.extend(walk(&path, sandbox));
        } else {
            out.push(name);
        }
    }
    out
}

/// Skill sync reports an empty skill list, failures to stage files, agents whose skills
/// directory already is the canonical one, and agents whose links cannot be created.
#[test]
fn reports_skill_sync_edge_cases() {
    let sandbox = Sandbox::new("sync-edges");
    let home = sandbox.root();
    let tmp = sandbox.path("tmp").display().to_string();
    let env = [("HOME", home.as_str()), ("TMPDIR", tmp.as_str())];
    let blocked = sandbox.path("blocked").display().to_string();
    sandbox.write("blocked", "");
    let bad_tmp = [("HOME", home.as_str()), ("TMPDIR", blocked.as_str())];
    std::fs::create_dir_all(sandbox.path(".agents/skills")).unwrap();
    std::fs::create_dir_all(sandbox.path(".claude")).unwrap();
    std::os::unix::fs::symlink(
        sandbox.path(".agents/skills"),
        sandbox.path(".claude/skills"),
    )
    .unwrap();
    sandbox.write(".codeium/windsurf/skills", "");
    let empty = Cli::new("empty")
        .update(false)
        .sync(incur::SkillSync::new().cwd(sandbox.path("tmp")));
    let cli = kit("edge", &sandbox, &["status"]);
    let outputs = [
        run(&empty, &["skills", "list"], &env, &[], false),
        run(&cli, &["skills", "add"], &bad_tmp, &[], false),
        run(&cli, &["skills", "add", "--json"], &env, &[], false),
    ];
    assert_snapshot!(sandbox.clean(&format!("{outputs:#?}")), @r#"
    [
        (
            0,
            "No skills found.\n",
        ),
        (
            1,
            "Syncing...code: SYNC_SKILLS_FAILED\nmessage: Not a directory (os error 20)\n",
        ),
        (
            0,
            "Syncing...\r\u{1b}[K  ✓ edge-status  A command. Run `edge status --help` for usage details.\n\n1 skill synced\n\nRun `edge --help` to see the full command reference.\n{\n  \"skills\": [\n    \"<sandbox>/.agents/skills/edge-status\"\n  ]\n}\n",
        ),
    ]
    "#);
}

/// `mcp add` reports runner failures without output, and registers a command without a
/// program with no agent. Skill notices name the package runner with a valid version, or fall
/// back to the CLI name.
#[test]
fn reports_registration_and_notice_edge_cases() {
    let sandbox = Sandbox::new("register");
    sandbox.script("bin/npx", "#!/bin/sh\nexit 3\n");
    let home = sandbox.root();
    let path = sandbox.path("bin").display().to_string();
    let env = [("HOME", home.as_str()), ("PATH", path.as_str())];
    let plain = Cli::new("plain").update(false).sync(false);
    let amp = Cli::new("amped")
        .update(false)
        .sync(false)
        .mcp(Mcp::new().agents(["amp"]).command(""));
    let stale = sandbox.path(".local/share/incur");
    std::fs::create_dir_all(&stale).unwrap();
    let npm = [("HOME", home.as_str()), ("npm_config_user_agent", "npm/10")];
    let notice = |name: &str, package: &str, version: Option<&str>| {
        std::fs::write(
            stale.join(format!("{name}.json")),
            r#"{"hash":"0","skills":["x"],"paths":[],"at":"2020-01-01T00:00:00.000Z"}"#,
        )
        .unwrap();
        sandbox.write(".agents/skills/x/SKILL.md", "x\n");
        let cli = Cli::new(name)
            .update(false)
            .package(package)
            .sync(incur::SkillSync::new().cwd(sandbox.path("tmp")))
            .command("status", Command::new().run(|_: Context| incur::ok(true)));
        let cli = match version {
            Some(version) => cli.version(version),
            None => cli,
        };
        run(&cli, &["status"], &npm, &[], false)
    };
    std::fs::create_dir_all(sandbox.path("empty")).unwrap();
    sandbox.write("locked/npx", "#!/bin/sh\n");
    let empty = sandbox.path("empty").display().to_string();
    let locked = sandbox.path("locked").display().to_string();
    let outputs = [
        run(
            &plain,
            &["mcp", "add"],
            &[("HOME", home.as_str()), ("PATH", empty.as_str())],
            &[],
            false,
        ),
        run(
            &plain,
            &["mcp", "add"],
            &[("HOME", home.as_str()), ("PATH", locked.as_str())],
            &[],
            false,
        ),
        run(&plain, &["mcp", "add"], &env, &[], false),
        run(&amp, &["mcp", "add"], &env, &[], false),
        notice("pre", "pkg", Some("1.0.0-rc.1+b5")),
        notice("bad", "pkg", Some("1.0.0+b@d")),
        notice("bare", "pkg", None),
    ];
    assert_snapshot!(sandbox.clean(&format!("{outputs:#?}")), @r#"
    [
        (
            1,
            "Registering MCP server...code: MCP_ADD_FAILED\nmessage: spawn npx ENOENT\n",
        ),
        (
            1,
            "Registering MCP server...code: MCP_ADD_FAILED\nmessage: spawn npx EACCES\n",
        ),
        (
            1,
            "Registering MCP server...code: MCP_ADD_FAILED\nmessage: \"Command failed: npx add-mcp npx plain --mcp --name plain -y -g\"\n",
        ),
        (
            0,
            "Registering MCP server...\r\u{1b}[K✓ Registered amped as MCP server\n\nAgents can now use amped tools.\n",
        ),
        (
            0,
            "data: true\ncta:\n  description: \"Skills are out of date:\"\n  commands[1]{command,description}:\n    npx pkg@1.0.0-rc.1+b5 skills add,sync outdated skills\n",
        ),
        (
            0,
            "data: true\ncta:\n  description: \"Skills are out of date:\"\n  commands[1]{command,description}:\n    bad skills add,sync outdated skills\n",
        ),
        (
            0,
            "data: true\ncta:\n  description: \"Skills are out of date:\"\n  commands[1]{command,description}:\n    npx pkg skills add,sync outdated skills\n",
        ),
    ]
    "#);
}

/// Update notices compare prerelease identifiers, ignore invalid cached versions, and schedule a
/// background check when the cache is due; a background check without a known version does
/// nothing.
#[test]
fn checks_for_updates() {
    let sandbox = Sandbox::new("updates");
    let home = sandbox.root();
    let env = [("HOME", home.as_str())];
    let cli = |name: &str, version: Option<&str>| {
        let update = incur::Update::default()
            .check(|_: incur::update::CheckContext| async {
                Ok::<_, Error>(Some("9.0.0".to_owned()))
            })
            .interval(Duration::from_hours(1));
        let cli = Cli::new(name)
            .sync(false)
            .update(update)
            .command("status", Command::new().run(|_: Context| incur::ok(true)));
        match version {
            Some(version) => cli.version(version),
            None => cli,
        }
    };
    let cached = |name: &str, latest: &str| {
        sandbox.write(
            &format!(".cache/incur/updates/{name}.json"),
            &format!(r#"{{"checkedAt":9000000000000,"latest":"{latest}"}}"#),
        );
    };
    cached("alpha", "1.0.0-alpha");
    cached("build", "2.0.0+b@d");
    cached("pre", "2.0.0-a..b");
    let mut outputs = vec![
        run(&cli("alpha", Some("1.0.0-1")), &["status"], &env, &[], true),
        run(&cli("build", Some("1.0.0")), &["status"], &env, &[], true),
        run(&cli("pre", Some("1.0.0")), &["status"], &env, &[], true),
        run(&cli("due", Some("1.0.0")), &["status"], &env, &[], true),
        run(
            &cli("unknown", None),
            &["--incur-update-check"],
            &env,
            &[],
            false,
        ),
        run(
            &cli("fresh", Some("1.0.0")),
            &["--incur-update-check"],
            &env,
            &[],
            false,
        ),
    ];
    let due = std::fs::read_to_string(sandbox.path(".cache/incur/updates/due.json")).unwrap();
    let blocked = Sandbox::new("updates-blocked");
    blocked.write(".cache", "");
    let home = blocked.root();
    outputs.push(run(
        &cli("due", Some("1.0.0")),
        &["status"],
        &[("HOME", home.as_str())],
        &[],
        true,
    ));
    let due = due.starts_with(r#"{"checkedAt":"#) && !due.contains("latest");
    assert_snapshot!(format!("{outputs:#?}\n{due:?}"), @r#"
    [
        (
            0,
            "true\n\nUpdate available for alpha:\n  alpha --update  # upgrade from 1.0.0-1 to 1.0.0-alpha\n",
        ),
        (
            0,
            "true\n",
        ),
        (
            0,
            "true\n",
        ),
        (
            0,
            "true\n",
        ),
        (
            0,
            "",
        ),
        (
            0,
            "",
        ),
        (
            0,
            "true\n",
        ),
    ]
    true
    "#);
}

/// Returns a fetch source that echoes the request method, path, and body.
fn echo_fetch() -> incur::Fetch {
    incur::Fetch::new(|request: http::Request<incur::Body>| async move {
        let line = format!("{} {}", request.method(), request.uri());
        let body = request.into_body().text().await;
        Ok(http::Response::new(incur::Body::from(format!(
            r#"{{"request":"{line}","body":"{body}"}}"#
        ))))
    })
}

/// Fetch commands read CLI globals and environment, appear in manifests, completions, and MCP
/// tools, and report failures to load generated commands.
#[test]
fn integrates_fetch_commands() {
    let cli = Cli::new("gw")
        .update(false)
        .sync(false)
        .globals::<EchoGlobals>()
        .mcp(Mcp::new().discovery(Discovery::Direct))
        .fetch_command(
            "api",
            incur::FetchCommand::new(echo_fetch()).description("Echo API"),
        );
    let env = Cli::new("env")
        .update(false)
        .sync(false)
        .env::<MissingEnv>()
        .fetch_command("api", incur::FetchCommand::new(echo_fetch()));
    let spec = offline(Cli::new("spec"))
        .update(false)
        .sync(false)
        .fetch_command(
            "api",
            incur::FetchCommand::new(incur::Fetch::url("http://offline.test"))
                .openapi("http://offline.test/openapi.json"),
        );
    let tool = call(1, "api", "{}");
    let outputs = [
        run(&cli, &["api", "users", "--limit", "2"], &[], &[], false),
        run(&cli, &["api", "users", "--limit", "x"], &[], &[], false),
        run(&cli, &["--llms", "--format", "json"], &[], &[], false),
        run(
            &cli,
            &["--", "gw", ""],
            &[("COMPLETE", "bash"), ("_COMPLETE_INDEX", "1")],
            &[],
            false,
        ),
        run(&cli, &["--mcp"], &[], &[INITIALIZE, &tool], false),
        run(&env, &["api", "users"], &[], &[], false),
        run(&spec, &["api", "ping"], &[], &[], false),
    ];
    assert_snapshot!(format!("{outputs:#?}"), @r#"
    [
        (
            0,
            "request: \"GET http://localhost/users\"\nbody: \"\"\n",
        ),
        (
            1,
            "code: VALIDATION_ERROR\nmessage: \"Invalid input: expected number, received NaN\\n\\nDetails: [\\n  {\\n    \\\"expected\\\": \\\"number\\\",\\n    \\\"code\\\": \\\"invalid_type\\\",\\n    \\\"received\\\": \\\"NaN\\\",\\n    \\\"path\\\": [\\n      \\\"limit\\\"\\n    ],\\n    \\\"message\\\": \\\"Invalid input: expected number, received NaN\\\"\\n  }\\n]\"\nfieldErrors[1]{code,missing,path,expected,received,message}:\n  invalid_type,false,limit,number,NaN,\"Invalid input: expected number, received NaN\"\n",
        ),
        (
            0,
            "{\n  \"version\": \"incur.v1\",\n  \"commands\": [\n    {\n      \"name\": \"api\",\n      \"description\": \"Echo API\"\n    }\n  ],\n  \"globals\": {\n    \"type\": \"object\",\n    \"properties\": {\n      \"limit\": {\n        \"description\": \"Limit\",\n        \"type\": \"number\"\n      }\n    },\n    \"additionalProperties\": false\n  }\n}\n",
        ),
        (
            0,
            "api\u{b}completions\u{b}mcp\u{1}",
        ),
        (
            0,
            "{\"result\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{\"tools\":{\"listChanged\":true}},\"serverInfo\":{\"name\":\"gw\",\"version\":\"0.0.0\"}},\"jsonrpc\":\"2.0\",\"id\":0}\n{\"result\":{\"_meta\":{\"error\":{\"code\":\"UNKNOWN\"}},\"content\":[{\"type\":\"text\",\"text\":\"command.run is not a function\"}],\"isError\":true},\"jsonrpc\":\"2.0\",\"id\":1}\n",
        ),
        (
            1,
            "code: VALIDATION_ERROR\nmessage: \"Invalid input: expected string, received undefined\\n\\nDetails: [\\n  {\\n    \\\"expected\\\": \\\"string\\\",\\n    \\\"code\\\": \\\"invalid_type\\\",\\n    \\\"path\\\": [\\n      \\\"INCUR_API_UNSET_VARIABLE\\\"\\n    ],\\n    \\\"message\\\": \\\"Invalid input: expected string, received undefined\\\"\\n  }\\n]\"\nfieldErrors[1]{code,missing,path,expected,received,message}:\n  invalid_type,true,INCUR_API_UNSET_VARIABLE,string,\"\",\"Invalid input: expected string, received undefined\"\n",
        ),
        (
            1,
            "code: UNKNOWN\nmessage: \"fetch failed: offline\"\n",
        ),
    ]
    "#);
}

/// An OpenAPI document with unusual paths, parameters without schemas, colliding header names,
/// and body schemas that exercise reference resolution, conversion, and compaction.
fn edge_spec() -> Value {
    let long = format!("^{}$", "[a-z]".repeat(40));
    json!({
        "openapi": "3.1.0",
        "info": { "title": "Edges", "version": "1.0.0" },
        "components": {
            "schemas": {
                "Node": {
                    "type": "object",
                    "properties": { "child": { "$ref": "#/components/schemas/Node" } }
                }
            }
        },
        "list": [{ "type": "integer" }],
        "paths": {
            "/v1": { "get": { "operationId": "rootV1" } },
            "/fail": { "get": { "operationId": "failing" } },
            "/vx/items": { "get": { "operationId": "vxItems" } },
            "/v1beta/items": { "get": { "operationId": "betaItems" } },
            "/v99999999999999999999999/huge": { "get": { "operationId": "huge" } },
            "/a b!/{id}": {
                "summary": "Odd path",
                "get": {
                    "operationId": "odd",
                    "parameters": [
                        { "name": "id", "in": "path", "required": true },
                        { "name": "q", "in": "query" },
                        { "name": "X-Key", "in": "header" },
                        { "name": "token", "in": "query", "schema": { "type": "string" } },
                        { "name": "token", "in": "header", "schema": { "type": "string" } },
                        { "name": "flag", "in": "query", "schema": { "type": "boolean" } },
                        { "name": "count", "in": "query", "required": true, "schema": { "type": "number" } },
                        { "name": "must", "in": "query", "required": true, "schema": { "type": "boolean" } }
                    ]
                }
            },
            "/body": {
                "post": {
                    "operationId": "body",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "examples": [{}],
                                    "properties": {
                                        "id": { "$id": "urn:id", "type": "string" },
                                        "one": { "type": ["string"] },
                                        "none": { "type": [] },
                                        "choice": { "enum": ["a", "b"] },
                                        "nested": { "properties": { "x": { "type": "string" } } },
                                        "anything": { "description": "Any" },
                                        "list": { "type": "array" },
                                        "when": { "type": "string", "format": "date-time", "example": "now" },
                                        "code": { "type": "string", "pattern": long },
                                        "node": { "$ref": "#/components/schemas/Node" },
                                        "whole": { "$ref": "#/info" },
                                        "item": { "$ref": "#/list/0" },
                                        "mixed": {
                                            "allOf": [{ "examples": ["x"] }, { "type": "string" }],
                                            "anyOf": [{ "type": "string", "examples": ["y"] }, true],
                                            "prefixItems": [{ "examples": [1] }],
                                            "items": { "type": "string", "format": "date-time" },
                                            "additionalProperties": { "type": "string", "example": "z" },
                                            "$defs": { "d": { "type": "string", "examples": ["d"] } }
                                        },
                                        "extra": { "type": "object", "properties": { "a": { "type": "string" } } }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    })
}

/// Serves the edge document, a failing operation, and a missing document.
async fn edge_client(
    request: http::Request<incur::Body>,
) -> Result<http::Response<incur::Body>, Error> {
    let path = request.uri().path().to_owned();
    let query = request.uri().query().unwrap_or_default().to_owned();
    match path.as_str() {
        path if path.ends_with("/edge.json") => Ok(http::Response::new(incur::Body::from(
            edge_spec().to_string(),
        ))),
        "/missing.json" => Ok(http::Response::builder()
            .status(404)
            .body(incur::Body::empty())
            .unwrap()),
        "/fail" => Err(Error::from("upstream unreachable")),
        _ => Ok(http::Response::new(incur::Body::from(
            json!({ "path": path, "query": query, "body": request.into_body().text().await })
                .to_string(),
        ))),
    }
}

/// OpenAPI generation handles version prefixes, schema-less parameters, header collisions,
/// reference cycles and dangling references, unusual body schemas, compaction, and documents
/// fetched relative to hosted sources.
#[test]
fn generates_commands_from_unusual_documents() {
    let hosted = |base: &str, spec: &str| {
        incur::FetchCommand::new(incur::Fetch::url(base)).openapi(spec.to_owned())
    };
    let handler = incur::Fetch::new(edge_client);
    let dangling = |pointer: &str| {
        let spec = json!({
            "openapi": "3.1.0",
            "info": { "title": "Dangling", "version": "1" },
            "paths": { "/x": { "get": { "parameters": [{ "$ref": pointer }] } } }
        });
        incur::FetchCommand::new(incur::Fetch::new(edge_client)).openapi(spec)
    };
    let broken = |command: incur::FetchCommand| {
        Cli::new("broken")
            .update(false)
            .sync(false)
            .client(edge_client)
            .fetch_command("api", command)
    };
    let cli = Cli::new("edge")
        .update(false)
        .sync(false)
        .mcp(Mcp::new().discovery(Discovery::Direct))
        .client(edge_client)
        .fetch_command(
            "ns",
            incur::FetchCommand::new(handler.clone())
                .openapi(edge_spec())
                .openapi_config(
                    incur::Openapi::new()
                        .mode(incur::openapi::Mode::Namespace)
                        .versions(incur::openapi::Versions::Latest)
                        .compact(true),
                ),
        )
        .fetch_command(
            "ops",
            incur::FetchCommand::new(handler).openapi(edge_spec()),
        )
        .fetch_command("up", hosted("http://h.test/a/b/", "../specs/edge.json"))
        .fetch_command("dots", hosted("http://h.test/a/", "./x/../../edge.json"))
        .fetch_command(
            "net",
            hosted("http://h.test/a/", "//h.test/specs/edge.json"),
        )
        .fetch_command("nope", incur::FetchCommand::new(incur::Fetch::url("nope")))
        .fetch_command(
            "empty",
            incur::FetchCommand::new(incur::Fetch::url("http://")),
        );
    let outputs = [
        run(&cli, &["ns", "--llms-full"], &[], &[], false),
        run(&cli, &["ops", "--llms-full"], &[], &[], false),
        run(&cli, &["ops", "body", "--schema"], &[], &[], false),
        run(
            &cli,
            &[
                "ops",
                "odd",
                "7",
                "--count",
                "1",
                "--q",
                "a b*~",
                "--token",
                "t",
                "--header-token",
                "h",
            ],
            &[],
            &[],
            false,
        ),
        run(
            &cli,
            &["ops", "body", "--when", "yesterday"],
            &[],
            &[],
            false,
        ),
        run(
            &cli,
            &["ops", "body", "--extra", r#"{"a":"1","b":2}"#],
            &[],
            &[],
            false,
        ),
        run(&cli, &["up", "rootV1"], &[], &[], false),
        run(&cli, &["dots", "rootV1"], &[], &[], false),
        run(&cli, &["net", "rootV1"], &[], &[], false),
        run(&cli, &["nope", "x"], &[], &[], false),
        run(&cli, &["empty", "x"], &[], &[], false),
        run(&cli, &["ops", "failing"], &[], &[], false),
        (
            0,
            http(
                &cli,
                "POST",
                "/ops/body",
                &[("content-type", "application/json")],
                r#"{"extra":{"a":"1","b":2}}"#,
            ),
        ),
        (0, http(&cli, "GET", "/ops/odd/7?count=%31&q=%zz", &[], "")),
        run(
            &cli,
            &["--mcp"],
            &[],
            &[
                INITIALIZE,
                &call(1, "ops_odd", r#"{"id":"7","count":null,"flag":0}"#),
                &call(2, "ops_odd", r#"{"id":"7","count":true,"flag":""}"#),
                &call(3, "ops_odd", r#"{"id":"7","count":[],"flag":[]}"#),
                &call(4, "ops_odd", r#"{"id":"7","count":5,"flag":null}"#),
                &call(5, "ops_odd", r#"{"id":"7","flag":"x"}"#),
            ],
            false,
        ),
        run(
            &broken(hosted("http://h.test/a/", "http://[bad")),
            &["x"],
            &[],
            &[],
            false,
        ),
        run(
            &broken(hosted("http://h.test/", "missing.json")),
            &["x"],
            &[],
            &[],
            false,
        ),
        run(
            &broken(incur::FetchCommand::new(incur::Fetch::new(edge_client)).openapi("edge.json")),
            &["x"],
            &[],
            &[],
            false,
        ),
        run(
            &broken(dangling("#/components/schemas/Missing")),
            &["x"],
            &[],
            &[],
            false,
        ),
        run(
            &broken(hosted("http://h.test/a/", "ht!tp://x")),
            &["x"],
            &[],
            &[],
            false,
        ),
        run(
            &broken(hosted("http://h.test/a/?q=1", "")),
            &["x"],
            &[],
            &[],
            false,
        ),
        run(
            &broken(hosted("http://h.test/a/", "?v=1")),
            &["x"],
            &[],
            &[],
            false,
        ),
        run(
            &broken(hosted("http://h.test/a/", "specs/.")),
            &["x"],
            &[],
            &[],
            false,
        ),
        run(
            &broken(hosted("http://h.test/a/", "specs/..")),
            &["x"],
            &[],
            &[],
            false,
        ),
        run(&broken(dangling("#/info/title/x")), &["x"], &[], &[], false),
    ];
    assert_snapshot!(format!("{outputs:#?}"), @r##"
    [
        (
            0,
            "# edge ns a-b- id\n\n## Arguments\n\n| Name | Type | Required | Description |\n|------|------|----------|-------------|\n| `id` | `string` | yes |  |\n\n## Options\n\n| Flag | Type | Default | Description |\n|------|------|---------|-------------|\n| `--q` | `string` |  |  |\n| `--token` | `string` |  |  |\n| `--flag` | `boolean` |  |  |\n| `--count` | `number` |  |  |\n| `--must` | `boolean` |  |  |\n| `--x-key` | `string` |  | X-Key header |\n| `--header-token` | `string` |  | token header |\n\n# edge ns body\n\n## Options\n\n| Flag | Type | Default | Description |\n|------|------|---------|-------------|\n| `--id` | `string` |  |  |\n| `--one` | `string` |  |  |\n| `--none` | `unknown` |  |  |\n| `--choice` | `string` |  |  |\n| `--nested` | `object` |  |  |\n| `--anything` | `unknown` |  | Any |\n| `--list` | `array` |  |  |\n| `--when` | `string` |  |  |\n| `--code` | `string` |  |  |\n| `--node` | `object` |  |  |\n| `--whole` | `unknown` |  |  |\n| `--item` | `number` |  |  |\n| `--mixed` | `unknown` |  |  |\n| `--extra` | `object` |  |  |\n\n> Confirm with the user before executing this destructive command.\n\n# edge ns fail\n\n# edge ns root get\n\n# edge ns v1beta items\n\n# edge ns v99999999999999999999999 huge\n\n# edge ns vx items\n",
        ),
        (
            0,
            "# edge ops betaItems\n\n# edge ops body\n\n## Options\n\n| Flag | Type | Default | Description |\n|------|------|---------|-------------|\n| `--id` | `string` |  |  |\n| `--one` | `string` |  |  |\n| `--none` | `unknown` |  |  |\n| `--choice` | `string` |  |  |\n| `--nested` | `object` |  |  |\n| `--anything` | `unknown` |  | Any |\n| `--list` | `array` |  |  |\n| `--when` | `string` |  |  |\n| `--code` | `string` |  |  |\n| `--node` | `object` |  |  |\n| `--whole` | `unknown` |  |  |\n| `--item` | `number` |  |  |\n| `--mixed` | `unknown` |  |  |\n| `--extra` | `object` |  |  |\n\n> Confirm with the user before executing this destructive command.\n\n# edge ops failing\n\n# edge ops huge\n\n# edge ops odd\n\n## Arguments\n\n| Name | Type | Required | Description |\n|------|------|----------|-------------|\n| `id` | `string` | yes |  |\n\n## Options\n\n| Flag | Type | Default | Description |\n|------|------|---------|-------------|\n| `--q` | `string` |  |  |\n| `--token` | `string` |  |  |\n| `--flag` | `boolean` |  |  |\n| `--count` | `number` |  |  |\n| `--must` | `boolean` |  |  |\n| `--x-key` | `string` |  | X-Key header |\n| `--header-token` | `string` |  | token header |\n\n# edge ops rootV1\n\n# edge ops vxItems\n",
        ),
        (
            0,
            "options:\n  type: object\n  properties:\n    id:\n      type: string\n      \"$id\": \"urn:id\"\n    one:\n      type: string\n    none:\n    choice:\n      type: string\n      enum[2]: a,b\n    nested:\n      type: object\n      properties:\n        x:\n          type: string\n      additionalProperties:\n    anything:\n      description: Any\n    list:\n      type: array\n      items:\n    when:\n      type: string\n      format: date-time\n      pattern: \"^(?:(?:\\\\d\\\\d[2468][048]|\\\\d\\\\d[13579][26]|\\\\d\\\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\\\d|30)|(?:02)-(?:0[1-9]|1\\\\d|2[0-8])))T(?:(?:[01]\\\\d|2[0-3]):[0-5]\\\\d(?::[0-5]\\\\d(?:\\\\.\\\\d+)?)?(?:Z))$\"\n      example: now\n    code:\n      type: string\n      pattern: \"^[a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z]$\"\n    node:\n      type: object\n      properties:\n        child:\n      additionalProperties:\n    whole:\n      title: Edges\n      version: 1.0.0\n    item:\n      type: integer\n      minimum: -9007199254740991\n      maximum: 9007199254740991\n    mixed:\n    extra:\n      type: object\n      properties:\n        a:\n          type: string\n      additionalProperties:\n  additionalProperties: false\n",
        ),
        (
            0,
            "path: /a%20b!/7\nquery: q=a+b*%7E&token=t&count=1&must=false\nbody: \"\"\n",
        ),
        (
            1,
            "code: VALIDATION_ERROR\nmessage: \"Invalid ISO datetime\\n\\nDetails: [\\n  {\\n    \\\"origin\\\": \\\"string\\\",\\n    \\\"code\\\": \\\"invalid_format\\\",\\n    \\\"format\\\": \\\"datetime\\\",\\n    \\\"pattern\\\": \\\"^(?:(?:\\\\\\\\d\\\\\\\\d[2468][048]|\\\\\\\\d\\\\\\\\d[13579][26]|\\\\\\\\d\\\\\\\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\\\\\\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\\\\\\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\\\\\\\d|30)|(?:02)-(?:0[1-9]|1\\\\\\\\d|2[0-8])))T(?:(?:[01]\\\\\\\\d|2[0-3]):[0-5]\\\\\\\\d(?::[0-5]\\\\\\\\d(?:\\\\\\\\.\\\\\\\\d+)?)?(?:Z))$\\\",\\n    \\\"path\\\": [\\n      \\\"when\\\"\\n    ],\\n    \\\"message\\\": \\\"Invalid ISO datetime\\\"\\n  }\\n]\"\nfieldErrors[1]{code,missing,path,expected,received,message}:\n  invalid_format,false,when,\"\",\"\",Invalid ISO datetime\n",
        ),
        (
            1,
            "code: VALIDATION_ERROR\nmessage: \"Invalid input: expected object, received string\\n\\nDetails: [\\n  {\\n    \\\"expected\\\": \\\"object\\\",\\n    \\\"code\\\": \\\"invalid_type\\\",\\n    \\\"path\\\": [\\n      \\\"extra\\\"\\n    ],\\n    \\\"message\\\": \\\"Invalid input: expected object, received string\\\"\\n  }\\n]\"\nfieldErrors[1]{code,missing,path,expected,received,message}:\n  invalid_type,false,extra,object,\"\",\"Invalid input: expected object, received string\"\n",
        ),
        (
            0,
            "path: /a/b/v1\nquery: \"\"\nbody: \"\"\n",
        ),
        (
            0,
            "path: /a/v1\nquery: \"\"\nbody: \"\"\n",
        ),
        (
            0,
            "path: /a/v1\nquery: \"\"\nbody: \"\"\n",
        ),
        (
            1,
            "code: UNKNOWN\nmessage: \"Invalid URL: nope\"\n",
        ),
        (
            1,
            "code: UNKNOWN\nmessage: \"Invalid URL: http://\"\n",
        ),
        (
            1,
            "code: UNKNOWN\nmessage: upstream unreachable\n",
        ),
        (
            0,
            "HTTP 200\ncontent-type: application/json\n\n{\"ok\":true,\"data\":{\"path\":\"/body\",\"query\":\"\",\"body\":\"{\\\"extra\\\":{\\\"a\\\":\\\"1\\\",\\\"b\\\":2}}\"},\"meta\":{\"command\":\"ops body\",\"duration\":\"<n>\"}}",
        ),
        (
            0,
            "HTTP 200\ncontent-type: application/json\n\n{\"ok\":true,\"data\":{\"path\":\"/a%20b!/7\",\"query\":\"q=%25zz&count=1&must=false\",\"body\":\"\"},\"meta\":{\"command\":\"ops odd\",\"duration\":\"<n>\"}}",
        ),
        (
            0,
            "{\"result\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{\"tools\":{\"listChanged\":true}},\"serverInfo\":{\"name\":\"edge\",\"version\":\"0.0.0\"}},\"jsonrpc\":\"2.0\",\"id\":0}\n{\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"path\\\":\\\"/a%20b!/7\\\",\\\"query\\\":\\\"flag=false&count=0&must=false\\\",\\\"body\\\":\\\"\\\"}\"}]},\"jsonrpc\":\"2.0\",\"id\":1}\n{\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"path\\\":\\\"/a%20b!/7\\\",\\\"query\\\":\\\"flag=false&count=1&must=false\\\",\\\"body\\\":\\\"\\\"}\"}]},\"jsonrpc\":\"2.0\",\"id\":2}\n{\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"Input validation error: Invalid arguments for tool ops_odd: count: Invalid input: expected number, received NaN\"}],\"isError\":true},\"jsonrpc\":\"2.0\",\"id\":3}\n{\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"path\\\":\\\"/a%20b!/7\\\",\\\"query\\\":\\\"flag=false&count=5&must=false\\\",\\\"body\\\":\\\"\\\"}\"}]},\"jsonrpc\":\"2.0\",\"id\":4}\n{\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"Input validation error: Invalid arguments for tool ops_odd: count: Invalid input: expected number, received NaN\"}],\"isError\":true},\"jsonrpc\":\"2.0\",\"id\":5}\n",
        ),
        (
            1,
            "code: UNKNOWN\nmessage: \"Invalid URL: http://[bad/\"\n",
        ),
        (
            1,
            "code: UNKNOWN\nmessage: \"Failed to fetch OpenAPI spec from missing.json: 404\"\n",
        ),
        (
            1,
            "code: UNKNOWN\nmessage: \"Relative OpenAPI spec URL requires a fetch URL base: edge.json\"\n",
        ),
        (
            1,
            "code: UNKNOWN\nmessage: \"Cannot resolve $ref \\\"#/components/schemas/Missing\\\": \\\"components\\\" not found\"\n",
        ),
        (
            1,
            "code: UNKNOWN\nmessage: \"Invalid URL: ht!tp://x\"\n",
        ),
        (
            1,
            "code: COMMAND_NOT_FOUND\nmessage: 'x' is not a command for 'broken'.\ncta:\n  description: \"Suggested command:\"\n  commands[1]{command,description}:\n    broken --help,see all available commands\n",
        ),
        (
            1,
            "code: COMMAND_NOT_FOUND\nmessage: 'x' is not a command for 'broken'.\ncta:\n  description: \"Suggested command:\"\n  commands[1]{command,description}:\n    broken --help,see all available commands\n",
        ),
        (
            1,
            "code: COMMAND_NOT_FOUND\nmessage: 'x' is not a command for 'broken'.\ncta:\n  description: \"Suggested command:\"\n  commands[1]{command,description}:\n    broken --help,see all available commands\n",
        ),
        (
            1,
            "code: COMMAND_NOT_FOUND\nmessage: 'x' is not a command for 'broken'.\ncta:\n  description: \"Suggested command:\"\n  commands[1]{command,description}:\n    broken --help,see all available commands\n",
        ),
        (
            1,
            "code: UNKNOWN\nmessage: \"Cannot resolve $ref \\\"#/info/title/x\\\": path segment \\\"x\\\" not found\"\n",
        ),
    ]
    "##);
}

/// A fake MCP server: answers `initialize`, lists `tools`, and replies to tool calls with
/// `call(name, arguments)`.
async fn fake_mcp(
    request: http::Request<incur::Body>,
    tools: Value,
    call: fn(&str, &Value) -> Value,
) -> Result<http::Response<incur::Body>, Error> {
    let message: Value = serde_json::from_str(&request.into_body().text().await).unwrap();
    let id = message["id"].clone();
    let result = match message["method"].as_str().unwrap() {
        "initialize" => {
            json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": { "name": "fake", "version": "1" } })
        }
        "tools/list" => json!({ "tools": tools }),
        "tools/call" => call(
            message["params"]["name"].as_str().unwrap(),
            &message["params"]["arguments"],
        ),
        _ => {
            return Ok(http::Response::builder()
                .status(202)
                .body(incur::Body::empty())
                .unwrap());
        }
    };
    let body = json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string();
    Ok(http::Response::builder()
        .header("content-type", "application/json")
        .body(incur::Body::from(body))
        .unwrap())
}

/// Remote MCP sources skip nameless tools, report failed results without text, treat
/// `isError` as JavaScript truthiness, reject non-advancing catalogs, and report invalid
/// headers.
#[test]
fn mounts_unusual_mcp_servers() {
    let direct = |request| {
        let tools = json!([
            { "description": "Nameless" },
            { "name": "silent" },
            { "name": "numeric" },
            { "name": "nulled" },
            { "name": "zero" },
            { "name": "listed" }
        ]);
        fake_mcp(request, tools, |name, _| match name {
            "silent" => json!({ "content": [], "isError": "yes" }),
            "listed" => json!({ "content": [{ "type": "text", "text": "listed" }], "isError": [] }),
            "numeric" => json!({ "content": [{ "type": "text", "text": "failed" }], "isError": 1 }),
            "nulled" => {
                json!({ "content": [{ "type": "text", "text": "{\"ok\":1}" }], "isError": null })
            }
            _ => json!({ "content": [{ "type": "text", "text": "{\"ok\":0}" }], "isError": 0 }),
        })
    };
    let catalog = |request| {
        let tools = json!([
            { "name": "search_tools" },
            { "name": "get_tool_details" },
            { "name": "call_read_tool" },
            { "name": "call_write_tool" }
        ]);
        fake_mcp(request, tools, |name, arguments| match name {
            "search_tools" => {
                let text = if arguments["offset"] == 0 {
                    r#"{"tools":[{"description":"Nameless"},{"name":"echo"}],"nextOffset":1}"#
                } else {
                    r#"{"tools":[],"nextOffset":1}"#
                };
                json!({ "content": [{ "type": "text", "text": text }] })
            }
            _ => json!({ "content": [{ "type": "text", "text": r#"{"name":"echo"}"# }] }),
        })
    };
    let failing = |request| {
        let tools = json!([
            { "name": "search_tools" },
            { "name": "get_tool_details" },
            { "name": "call_read_tool" },
            { "name": "call_write_tool" }
        ]);
        fake_mcp(
            request,
            tools,
            |_, _| json!({ "content": [], "isError": true }),
        )
    };
    let broke = |request| {
        let tools = json!([
            { "name": "search_tools" },
            { "name": "get_tool_details" },
            { "name": "call_read_tool" },
            { "name": "call_write_tool" }
        ]);
        fake_mcp(
            request,
            tools,
            |_, _| json!({ "content": [{ "type": "text", "text": "search broke" }], "isError": true }),
        )
    };
    let cli = Cli::new("remote")
        .update(false)
        .sync(false)
        .mcp_source(
            "failing",
            incur::McpSource::new("http://failing.test/mcp").fetch(failing),
        )
        .mcp_source(
            "broke",
            incur::McpSource::new("http://broke.test/mcp").fetch(broke),
        )
        .mcp_source(
            "direct",
            incur::McpSource::new("http://direct.test/mcp").fetch(direct),
        )
        .mcp_source(
            "catalog",
            incur::McpSource::new("http://catalog.test/mcp").fetch(catalog),
        )
        .mcp_source(
            "headers",
            incur::McpSource::new("http://direct.test/mcp")
                .header("bad header", "x")
                .fetch(direct),
        );
    let outputs = [
        run(&cli, &["direct", "--help"], &[], &[], false),
        run(&cli, &["direct", "silent"], &[], &[], false),
        run(&cli, &["direct", "numeric"], &[], &[], false),
        run(&cli, &["direct", "nulled"], &[], &[], false),
        run(&cli, &["direct", "zero"], &[], &[], false),
        run(&cli, &["catalog", "echo"], &[], &[], false),
        run(&cli, &["headers", "silent"], &[], &[], false),
        run(&cli, &["failing", "x"], &[], &[], false),
        run(&cli, &["broke", "x"], &[], &[], false),
        run(&cli, &["direct", "listed"], &[], &[], false),
    ];
    assert_snapshot!(format!("{outputs:#?}"), @r#"
    [
        (
            0,
            "remote direct\n\nUsage: remote direct <command>\n\nCommands:\n  listed\n  nulled\n  numeric\n  silent\n  zero\n\nGlobal Options:\n  --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])\n  --format <toon|json|yaml|md|jsonl>  Output format\n  --full-output                       Show full output envelope\n  --help                              Show help\n  --llms, --llms-full                 Print LLM-readable manifest\n  --schema                            Show JSON Schema for command\n  --token-count                       Print token count of output (instead of output)\n  --token-limit <n>                   Limit output to n tokens\n  --token-offset <n>                  Skip first n tokens of output\n",
        ),
        (
            1,
            "code: MCP_TOOL_ERROR\nmessage: \"\"\n",
        ),
        (
            1,
            "code: MCP_TOOL_ERROR\nmessage: failed\n",
        ),
        (
            0,
            "ok: 1\n",
        ),
        (
            0,
            "ok: 0\n",
        ),
        (
            1,
            "code: UNKNOWN\nmessage: MCP tool catalog returned a non-advancing offset\n",
        ),
        (
            1,
            "code: UNKNOWN\nmessage: invalid HTTP header name\n",
        ),
        (
            1,
            "code: UNKNOWN\nmessage: \"MCP tool failed: search_tools\"\n",
        ),
        (
            1,
            "code: UNKNOWN\nmessage: search broke\n",
        ),
        (
            1,
            "code: MCP_TOOL_ERROR\nmessage: listed\n",
        ),
    ]
    "#);
}

/// Builders have defaults, and sources and bodies describe themselves for debugging.
#[test]
fn describes_builders_and_bodies() {
    use http_body::Body as _;

    let body = incur::Body::from(vec![1_u8, 2]);
    let ended = incur::Body::default();
    let stream = incur::Body::stream(stream::iter([bytes::Bytes::from_static(b"x")]));
    let handler = incur::Fetch::new(|_: http::Request<incur::Body>| async {
        Ok(http::Response::new(incur::Body::empty()))
    });
    let lines = [
        format!(
            "{body:?} {} {}",
            body.is_end_stream(),
            ended.is_end_stream()
        ),
        format!("{stream:?}"),
        format!(
            "{handler:?} {:?} {:?}",
            incur::Fetch::url("http://h.test/a"),
            incur::Fetch::url("nope")
        ),
        format!("{:?}", incur::Openapi::new()),
        format!("{:?}", Mcp::default()),
        format!("{:?}", Tool::default()),
        format!("{:?}", incur::SkillSync::default()),
    ];
    assert_snapshot!(lines.join("\n"), @r#"
    Body(Some(b"\x01\x02")) false true
    Body(Stream)
    Fetch(Handler) Fetch("http://h.test/a") Fetch("nope")
    Openapi { mode: Operation, versions: All, .. }
    Mcp { agents: [], command: None, discovery: Progressive, enabled: true, exclude: [], include: [], instructions: None, name: None, stateless: true, title: None }
    Tool { annotations: None, description: None, enabled: true, instructions: None, name: None }
    SkillSync { body: None, cwd: None, depth: None, enabled: true, include: [], suggestions: [] }
    "#);
}

/// Skill frontmatter accepts quoted values, comments, and nested keys, and files without a
/// closing delimiter or with malformed mappings have no metadata. HTTP skill discovery names a
/// skill after the CLI when the CLI name has no slug characters, and openapi.json lets globals
/// replace same-named options.
#[test]
fn reads_skill_metadata() {
    let sandbox = Sandbox::new("frontmatter");
    sandbox.write(
        "skills/quoted/SKILL.md",
        "---\n# comment\nname: 'it''s'\ndescription: \"double \\\"quoted\\\"\"\nempty:\nnested:\n  key: value\n---\n",
    );
    sandbox.write("skills/open/SKILL.md", "---\nname: open\n");
    sandbox.write("skills/broken/SKILL.md", "---\nnot a mapping\n---\n");
    let home = sandbox.root();
    let env = [("HOME", home.as_str())];
    let cli = Cli::new("kit!")
        .update(false)
        .sync(
            incur::SkillSync::new()
                .cwd(sandbox.path(""))
                .include(["skills/*"]),
        )
        .command("a", Command::new().run(|_: Context| incur::ok(1)))
        .group(
            Cli::new("grp")
                .command("x", Command::new().run(|_: Context| incur::ok(1)))
                .command("y", Command::new().run(|_: Context| incur::ok(2))),
        );
    let unnamed = Cli::new("!!!")
        .update(false)
        .globals::<EchoGlobals>()
        .root(Command::new().run(|_: Context| incur::ok(1)))
        .command(
            "list",
            Command::new().run(|c: Context<(), EchoOptions>| incur::ok(c.options.limit)),
        );
    let outputs = [
        run(&cli, &["skills", "list"], &env, &[], false).1,
        http(&unnamed, "GET", "/.well-known/skills/index.json", &[], ""),
        http(&unnamed, "GET", "/openapi.json", &[], ""),
    ];
    assert_snapshot!(outputs.join("\n---\n"), @r#"
      ✗ broken
      ✗ kit-a    Run `kit! a --help` for usage details.
      ✗ kit-grp  Run `kit! grp --help` for usage details.
      ✗ open
      ✗ quoted   double "quoted"

    5 skills (0 installed)

    ---
    HTTP 200
    cache-control: public, max-age=300
    content-type: application/json

    {"skills":[{"name":"!!!","description":"Run `!!! --help` for usage details.","files":["SKILL.md"]},{"name":"list","description":"Run `!!! list --help` for usage details.","files":["SKILL.md"]}]}
    ---
    HTTP 200
    cache-control: public, max-age=300
    content-type: application/json

    {"openapi":"3.2.0","info":{"title":"!!!","version":"0.0.0"},"paths":{"/":{"post":{"operationId":"post","requestBody":{"required":false,"content":{"application/json":{"schema":{"type":"object","properties":{"limit":{"description":"Limit","type":"number"}},"additionalProperties":false}}}},"responses":{"200":{"description":"Command completed successfully.","content":{"application/json":{"schema":{"type":"object","required":["ok","data","meta"],"properties":{"ok":{"const":true},"data":{},"meta":{"type":"object","required":["command","duration"],"properties":{"command":{"type":"string"},"duration":{"type":"string"}}}}}}}},"400":{"description":"Validation error.","content":{"application/json":{"schema":{"type":"object","required":["ok","error","meta"],"properties":{"ok":{"const":false},"error":{"type":"object","required":["code","message"],"properties":{"code":{"type":"string"},"message":{"type":"string"},"hint":{"type":"string"},"retryable":{"type":"boolean"}}},"meta":{"type":"object","required":["command","duration"],"properties":{"command":{"type":"string"},"duration":{"type":"string"}}}}}}}},"500":{"description":"Command failed.","content":{"application/json":{"schema":{"type":"object","required":["ok","error","meta"],"properties":{"ok":{"const":false},"error":{"type":"object","required":["code","message"],"properties":{"code":{"type":"string"},"message":{"type":"string"},"hint":{"type":"string"},"retryable":{"type":"boolean"}}},"meta":{"type":"object","required":["command","duration"],"properties":{"command":{"type":"string"},"duration":{"type":"string"}}}}}}}}}}},"/list":{"get":{"operationId":"getList","parameters":[{"name":"limit","in":"query","schema":{"description":"Limit","type":"number"}}],"responses":{"200":{"description":"Command completed successfully.","content":{"application/json":{"schema":{"type":"object","required":["ok","data","meta"],"properties":{"ok":{"const":true},"data":{},"meta":{"type":"object","required":["command","duration"],"properties":{"command":{"type":"string"},"duration":{"type":"string"}}}}}}}},"400":{"description":"Validation error.","content":{"application/json":{"schema":{"type":"object","required":["ok","error","meta"],"properties":{"ok":{"const":false},"error":{"type":"object","required":["code","message"],"properties":{"code":{"type":"string"},"message":{"type":"string"},"hint":{"type":"string"},"retryable":{"type":"boolean"}}},"meta":{"type":"object","required":["command","duration"],"properties":{"command":{"type":"string"},"duration":{"type":"string"}}}}}}}},"500":{"description":"Command failed.","content":{"application/json":{"schema":{"type":"object","required":["ok","error","meta"],"properties":{"ok":{"const":false},"error":{"type":"object","required":["code","message"],"properties":{"code":{"type":"string"},"message":{"type":"string"},"hint":{"type":"string"},"retryable":{"type":"boolean"}}},"meta":{"type":"object","required":["command","duration"],"properties":{"command":{"type":"string"},"duration":{"type":"string"}}}}}}}}}}}}}
    "#);
}

#[derive(Deserialize, Schema)]
struct EchoOptions {
    /// Limit option
    limit: Option<String>,
}
