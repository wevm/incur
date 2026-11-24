//! CLI definition, command routing, and the `serve` loop.

use std::future::poll_fn;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::task::Poll;
use std::time::Instant;

use futures_channel::mpsc;
use futures_core::Stream;
use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::body::Body;
use crate::command::{
    self, Chunks, Command, Middleware, MiddlewareContext, Next, Outcome, OutputPolicy, Vars,
};
use crate::completions::{self, Shell};
use crate::elicit::Elicit;
use crate::errors::{CtaBlock, Error, FormattedCta, FormattedCtaBlock, human_error};
use crate::execute::{self, Executed};
use crate::fetch::{self, Fetch, FetchCommand};
use crate::filter;
use crate::formatter::{self, Format};
use crate::help::{self, Entry as HelpEntry, Example};
use crate::js;
use crate::mcp::{self, Mcp};
use crate::modern;
use crate::openapi;
use crate::parser::{self, GlobalsOptions};
use crate::remote::McpSource;
use crate::schema::{self, Schema, Type};
use crate::server;
use crate::skill::{self, CommandInfo};
use crate::sync::{self, SkillSync};
use crate::tokens;
use crate::update::{self, Update};

/// The hint appended to destructive commands in agent skills.
const DESTRUCTIVE_HINT: &str = "Confirm with the user before executing this destructive command.";

/// A command tree entry.
#[derive(Clone)]
pub(crate) enum Entry {
    /// Another name for a sibling command, holding a copy of it.
    Alias(Command),
    /// A command.
    Command(Command),
    /// A command that forwards curl-style arguments to a fetch handler.
    Fetch(Gateway),
    /// A group of commands.
    Group(Group),
}

/// A mounted command group.
#[derive(Clone)]
pub(crate) struct Group {
    /// Subcommands.
    pub(crate) commands: IndexMap<String, Entry>,
    /// Description.
    pub(crate) description: Option<String>,
    /// Commands generated on first use: an OpenAPI document or a remote MCP server.
    pub(crate) generated: Option<Arc<dyn Generate>>,
    /// Whether MCP clients see the group.
    pub(crate) mcp: bool,
    /// Group middleware.
    pub(crate) middleware: Vec<Middleware>,
    /// Output policy inherited by children.
    pub(crate) output_policy: Option<OutputPolicy>,
    /// The group's own command.
    pub(crate) root: Option<Command>,
}

impl Default for Group {
    fn default() -> Self {
        Self {
            commands: IndexMap::new(),
            description: None,
            generated: None,
            mcp: true,
            middleware: Vec::new(),
            output_policy: None,
            root: None,
        }
    }
}

/// Generates the commands of a group on first use.
pub(crate) trait Generate: Send + Sync {
    /// Whether generation waits until an invocation reaches the group. Groups that are not
    /// lazy generate before every invocation.
    fn lazy(&self) -> bool;

    /// Returns the generated commands.
    fn generate<'a>(
        &'a self,
        client: &'a fetch::Handler,
    ) -> futures_util::future::BoxFuture<'a, Result<IndexMap<String, Entry>, Error>>;
}

/// Which lazy groups an invocation loads.
pub(crate) enum Scope {
    /// Every group.
    All,
    /// No lazy group.
    None,
    /// The top-level group with this name.
    Only(String),
}

/// A fetch command: forwards curl-style arguments to a handler.
#[derive(Clone)]
pub(crate) struct Gateway {
    /// Prefix for request paths.
    pub(crate) base_path: Option<String>,
    /// Description.
    pub(crate) description: Option<String>,
    /// The handler.
    pub(crate) fetch: Fetch,
    /// Output policy.
    pub(crate) output_policy: Option<OutputPolicy>,
}

impl Gateway {
    /// Returns a handler that sends the request curl-style arguments describe, and returns the
    /// response data, an error, or a stream of NDJSON lines.
    pub(crate) fn handler(&self, argv: Vec<String>, client: fetch::Handler) -> command::Handler {
        let fetch = self.fetch.clone();
        let base_path = self.base_path.clone();
        Arc::new(move |_| {
            let fetch = fetch.clone();
            let base_path = base_path.clone();
            let client = client.clone();
            let argv = argv.clone();
            Box::pin(async move {
                let result = async {
                    let mut input = fetch::parse_argv(&argv)?;
                    if let Some(base_path) = &base_path {
                        input.path = format!("{base_path}{}", input.path);
                    }
                    fetch.send(fetch::build_request(input)?, &client).await
                }
                .await;
                match result {
                    Err(error) => Outcome::from(error),
                    Ok(response) if fetch::is_streaming(&response) => {
                        command::stream(fetch::ndjson(response.into_body()))
                    }
                    Ok(response) => {
                        let status = response.status();
                        let data = fetch::json_or_text(&response.into_body().text().await);
                        if status.is_success() {
                            command::ok(data)
                        } else {
                            Outcome::from(fetch::parse_error(&data, status.as_u16()))
                        }
                    }
                }
            })
        })
    }

    /// Returns the command an MCP tool sees for the gateway, which has no handler of its own.
    pub(crate) fn as_command(&self) -> Command {
        let mut command = Command::new().run(|_: command::Context| {
            Err::<Value, _>(Error::unknown("command.run is not a function"))
        });
        command.description.clone_from(&self.description);
        command
    }
}

/// Config-file option defaults.
#[derive(Clone, Default)]
pub struct Config {
    /// Global flag that names a config file, such as `config` for `--config <path>`.
    pub flag: Option<String>,
    /// Ordered search paths. The first existing file wins. Defaults to `<cli>.json`.
    pub files: Vec<String>,
    /// Custom loader, called with the resolved path or `None`.
    #[expect(clippy::type_complexity, reason = "The loader is a plain callback.")]
    pub loader: Option<Arc<dyn Fn(Option<&Path>) -> Result<Option<Value>, Error> + Send + Sync>>,
}

/// Who sees the banner.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum BannerMode {
    /// Agents only.
    Agent,
    /// Everyone.
    #[default]
    All,
    /// Terminals only.
    Human,
}

/// Process I/O for [`Cli::run`] and [`Cli::serve_with`].
///
/// Every part is thread-safe, so the future [`Cli::run`] returns is [`Send`].
pub struct Io<'a> {
    /// Environment lookup.
    pub env: &'a (dyn Fn(&str) -> Option<String> + Sync),
    /// Standard error.
    pub stderr: &'a mut (dyn Write + Send),
    /// Standard input lines, without line endings. `--mcp` reads JSON-RPC messages from it.
    /// Pass `&mut futures::stream::empty()` when there is no input.
    pub stdin: &'a mut (dyn Stream<Item = String> + Send + Unpin),
    /// Standard output.
    pub stdout: &'a mut (dyn Write + Send),
    /// Whether standard output is a terminal.
    pub tty: bool,
}

/// A CLI: a router of commands, optionally with its own root command.
///
/// Declare one with `#[derive(Parser)]` (see [`Parser`](crate::Parser)), or build one at run
/// time:
///
/// ```no_run
/// use incur::{Cli, Command, Context};
///
/// #[derive(serde::Serialize)]
/// struct Status {
///     clean: bool,
/// }
///
/// Cli::new("my-cli")
///     .description("My CLI")
///     .command(
///         "status",
///         Command::new()
///             .description("Show repo status")
///             .run(|_: Context| Status { clean: true }),
///     )
///     .serve();
/// ```
#[derive(Clone)]
pub struct Cli {
    /// Alternative binary names.
    pub(crate) aliases: Vec<String>,
    /// Banner shown above root help.
    #[expect(clippy::type_complexity, reason = "The banner is a plain callback.")]
    pub(crate) banner: Option<(Arc<dyn Fn() -> Option<String> + Send + Sync>, BannerMode)>,
    /// The HTTP client outgoing requests go through.
    pub(crate) client: Option<fetch::Handler>,
    /// Commands.
    pub(crate) commands: IndexMap<String, Entry>,
    /// Config-file defaults.
    pub(crate) config: Option<Config>,
    /// Description.
    pub(crate) description: Option<String>,
    /// CLI-level environment schema.
    pub(crate) env: Option<Type>,
    /// Default output format.
    pub(crate) format: Option<Format>,
    /// Global options schema.
    pub(crate) globals: Option<Type>,
    /// MCP server settings.
    pub(crate) mcp: Mcp,
    /// Middleware.
    pub(crate) middleware: Vec<Middleware>,
    /// The CLI name.
    pub(crate) name: String,
    /// Default output policy.
    pub(crate) output_policy: Option<OutputPolicy>,
    /// The trusted npm package that provides the CLI.
    pub(crate) package: Option<String>,
    /// MCP prompt templates.
    pub(crate) prompts: Vec<mcp::Prompt>,
    /// MCP resource templates.
    pub(crate) resource_templates: Vec<mcp::ResourceTemplate>,
    /// MCP resources at fixed URIs.
    pub(crate) resources: Vec<mcp::Resource>,
    /// The root command.
    pub(crate) root: Option<Command>,
    /// The root fetch handler, which runs when no command matches.
    pub(crate) root_fetch: Option<Gateway>,
    /// Commands generated from the root fetch handler's OpenAPI document.
    pub(crate) root_generated: Option<Arc<dyn Generate>>,
    /// State shared between invocations: the MCP HTTP session and generated commands.
    pub(crate) state: Arc<State>,
    /// Whether the CLI only parses a derived command, so commands that need a handler, such
    /// as `--mcp`, are hidden.
    pub(crate) parse_only: bool,
    /// Skills integration settings.
    pub(crate) sync: SkillSync,
    /// Update settings.
    pub(crate) update: Update,
    /// Default variables.
    pub(crate) vars: Vars,
    /// Version.
    pub(crate) version: Option<String>,
}

/// State a CLI keeps between invocations.
#[derive(Default)]
pub(crate) struct State {
    /// The stateful MCP HTTP session.
    pub(crate) session: futures_util::lock::Mutex<Option<server::Session>>,
}

impl Cli {
    /// Creates a CLI.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            aliases: Vec::new(),
            banner: None,
            client: None,
            commands: IndexMap::new(),
            config: None,
            description: None,
            env: None,
            format: None,
            globals: None,
            mcp: Mcp::new(),
            middleware: Vec::new(),
            name: name.into(),
            output_policy: None,
            package: None,
            parse_only: false,
            prompts: Vec::new(),
            resource_templates: Vec::new(),
            resources: Vec::new(),
            root: None,
            root_fetch: None,
            root_generated: None,
            state: Arc::default(),
            sync: SkillSync::new(),
            update: Update::new(),
            vars: Vars::default(),
            version: None,
        }
    }

    /// Returns the CLI name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Sets alternative binary names. Completions register every name.
    #[must_use]
    pub fn aliases(mut self, aliases: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.aliases = aliases.into_iter().map(Into::into).collect();
        self
    }

    /// Sets text shown above root help.
    #[must_use]
    pub fn banner<F>(mut self, mode: BannerMode, render: F) -> Self
    where
        F: Fn() -> Option<String> + Send + Sync + 'static,
    {
        self.banner = Some((Arc::new(render), mode));
        self
    }

    /// Registers a command.
    #[must_use]
    pub fn command(mut self, name: impl Into<String>, command: Command) -> Self {
        let name = name.into();
        for alias in &command.aliases {
            self.commands
                .insert(alias.clone(), Entry::Alias(command.clone()));
        }
        self.commands.insert(name, Entry::Command(command));
        self
    }

    /// Enables config-file option defaults.
    #[must_use]
    pub fn config(mut self, config: Config) -> Self {
        self.config = Some(config);
        self
    }

    /// Sets the description.
    #[must_use]
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Sets the CLI-level environment schema, parsed before middleware runs.
    #[must_use]
    pub fn env<T: Schema>(mut self) -> Self {
        self.env = Some(T::schema());
        self
    }

    /// Sets the default output format.
    #[must_use]
    pub fn format(mut self, format: Format) -> Self {
        self.format = Some(format);
        self
    }

    /// Sets global options available to every command.
    ///
    /// # Panics
    ///
    /// Panics when a global option or alias collides with a built-in flag.
    #[must_use]
    pub fn globals<T: Schema>(mut self) -> Self {
        let schema = T::schema();
        let mut builtins = vec![
            "fullOutput",
            "format",
            "json",
            "llms",
            "llmsFull",
            "mcp",
            "help",
            "incurBinaryApply",
            "incurUpdateCheck",
            "version",
            "schema",
            "filterOutput",
            "tokenLimit",
            "tokenOffset",
            "tokenCount",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
        if self.update.enabled {
            builtins.push("update".into());
        }
        // The config flag and its `--no-` form are built-ins too.
        builtins.extend(
            self.config
                .iter()
                .filter_map(|c| c.flag.as_ref())
                .flat_map(|flag| {
                    let mut chars = flag.chars();
                    let capitalized = chars
                        .next()
                        .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
                        .unwrap_or_default();
                    [flag.clone(), format!("no{capitalized}")]
                }),
        );
        for field in schema.fields() {
            assert!(
                !builtins.contains(&field.name),
                "Global option '{}' conflicts with a built-in flag. Choose a different name.",
                field.name
            );
            assert!(
                field.alias != Some('h'),
                "Global alias '-h' for '{}' conflicts with a built-in short flag. Choose a different alias.",
                field.name
            );
        }
        self.globals = Some(schema);
        self
    }

    /// Mounts another CLI as a command group.
    #[must_use]
    pub fn group(mut self, cli: Self) -> Self {
        let name = cli.name.clone();
        let root = cli.root.map(|mut root| {
            if root.description.is_none() {
                root.description.clone_from(&cli.description);
            }
            root
        });
        let entry = match root {
            // A CLI without subcommands mounts as a command, keeping its aliases.
            Some(mut root) if cli.commands.is_empty() => {
                root.aliases = cli.aliases;
                Entry::Command(root)
            }
            root => Entry::Group(Group {
                commands: cli.commands,
                description: cli.description,
                generated: None,
                mcp: cli.mcp.enabled,
                middleware: cli.middleware,
                output_policy: cli.output_policy,
                root,
            }),
        };
        if let Entry::Command(command) = &entry {
            for alias in &command.aliases {
                self.commands
                    .insert(alias.clone(), Entry::Alias(command.clone()));
            }
        }
        self.commands.insert(name, entry);
        self
    }

    /// Adds middleware, which runs around every command in registration order.
    ///
    /// Middleware receives the context and the rest of the chain, and returns a future. It may
    /// set variables before passing the context on with [`Next::run`], return an error instead
    /// of running the command, or run code after the command finishes. Returning `next.run(c)`
    /// directly makes plain middleware that needs no `async` block.
    ///
    /// ```
    /// use incur::{Cli, Error};
    ///
    /// struct User(String);
    ///
    /// let cli = Cli::new("tool")
    ///     .middleware(|mut c, next| {
    ///         c.set(User("alice".into()));
    ///         next.run(c)
    ///     })
    ///     .middleware(|c, next| async move {
    ///         if c.var::<User>().is_none() {
    ///             return Err(Error::new("UNAUTHENTICATED", "Log in first"));
    ///         }
    ///         next.run(c).await
    ///     });
    /// ```
    #[must_use]
    pub fn middleware<F, R>(mut self, f: F) -> Self
    where
        F: Fn(MiddlewareContext, Next) -> R + Send + Sync + 'static,
        R: Future<Output = Result<(), Error>> + Send + 'static,
    {
        self.middleware.push(command::middleware(f));
        self
    }

    /// Registers an MCP prompt template clients can list, render, and complete arguments for.
    #[must_use]
    pub fn prompt(mut self, prompt: mcp::Prompt) -> Self {
        self.prompts.push(prompt);
        self
    }

    /// Registers an MCP resource clients can list and read at a fixed URI.
    #[must_use]
    pub fn resource(mut self, resource: mcp::Resource) -> Self {
        self.resources.push(resource);
        self
    }

    /// Registers an MCP resource template, such as `docs://{section}/{page}`, whose matching
    /// URIs clients can read.
    #[must_use]
    pub fn resource_template(mut self, template: mcp::ResourceTemplate) -> Self {
        self.resource_templates.push(template);
        self
    }

    /// Sets the default output policy, inherited by every command.
    #[must_use]
    pub fn output_policy(mut self, policy: OutputPolicy) -> Self {
        self.output_policy = Some(policy);
        self
    }

    /// Sets the root command, which runs when no subcommand matches.
    #[must_use]
    pub fn root(mut self, command: Command) -> Self {
        self.root = Some(command);
        self
    }

    /// Configures the built-in skills integration: `skills add`, `skills list`, and staleness
    /// notices. `false` disables it.
    #[must_use]
    pub fn sync(mut self, sync: impl Into<SkillSync>) -> Self {
        self.sync = sync.into();
        self
    }

    /// Configures update checks and the `--update` flag. `false` disables both.
    #[must_use]
    pub fn update(mut self, update: impl Into<Update>) -> Self {
        self.update = update.into();
        self
    }

    /// Configures the MCP server behind `--mcp`, MCP over HTTP, and `mcp add`. On a mounted CLI,
    /// `false` hides the group from MCP clients.
    #[must_use]
    pub fn mcp(mut self, mcp: impl Into<Mcp>) -> Self {
        self.mcp = mcp.into();
        self
    }

    /// Sets the trusted npm package that provides the CLI, used in generated commands such as
    /// `npx <package> --mcp`.
    #[must_use]
    pub fn package(mut self, package: impl Into<String>) -> Self {
        self.package = Some(package.into());
        self
    }

    /// Sets the HTTP client every outgoing request goes through: hosted fetch sources, OpenAPI
    /// documents and MCP servers fetched by URL, and npm registry update checks.
    ///
    /// Defaults to a real client with the `client` cargo feature, and otherwise to one that
    /// fails every request.
    #[must_use]
    pub fn client<F, R>(mut self, f: F) -> Self
    where
        F: Fn(http::Request<Body>) -> R + Send + Sync + 'static,
        R: Future<Output = Result<http::Response<Body>, Error>> + Send + 'static,
    {
        self.client = Some(fetch::handler(f));
        self
    }

    /// Mounts a fetch command: curl-style arguments become a request to the source.
    ///
    /// ```
    /// use incur::{Body, Cli, Fetch, FetchCommand};
    ///
    /// let cli = Cli::new("tool").fetch_command(
    ///     "api",
    ///     FetchCommand::new(Fetch::url("https://api.example.com")).description("The API"),
    /// );
    /// ```
    #[must_use]
    pub fn fetch_command(mut self, name: impl Into<String>, command: FetchCommand) -> Self {
        let entry = command.into_entry();
        self.commands.insert(name.into(), entry);
        self
    }

    /// Sets a root fetch handler that receives the arguments when no command matches, and
    /// optionally an OpenAPI document whose operations become commands.
    #[must_use]
    pub fn root_fetch(mut self, command: FetchCommand) -> Self {
        let FetchCommand {
            base_path,
            fetch,
            openapi,
            config,
            ..
        } = command;
        if let Some(spec) = openapi {
            self.root_generated = Some(Arc::new(openapi::Generator::new(
                spec,
                config,
                fetch.clone(),
                base_path.clone(),
            )));
        }
        self.root_fetch = Some(Gateway {
            base_path,
            description: None,
            fetch,
            output_policy: None,
        });
        self
    }

    /// Sets a default variable that middleware may replace.
    #[must_use]
    pub fn var<T: std::any::Any + Send + Sync>(mut self, value: T) -> Self {
        self.vars.set(value);
        self
    }

    /// Sets the version.
    #[must_use]
    pub fn version(mut self, version: impl Into<String>) -> Self {
        self.version = Some(version.into());
        self
    }

    /// Mounts a remote MCP server as a command group: each tool becomes a command. The server
    /// is contacted only when an invocation reaches the group.
    ///
    /// ```
    /// use incur::{Cli, McpSource};
    ///
    /// let cli = Cli::new("tool").mcp_source(
    ///     "docs",
    ///     McpSource::new("https://mcp.example.com/mcp").description("Documentation search"),
    /// );
    /// ```
    #[must_use]
    pub fn mcp_source(mut self, name: impl Into<String>, source: McpSource) -> Self {
        self.commands.insert(name.into(), source.into_entry());
        self
    }

    /// Returns the HTTP client outgoing requests go through.
    pub(crate) fn http_client(&self) -> fetch::Handler {
        self.client.clone().unwrap_or_else(fetch::default_client)
    }

    /// Returns the command tree with generated groups loaded: every non-lazy group, and the lazy
    /// top-level groups `scope` names. Groups inside mounted CLIs always load.
    pub(crate) async fn tree(&self, scope: &Scope) -> Result<IndexMap<String, Entry>, Error> {
        let client = self.http_client();
        let mut tree = expand(&self.commands, &client, Some(scope)).await?;
        if let Some(generator) = &self.root_generated {
            tree.extend(generator.generate(&client).await?);
        }
        Ok(tree)
    }

    /// Runs the CLI with the process arguments, environment, and standard streams, then exits
    /// with the command's exit code.
    ///
    /// With the default `tokio` feature, blocks on a current-thread tokio runtime with every
    /// driver the dependency graph enables, so handlers may await tokio timers and IO. Inside a
    /// running async runtime, await [`Cli::serve_async`] instead: tokio refuses to start a
    /// runtime within another. Without the feature, a minimal executor parks the thread between
    /// polls, which suits synchronous handlers and runtime-agnostic futures.
    pub fn serve(&self) {
        // The runtime fails to start only when the operating system refuses its drivers.
        let code = block_on(self.serve_process());
        exit(code.unwrap_or_else(|error| fail(&mut std::io::stderr(), &error.into())));
    }

    /// Runs the CLI with the process arguments, environment, and standard streams on the
    /// caller's async runtime, then exits with the command's exit code.
    pub async fn serve_async(&self) {
        exit(self.serve_process().await);
    }

    /// Runs the CLI with explicit arguments and I/O, blocking like [`Cli::serve`]. Returns the
    /// exit code.
    pub fn serve_with(&self, argv: &[String], io: &mut Io<'_>) -> i32 {
        block_on(self.run(argv, io)).unwrap_or_else(|error| fail(io.stderr, &error.into()))
    }

    /// Runs the CLI with explicit arguments and I/O on the caller's async runtime. Returns the
    /// exit code.
    ///
    /// The future is [`Send`], so it may run on any executor, including multi-threaded ones.
    pub async fn run(&self, argv: &[String], io: &mut Io<'_>) -> i32 {
        self.serve_impl(argv, io).await
    }

    /// Serves the process arguments with process I/O. Returns the exit code.
    async fn serve_process(&self) -> i32 {
        let mut process = Process::new();
        let argv = std::mem::take(&mut process.argv);
        self.serve_impl(&argv, &mut process.io()).await
    }

    /// Whether a built-in command is available: `skills` needs the skills integration, and
    /// `mcp` a handler.
    fn builtin_enabled(&self, builtin: &str) -> bool {
        match builtin {
            "skills" => self.sync.enabled,
            "mcp" => !self.parse_only,
            _ => true,
        }
    }

    /// Returns the root command with the CLI description as its fallback.
    pub(crate) fn root_command(&self) -> Option<Command> {
        self.root.clone().map(|mut root| {
            if root.description.is_none() {
                root.description.clone_from(&self.description);
            }
            root
        })
    }

    /// The shared serve implementation. The display name is the executing program's file name
    /// when it matches the CLI name or an alias.
    async fn serve_impl(&self, argv: &[String], io: &mut Io<'_>) -> i32 {
        let bin = update::program().and_then(|bin| bin.file_name()?.to_str().map(str::to_owned));
        let display_name = match bin.as_deref() {
            Some(bin) if bin == self.name || self.aliases.iter().any(|a| a == bin) => {
                bin.to_owned()
            }
            _ => self.name.clone(),
        };
        let root = self.root_command();
        let mut run = Run {
            cli: self,
            commands: Arc::new(self.commands.clone()),
            display_name,
            exit: 0,
            io,
            notice: None,
            root: root.as_ref(),
            shadowed: Vec::new(),
            start: Instant::now(),
        };
        run.serve(argv).await;
        run.exit
    }
}

/// Loads the generated groups of a command tree. `scope` limits lazy groups at the top level;
/// nested groups always load.
fn expand<'a>(
    commands: &'a IndexMap<String, Entry>,
    client: &'a fetch::Handler,
    scope: Option<&'a Scope>,
) -> futures_util::future::BoxFuture<'a, Result<IndexMap<String, Entry>, Error>> {
    Box::pin(async move {
        let mut out = IndexMap::new();
        for (name, entry) in commands {
            let entry = match entry {
                Entry::Group(group) => {
                    let mut group = group.clone();
                    if let Some(generator) = &group.generated {
                        let load = !generator.lazy()
                            || match scope {
                                None | Some(Scope::All) => true,
                                Some(Scope::None) => false,
                                Some(Scope::Only(only)) => only == name,
                            };
                        if load {
                            group.commands = generator.generate(client).await?;
                        }
                    }
                    group.commands = expand(&group.commands, client, None).await?;
                    Entry::Group(group)
                }
                entry => entry.clone(),
            };
            out.insert(name.clone(), entry);
        }
        Ok(out)
    })
}

/// The process arguments and standard streams.
pub(crate) struct Process {
    /// The arguments after the program name.
    pub(crate) argv: Vec<String>,
    /// Standard error.
    stderr: std::io::Stderr,
    /// Standard input lines.
    stdin: ProcessLines,
    /// Standard output.
    stdout: std::io::Stdout,
}

impl Process {
    /// Captures the process arguments and streams.
    pub(crate) fn new() -> Self {
        Self {
            argv: std::env::args().skip(1).collect(),
            stderr: std::io::stderr(),
            stdin: ProcessLines::default(),
            stdout: std::io::stdout(),
        }
    }

    /// Returns process I/O: the environment, the streams, and whether stdout is a terminal.
    pub(crate) fn io(&mut self) -> Io<'_> {
        Io {
            env: &|key| std::env::var(key).ok(),
            tty: std::io::IsTerminal::is_terminal(&self.stdout),
            stderr: &mut self.stderr,
            stdin: &mut self.stdin,
            stdout: &mut self.stdout,
        }
    }
}

/// Process standard input as lines, read on a thread started at the first poll so commands that
/// never read input leave it untouched.
#[derive(Default)]
struct ProcessLines(Option<mpsc::UnboundedReceiver<String>>);

impl Stream for ProcessLines {
    type Item = String;

    fn poll_next(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<String>> {
        let receiver = self.0.get_or_insert_with(|| {
            let (tx, rx) = mpsc::unbounded();
            std::thread::spawn(move || {
                // Reading stops at a read error or once the receiver is gone.
                let _ = std::io::stdin()
                    .lines()
                    .map_while(Result::ok)
                    .try_for_each(|line| tx.unbounded_send(line));
            });
            rx
        });
        Pin::new(receiver).poll_next(cx)
    }
}

/// Drives a future to completion on a current-thread tokio runtime with every enabled driver.
#[cfg(feature = "tokio")]
fn block_on<F: Future>(future: F) -> std::io::Result<F::Output> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    Ok(runtime.block_on(future))
}

/// Drives a future to completion on the current thread, parking it until the future's waker
/// fires. Synchronous handlers complete on the first poll.
#[cfg(not(feature = "tokio"))]
fn block_on<F: Future>(future: F) -> std::io::Result<F::Output> {
    /// Wakes the blocked thread.
    struct Unpark(std::thread::Thread);

    impl std::task::Wake for Unpark {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }

    let mut future = std::pin::pin!(future);
    let waker = std::task::Waker::from(Arc::new(Unpark(std::thread::current())));
    let mut cx = std::task::Context::from_waker(&waker);
    loop {
        if let Poll::Ready(output) = future.as_mut().poll(&mut cx) {
            return Ok(output);
        }
        std::thread::park();
    }
}

/// Exits the process with a non-zero exit code.
fn exit(code: i32) {
    if code != 0 {
        std::process::exit(code);
    }
}

/// Writes a line, adding a newline unless the text ends with one.
fn write_line(out: &mut dyn Write, text: &str) {
    let _ = if text.ends_with('\n') {
        out.write_all(text.as_bytes())
    } else {
        writeln!(out, "{text}")
    };
}

/// Writes an error for a terminal and returns exit code 1.
fn fail(out: &mut dyn Write, error: &Error) -> i32 {
    write_line(out, &human_error(error));
    1
}

/// The resolved target of an invocation.
pub(crate) enum Resolved<'a> {
    /// A command to run.
    Command {
        /// The command.
        command: &'a Command,
        /// Subcommands, when the command is a group root.
        commands: Option<&'a IndexMap<String, Entry>>,
        /// Group middleware collected on the way.
        middleware: Vec<Middleware>,
        /// Inherited output policy.
        output_policy: Option<OutputPolicy>,
        /// The command path.
        path: String,
        /// Remaining tokens.
        rest: Vec<String>,
    },
    /// A fetch command.
    Fetch {
        /// The gateway.
        gateway: &'a Gateway,
        /// Group middleware collected on the way.
        middleware: Vec<Middleware>,
        /// Inherited output policy.
        output_policy: Option<OutputPolicy>,
        /// The command path.
        path: String,
        /// Remaining tokens, forwarded as the request.
        rest: Vec<String>,
    },
    /// An unknown command.
    Error {
        /// Siblings of the unknown token.
        commands: &'a IndexMap<String, Entry>,
        /// The unknown token.
        error: String,
        /// The parent path.
        path: String,
        /// Tokens after the unknown token.
        rest: Vec<String>,
    },
    /// A group without a root command.
    Help {
        /// Subcommands.
        commands: &'a IndexMap<String, Entry>,
        /// Description.
        description: Option<&'a str>,
        /// The group path.
        path: String,
    },
}

/// Walks tokens down the command tree.
pub(crate) fn resolve<'a>(
    commands: &'a IndexMap<String, Entry>,
    tokens: &[String],
) -> Resolved<'a> {
    let Some((first, rest, mut entry)) = tokens
        .split_first()
        .and_then(|(first, rest)| Some((first, rest, commands.get(first)?)))
    else {
        return Resolved::Error {
            commands,
            error: tokens.first().cloned().unwrap_or_else(|| "(none)".into()),
            path: String::new(),
            rest: tokens.get(1..).unwrap_or_default().to_vec(),
        };
    };
    let mut path = vec![first.clone()];
    let mut remaining = rest.to_vec();
    let mut inherited = None;
    let mut middleware = Vec::new();
    let command = loop {
        let group = match entry {
            Entry::Command(command) | Entry::Alias(command) => break command,
            Entry::Fetch(gateway) => {
                return Resolved::Fetch {
                    gateway,
                    middleware,
                    output_policy: gateway.output_policy.or(inherited),
                    path: path.join(" "),
                    rest: remaining,
                };
            }
            Entry::Group(group) => group,
        };
        if group.output_policy.is_some() {
            inherited = group.output_policy;
        }
        middleware.extend(group.middleware.iter().cloned());
        let root_target = |remaining: Vec<String>, middleware: Vec<Middleware>| {
            group.root.as_ref().map(|root| Resolved::Command {
                command: root,
                commands: Some(&group.commands),
                middleware,
                output_policy: root.output_policy.or(inherited),
                path: path.join(" "),
                rest: remaining,
            })
        };
        let Some(next) = remaining.first().cloned() else {
            if let Some(resolved) = root_target(remaining.clone(), middleware.clone()) {
                return resolved;
            }
            return Resolved::Help {
                commands: &group.commands,
                description: group.description.as_deref(),
                path: path.join(" "),
            };
        };
        let Some(child) = group.commands.get(&next) else {
            if suggest(&next, group.commands.keys().map(String::as_str)).is_none()
                && let Some(resolved) = root_target(remaining.clone(), middleware.clone())
            {
                return resolved;
            }
            return Resolved::Error {
                commands: &group.commands,
                error: next,
                path: path.join(" "),
                rest: remaining[1..].to_vec(),
            };
        };
        entry = child;
        path.push(next);
        remaining.remove(0);
    };
    Resolved::Command {
        command,
        commands: None,
        middleware,
        output_policy: command.output_policy.or(inherited),
        path: path.join(" "),
        rest: remaining,
    }
}

/// Suggests the closest candidate by prefix, substring, then edit distance.
pub(crate) fn suggest<'a>(
    input: &str,
    candidates: impl IntoIterator<Item = &'a str>,
) -> Option<&'a str> {
    let threshold = if js::utf16_len(input) <= 4 {
        2
    } else {
        js::utf16_len(input) / 2
    };
    let lower = input.to_lowercase();
    let mut best = None;
    let mut best_score = usize::MAX;
    for candidate in candidates {
        let lc = candidate.to_lowercase();
        let distance = levenshtein(&lower, &lc);
        let score = if lc.starts_with(&lower) && lc != lower {
            distance
        } else if lc.contains(&lower) {
            100 + distance
        } else if distance <= threshold {
            200 + distance
        } else {
            continue;
        };
        if score < best_score {
            best_score = score;
            best = Some(candidate);
        }
    }
    best
}

/// Computes the Levenshtein distance over UTF-16 code units.
fn levenshtein(a: &str, b: &str) -> usize {
    let a = a.encode_utf16().collect::<Vec<_>>();
    let b = b.encode_utf16().collect::<Vec<_>>();
    let mut dp = (0..=b.len()).collect::<Vec<_>>();
    for i in 1..=a.len() {
        let mut prev = dp[0];
        dp[0] = i;
        for j in 1..=b.len() {
            let tmp = dp[j];
            dp[j] = if a[i - 1] == b[j - 1] {
                prev
            } else {
                1 + prev.min(dp[j]).min(dp[j - 1])
            };
            prev = tmp;
        }
    }
    dp[b.len()]
}

/// Built-in flags extracted from argv.
#[derive(Default)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "Each field is one built-in flag."
)]
struct Flags {
    /// `--no-<config>`.
    config_disabled: bool,
    /// `--<config> <path>`.
    config_path: Option<String>,
    /// Parsed `--filter-output` paths.
    filter_output: Option<Vec<Vec<filter::Segment>>>,
    /// `--format` or `--json`.
    format: Format,
    /// Whether the format was explicit.
    format_explicit: bool,
    /// `--full-output`.
    full_output: bool,
    /// `--help`.
    help: bool,
    /// `--llms`.
    llms: bool,
    /// `--llms-full`.
    llms_full: bool,
    /// `--mcp`.
    mcp: bool,
    /// Remaining tokens.
    rest: Vec<String>,
    /// `--schema`.
    schema: bool,
    /// `--token-count`.
    token_count: bool,
    /// `--token-limit`.
    token_limit: Option<f64>,
    /// `--token-offset`.
    token_offset: Option<f64>,
    /// `--update`.
    update: bool,
    /// The hidden flag of a detached update check.
    update_check: bool,
    /// `--version`.
    version: bool,
}

/// Extracts built-in flags from argv.
fn extract_flags(
    argv: &[String],
    config_flag: Option<&str>,
    update: bool,
    mcp: bool,
) -> Result<Flags, Error> {
    let mut flags = Flags::default();
    let config = config_flag.map(|flag| {
        (
            format!("--{flag}"),
            format!("--{flag}="),
            format!("--no-{flag}"),
        )
    });
    let mut i = 0;
    while i < argv.len() {
        let token = argv[i].as_str();
        let next = argv.get(i + 1).filter(|next| !next.is_empty());
        match token {
            "--full-output" => flags.full_output = true,
            "--llms" => flags.llms = true,
            "--llms-full" => flags.llms_full = true,
            "--mcp" if mcp => flags.mcp = true,
            "--help" | "-h" => flags.help = true,
            "--update" if update => flags.update = true,
            update::CHECK_FLAG => flags.update_check = true,
            // A following value belongs to a command-local `--version` option.
            "--version" if next.is_none_or(|next| next.starts_with('-')) => flags.version = true,
            "--schema" => flags.schema = true,
            "--json" => {
                flags.format = Format::Json;
                flags.format_explicit = true;
            }
            "--format" if next.is_some() => {
                let value = next.map_or("", String::as_str);
                flags.format = value.parse().map_err(|()| {
                    Error::new(
                        "UNKNOWN",
                        format!(
                            "Invalid format: \"{value}\". Expected one of: toon, json, yaml, md, jsonl"
                        ),
                    )
                })?;
                flags.format_explicit = true;
                i += 1;
            }
            "--filter-output" if next.is_some() => {
                flags.filter_output = Some(filter::parse(next.map_or("", String::as_str))?);
                i += 1;
            }
            "--token-limit" | "--token-offset" if next.is_some() => {
                let raw = next.map_or("", String::as_str);
                let value = js::to_number(raw);
                if !value.is_finite()
                    || value < 0.0
                    || raw.trim_matches(js::is_whitespace).is_empty()
                {
                    return Err(Error::new(
                        "UNKNOWN",
                        format!("Invalid value for {token}: \"{raw}\""),
                    ));
                }
                if token == "--token-limit" {
                    flags.token_limit = Some(value);
                } else {
                    flags.token_offset = Some(value);
                }
                i += 1;
            }
            "--token-count" => flags.token_count = true,
            _ => match &config {
                Some((flag, _, _)) if token == flag => {
                    let value = argv.get(i + 1).ok_or_else(|| {
                        Error::new("UNKNOWN", format!("Missing value for flag: {flag}"))
                    })?;
                    flags.config_path = Some(value.clone());
                    flags.config_disabled = false;
                    i += 1;
                }
                Some((flag, eq, _)) if token.starts_with(eq.as_str()) => {
                    let value = &token[eq.len()..];
                    if value.is_empty() {
                        return Err(Error::new(
                            "UNKNOWN",
                            format!("Missing value for flag: {flag}"),
                        ));
                    }
                    flags.config_path = Some(value.to_owned());
                    flags.config_disabled = false;
                }
                Some((_, _, no)) if token == no => {
                    flags.config_path = None;
                    flags.config_disabled = true;
                }
                _ => flags.rest.push(token.to_owned()),
            },
        }
        i += 1;
    }
    Ok(flags)
}

/// Lists immediate children for help output, sorted by name.
fn help_entries(commands: &IndexMap<String, Entry>) -> Vec<HelpEntry> {
    let mut out = commands
        .iter()
        .filter_map(|(name, entry)| {
            let description = match entry {
                Entry::Alias(_) => return None,
                Entry::Command(command) => command.description.clone(),
                Entry::Fetch(gateway) => gateway.description.clone(),
                Entry::Group(group) => group.description.clone(),
            };
            Some(HelpEntry {
                description,
                name: name.clone(),
            })
        })
        .collect::<Vec<_>>();
    out.sort_by(|a, b| js::locale_compare(&a.name, &b.name));
    out
}

/// Returns the command hint, with the destructive notice when the command is destructive or its
/// MCP annotations say so.
fn hint_with_destructive(command: &Command) -> Option<String> {
    let annotated = command.mcp.as_ref().is_some_and(|tool| {
        tool.enabled
            && tool
                .annotations
                .as_ref()
                .and_then(|a| a.get("destructiveHint"))
                == Some(&Value::Bool(true))
    });
    if !command.destructive && !annotated {
        return command.hint.clone();
    }
    Some(match command.hint.as_deref().filter(|h| !h.is_empty()) {
        None => DESTRUCTIVE_HINT.to_owned(),
        Some(hint) if hint.contains(DESTRUCTIVE_HINT) => hint.to_owned(),
        Some(hint) => format!("{hint} {DESTRUCTIVE_HINT}"),
    })
}

/// Prefixes examples with a command path.
fn prefixed_examples(examples: &[Example], name: &str) -> Vec<Example> {
    examples
        .iter()
        .map(|example| Example {
            command: if example.command.is_empty() {
                name.to_owned()
            } else {
                format!("{name} {}", example.command)
            },
            description: example.description.clone(),
        })
        .collect()
}

/// Builds a manifest entry for a command.
fn command_info(name: Option<String>, command: &Command) -> CommandInfo {
    let examples = match &name {
        Some(name) => prefixed_examples(&command.examples, name),
        None => command.examples.clone(),
    };
    CommandInfo {
        args: command.args.clone(),
        description: command.description.clone(),
        env: command.env.clone(),
        examples,
        hint: hint_with_destructive(command),
        name,
        options: command.options.clone(),
        output: command.output.clone(),
    }
}

/// Collects commands for Markdown manifests, sorted by name.
pub(crate) fn skill_commands(
    commands: &IndexMap<String, Entry>,
    prefix: &[String],
    groups: &mut IndexMap<String, String>,
    root: Option<&Command>,
) -> Vec<CommandInfo> {
    let mut out = Vec::new();
    if let Some(root) = root {
        out.push(command_info(None, root));
    }
    for (name, entry) in commands {
        let mut path = prefix.to_vec();
        path.push(name.clone());
        let joined = path.join(" ");
        match entry {
            Entry::Alias(_) => {}
            Entry::Command(command) => out.push(command_info(Some(joined), command)),
            Entry::Fetch(gateway) => out.push(CommandInfo {
                args: None,
                description: gateway.description.clone(),
                env: None,
                examples: Vec::new(),
                hint: Some(
                    "Fetch gateway. Pass path segments and curl-style flags (-X, -H, -d, --key value)."
                        .into(),
                ),
                name: Some(joined),
                options: None,
                output: None,
            }),
            Entry::Group(group) => {
                if let Some(description) = &group.description {
                    groups.insert(joined.clone(), description.clone());
                }
                if let Some(root) = &group.root {
                    out.push(command_info(Some(joined), root));
                }
                out.extend(skill_commands(&group.commands, &path, groups, None));
            }
        }
    }
    out.sort_by(|a, b| {
        js::locale_compare(
            a.name.as_deref().unwrap_or(""),
            b.name.as_deref().unwrap_or(""),
        )
    });
    out
}

/// Builds a JSON manifest entry for a command.
fn manifest_entry(path: &str, command: &Command, full: bool) -> Value {
    let mut out = Map::new();
    out.insert("name".into(), path.into());
    if let Some(description) = command.description.as_ref().filter(|d| !d.is_empty()) {
        out.insert("description".into(), description.clone().into());
    }
    if !full {
        return Value::Object(out);
    }
    let mut schema = Map::new();
    for (key, ty) in [
        ("args", &command.args),
        ("env", &command.env),
        ("options", &command.options),
        ("output", &command.output),
    ] {
        if let Some(ty) = ty {
            schema.insert(key.into(), schema::json_schema(ty));
        }
    }
    if !schema.is_empty() {
        out.insert("schema".into(), Value::Object(schema));
    }
    if !command.examples.is_empty() {
        let examples = prefixed_examples(&command.examples, path)
            .into_iter()
            .map(|example| {
                let mut entry = Map::new();
                entry.insert("command".into(), example.command.into());
                if let Some(description) = example.description {
                    entry.insert("description".into(), description.into());
                }
                Value::Object(entry)
            })
            .collect();
        out.insert("examples".into(), examples);
    }
    Value::Object(out)
}

/// Collects JSON manifest entries.
fn manifest_commands(
    commands: &IndexMap<String, Entry>,
    prefix: &[String],
    full: bool,
) -> Vec<Value> {
    let mut out = Vec::new();
    for (name, entry) in commands {
        let mut path = prefix.to_vec();
        path.push(name.clone());
        let joined = path.join(" ");
        match entry {
            Entry::Alias(_) => {}
            Entry::Command(command) => out.push(manifest_entry(&joined, command, full)),
            Entry::Fetch(gateway) => {
                let mut entry = Map::new();
                entry.insert("name".into(), joined.into());
                if let Some(description) = gateway.description.as_ref().filter(|d| !d.is_empty()) {
                    entry.insert("description".into(), description.clone().into());
                }
                out.push(Value::Object(entry));
            }
            Entry::Group(group) => {
                if let Some(root) = &group.root {
                    out.push(manifest_entry(&joined, root, full));
                }
                out.extend(manifest_commands(&group.commands, &path, full));
            }
        }
    }
    out
}

/// Formats examples for help output.
fn help_examples(command: &Command) -> Option<&[Example]> {
    (!command.examples.is_empty()).then_some(command.examples.as_slice())
}

/// Built-in subcommand descriptions: built-in name, subcommand name, description, aliases.
const BUILTIN_SUBCOMMANDS: [(&str, &str, &str, &[&str]); 4] = [
    ("mcp", "add", "Register as MCP server", &[]),
    (
        "mcp",
        "doctor",
        "Validate MCP server startup and tool listing",
        &[],
    ),
    ("skills", "add", "Sync skill files to agents", &[]),
    ("skills", "list", "List skills", &["ls"]),
];

/// Built-in command descriptions.
const BUILTINS: [(&str, &str); 3] = [
    ("completions", "Generate shell completion script"),
    ("mcp", "Register as MCP server"),
    ("skills", "Sync skill files to agents"),
];

/// Resolves a token to a built-in command name.
fn find_builtin(token: &str) -> Option<&'static str> {
    match token {
        "completions" => Some("completions"),
        "mcp" => Some("mcp"),
        "skills" | "skill" => Some("skills"),
        _ => None,
    }
}

/// Resolves a token to a built-in command name, unless a registered command or alias of the same
/// name shadows it.
fn find_unshadowed_builtin(
    commands: &IndexMap<String, Entry>,
    token: &str,
) -> Option<&'static str> {
    if commands.contains_key(token) {
        None
    } else {
        find_builtin(token)
    }
}

/// The per-invocation serve state.
struct Run<'a, 'b> {
    /// The CLI.
    cli: &'a Cli,
    /// The command tree, with generated commands this invocation reaches.
    commands: Arc<IndexMap<String, Entry>>,
    /// The invoked binary name.
    display_name: String,
    /// The exit code.
    exit: i32,
    /// Process I/O.
    io: &'a mut Io<'b>,
    /// Skills and update notices appended to suggestions.
    notice: Option<FormattedCtaBlock>,
    /// The root command.
    root: Option<&'a Command>,
    /// Built-ins a registered command or alias shadows, which root help leaves out.
    shadowed: Vec<&'static str>,
    /// When the invocation started.
    start: Instant,
}

/// Output settings resolved for a command.
struct Output<'f> {
    /// The built-in flags.
    flags: &'f Flags,
    /// The effective format.
    format: Format,
    /// Whether output targets a terminal.
    human: bool,
    /// Parsed `--filter-output` paths.
    filter: Option<Vec<Vec<filter::Segment>>>,
    /// Whether data renders for this consumer.
    render: bool,
}

impl Run<'_, '_> {
    /// Writes to stdout.
    fn write(&mut self, text: &str) {
        let _ = self.io.stdout.write_all(text.as_bytes());
    }

    /// Writes a line to stdout.
    fn writeln(&mut self, text: &str) {
        write_line(self.io.stdout, text);
    }

    /// Reads an environment variable.
    fn env(&self, key: &str) -> Option<String> {
        (self.io.env)(key)
    }

    /// Returns the elapsed time as `Nms`.
    fn duration(&self) -> String {
        format!("{}ms", self.start.elapsed().as_millis())
    }

    /// Base help options shared by most help output.
    fn help_options(&self) -> help::Options<'_> {
        help::Options {
            config_flag: self.config_flag(),
            globals: self.cli.globals.as_ref(),
            hide_builtins: &self.shadowed,
            hide_mcp: self.cli.parse_only,
            hide_skills: !self.cli.sync.enabled,
            hide_update: !self.cli.update.enabled,
            ..help::Options::default()
        }
    }

    /// Returns the config flag name.
    fn config_flag(&self) -> Option<&str> {
        self.cli.config.as_ref().and_then(|c| c.flag.as_deref())
    }

    /// Reports an error before a command resolves.
    fn early_error(&mut self, error: &Error, human: bool, format: Format) {
        self.exit = if human {
            fail(self.io.stdout, error)
        } else {
            self.writeln(&formatter::format(&error.to_value(), format));
            1
        };
    }

    /// Writes the banner when its mode matches.
    fn banner(&mut self, human: bool, help: bool) {
        let Some((render, mode)) = &self.cli.banner.as_ref().filter(|_| !help) else {
            return;
        };
        let matches = match mode {
            BannerMode::All => true,
            BannerMode::Human => human,
            BannerMode::Agent => !human,
        };
        if matches && let Some(text) = render().filter(|t| !t.is_empty()) {
            self.writeln(&text);
        }
    }

    /// Serves one invocation.
    async fn serve(&mut self, argv: &[String]) {
        let cli = self.cli;
        if let Some(shell) = self.env("COMPLETE") {
            if let Ok(tree) = cli.tree(&Scope::None).await {
                self.commands = Arc::new(tree);
            }
            self.complete(&shell, argv);
            return;
        }
        let tty = self.io.tty;
        let flags = match extract_flags(
            argv,
            self.config_flag(),
            cli.update.enabled,
            !cli.parse_only,
        ) {
            Ok(flags) => flags,
            Err(error) => {
                self.early_error(&error, tty, Format::Toon);
                return;
            }
        };
        let human = tty && !flags.format_explicit;

        let filtered = match &cli.globals {
            None => flags.rest.clone(),
            Some(schema) => match parser::parse_globals(
                &flags.rest,
                schema,
                GlobalsOptions {
                    command: Some(None),
                    validate: false,
                },
            ) {
                Ok((_, rest)) => rest,
                Err(error) => {
                    self.early_error(&error, human, flags.format);
                    return;
                }
            },
        };

        // Generated commands load only when this invocation can reach them.
        let first = filtered.first();
        let scope = if flags.mcp
            || ((flags.llms || flags.llms_full) && first.is_none())
            || first == Some(&cli.name)
            || first.is_some_and(|t| find_builtin(t).is_some())
        {
            Scope::All
        } else {
            first.map_or(Scope::None, |first| Scope::Only(first.clone()))
        };
        match cli.tree(&scope).await {
            Ok(tree) => {
                self.shadowed = BUILTINS
                    .iter()
                    .map(|(name, _)| *name)
                    .filter(|name| tree.contains_key(*name))
                    .collect();
                self.commands = Arc::new(tree);
            }
            Err(error) => {
                self.early_error(&error, human, flags.format);
                return;
            }
        }

        if flags.update_check {
            if cli.update.enabled {
                let client = cli.http_client();
                let machine = update::Machine {
                    client: &client,
                    env: self.io.env,
                };
                update::refresh(&cli.name, &cli.update, cli.version.as_deref(), &machine).await;
            }
            return;
        }

        // `--help` takes precedence over `--update`.
        if flags.update && !flags.help {
            self.install(&flags, human).await;
            return;
        }

        if flags.mcp {
            self.mcp_stdio(&flags, human).await;
            return;
        }

        let skills_cta = if cli.sync.enabled
            && !flags.llms
            && !flags.llms_full
            && !flags.schema
            && !flags.help
            && !flags.update
            && !flags.update_check
            && !flags.version
        {
            self.skills_notice(&filtered).await
        } else {
            None
        };

        if flags.llms || flags.llms_full {
            self.llms(&flags, &filtered);
            return;
        }

        let commands = self.commands.clone();
        let builtin_index = |builtin: &str| {
            let matches = |token: Option<&String>| {
                token.and_then(|t| find_unshadowed_builtin(&commands, t)) == Some(builtin)
            };
            if matches(filtered.first()) {
                Some(0)
            } else if filtered.first() == Some(&cli.name) && matches(filtered.get(1)) {
                Some(1)
            } else {
                None
            }
        };

        if let Some(index) = builtin_index("completions") {
            let shell = filtered.get(index + 1);
            match shell {
                None => self.completions_help(),
                Some(_) if flags.help => self.completions_help(),
                Some(name) => {
                    if let Ok(shell) = name.parse::<Shell>() {
                        let scripts = std::iter::once(&cli.name)
                            .chain(&cli.aliases)
                            .map(|name| completions::register(shell, name))
                            .collect::<Vec<_>>()
                            .join("\n");
                        self.writeln(&scripts);
                    } else {
                        let error = Error::new(
                            "INVALID_SHELL",
                            format!("Unknown shell '{name}'. Supported: bash, fish, nushell, zsh"),
                        );
                        self.writeln(&human_error(&error));
                        self.exit = 1;
                    }
                }
            }
            return;
        }

        for builtin in ["skills", "mcp"] {
            if !cli.builtin_enabled(builtin) {
                continue;
            }
            if let Some(index) = builtin_index(builtin) {
                self.builtin(builtin, &filtered, index, argv, &flags, human);
                return;
            }
        }

        if flags.version
            && !flags.help
            && let Some(version) = &cli.version
        {
            self.writeln(version);
            return;
        }

        let commands = self.commands.clone();
        if filtered.is_empty() {
            let required_args = self
                .root
                .and_then(|root| root.args.as_ref())
                .is_some_and(|args| args.fields().iter().any(|f| !f.ty.is_optional()));
            if let Some(root) = self.root.filter(|_| human && required_args) {
                self.banner(human, flags.help);
                let entries = help_entries(&commands);
                let text = help::format_command(
                    &cli.name,
                    &self.command_help(
                        root,
                        &cli.aliases,
                        cli.version.as_deref(),
                        Some(&entries),
                        true,
                    ),
                );
                self.writeln(&text);
                return;
            }
            if self.root.is_none() && cli.root_fetch.is_none() {
                self.banner(human, flags.help);
                let entries = help_entries(&commands);
                let text = help::format_root(
                    &cli.name,
                    &help::Options {
                        aliases: &cli.aliases,
                        commands: Some(&entries),
                        description: cli.description.as_deref(),
                        root: true,
                        version: cli.version.as_deref(),
                        ..self.help_options()
                    },
                );
                self.writeln(&text);
                return;
            }
        }

        let root_fetch = cli.root_fetch.as_ref().map(|gateway| Gateway {
            description: cli.description.clone(),
            ..gateway.clone()
        });
        let resolved = match (self.root, &root_fetch) {
            (Some(root), _) if filtered.is_empty() => Resolved::Command {
                command: root,
                commands: None,
                middleware: Vec::new(),
                output_policy: None,
                path: cli.name.clone(),
                rest: Vec::new(),
            },
            (None, Some(gateway)) if filtered.is_empty() => Resolved::Fetch {
                gateway,
                middleware: Vec::new(),
                output_policy: None,
                path: cli.name.clone(),
                rest: Vec::new(),
            },
            _ => resolve(&commands, &filtered),
        };

        if flags.help {
            self.help(&resolved);
            return;
        }

        if flags.schema {
            self.schema(&resolved, &flags);
            return;
        }

        let group_help = matches!(resolved, Resolved::Help { .. });

        let update_cta = if human && cli.update.enabled && !group_help {
            let client = cli.http_client();
            let machine = update::Machine {
                client: &client,
                env: self.io.env,
            };
            update::check(&cli.name, &cli.update, cli.version.as_deref(), &machine).map(
                |available| FormattedCtaBlock {
                    description: format!("Update available for {}:", available.name),
                    commands: vec![FormattedCta {
                        command: format!("{} --update", self.display_name),
                        description: Some(format!(
                            "upgrade from {} to {}",
                            available.current, available.latest
                        )),
                    }],
                },
            )
        } else {
            None
        };
        self.notice = FormattedCtaBlock::merge(skills_cta, update_cta);

        let command_format = match &resolved {
            Resolved::Command { command, .. } => command.format,
            _ => None,
        };
        let format = if flags.format_explicit {
            flags.format
        } else {
            command_format.or(cli.format).unwrap_or_default()
        };

        // A token that is not a typo of a known command falls back to the root fetch handler or
        // command. A token starting with `/` is a request path, never a mistyped command.
        let resolved = match resolved {
            Resolved::Error {
                error,
                path,
                commands,
                rest,
            } if path.is_empty() => {
                let mut candidates = commands.keys().map(String::as_str).collect::<Vec<_>>();
                candidates.extend(
                    BUILTINS
                        .iter()
                        .map(|(name, _)| *name)
                        .filter(|n| cli.builtin_enabled(n)),
                );
                let blocked = !error.starts_with('/') && suggest(&error, candidates).is_some();
                match (&root_fetch, self.root) {
                    (Some(gateway), _) if !blocked => Resolved::Fetch {
                        gateway,
                        middleware: Vec::new(),
                        output_policy: None,
                        path: cli.name.clone(),
                        rest: filtered.clone(),
                    },
                    (None, Some(root)) if !blocked => Resolved::Command {
                        command: root,
                        commands: None,
                        middleware: Vec::new(),
                        output_policy: None,
                        path: cli.name.clone(),
                        rest: filtered.clone(),
                    },
                    _ => Resolved::Error {
                        error,
                        path,
                        commands,
                        rest,
                    },
                }
            }
            resolved => resolved,
        };

        let policy = match &resolved {
            Resolved::Command { output_policy, .. } | Resolved::Fetch { output_policy, .. } => {
                output_policy.or(cli.output_policy)
            }
            _ => cli.output_policy,
        };
        let output = Output {
            flags: &flags,
            format,
            human,
            filter: flags.filter_output.clone(),
            render: !(human && policy == Some(OutputPolicy::AgentOnly)),
        };

        match resolved {
            Resolved::Error {
                error,
                path,
                commands,
                ..
            } => {
                self.not_found(&error, &path, commands, argv, &output);
            }
            Resolved::Command {
                command,
                middleware,
                path,
                rest,
                ..
            } => {
                self.execute(command, middleware, &path, &filtered, &rest, &output)
                    .await;
            }
            Resolved::Fetch {
                gateway,
                middleware,
                path,
                rest,
                ..
            } => {
                self.fetch(gateway, middleware, &path, &filtered, &rest, &output)
                    .await;
            }
            Resolved::Help {
                commands,
                description,
                path,
            } => {
                let entries = help_entries(commands);
                let text = help::format_root(
                    &format!("{} {path}", cli.name),
                    &help::Options {
                        commands: Some(&entries),
                        description,
                        hide_skills: false,
                        hide_update: false,
                        ..self.help_options()
                    },
                );
                self.writeln(&text);
            }
        }
    }

    /// Help options for a command.
    fn command_help<'c>(
        &'c self,
        command: &'c Command,
        aliases: &'c [String],
        version: Option<&'c str>,
        commands: Option<&'c [HelpEntry]>,
        root: bool,
    ) -> help::Options<'c> {
        help::Options {
            aliases,
            args: command.args.as_ref(),
            commands: commands.filter(|c| !c.is_empty()),
            description: command.description.as_deref(),
            env: command.env.as_ref(),
            env_source: Some(self.io.env),
            examples: help_examples(command),
            hint: command.hint.as_deref(),
            options: command.options.as_ref(),
            root,
            usage: &command.usage,
            version,
            ..self.help_options()
        }
    }

    /// Prints help for the resolved target.
    fn help(&mut self, resolved: &Resolved<'_>) {
        let cli = self.cli;
        let commands = self.commands.clone();
        let text = match resolved {
            Resolved::Fetch { gateway, path, .. } => {
                if *path == cli.name && !commands.is_empty() {
                    let entries = help_entries(&commands);
                    help::format_root(
                        &cli.name,
                        &help::Options {
                            aliases: &cli.aliases,
                            commands: Some(&entries),
                            description: cli.description.as_deref(),
                            globals: None,
                            root: true,
                            version: cli.version.as_deref(),
                            ..self.help_options()
                        },
                    )
                } else {
                    let name = if *path == cli.name {
                        cli.name.clone()
                    } else {
                        format!("{} {path}", cli.name)
                    };
                    fetch::help(&name, gateway.description.as_deref())
                }
            }
            Resolved::Help {
                path,
                description,
                commands,
            } => {
                let entries = help_entries(commands);
                help::format_root(
                    &format!("{} {path}", cli.name),
                    &help::Options {
                        commands: Some(&entries),
                        description: *description,
                        ..self.help_options()
                    },
                )
            }
            Resolved::Error { .. } => {
                let entries = help_entries(&commands);
                match self.root.filter(|_| !entries.is_empty()) {
                    Some(root) => help::format_command(
                        &cli.name,
                        &self.command_help(
                            root,
                            &cli.aliases,
                            cli.version.as_deref(),
                            Some(&entries),
                            true,
                        ),
                    ),
                    None => help::format_root(
                        &cli.name,
                        &help::Options {
                            aliases: &cli.aliases,
                            commands: Some(&entries),
                            description: cli.description.as_deref(),
                            root: true,
                            version: cli.version.as_deref(),
                            ..self.help_options()
                        },
                    ),
                }
            }
            Resolved::Command {
                command,
                commands,
                path,
                ..
            } => {
                let is_root = *path == cli.name;
                let name = if is_root {
                    cli.name.clone()
                } else {
                    format!("{} {path}", cli.name)
                };
                let entries = match commands {
                    Some(group) if !group.is_empty() => help_entries(group),
                    _ if is_root => help_entries(&self.commands.clone()),
                    _ => Vec::new(),
                };
                let aliases = if is_root {
                    &cli.aliases
                } else {
                    &command.aliases
                };
                let version = if is_root {
                    cli.version.as_deref()
                } else {
                    None
                };
                help::format_command(
                    &name,
                    &self.command_help(command, aliases, version, Some(&entries), is_root),
                )
            }
        };
        self.writeln(&text);
    }

    /// Prints the JSON Schema of the resolved command.
    fn schema(&mut self, resolved: &Resolved<'_>, flags: &Flags) {
        let cli = self.cli;
        match resolved {
            Resolved::Fetch { .. } => {
                self.writeln("--schema is not supported for fetch commands.");
                self.exit = 1;
            }
            Resolved::Help {
                path,
                description,
                commands,
            } => {
                let entries = help_entries(commands);
                let text = help::format_root(
                    &format!("{} {path}", cli.name),
                    &help::Options {
                        commands: Some(&entries),
                        description: *description,
                        hide_skills: false,
                        ..self.help_options()
                    },
                );
                self.writeln(&text);
            }
            Resolved::Error {
                error,
                path,
                commands,
                ..
            } => {
                let parent = if path.is_empty() {
                    cli.name.clone()
                } else {
                    format!("{} {path}", cli.name)
                };
                let suggestion = suggest(error, commands.keys().map(String::as_str))
                    .map_or_else(String::new, |s| format!(" Did you mean '{s}'?"));
                self.writeln(&format!(
                    "Error: '{error}' is not a command for '{parent}'.{suggestion}"
                ));
                self.exit = 1;
            }
            Resolved::Command { command, .. } => {
                let format = if flags.format_explicit {
                    flags.format
                } else {
                    Format::Toon
                };
                let mut out = Map::new();
                for (key, ty) in [
                    ("args", &command.args),
                    ("env", &command.env),
                    ("options", &command.options),
                    ("output", &command.output),
                    ("globals", &cli.globals),
                ] {
                    if let Some(ty) = ty {
                        out.insert(key.into(), schema::json_schema(ty));
                    }
                }
                self.writeln(&formatter::format(&Value::Object(out), format));
            }
        }
    }

    /// Prints `--llms` or `--llms-full` output.
    fn llms(&mut self, flags: &Flags, filtered: &[String]) {
        let cli = self.cli;
        let tree = self.commands.clone();
        let mut commands = &*tree;
        let mut prefix: Vec<String> = Vec::new();
        let mut description = cli.description.as_deref();
        let mut root = self.root;
        let mut single: Option<IndexMap<String, Entry>> = None;
        for token in filtered {
            let Some(raw) = commands.get(token) else {
                break;
            };
            match raw {
                Entry::Group(group) => {
                    commands = &group.commands;
                    description = group.description.as_deref();
                    root = group.root.as_ref();
                    prefix.push(token.clone());
                }
                Entry::Alias(command) | Entry::Command(command) => {
                    let mut map = IndexMap::new();
                    map.insert(token.clone(), Entry::Command(command.clone()));
                    single = Some(map);
                    root = None;
                    break;
                }
                Entry::Fetch(_) => {
                    let mut map = IndexMap::new();
                    map.insert(token.clone(), raw.clone());
                    single = Some(map);
                    root = None;
                    break;
                }
            }
        }
        let commands = single.as_ref().unwrap_or(commands);
        if prefix.is_empty() {
            root = self.root;
        }
        let markdown = !flags.format_explicit || flags.format == Format::Md;
        // Markdown manifests show `sync.command` (e.g. `bunx @scope/cli`) in place of the name.
        let shown = cli.sync.command.as_deref().unwrap_or(&cli.name);
        let scoped = if prefix.is_empty() {
            shown.to_owned()
        } else {
            format!("{shown} {}", prefix.join(" "))
        };
        if markdown {
            let mut groups = IndexMap::new();
            let infos = skill_commands(commands, &[], &mut groups, root);
            let text = if flags.llms_full {
                skill::generate(&scoped, &infos, &groups)
            } else {
                skill::index(&scoped, &infos, description)
            };
            self.writeln(&text);
            return;
        }
        let full = flags.llms_full;
        let mut entries = manifest_commands(commands, &prefix, full);
        if let Some(root) = root.filter(|_| !prefix.is_empty()) {
            entries.push(manifest_entry(&prefix.join(" "), root, full));
        }
        entries.sort_by(|a, b| {
            js::locale_compare(
                a["name"].as_str().unwrap_or(""),
                b["name"].as_str().unwrap_or(""),
            )
        });
        let mut manifest = Map::new();
        manifest.insert("version".into(), "incur.v1".into());
        manifest.insert("commands".into(), entries.into());
        if let Some(globals) = &cli.globals {
            manifest.insert("globals".into(), schema::json_schema(globals));
        }
        self.writeln(&formatter::format(&Value::Object(manifest), flags.format));
    }

    /// Prints help for the `completions` built-in.
    fn completions_help(&mut self) {
        let name = &self.cli.name;
        let rows = [
            (
                "bash",
                format!("eval \"$({name} completions bash)\""),
                "# add to ~/.bashrc",
            ),
            (
                "fish",
                format!("{name} completions fish | source"),
                "# add to ~/.config/fish/config.fish",
            ),
            (
                "nushell",
                format!("see `{name} completions nushell`"),
                "# add to config.nu",
            ),
            (
                "zsh",
                format!("eval \"$({name} completions zsh)\""),
                "# add to ~/.zshrc",
            ),
        ];
        let width = rows.iter().map(|r| js::utf16_len(&r.1)).max().unwrap_or(0);
        let hint = std::iter::once("Setup:".to_owned())
            .chain(rows.iter().map(|(shell, command, comment)| {
                format!(
                    "  {shell:<7}  {command}{}  {comment}",
                    " ".repeat(width - js::utf16_len(command))
                )
            }))
            .collect::<Vec<_>>()
            .join("\n");
        let args = Type::object(vec![schema::Field::new(
            "shell",
            Type::new(schema::Kind::Enum(
                Shell::ALL.iter().map(|s| s.as_str().to_owned()).collect(),
            ))
            .describe("Shell to generate completions for"),
        )]);
        let text = help::format_command(
            &format!("{name} completions"),
            &help::Options {
                args: Some(&args),
                description: Some("Generate shell completion script"),
                hide_global_options: true,
                hint: Some(&hint),
                ..help::Options::default()
            },
        );
        self.writeln(&text);
    }

    /// Handles the `skills` and `mcp` built-ins.
    fn builtin(
        &mut self,
        builtin: &str,
        filtered: &[String],
        index: usize,
        argv: &[String],
        flags: &Flags,
        human: bool,
    ) {
        let name = self.cli.name.clone();
        let subs = BUILTIN_SUBCOMMANDS
            .iter()
            .filter(|s| s.0 == builtin)
            .collect::<Vec<_>>();
        let Some(sub) = filtered.get(index + 1) else {
            let entries = subs
                .iter()
                .map(|s| HelpEntry {
                    description: Some(s.2.to_owned()),
                    name: s.1.to_owned(),
                })
                .collect::<Vec<_>>();
            let aliases = if builtin == "skills" {
                vec!["skill".to_owned()]
            } else {
                Vec::new()
            };
            let description = BUILTINS.iter().find(|b| b.0 == builtin).map(|b| b.1);
            let text = help::format_root(
                &format!("{name} {builtin}"),
                &help::Options {
                    aliases: &aliases,
                    commands: Some(&entries),
                    description,
                    ..help::Options::default()
                },
            );
            self.writeln(&text);
            return;
        };
        let found = subs
            .iter()
            .find(|s| s.1 == sub || s.3.contains(&sub.as_str()));
        let Some(found) = found else {
            let candidates = subs
                .iter()
                .flat_map(|s| std::iter::once(s.1).chain(s.3.iter().copied()));
            let suggestion = suggest(sub, candidates);
            let did_you_mean =
                suggestion.map_or_else(String::new, |s| format!(" Did you mean '{s}'?"));
            let message = format!("'{sub}' is not a command for '{name} {builtin}'.{did_you_mean}");
            let mut commands = Vec::new();
            if let Some(suggestion) = suggestion {
                let corrected = argv
                    .iter()
                    .map(|t| if t == sub { suggestion } else { t.as_str() })
                    .collect::<Vec<_>>()
                    .join(" ");
                commands.push(FormattedCta {
                    command: format!("{name} {corrected}"),
                    description: None,
                });
            }
            commands.push(FormattedCta {
                command: format!("{name} {builtin} --help"),
                description: Some("see all available commands".into()),
            });
            let cta = FormattedCtaBlock {
                description: if commands.len() == 1 {
                    "Suggested command:"
                } else {
                    "Suggested commands:"
                }
                .into(),
                commands,
            };
            let error = Error::new("COMMAND_NOT_FOUND", message);
            if human {
                self.writeln(&human_error(&error));
                self.writeln(&cta.human());
            } else {
                let mut value = Map::new();
                value.insert("code".into(), error.code.into());
                value.insert("message".into(), error.message.into());
                value.insert("cta".into(), cta.to_value());
                self.writeln(&formatter::format(&Value::Object(value), Format::Toon));
            }
            self.exit = 1;
            return;
        };
        if flags.help {
            let options = match (builtin, found.1) {
                ("mcp", "add") => Some(Type::object(vec![
                    schema::Field::new(
                        "agent",
                        String::schema()
                            .optional()
                            .describe("Target a specific agent (e.g. claude-code, cursor)"),
                    ),
                    schema::Field::new(
                        "command",
                        String::schema().optional().describe(
                            "Override the command agents will run (e.g. \"pnpm my-cli --mcp\")",
                        ),
                    )
                    .alias('c'),
                    schema::Field::new(
                        "noGlobal",
                        bool::schema()
                            .optional()
                            .describe("Install to project instead of globally"),
                    ),
                ])),
                ("skills", "add") => Some(Type::object(vec![
                    schema::Field::new(
                        "depth",
                        f64::schema()
                            .optional()
                            .describe("Grouping depth for skill files (default: 1)"),
                    ),
                    schema::Field::new(
                        "noGlobal",
                        bool::schema()
                            .optional()
                            .describe("Install to project instead of globally"),
                    ),
                ])),
                _ => None,
            };
            let aliases = found.3.iter().map(|a| (*a).to_owned()).collect::<Vec<_>>();
            let text = help::format_command(
                &format!("{name} {builtin} {}", found.1),
                &help::Options {
                    aliases: &aliases,
                    description: Some(found.2),
                    hide_global_options: true,
                    options: options.as_ref(),
                    ..help::Options::default()
                },
            );
            self.writeln(&text);
            return;
        }
        let rest = filtered.get(index + 2..).unwrap_or_default();
        match (builtin, found.1) {
            ("skills", "list") => self.skills_list(flags),
            ("skills", "add") => self.skills_add(rest, flags),
            ("mcp", "doctor") => self.mcp_doctor(flags),
            _ => self.mcp_add(rest, flags, human),
        }
    }

    /// The format built-in actions print data in: the explicit format, or TOON.
    fn action_format(flags: &Flags) -> Format {
        if flags.format_explicit {
            flags.format
        } else {
            Format::Toon
        }
    }

    /// Reports a failed built-in action and sets the exit code.
    fn action_failed(&mut self, code: &str, error: &Error, flags: &Flags) {
        let mut value = Map::new();
        value.insert("code".into(), code.into());
        value.insert("message".into(), error.message.clone().into());
        self.writeln(&formatter::format(
            &Value::Object(value),
            Self::action_format(flags),
        ));
        self.exit = 1;
    }

    /// What `skills add` and `skills list` read: skill commands with the CLI description as a
    /// group, and the hash of the commands without groups.
    fn skill_source(&self) -> (Vec<CommandInfo>, IndexMap<String, String>, String) {
        let cli = self.cli;
        let mut groups = IndexMap::new();
        if let Some(description) = &cli.description {
            groups.insert(cli.name.clone(), description.clone());
        }
        let infos = skill_commands(&self.commands, &[], &mut groups, self.root);
        let plain = skill_commands(&self.commands, &[], &mut IndexMap::new(), self.root);
        (infos, groups, skill::hash(&plain))
    }

    /// Runs `skills list`.
    fn skills_list(&mut self, flags: &Flags) {
        let _ = flags;
        let cli = self.cli;
        let (infos, groups, hash) = self.skill_source();
        let source = sync::Source {
            name: &cli.name,
            commands: &infos,
            groups: &groups,
            hash,
            env: self.io.env,
            settings: &cli.sync,
        };
        let skills = sync::list(&source, cli.sync.depth.unwrap_or(1.0));
        if skills.is_empty() {
            self.writeln("No skills found.");
            return;
        }
        let width = skills
            .iter()
            .map(|s| js::utf16_len(&s.name))
            .max()
            .unwrap_or(0);
        let mut lines = skills
            .iter()
            .map(|s| {
                let icon = if s.installed { '\u{2713}' } else { '\u{2717}' };
                match s.description.as_deref() {
                    Some(description) => format!(
                        "  {icon} {}{}  {description}",
                        s.name,
                        " ".repeat(width - js::utf16_len(&s.name))
                    ),
                    None => format!("  {icon} {}", s.name),
                }
            })
            .collect::<Vec<_>>();
        let installed = skills.iter().filter(|s| s.installed).count();
        lines.push(String::new());
        lines.push(format!(
            "{} skill{} ({installed} installed)",
            skills.len(),
            if skills.len() == 1 { "" } else { "s" }
        ));
        self.writeln(&lines.join("\n"));
    }

    /// Runs `skills add`.
    fn skills_add(&mut self, rest: &[String], flags: &Flags) {
        let cli = self.cli;
        let depth = if let Some(index) = rest.iter().position(|t| t == "--depth") {
            rest.get(index + 1)
                .map_or(f64::NAN, |raw| js::to_number(raw))
        } else if let Some(token) = rest.iter().find(|t| t.starts_with("--depth=")) {
            js::to_number(token.split('=').nth(1).unwrap_or_default())
        } else {
            cli.sync.depth.unwrap_or(1.0)
        };
        let global = !rest.iter().any(|t| t == "--no-global");
        let (infos, groups, hash) = self.skill_source();
        let source = sync::Source {
            name: &cli.name,
            commands: &infos,
            groups: &groups,
            hash,
            env: self.io.env,
            settings: &cli.sync,
        };
        // Progress and the summary are for people; an explicit format prints only the result.
        if !flags.format_explicit {
            self.write("Syncing...");
        }
        let synced = match sync::sync(&source, depth, global) {
            Ok(synced) => synced,
            Err(error) => {
                self.action_failed("SYNC_SKILLS_FAILED", &error, flags);
                return;
            }
        };
        let width = synced
            .skills
            .iter()
            .map(|s| js::utf16_len(&s.name))
            .max()
            .unwrap_or(0);
        let mut lines = synced
            .skills
            .iter()
            .map(|s| match s.description.as_deref() {
                Some(description) => format!(
                    "  \u{2713} {}{}  {description}",
                    s.name,
                    " ".repeat(width - js::utf16_len(&s.name))
                ),
                None => format!("  \u{2713} {}", s.name),
            })
            .collect::<Vec<_>>();
        lines.push(String::new());
        lines.push(format!(
            "{} skill{} synced",
            synced.skills.len(),
            if synced.skills.len() == 1 { "" } else { "s" }
        ));
        let body = cli.sync.body.as_deref().filter(|b| !b.is_empty());
        if let Some(body) = body {
            lines.push(String::new());
            lines.push(body.to_owned());
        }
        if !cli.sync.suggestions.is_empty() {
            lines.push(String::new());
            lines.push(format!("Your agent can now use {}. Try asking:", cli.name));
            for suggestion in &cli.sync.suggestions {
                lines.push(format!("  \"{suggestion}\""));
            }
        }
        lines.push(String::new());
        lines.push(format!(
            "Run `{} --help` to see the full command reference.",
            cli.name
        ));
        if !flags.format_explicit {
            self.write("\r\x1b[K");
            self.writeln(&lines.join("\n"));
        }
        if flags.full_output || flags.format_explicit {
            let mut out = Map::new();
            out.insert(
                "skills".into(),
                synced
                    .paths
                    .iter()
                    .map(|p| Value::String(p.to_string_lossy().into_owned()))
                    .collect(),
            );
            if let Some(body) = body {
                out.insert("body".into(), body.into());
            }
            let agents = synced.agents();
            if flags.full_output && !agents.is_empty() {
                out.insert("agents".into(), agents.into());
            }
            self.writeln(&formatter::format(
                &Value::Object(out),
                Self::action_format(flags),
            ));
        }
    }

    /// Runs `mcp add`.
    fn mcp_add(&mut self, rest: &[String], flags: &Flags, human: bool) {
        let cli = self.cli;
        let global = !rest.iter().any(|t| t == "--no-global");
        let mut command = cli.mcp.command.clone();
        let mut agents = cli.mcp.agents.clone();
        let mut i = 0;
        while i < rest.len() {
            // `--command` / `-c` and `--agent`, spaced or with `=`. A blank or option-shaped
            // value is missing, so it cannot swallow the next flag.
            let (flag, value) = match rest[i].split_once('=') {
                Some((flag, value)) => (flag, Some(value)),
                None => (rest[i].as_str(), None),
            };
            i += 1;
            if !matches!(flag, "--command" | "-c" | "--agent") {
                continue;
            }
            let value = value.or_else(|| {
                i += 1;
                rest.get(i - 1).map(String::as_str)
            });
            let Some(value) = value.filter(|v| {
                !v.trim_matches(js::is_whitespace).is_empty() && (*v == "-" || !v.starts_with('-'))
            }) else {
                let error = Error::unknown(format!("Missing value for flag: {flag}"));
                self.early_error(&error, human, Self::action_format(flags));
                return;
            };
            if flag == "--agent" {
                agents.push(value.to_owned());
            } else {
                command = Some(value.to_owned());
            }
        }
        let name = cli.mcp.name.clone().unwrap_or_else(|| cli.name.clone());
        // Progress and the summary are for people; an explicit format prints only the result.
        if !flags.format_explicit {
            self.write("Registering MCP server...");
        }
        let registered = sync::register(sync::Register {
            name: &name,
            cli: &cli.name,
            command,
            global,
            agents,
            package: cli
                .package
                .as_deref()
                .map(|package| (package, cli.version.as_deref())),
            env: self.io.env,
        });
        let (command, agents) = match registered {
            Ok(registered) => registered,
            Err(error) => {
                self.action_failed("MCP_ADD_FAILED", &error, flags);
                return;
            }
        };
        if !flags.format_explicit {
            self.write("\r\x1b[K");
            let mut lines = vec![format!("\u{2713} Registered {name} as MCP server")];
            if !agents.is_empty() {
                lines.push(format!("  Agents: {}", agents.join(", ")));
            }
            lines.push(String::new());
            lines.push(format!("Agents can now use {name} tools."));
            if !cli.sync.suggestions.is_empty() {
                lines.push(String::new());
                lines.push("Try asking:".into());
                for suggestion in &cli.sync.suggestions {
                    lines.push(format!("  \"{suggestion}\""));
                }
            }
            self.writeln(&lines.join("\n"));
        }
        if flags.full_output || flags.format_explicit {
            let mut out = Map::new();
            out.insert("name".into(), name.into());
            out.insert("command".into(), command.into());
            out.insert(
                "agents".into(),
                agents.into_iter().map(Value::String).collect(),
            );
            self.writeln(&formatter::format(
                &Value::Object(out),
                Self::action_format(flags),
            ));
        }
    }

    /// Runs `mcp doctor`: starts the server in process, initializes it, and lists its tools.
    fn mcp_doctor(&mut self, flags: &Flags) {
        let mut warnings = Vec::new();
        let mut errors = Vec::new();
        let mut tools = Vec::new();
        match self
            .cli
            .mcp_server(&self.commands, self.io.env, true, &mcp::Defaults::default())
        {
            Err(error) => errors.push(json_error("MCP_SERVER_FAILED", &error.message)),
            Ok(server) => {
                for tool in server.list() {
                    let mut entry = Map::new();
                    entry.insert("name".into(), tool["name"].clone());
                    if let Some(description) = tool.get("description") {
                        entry.insert("description".into(), description.clone());
                    }
                    tools.push(Value::Object(entry));
                }
            }
        }
        if errors.is_empty() && tools.is_empty() {
            warnings.push(Value::from("No MCP tools exposed."));
        }
        let ok = errors.is_empty();
        let mut out = Map::new();
        out.insert("ok".into(), ok.into());
        out.insert("toolCount".into(), tools.len().into());
        out.insert("tools".into(), tools.into());
        out.insert("warnings".into(), warnings.into());
        out.insert("errors".into(), errors.into());
        self.writeln(&formatter::format(
            &Value::Object(out),
            Self::action_format(flags),
        ));
        if !ok {
            self.exit = 1;
        }
    }

    /// Serves MCP over standard input and output until input ends.
    async fn mcp_stdio(&mut self, flags: &Flags, human: bool) {
        let cli = self.cli;
        // Globals passed to the server apply to every call. Only those are validated: a required
        // global may still come with each call.
        let loaded = (|| -> Result<_, Error> {
            let globals = match &cli.globals {
                Some(schema) => {
                    let options = GlobalsOptions {
                        command: Some(None),
                        validate: false,
                    };
                    let (raw, _) = parser::parse_globals(&flags.rest, schema, options)?;
                    parser::parse_passed_globals(
                        schema,
                        raw.as_object().cloned().unwrap_or_default(),
                    )?
                }
                None => Map::new(),
            };
            Ok((globals, self.load_config(flags)?))
        })();
        let section = |tree: &Value, path: &str| config_section(tree, &cli.name, path);
        // An invalid global or config file stops the server before it serves.
        let built = loaded.and_then(|(globals, tree)| {
            let options = tree
                .as_ref()
                .map(|tree| move |path: &str| section(tree, path));
            let defaults = mcp::Defaults {
                globals,
                options: options.as_ref().map(|f| f as _),
            };
            cli.mcp_server(&self.commands, self.io.env, false, &defaults)
        });
        let server = match built {
            Ok(server) => server,
            Err(error) => {
                self.early_error(&error, human, flags.format);
                return;
            }
        };
        // The opening message picks the era: a 2026-07-28 envelope pins the connection to
        // per-request `_meta` serving (after any `server/discover` probes), anything else to the
        // 2025 handshake.
        let mut era = Era::Opening;
        while let Some(line) = futures_util::StreamExt::next(&mut *self.io.stdin).await {
            let Ok(value) = js::json_parse(&line, |_| Value::Null) else {
                continue;
            };
            let Some(parsed) = mcp::message(&value) else {
                continue;
            };
            let request = matches!(parsed, mcp::Message::Request { .. });
            if matches!(era, Era::Opening | Era::Probe) {
                let Some(opened) = self.open_stdio(&value, request) else {
                    continue;
                };
                let discover = value.get("method") == Some(&Value::from("server/discover"));
                era = match opened {
                    Era::Legacy => Era::Legacy,
                    _ if discover && request => Era::Probe,
                    _ if era == Era::Opening || request => Era::Modern,
                    _ => era,
                };
            }
            let mcp::Message::Request { id, method, params } = parsed else {
                continue;
            };
            let mut notifications = Vec::new();
            let response = if era == Era::Legacy {
                server
                    .handle(&id, &method, &params, None, &mut |n| notifications.push(n))
                    .await
            } else if method == "initialize" && !modern::valid_claim(&params) {
                modern::Reject::initialize(&params).response(&id)
            } else {
                server
                    .handle_modern(&id, &method, &params, None, &mut |n| {
                        notifications.push(n);
                    })
                    .await
                    .0
            };
            for notification in notifications {
                self.writeln(&js::stringify(&notification));
            }
            self.writeln(&js::stringify(&response));
            let _ = self.io.stdout.flush();
        }
    }

    /// Classifies a message on a stdio connection without an era. Returns `None` after
    /// answering or dropping it.
    fn open_stdio(&mut self, value: &Value, request: bool) -> Option<Era> {
        let method = value.get("method")?.as_str()?;
        let empty = Map::new();
        let params = value
            .get("params")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        if method == "initialize" && !modern::valid_claim(params) || !modern::has_claim(params) {
            return Some(Era::Legacy);
        }
        let id = value.get("id").cloned().unwrap_or_default();
        let reject = match modern::params_issues(params).into_iter().next() {
            Some(issue) => modern::Reject::envelope(issue),
            None => match modern::claimed(params) {
                Some(modern::VERSION) => return Some(Era::Modern),
                claimed => modern::Reject::unsupported(claimed.unwrap_or_default()),
            },
        };
        if request {
            self.writeln(&js::stringify(&reject.response(&id)));
        }
        None
    }

    /// Runs `--update`.
    async fn install(&mut self, flags: &Flags, human: bool) {
        let cli = self.cli;
        let client = cli.http_client();
        let machine = update::Machine {
            client: &client,
            env: self.io.env,
        };
        match update::install(&cli.name, &cli.update, cli.version.as_deref(), &machine).await {
            Ok(installed) if human => {
                let mut lines = vec![if installed.deferred {
                    format!("\u{2713} Update staged for {}", installed.name)
                } else {
                    format!("\u{2713} Updated {}", installed.name)
                }];
                lines.extend(
                    installed
                        .command
                        .iter()
                        .map(|command| format!("  {command}")),
                );
                if installed.deferred {
                    lines.push("  Installation will finish after this process exits.".into());
                }
                self.writeln(&lines.join("\n"));
            }
            Ok(installed) => {
                self.writeln(&formatter::format(&installed.to_value(), flags.format));
            }
            Err(error) => {
                let error = Error::new("UPDATE_FAILED", error.message);
                self.early_error(&error, human, flags.format);
            }
        }
    }

    /// Returns the notice that installed skills are out of date, when they are.
    async fn skills_notice(&mut self, filtered: &[String]) -> Option<FormattedCtaBlock> {
        let cli = self.cli;
        let commands = &self.commands;
        let matches = |token: Option<&String>, name: &str| {
            token.and_then(|t| find_unshadowed_builtin(commands, t)) == Some(name)
        };
        let builtin = |name: &str| {
            matches(filtered.first(), name)
                || (filtered.first() == Some(&cli.name) && matches(filtered.get(1), name))
        };
        if builtin("skills") || builtin("mcp") {
            return None;
        }
        let env = self.io.env;
        let cwd = std::env::current_dir().unwrap_or_default();
        // Skills installed in this project take precedence over global ones.
        let global = !sync::has_installed(&cli.name, env, &cwd, false);
        let stored = sync::read_hash(&cli.name, env, (!global).then_some(cwd.as_path()))?;
        if !sync::has_installed(&cli.name, env, &cwd, global) {
            return None;
        }
        let tree = cli.tree(&Scope::All).await.ok()?;
        let infos = skill_commands(&tree, &[], &mut IndexMap::new(), self.root);
        if skill::hash(&infos) == stored {
            return None;
        }
        let present = |key: &str| env(key).is_some_and(|v| !v.is_empty());
        let runnable = (present("npm_config_user_agent") || present("npm_execpath"))
            && (cli.package.is_some() || sync::is_package_name(&cli.name));
        let flag = if global { "" } else { " --no-global" };
        let command = if runnable {
            match sync::package_specifier(&cli.name, cli.package.as_deref(), cli.version.as_deref())
            {
                Ok(specifier) => format!("{} {specifier} skills add{flag}", update::runner(env)),
                Err(_) => format!("{} skills add{flag}", self.display_name),
            }
        } else {
            format!("{} skills add{flag}", self.display_name)
        };
        Some(FormattedCtaBlock {
            description: "Skills are out of date:".into(),
            commands: vec![FormattedCta {
                command,
                description: Some("sync outdated skills".into()),
            }],
        })
    }

    /// Answers a shell completion request.
    fn complete(&mut self, shell: &str, argv: &[String]) {
        let cli = self.cli;
        let Ok(shell) = shell.parse::<Shell>() else {
            return;
        };
        let words = match argv.iter().position(|t| t == "--") {
            Some(index) => &argv[index + 1..],
            None => argv,
        };
        if words.is_empty() {
            let scripts = std::iter::once(&cli.name)
                .chain(&cli.aliases)
                .map(|name| completions::register(shell, name))
                .collect::<Vec<_>>()
                .join("\n");
            self.write(&scripts);
            return;
        }
        // The index is a JavaScript number: shells may send anything, and `slice` and element
        // reads interpret it as JavaScript does.
        #[expect(clippy::cast_precision_loss, reason = "Word counts are small.")]
        let index = self
            .env("_COMPLETE_INDEX")
            .map_or((words.len() - 1) as f64, |raw| js::to_number(&raw));
        let cut = js::relative_index(index, words.len());
        let before = (|| {
            let mut rest = extract_flags(&words[..cut], self.config_flag(), true, true)
                .ok()?
                .rest;
            if js::element(words, index - 1.0).is_some_and(|w| w == "--version") {
                rest.push("--version".into());
            }
            match &cli.globals {
                None => Some(rest),
                Some(schema) => parser::parse_globals(&rest, schema, GlobalsOptions::default())
                    .ok()
                    .map(|(_, rest)| rest),
            }
        })();
        let (input, at) = match &before {
            Some(before) => ([before.as_slice(), &words[cut..]].concat(), before.len()),
            None => (words.to_vec(), cut),
        };
        let commands = self.commands.clone();
        let tree = tree(&commands, self.root, None);
        let mut candidates = completions::complete(&tree, &input, at, cli.globals.as_ref());
        let current = js::element(words, index).map_or("", String::as_str);
        let non_flags = before
            .as_ref()
            .map(|b| b.iter().filter(|w| !w.starts_with('-')).collect::<Vec<_>>());
        match non_flags.as_deref() {
            Some(words) if words.len() <= 1 => {
                for (name, description) in BUILTINS {
                    if !cli.builtin_enabled(name) {
                        continue;
                    }
                    if name.starts_with(current) && !candidates.iter().any(|c| c.value == name) {
                        candidates.push(completions::Candidate {
                            description: Some(description.into()),
                            no_space: name != "completions",
                            value: name.into(),
                        });
                    }
                }
            }
            Some([_, parent]) => {
                // A built-in group completes its own subcommands in place of root commands
                if let Some(builtin) = find_unshadowed_builtin(&commands, parent).filter(|b| {
                    *b != "completions" && cli.builtin_enabled(b) && !current.starts_with('-')
                }) {
                    candidates.clear();
                    for sub in BUILTIN_SUBCOMMANDS.iter().filter(|s| s.0 == builtin) {
                        for value in std::iter::once(sub.1).chain(sub.3.iter().copied()) {
                            if value.starts_with(current) {
                                candidates.push(completions::Candidate {
                                    description: Some(sub.2.into()),
                                    no_space: false,
                                    value: value.into(),
                                });
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        // Add the built-in global flags that help lists for the active command
        if let Some(words) = non_flags.as_deref().filter(|_| current.starts_with('-')) {
            let options = help::Options {
                root: words.len() <= 1,
                ..self.help_options()
            };
            for (flag, description) in help::global_flags(&options) {
                for value in flag
                    .split(", ")
                    .map(|f| f.split_once(' ').map_or(f, |(name, _)| name))
                {
                    if value.starts_with(current) && !candidates.iter().any(|c| c.value == value) {
                        candidates.push(completions::Candidate {
                            description: Some(description.into()),
                            no_space: false,
                            value: value.into(),
                        });
                    }
                }
            }
        }
        let out = completions::format(shell, &candidates);
        if !out.is_empty() {
            self.write(&out);
        }
    }

    /// Reports an unknown command.
    fn not_found(
        &mut self,
        error: &str,
        path: &str,
        commands: &IndexMap<String, Entry>,
        argv: &[String],
        output: &Output<'_>,
    ) {
        let cli = self.cli;
        let parent = if path.is_empty() {
            cli.name.clone()
        } else {
            format!("{} {path}", cli.name)
        };
        let help = format!("{parent} --help");
        let mut candidates = commands.keys().map(String::as_str).collect::<Vec<_>>();
        if path.is_empty() {
            candidates.extend(
                BUILTINS
                    .iter()
                    .map(|b| b.0)
                    .filter(|n| cli.builtin_enabled(n)),
            );
        }
        let suggestion = suggest(error, candidates);
        let did_you_mean = suggestion.map_or_else(String::new, |s| format!(" Did you mean '{s}'?"));
        let message = format!("'{error}' is not a command for '{parent}'.{did_you_mean}");
        let mut ctas = Vec::new();
        if let Some(suggestion) = suggestion {
            let corrected = argv
                .iter()
                .map(|t| if t == error { suggestion } else { t.as_str() })
                .collect::<Vec<_>>()
                .join(" ");
            ctas.push(FormattedCta {
                command: format!("{} {corrected}", cli.name),
                description: None,
            });
        }
        ctas.push(FormattedCta {
            command: help,
            description: Some("see all available commands".into()),
        });
        let cta = FormattedCtaBlock {
            description: if ctas.len() == 1 {
                "Suggested command:"
            } else {
                "Suggested commands:"
            }
            .into(),
            commands: ctas,
        };
        let failure = Error::new("COMMAND_NOT_FOUND", message);
        if output.human && !output.flags.full_output {
            self.writeln(&human_error(&failure));
            let merged = FormattedCtaBlock::merge(Some(cta), self.notice.clone());
            if let Some(merged) = merged {
                self.writeln(&merged.human());
            }
        } else {
            self.write_output(output, false, Some(failure.to_value()), error, Some(&cta));
        }
        self.exit = 1;
    }

    /// Truncates text to the requested token window.
    fn truncate(flags: &Flags, text: &str) -> (String, bool, Option<f64>) {
        if flags.token_limit.is_none() && flags.token_offset.is_none() {
            return (text.to_owned(), false, None);
        }
        #[expect(clippy::cast_precision_loss, reason = "Token counts are small.")]
        let total = tokens::estimate(text) as f64;
        let offset = flags.token_offset.unwrap_or(0.0);
        let end = flags.token_limit.map_or(total, |limit| offset + limit);
        if offset == 0.0 && end >= total {
            return (text.to_owned(), false, None);
        }
        let sliced = tokens::slice(text, offset, end);
        let start = offset.min(total);
        let actual_end = end.min(total);
        let next = (actual_end < total).then_some(actual_end);
        (
            format!(
                "{sliced}\n[truncated: showing tokens {}\u{2013}{} of {}]",
                js::number_to_string(start),
                js::number_to_string(actual_end),
                js::number_to_string(total)
            ),
            true,
            next,
        )
    }

    /// Writes a command result.
    fn write_output(
        &mut self,
        output: &Output<'_>,
        ok: bool,
        body: Option<Value>,
        command: &str,
        cta: Option<&FormattedCtaBlock>,
    ) {
        let merged = FormattedCtaBlock::merge(cta.cloned(), self.notice.clone());
        let cta = merged.as_ref();
        let flags = output.flags;
        let format = output.format;
        let body = match (&output.filter, ok, body) {
            (Some(paths), true, Some(data)) => filter::apply(&data, paths),
            (_, _, body) => body,
        };
        let fmt = |value: Option<&Value>| {
            value.map_or_else(String::new, |v| formatter::format(v, format))
        };
        if flags.token_count {
            let text = fmt(body.as_ref());
            self.writeln(&tokens::estimate(&text).to_string());
            return;
        }
        if output.human && !flags.full_output {
            if ok {
                if let Some(data) = body.as_ref().filter(|d| !d.is_null() && output.render) {
                    let text = Self::truncate(flags, &formatter::format(data, format)).0;
                    self.writeln(&text);
                }
            } else if let Some(error) = &body {
                self.writeln(&human_error(&error_from_value(error)));
            }
            if let Some(cta) = cta {
                self.writeln(&cta.human());
            }
            return;
        }
        let mut meta = Map::new();
        meta.insert("command".into(), command.into());
        meta.insert("duration".into(), self.duration().into());
        if let Some(cta) = cta {
            meta.insert("cta".into(), cta.to_value());
        }
        if flags.full_output {
            let key = if ok { "data" } else { "error" };
            if flags.token_limit.is_some() || flags.token_offset.is_some() {
                let text = fmt(body.as_ref().filter(|b| !b.is_null()));
                let (text, truncated, next) = Self::truncate(flags, &text);
                if truncated {
                    let mut envelope = Map::new();
                    envelope.insert("ok".into(), ok.into());
                    envelope.insert(key.into(), text.into());
                    if let Some(next) = next {
                        meta.insert("nextOffset".into(), js::number(next));
                    }
                    envelope.insert("meta".into(), Value::Object(meta));
                    self.writeln(&formatter::format(&Value::Object(envelope), format));
                    return;
                }
            }
            let mut envelope = Map::new();
            envelope.insert("ok".into(), ok.into());
            if let Some(body) = body {
                envelope.insert(key.into(), body);
            }
            envelope.insert("meta".into(), Value::Object(meta));
            self.writeln(&formatter::format(&Value::Object(envelope), format));
            return;
        }
        let Some(cta) = cta else {
            let text = fmt(body.as_ref());
            if !text.is_empty() {
                let text = Self::truncate(flags, &text).0;
                self.writeln(&text);
            }
            return;
        };
        let payload = match body {
            Some(Value::Object(mut map)) => {
                map.insert("cta".into(), cta.to_value());
                Value::Object(map)
            }
            body => {
                let mut map = Map::new();
                if let Some(body) = body {
                    map.insert("data".into(), body);
                }
                map.insert("cta".into(), cta.to_value());
                Value::Object(map)
            }
        };
        let text = Self::truncate(flags, &formatter::format(&payload, format)).0;
        self.writeln(&text);
    }

    /// Writes a failure and sets the exit code.
    fn write_failure(&mut self, output: &Output<'_>, error: &Error, command: &str) {
        let cta = FormattedCtaBlock::new(&self.display_name, error.cta.as_deref());
        self.write_output(output, false, Some(error.to_value()), command, cta.as_ref());
        self.exit = error.exit_code.unwrap_or(1);
    }

    /// Writes deprecation warnings for deprecated flags.
    fn deprecations(&mut self, argv: &[String], options: Option<&Type>) {
        let Some(options) = options else {
            return;
        };
        let deprecated = options
            .fields()
            .iter()
            .filter(|f| f.ty.deprecated)
            .map(|f| (js::to_kebab(&f.name), f.alias))
            .collect::<Vec<_>>();
        for token in argv {
            if let Some(stripped) = token.strip_prefix("--") {
                let stripped = stripped.split('=').next().unwrap_or_default();
                let known = |name: &str| deprecated.iter().any(|(kebab, _)| kebab == name);
                let raw = match stripped.strip_prefix("no-") {
                    Some(rest) if !known(stripped) => rest,
                    _ => stripped,
                };
                if known(raw) {
                    let _ = writeln!(self.io.stderr, "Warning: --{raw} is deprecated");
                }
            } else if token.len() >= 2 && token.starts_with('-') {
                for ch in token[1..].chars() {
                    if let Some((kebab, _)) =
                        deprecated.iter().find(|(_, alias)| *alias == Some(ch))
                    {
                        let _ = writeln!(self.io.stderr, "Warning: --{kebab} is deprecated");
                    }
                }
            }
        }
    }

    /// Loads config-file defaults for a command path.
    fn config_defaults(
        &self,
        path: &str,
        flags: &Flags,
    ) -> Result<Option<Map<String, Value>>, Error> {
        match self.load_config(flags)? {
            Some(tree) => config_section(&tree, &self.cli.name, path),
            None => Ok(None),
        }
    }

    /// Loads the config tree, honoring `--config`, `--no-config`, and a custom loader.
    fn load_config(&self, flags: &Flags) -> Result<Option<Value>, Error> {
        let Some(config) = &self.cli.config else {
            return Ok(None);
        };
        if flags.config_disabled {
            return Ok(None);
        }
        let resolve_path = |p: &str| -> PathBuf {
            if let Some(rest) = p
                .strip_prefix('~')
                .filter(|rest| rest.is_empty() || rest.starts_with('/'))
            {
                let home = sync::home(&|key| self.env(key));
                let rest = rest.trim_start_matches('/');
                if rest.is_empty() {
                    home
                } else {
                    home.join(rest)
                }
            } else {
                std::env::current_dir().unwrap_or_default().join(p)
            }
        };
        let target = if let Some(p) = &flags.config_path {
            Some(resolve_path(p))
        } else {
            let files = if config.files.is_empty() {
                vec![format!("{}.json", self.cli.name)]
            } else {
                config.files.clone()
            };
            files
                .iter()
                .map(|f| resolve_path(f))
                .find(|p| std::fs::File::open(p).is_ok())
        };
        let parsed = if let Some(loader) = &config.loader {
            match loader(target.as_deref())? {
                None => return Ok(None),
                Some(Value::Object(map)) => Value::Object(map),
                Some(_) => {
                    return Err(Error::new(
                        "UNKNOWN",
                        "Config loader must return a plain object or undefined",
                    ));
                }
            }
        } else {
            let Some(target) = target else {
                return Ok(None);
            };
            let display = target.display().to_string();
            // Node decodes the file as UTF-8, replacing invalid sequences.
            let raw = match std::fs::read(&target) {
                Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                // Search paths only resolve to existing files, so a missing file was named by flag.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err(Error::new(
                        "UNKNOWN",
                        format!("Config file not found: {display}"),
                    ));
                }
                // TypeScript reports Node's `fs` message here, whose wording varies by Node version.
                Err(error) => return Err(Error::new("UNKNOWN", error.to_string())),
            };
            // Infinities reach validation as the marker number options report.
            let parsed = js::json_parse(&raw, parser::number_value).map_err(|details| {
                Error::new(
                    "UNKNOWN",
                    format!("Invalid JSON config file: {display}\n\nDetails: {details}"),
                )
            })?;
            if !parsed.is_object() {
                return Err(Error::new(
                    "UNKNOWN",
                    format!("Invalid config file: expected a top-level object in {display}"),
                ));
            }
            js::normalize(parsed)
        };
        Ok(Some(parsed))
    }

    /// Parses input, runs middleware and the handler, and writes the result.
    async fn execute(
        &mut self,
        command: &Command,
        group_middleware: Vec<Middleware>,
        path: &str,
        filtered: &[String],
        rest: &[String],
        output: &Output<'_>,
    ) {
        let cli = self.cli;
        let depth = filtered.len() - rest.len();
        let mut globals = Value::Object(Map::new());
        let argv = match &cli.globals {
            None => output.flags.rest.clone(),
            Some(schema) => match parser::parse_globals(
                &output.flags.rest,
                schema,
                GlobalsOptions {
                    command: Some(command.options.as_ref()),
                    validate: true,
                },
            ) {
                Ok((parsed, rest)) => {
                    globals = parsed;
                    rest
                }
                Err(error) => {
                    self.early_error(&error, output.human, output.flags.format);
                    return;
                }
            },
        };
        let argv = argv.get(depth..).unwrap_or_default().to_vec();
        if output.human {
            self.deprecations(&argv, command.options.as_ref());
        }
        let defaults = match self.config_defaults(path, output.flags) {
            Ok(defaults) => defaults,
            Err(error) => {
                self.write_failure(output, &error, path);
                return;
            }
        };

        let mut chain = cli.middleware.clone();
        chain.extend(group_middleware);
        chain.extend(command.middleware.iter().cloned());

        let env_lookup = self.io.env;
        let cli_env = match &cli.env {
            Some(schema) => parser::parse_env(schema, env_lookup),
            None => Ok(Value::Object(Map::new())),
        };
        let env = match cli_env {
            Ok(env) => env,
            Err(error) => {
                self.report(Executed::Error(error), Some(command), path, output)
                    .await;
                return;
            }
        };
        let context = MiddlewareContext {
            agent: !output.human,
            command: path.to_owned(),
            display_name: self.display_name.clone(),
            env,
            format: output.format,
            format_explicit: output.flags.format_explicit,
            globals,
            name: cli.name.clone(),
            request: None,
            vars: cli.vars.clone(),
            version: cli.version.clone(),
        };
        // Parsing reads only argv, defaults, and the environment, so it runs up front; the
        // terminal step reports its result after middleware, as TypeScript does.
        let parsed = parser::parse(
            &argv,
            command.args.as_ref(),
            command.options.as_ref(),
            defaults.as_ref(),
        )
        .and_then(|parsed| {
            let env = match &command.env {
                Some(schema) => parser::parse_env(schema, env_lookup)?,
                None => Value::Object(Map::new()),
            };
            Ok((parsed, env))
        });
        let executed = execute::execute(
            chain,
            context,
            command.handler.clone(),
            parsed,
            Elicit::default(),
        )
        .await;
        self.report(executed, Some(command), path, output).await;
    }

    /// Forwards curl-style arguments to a fetch command through middleware, and writes the
    /// response.
    async fn fetch(
        &mut self,
        gateway: &Gateway,
        group_middleware: Vec<Middleware>,
        path: &str,
        filtered: &[String],
        rest: &[String],
        output: &Output<'_>,
    ) {
        let cli = self.cli;
        let depth = filtered.len() - rest.len();
        let mut globals = Value::Object(Map::new());
        let argv = match &cli.globals {
            None => output.flags.rest.clone(),
            Some(schema) => match parser::parse_globals(
                &output.flags.rest,
                schema,
                GlobalsOptions {
                    command: Some(None),
                    validate: true,
                },
            ) {
                Ok((parsed, rest)) => {
                    globals = parsed;
                    rest
                }
                Err(error) => {
                    self.early_error(&error, output.human, output.flags.format);
                    return;
                }
            },
        };
        let argv = argv.get(depth..).unwrap_or_default().to_vec();
        let mut chain = cli.middleware.clone();
        chain.extend(group_middleware);
        let env = match execute::parse_env(cli.env.as_ref(), self.io.env) {
            Ok(env) => env,
            Err(error) => {
                self.write_failure(output, &error, path);
                return;
            }
        };
        let context = MiddlewareContext {
            agent: !output.human,
            command: path.to_owned(),
            display_name: self.display_name.clone(),
            env,
            format: output.format,
            format_explicit: output.flags.format_explicit,
            globals,
            name: cli.name.clone(),
            request: None,
            vars: cli.vars.clone(),
            version: cli.version.clone(),
        };
        let handler = gateway.handler(argv, cli.http_client());
        let input = Ok((
            parser::Parsed {
                args: Value::Object(Map::new()),
                options: Value::Object(Map::new()),
            },
            Value::Object(Map::new()),
        ));
        let executed =
            execute::execute(chain, context, Some(handler), input, Elicit::default()).await;
        self.report(executed, None, path, output).await;
    }

    /// Writes an execution result.
    async fn report(
        &mut self,
        executed: Executed,
        command: Option<&Command>,
        path: &str,
        output: &Output<'_>,
    ) {
        match executed {
            Executed::Data { cta, data } => {
                let cta = FormattedCtaBlock::new(&self.display_name, cta.as_ref());
                self.write_output(output, true, data, path, cta.as_ref());
            }
            Executed::Error(error) => match command {
                Some(command)
                    if output.human
                        && !output.flags.format_explicit
                        && error.field_errors.is_some() =>
                {
                    self.validation_help(command, path, &error);
                }
                _ => self.write_failure(output, &error, path),
            },
            Executed::Stream { chunks, cta, rest } => {
                self.stream(chunks, cta.as_ref(), path, output).await;
                if let Err(error) = rest.finish().await {
                    self.write_failure(output, &error, path);
                }
            }
        }
    }

    /// Writes human validation errors followed by command help.
    fn validation_help(&mut self, command: &Command, path: &str, error: &Error) {
        let cli = self.cli;
        let mut lines = Vec::new();
        for field in error.field_errors.iter().flatten() {
            let mut parts = field.path.split('.');
            let head = parts.next().unwrap_or_default();
            let tail = parts.collect::<Vec<_>>();
            let suffix = if tail.is_empty() {
                String::new()
            } else {
                format!(".{}", tail.join("."))
            };
            let (kind, label) = if command
                .options
                .as_ref()
                .and_then(|o| o.field(head))
                .is_some()
            {
                ("option", format!("--{}{suffix}", js::to_kebab(head)))
            } else if command.env.as_ref().and_then(|e| e.field(head)).is_some() {
                ("environment variable", format!("{head}{suffix}"))
            } else {
                ("argument", format!("<{}>", field.path))
            };
            lines.push(if field.missing {
                format!("Error: missing required {kind} {label}")
            } else if kind == "environment variable" {
                format!(
                    "Error: invalid value for environment variable {label}: {}",
                    field.message
                )
            } else {
                format!("Error: invalid value for {label}: {}", field.message)
            });
        }
        lines.push("See below for usage.".into());
        lines.push(String::new());
        let name = if path == cli.name {
            cli.name.clone()
        } else {
            format!("{} {path}", cli.name)
        };
        lines.push(help::format_command(
            &name,
            &help::Options {
                args: command.args.as_ref(),
                config_flag: self.config_flag(),
                description: command.description.as_deref(),
                env: command.env.as_ref(),
                env_source: Some(self.io.env),
                examples: help_examples(command),
                hint: command.hint.as_deref(),
                options: command.options.as_ref(),
                usage: &command.usage,
                ..help::Options::default()
            },
        ));
        self.writeln(&lines.join("\n"));
        self.exit = 1;
    }

    /// Writes a streamed result.
    async fn stream(
        &mut self,
        mut chunks: Chunks,
        cta: Option<&CtaBlock>,
        path: &str,
        output: &Output<'_>,
    ) {
        let jsonl = output.format == Format::Jsonl;
        let incremental = jsonl || (!output.flags.format_explicit && output.format == Format::Toon);
        let name = self.display_name.clone();
        let fail = |run: &mut Self, error: &Error| {
            let cta = FormattedCtaBlock::new(&name, error.cta.as_deref());
            if jsonl {
                let mut record = Map::new();
                record.insert("type".into(), "error".into());
                record.insert("ok".into(), false.into());
                record.insert("error".into(), error.to_value());
                if let Some(cta) = &cta {
                    let mut meta = Map::new();
                    meta.insert("cta".into(), cta.to_value());
                    record.insert("meta".into(), Value::Object(meta));
                }
                run.writeln(&js::stringify(&Value::Object(record)));
            } else if incremental {
                run.writeln(&human_error(error));
                if let Some(cta) = &cta {
                    run.writeln(&cta.human());
                }
            } else {
                run.write_output(output, false, Some(error.to_value()), path, cta.as_ref());
            }
            run.exit = error.exit_code.unwrap_or(1);
        };
        let mut buffered = Vec::new();
        while let Some(chunk) = poll_fn(|cx| chunks.as_mut().poll_next(cx)).await {
            match chunk {
                Err(error) => {
                    fail(self, &error);
                    return;
                }
                Ok(value) if jsonl => {
                    let mut record = Map::new();
                    record.insert("type".into(), "chunk".into());
                    record.insert("data".into(), value);
                    self.writeln(&js::stringify(&Value::Object(record)));
                }
                Ok(value) if incremental => {
                    if output.render {
                        let text =
                            Self::truncate(output.flags, &formatter::format(&value, output.format))
                                .0;
                        self.writeln(&text);
                    }
                }
                Ok(value) => buffered.push(value),
            }
        }
        let cta = FormattedCtaBlock::new(&name, cta);
        if jsonl {
            let mut meta = Map::new();
            meta.insert("command".into(), path.into());
            meta.insert("duration".into(), self.duration().into());
            if let Some(cta) = &cta {
                meta.insert("cta".into(), cta.to_value());
            }
            let mut record = Map::new();
            record.insert("type".into(), "done".into());
            record.insert("ok".into(), true.into());
            record.insert("meta".into(), Value::Object(meta));
            self.writeln(&js::stringify(&Value::Object(record)));
        } else if incremental {
            if let Some(cta) = &cta {
                self.writeln(&cta.human());
            }
        } else {
            self.write_output(
                output,
                true,
                Some(Value::Array(buffered)),
                path,
                cta.as_ref(),
            );
        }
    }
}

/// Builds a `{ code, message }` error entry.
fn json_error(code: &str, message: &str) -> Value {
    let mut out = Map::new();
    out.insert("code".into(), code.into());
    out.insert("message".into(), message.into());
    Value::Object(out)
}

/// Rebuilds an error from its output value, for terminal rendering. Errors with field errors
/// render as validation help instead, so those are not rebuilt.
fn error_from_value(value: &Value) -> Error {
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    Error {
        code: text("code").unwrap_or_default(),
        hint: text("hint"),
        message: text("message").unwrap_or_default(),
        ..Error::default()
    }
}

/// Builds the completion tree of a command group.
fn tree<'a>(
    commands: &'a IndexMap<String, Entry>,
    root: Option<&'a Command>,
    description: Option<&'a str>,
) -> completions::Node<'a> {
    completions::Node::Group {
        commands: commands
            .iter()
            .map(|(name, entry)| {
                let node = match entry {
                    Entry::Alias(command) | Entry::Command(command) => completions::Node::Leaf {
                        description: command.description.as_deref(),
                        options: command.options.as_ref(),
                    },
                    Entry::Fetch(gateway) => completions::Node::Leaf {
                        description: gateway.description.as_deref(),
                        options: None,
                    },
                    Entry::Group(group) => tree(
                        &group.commands,
                        group.root.as_ref(),
                        group.description.as_deref(),
                    ),
                };
                (name.as_str(), node, matches!(entry, Entry::Alias(_)))
            })
            .collect(),
        description,
        leaf: root.and_then(|r| r.options.as_ref()),
    }
}

/// Walks the config tree to the option defaults of a command path.
fn config_section(
    tree: &Value,
    cli: &str,
    path: &str,
) -> Result<Option<Map<String, Value>>, Error> {
    let segments: Vec<&str> = if path == cli {
        Vec::new()
    } else {
        path.split(' ').collect()
    };
    let mut node = tree;
    for segment in segments {
        let Some(next) = node
            .get("commands")
            .filter(|c| c.is_object())
            .and_then(|c| c.get(segment))
        else {
            return Ok(None);
        };
        node = next;
    }
    if !node.is_object() {
        return Err(Error::new(
            "UNKNOWN",
            format!("Invalid config section for '{path}': expected an object"),
        ));
    }
    match node.get("options") {
        None => Ok(None),
        Some(Value::Object(options)) if options.is_empty() => Ok(None),
        Some(Value::Object(options)) => Ok(Some(options.clone())),
        Some(_) => Err(Error::new(
            "UNKNOWN",
            format!("Invalid config 'options' for '{path}': expected an object"),
        )),
    }
}

/// The protocol era of an MCP stdio connection.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Era {
    /// No message has picked an era yet.
    Opening,
    /// Only `server/discover` probes have arrived.
    Probe,
    /// The 2026-07-28 revision, with a per-request envelope.
    Modern,
    /// The 2025 `initialize` handshake.
    Legacy,
}
