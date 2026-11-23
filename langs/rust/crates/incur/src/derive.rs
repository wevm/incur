//! Typed CLIs declared with `#[derive(Parser)]`.
//!
//! The derive turns a struct into a single-command CLI and an enum into a CLI with one
//! subcommand per variant. [`Parser::parse`] returns the typed command; [`Parser::serve`] runs a
//! handler for it, which also serves `--mcp` and HTTP.

use std::io::Write;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::cli::{Cli, Io};
use crate::command::{Command, Context, HandlerOutput, Invocation, Outcome, ok};
use crate::errors::Error;
use crate::schema::{Field, Type};

/// A command-line interface declared as a type with `#[derive(Parser)]`.
///
/// A struct is a single-command CLI: its fields are the command's options, or positional
/// arguments with `#[incur(arg)]`, or environment variables with `#[incur(env)]`. An enum is a
/// CLI with a subcommand per variant: unit variants take no input, struct variants declare their
/// fields inline, and a tuple variant holds another `Parser` type, which nests a struct as a
/// command or an enum as a command group.
///
/// Two entries share one definition:
///
/// - [`Parser::parse`] returns the typed command for your code to match. incur handles every
///   built-in first (help, `--version`, `--llms`, `--schema`, completions, `skills`, `--update`,
///   config files, validation errors) and exits when one ran. Your code writes the output.
/// - [`Parser::serve`] runs a handler with the typed command and writes what it returns in the
///   requested format. Only this form serves `--mcp` and HTTP, which call the handler once per
///   request, so `parse` hides `--mcp` and `mcp add`.
///
/// ```no_run
/// use incur::Parser;
///
/// /// A package manager.
/// #[derive(Parser)]
/// #[incur(name = "pm", version = "1.0.0")]
/// enum Pm {
///     /// Install a package
///     Install {
///         /// Package name
///         #[incur(arg)]
///         package: String,
///         /// Save as a dev dependency
///         #[incur(alias = 'D')]
///         save_dev: bool,
///     },
///     /// Show status
///     Status,
/// }
///
/// match Pm::parse() {
///     Pm::Install { package, save_dev } => println!("installing {package} (dev: {save_dev})"),
///     Pm::Status => println!("clean"),
/// }
/// ```
///
/// Customize the CLI with the builder that [`Parser::cli`] returns, then call [`Cli::parse`] or
/// [`Cli::handle`]:
///
/// ```no_run
/// # use incur::Parser;
/// # #[derive(Parser)]
/// # enum Pm { Status }
/// let pm: Pm = Pm::cli().update(false).sync(false).parse();
/// ```
///
/// Attributes declare middleware, examples, and usage lines per command; the
/// [derive macro](macro@crate::Parser) lists them all:
///
/// ```
/// use incur::{Error, MiddlewareContext, Next, Parser};
///
/// async fn audit(c: MiddlewareContext, next: Next) -> Result<(), Error> {
///     next.run(c).await
/// }
///
/// #[derive(Parser)]
/// enum Ops {
///     /// Deploy a service
///     #[incur(middleware = audit, example(command = "api", description = "Deploy the API"))]
///     Deploy {
///         /// Service name
///         #[incur(arg)]
///         service: String,
///     },
/// }
/// ```
pub trait Parser: Node {
    /// Returns the CLI with the derived name, description, version, and aliases, before the
    /// commands are added. Customize it with the builder, then call [`Cli::parse`] or
    /// [`Cli::handle`].
    fn cli() -> Cli;

    /// Parses the process arguments into the typed command. When a built-in runs or the input
    /// is invalid, incur writes its output and exits with its exit code.
    fn parse() -> Self {
        Self::cli().parse()
    }

    /// Parses explicit arguments with explicit I/O. Returns the exit code instead of the
    /// command when a built-in ran or the input was invalid.
    ///
    /// # Errors
    ///
    /// Returns the exit code when no command was parsed.
    fn parse_with(argv: &[String], io: &mut Io<'_>) -> Result<Self, i32> {
        Self::cli().parse_with(argv, io)
    }

    /// Serves the process arguments, running `f` with the typed command and writing what it
    /// returns, then exits with the command's exit code. Serves `--mcp` too. See
    /// [`Cli::handle`] for what `f` may return and [`Cli::serve`] for the runtime.
    fn serve<F, R, M>(f: F)
    where
        F: Fn(Self, Context) -> R + Send + Sync + 'static,
        R: HandlerOutput<M>,
    {
        Self::cli().handle(f).serve();
    }

    /// Like [`Parser::serve`], on the caller's async runtime.
    fn serve_async<F, R, M>(f: F) -> impl Future<Output = ()> + Send
    where
        F: Fn(Self, Context) -> R + Send + Sync + 'static,
        R: HandlerOutput<M>,
    {
        let cli = Self::cli().handle(f);
        async move { cli.serve_async().await }
    }
}

/// How a derived type registers its commands. Implemented by `#[derive(Parser)]`.
#[doc(hidden)]
pub trait Node: Sized + Send + 'static {
    /// The description from the type's doc comment or attribute.
    const DESCRIPTION: Option<&'static str>;

    /// Adds the commands: a struct becomes the root command, an enum's variants subcommands.
    fn attach(cli: Cli, run: Run<Self>) -> Cli;

    /// Mounts under `name`: a struct as a command, an enum as a command group.
    fn mount(cli: Cli, name: &str, meta: Meta, run: Run<Self>) -> Cli;
}

/// The handler a derived command runs with its parsed value.
#[doc(hidden)]
pub type Run<T> =
    Arc<dyn Fn(T, Context) -> Pin<Box<dyn Future<Output = Outcome> + Send>> + Send + Sync>;

/// Marks derived types that are commands rather than command groups: structs. A tuple variant
/// with command attributes requires it of the type it holds.
#[doc(hidden)]
#[diagnostic::on_unimplemented(
    message = "`{Self}` is a command group, so this attribute does not apply",
    label = "describes a command",
    note = "a group variant takes only `name` and `description`; put middleware on the enum"
)]
pub trait Leaf {
    /// Names the assertion that a type is a command.
    const COMMAND: () = ();
}

/// Command metadata from variant and type attributes.
#[doc(hidden)]
#[derive(Clone, Copy, Default)]
pub struct Meta {
    /// Alternative names.
    pub aliases: &'static [&'static str],
    /// Adds middleware, examples, and usage lines.
    pub configure: Option<fn(Command) -> Command>,
    /// Description.
    pub description: Option<&'static str>,
    /// Whether the command changes or deletes state.
    pub destructive: bool,
    /// Guidance shown after examples.
    pub hint: Option<&'static str>,
    /// The output schema.
    pub output: Option<fn() -> Type>,
}

impl Meta {
    /// Uses `description` when no description is set.
    #[must_use]
    pub fn or_description(mut self, description: Option<&'static str>) -> Self {
        self.description = self.description.or(description);
        self
    }

    /// Applies the middleware, examples, and usage lines.
    pub fn apply(&self, command: Command) -> Command {
        match self.configure {
            Some(configure) => configure(command),
            None => command,
        }
    }

    /// Fills what `self` leaves unset from the metadata a type declares. Aliases stay: a
    /// type's aliases name its CLI. The type applies its own middleware, examples, and usage
    /// lines.
    #[must_use]
    pub fn or(self, fallback: Self) -> Self {
        Self {
            aliases: self.aliases,
            configure: self.configure,
            description: self.description.or(fallback.description),
            destructive: self.destructive || fallback.destructive,
            hint: self.hint.or(fallback.hint),
            output: self.output.or(fallback.output),
        }
    }

    /// Mounts an enum's commands on `group`, with this description.
    pub fn group<T: Node>(self, cli: Cli, group: Cli, run: Run<T>) -> Cli {
        let group = match self.description {
            Some(description) => group.description(description),
            None => group,
        };
        cli.group(T::attach(group, run))
    }
}

/// The validated inputs of a derived command, taken field by field.
#[doc(hidden)]
pub struct Fields {
    /// Positional arguments.
    args: Map<String, Value>,
    /// Environment variables.
    env: Map<String, Value>,
    /// Named options.
    options: Map<String, Value>,
}

impl Fields {
    /// Takes a positional argument.
    ///
    /// # Errors
    ///
    /// Returns an error when the value does not deserialize into `T`.
    pub fn arg<T: DeserializeOwned>(&mut self, name: &str) -> Result<T, Error> {
        take(&mut self.args, name)
    }

    /// Takes an environment variable.
    ///
    /// # Errors
    ///
    /// Returns an error when the value does not deserialize into `T`.
    pub fn env<T: DeserializeOwned>(&mut self, name: &str) -> Result<T, Error> {
        take(&mut self.env, name)
    }

    /// Takes an option.
    ///
    /// # Errors
    ///
    /// Returns an error when the value does not deserialize into `T`.
    pub fn option<T: DeserializeOwned>(&mut self, name: &str) -> Result<T, Error> {
        take(&mut self.options, name)
    }
}

/// Removes a field and deserializes it, reading a missing field as `null`.
fn take<T: DeserializeOwned>(map: &mut Map<String, Value>, name: &str) -> Result<T, Error> {
    Ok(serde_json::from_value(
        map.remove(name).unwrap_or_default(),
    )?)
}

/// Reads a validated input object.
fn object(value: Value) -> Map<String, Value> {
    serde_json::from_value(value).unwrap_or_default()
}

/// Builds a derived command: its input schemas, metadata, and a handler that builds the typed
/// value with `build` and runs `run` with it.
#[doc(hidden)]
pub fn leaf<T: Send + 'static>(
    inputs: [Vec<Field>; 3],
    build: fn(&mut Fields) -> Result<T, Error>,
    meta: Meta,
    run: Run<T>,
) -> Command {
    let [args, options, env] =
        inputs.map(|fields| (!fields.is_empty()).then(|| Type::object(fields)));
    let mut command = Command {
        aliases: meta
            .aliases
            .iter()
            .map(|alias| (*alias).to_owned())
            .collect(),
        args,
        description: meta.description.map(str::to_owned),
        destructive: meta.destructive,
        env,
        hint: meta.hint.map(str::to_owned),
        options,
        output: meta.output.map(|output| output()),
        ..Command::new()
    };
    command.handler = Some(Arc::new(move |mut input: Invocation| {
        let mut fields = Fields {
            args: object(std::mem::take(&mut input.args)),
            env: object(std::mem::take(&mut input.env)),
            options: object(std::mem::take(&mut input.options)),
        };
        match build(&mut fields) {
            Ok(value) => run(value, input.into_context((), (), ())),
            Err(error) => Box::pin(std::future::ready(error.into())),
        }
    }));
    command
}

impl Cli {
    /// Adds the commands of a derived [`Parser`] type, each running `f` with the typed command
    /// and the run context. Serve the result like any CLI: [`Cli::serve`], [`Cli::run`],
    /// `--mcp`, or [`Cli::fetch`] over HTTP.
    ///
    /// `f` returns any [`HandlerOutput`]: serializable data, a `Result` of it, an
    /// [`Outcome`](crate::Outcome) from [`ok`](crate::ok) or [`stream`](crate::stream) when
    /// variants return different types, or a future of any of these.
    ///
    /// ```no_run
    /// use incur::Parser;
    /// use serde::Serialize;
    ///
    /// /// Greets people.
    /// #[derive(Parser)]
    /// #[incur(name = "greet")]
    /// struct Greet {
    ///     /// Name to greet
    ///     #[incur(arg)]
    ///     name: String,
    /// }
    ///
    /// #[derive(Serialize)]
    /// struct Greeting {
    ///     message: String,
    /// }
    ///
    /// Greet::cli()
    ///     .update(false)
    ///     .handle(|greet: Greet, _| Greeting { message: format!("hello {}", greet.name) })
    ///     .serve();
    /// ```
    #[must_use]
    pub fn handle<T, F, R, M>(self, f: F) -> Self
    where
        T: Parser,
        F: Fn(T, Context) -> R + Send + Sync + 'static,
        R: HandlerOutput<M>,
    {
        T::attach(
            self,
            Arc::new(move |value, context| Box::pin(f(value, context).resolve())),
        )
    }

    /// Parses the process arguments into a derived [`Parser`] type. When a built-in runs or the
    /// input is invalid, writes its output and exits with its exit code. See [`Parser::parse`].
    pub fn parse<T: Parser>(self) -> T {
        let mut process = crate::cli::Process::new();
        let argv = std::mem::take(&mut process.argv);
        self.parse_with(&argv, &mut process.io())
            .unwrap_or_else(|code| std::process::exit(code))
    }

    /// Parses explicit arguments into a derived [`Parser`] type with explicit I/O, blocking
    /// like [`Cli::serve_with`].
    ///
    /// Middleware runs before the command returns. Output after the command, such as an
    /// output envelope or update notices, is left to the caller, and `--mcp` and `mcp add`,
    /// which need a handler, are hidden.
    ///
    /// # Errors
    ///
    /// Returns the exit code when a built-in ran or the input was invalid.
    pub fn parse_with<T: Parser>(mut self, argv: &[String], io: &mut Io<'_>) -> Result<T, i32> {
        let slot = Arc::new(Mutex::new(None));
        let capture = slot.clone();
        self.parse_only = true;
        let cli = T::attach(
            self,
            Arc::new(move |value, _| {
                let _ = capture.lock().map(|mut slot| *slot = Some(value));
                Box::pin(std::future::ready(ok(())))
            }),
        );
        let parsed = || slot.lock().is_ok_and(|slot| slot.is_some());
        let mut stdout = Gate {
            out: io.stdout,
            closed: &parsed,
        };
        let code = cli.serve_with(
            argv,
            &mut Io {
                env: io.env,
                stderr: io.stderr,
                stdin: io.stdin,
                stdout: &mut stdout,
                tty: io.tty,
            },
        );
        let _ = stdout.flush();
        slot.lock()
            .ok()
            .and_then(|mut slot| slot.take())
            .ok_or(code)
    }
}

/// Standard output that discards writes once `closed` returns true: after a parsed command,
/// output belongs to the caller.
struct Gate<'a> {
    /// The underlying output.
    out: &'a mut (dyn Write + Send),
    /// Whether output is discarded.
    closed: &'a (dyn Fn() -> bool + Sync),
}

impl Write for Gate<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if (self.closed)() {
            return Ok(buf.len());
        }
        self.out.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.out.flush()
    }
}
