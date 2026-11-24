//! Commands, their run context, results, and middleware.

use std::any::{Any, TypeId};
use std::fmt;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};

use futures_core::Stream;
use indexmap::IndexMap;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::errors::{CtaBlock, Error};
use crate::formatter::Format;
use crate::help::{Example, Usage};
use crate::js;
use crate::schema::{Schema, Type};

/// Input types a command reads: `()` for none, or any [`Schema`] that deserializes.
pub trait Input: Sized {
    /// Returns the schema, or `None` when the command takes no input of this kind.
    fn schema() -> Option<Type>;

    /// Deserializes validated input.
    ///
    /// # Errors
    ///
    /// Returns an error when the value does not deserialize into the type.
    fn from_value(value: Value) -> Result<Self, serde_json::Error>;
}

impl Input for () {
    fn schema() -> Option<Type> {
        None
    }

    fn from_value(_: Value) -> Result<Self, serde_json::Error> {
        Ok(())
    }
}

impl<T: Schema + DeserializeOwned> Input for T {
    fn schema() -> Option<Type> {
        Some(T::schema())
    }

    fn from_value(value: Value) -> Result<Self, serde_json::Error> {
        serde_json::from_value(value)
    }
}

/// Typed values that middleware sets and handlers read, keyed by type.
#[derive(Clone, Default)]
pub struct Vars(IndexMap<TypeId, Arc<dyn Any + Send + Sync>>);

impl Vars {
    /// Stores a value, replacing any value of the same type.
    pub fn set<T: Any + Send + Sync>(&mut self, value: T) {
        self.0.insert(TypeId::of::<T>(), Arc::new(value));
    }

    /// Returns the value of a type.
    pub fn get<T: Any + Send + Sync>(&self) -> Option<&T> {
        self.0.get(&TypeId::of::<T>())?.downcast_ref()
    }
}

impl fmt::Debug for Vars {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Vars").field("len", &self.0.len()).finish()
    }
}

/// Deserializes a JSON value into a type, converting failures to `UNKNOWN` errors.
fn deserialize<T: DeserializeOwned>(value: &Value) -> Result<T, Error> {
    serde_json::from_value(value.clone()).map_err(Error::from)
}

/// The context a command handler receives.
#[derive(Debug)]
pub struct Context<A = (), O = (), E = ()> {
    /// Whether the consumer is an agent (stdout is not a terminal).
    pub agent: bool,
    /// Positional arguments.
    pub args: A,
    /// The binary name the user invoked.
    pub display_name: String,
    /// Environment variables declared by the command.
    pub env: E,
    /// The resolved output format.
    pub format: Format,
    /// Whether the user passed `--format` or `--json`.
    pub format_explicit: bool,
    /// Global options, as parsed JSON.
    pub globals: Value,
    /// The CLI name.
    pub name: String,
    /// Named options.
    pub options: O,
    /// The HTTP request, when the command runs through [`Cli::fetch`](crate::Cli::fetch) or MCP
    /// over HTTP. Its body has already been read into the arguments and options.
    pub request: Option<Arc<http::request::Parts>>,
    /// Variables set by middleware.
    pub vars: Vars,
    /// The CLI version.
    pub version: Option<String>,
}

impl<A, O, E> Context<A, O, E> {
    /// Deserializes the global options.
    ///
    /// # Errors
    ///
    /// Returns an error when the globals do not deserialize into `G`.
    pub fn globals<G: DeserializeOwned>(&self) -> Result<G, Error> {
        deserialize(&self.globals)
    }

    /// Returns a variable set by middleware or as a CLI default.
    pub fn var<T: Any + Send + Sync>(&self) -> Option<&T> {
        self.vars.get()
    }
}

/// A boxed future that can move between threads.
pub(crate) type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// Streamed chunks, converted to JSON.
pub(crate) type Chunks = Pin<Box<dyn Stream<Item = Result<Value, Error>> + Send>>;

/// A command result: data, an error, or a stream of chunks.
pub struct Outcome(pub(crate) Inner);

/// The internal representation of an [`Outcome`].
pub(crate) enum Inner {
    /// Returned data.
    Data {
        /// Suggested next commands.
        cta: Option<CtaBlock>,
        /// The data, or `None` for no data.
        data: Option<Value>,
    },
    /// A failure.
    Error(Error),
    /// Streamed chunks.
    Stream {
        /// Chunks, ending early at the first error.
        chunks: Chunks,
        /// Suggested next commands, shown after the stream.
        cta: Option<CtaBlock>,
    },
}

impl Outcome {
    /// Attaches suggested next commands to data or a stream. Errors carry their own suggestions.
    #[must_use]
    pub fn cta(mut self, block: CtaBlock) -> Self {
        match &mut self.0 {
            Inner::Data { cta, .. } | Inner::Stream { cta, .. } => *cta = Some(block),
            Inner::Error(error) => error.cta = Some(Box::new(block)),
        }
        self
    }
}

impl fmt::Debug for Outcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            Inner::Data { data, .. } => f.debug_tuple("Data").field(data).finish(),
            Inner::Error(error) => f.debug_tuple("Error").field(error).finish(),
            Inner::Stream { .. } => f.write_str("Stream"),
        }
    }
}

/// Converts serializable data into JSON, treating `null` as no data.
fn to_data<T: Serialize>(data: &T) -> Result<Option<Value>, Error> {
    let value = js::normalize(serde_json::to_value(data)?);
    Ok((!value.is_null()).then_some(value))
}

/// Returns data as a successful outcome.
pub fn ok<T: Serialize>(data: T) -> Outcome {
    Outcome(match to_data(&data) {
        Ok(data) => Inner::Data { cta: None, data },
        Err(error) => Inner::Error(error),
    })
}

/// Streams chunks from any [`Stream`], such as `futures::stream::iter` over a vector or a
/// channel receiver. Human and TOON output writes each chunk as it arrives; JSONL writes one
/// `chunk` record per item; other explicit formats buffer the chunks into one array. The first
/// error ends the stream.
///
/// ```
/// use incur::{Command, Context};
///
/// #[derive(serde::Serialize)]
/// struct Progress {
///     percent: u8,
/// }
///
/// let command = Command::new().run(|_: Context| {
///     incur::stream(futures::stream::iter([
///         Ok(Progress { percent: 50 }),
///         Ok(Progress { percent: 100 }),
///     ]))
/// });
/// ```
pub fn stream<S, T>(chunks: S) -> Outcome
where
    S: Stream<Item = Result<T, Error>> + Send + 'static,
    T: Serialize,
{
    Outcome(Inner::Stream {
        chunks: Box::pin(ToJson(Box::pin(chunks))),
        cta: None,
    })
}

/// A stream adapter that converts serializable chunks to JSON.
struct ToJson<S>(Pin<Box<S>>);

impl<S, T> Stream for ToJson<S>
where
    S: Stream<Item = Result<T, Error>>,
    T: Serialize,
{
    type Item = Result<Value, Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>> {
        self.0.as_mut().poll_next(cx).map(|chunk| {
            chunk.map(|chunk| {
                chunk.and_then(|value| Ok(js::normalize(serde_json::to_value(value)?)))
            })
        })
    }
}

/// Marker types that tell [`HandlerOutput`] implementations apart, so one `run` method accepts
/// both plain and `async` handlers.
pub mod marker {
    /// Marks values a handler returns directly.
    pub enum Immediate {}

    /// Marks futures a handler returns, resolved by awaiting them.
    pub enum Deferred {}

    /// Marks serializable data a handler returns directly.
    pub enum Data {}

    /// Marks futures that resolve to serializable data.
    pub enum DeferredData {}
}

/// A `Result` whose error defaults to [`Error`], for handlers and helpers that may fail.
///
/// ```
/// use incur::{Command, Context};
///
/// let command = Command::new().run(|_: Context| -> incur::Result<u32> {
///     let parsed = "42".parse::<u32>().map_err(incur::Error::unknown)?;
///     Ok(parsed)
/// });
/// ```
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Values a handler may return:
///
/// - any serializable data, such as a struct deriving `Serialize` (`null` and `()` mean no
///   data);
/// - anything [`IntoOutcome`]: an [`Outcome`] from [`ok`] or [`stream`], or a `Result` of
///   either;
/// - a [`Future`] that resolves to any of these, such as an `async` block.
///
/// The marker `M` is inferred. A `Result` whose error type is itself serializable, such as
/// `Result<T, String>`, matches two forms; return `Result<T, Error>` instead.
pub trait HandlerOutput<M> {
    /// Resolves the value to an outcome.
    fn resolve(self) -> impl Future<Output = Outcome> + Send + 'static;
}

impl<R: IntoOutcome> HandlerOutput<marker::Immediate> for R {
    fn resolve(self) -> impl Future<Output = Outcome> + Send + 'static {
        std::future::ready(self.into_outcome())
    }
}

impl<F> HandlerOutput<marker::Deferred> for F
where
    F: Future + Send + 'static,
    F::Output: IntoOutcome,
{
    async fn resolve(self) -> Outcome {
        self.await.into_outcome()
    }
}

impl<T: Serialize> HandlerOutput<marker::Data> for T {
    fn resolve(self) -> impl Future<Output = Outcome> + Send + 'static {
        std::future::ready(ok(self))
    }
}

impl<F> HandlerOutput<marker::DeferredData> for F
where
    F: Future + Send + 'static,
    F::Output: Serialize,
{
    async fn resolve(self) -> Outcome {
        ok(self.await)
    }
}

/// Values a callback may return: a `T` directly, or a [`Future`] that resolves to one.
///
/// The marker `M` is inferred: [`marker::Immediate`] for direct values and [`marker::Deferred`]
/// for futures.
pub trait MaybeFuture<T, M> {
    /// Resolves the value.
    fn resolve(self) -> impl Future<Output = T> + Send + 'static;
}

impl<T: Send + 'static> MaybeFuture<T, marker::Immediate> for T {
    fn resolve(self) -> impl Future<Output = T> + Send + 'static {
        std::future::ready(self)
    }
}

impl<F, T> MaybeFuture<T, marker::Deferred> for F
where
    F: Future<Output = T> + Send + 'static,
{
    fn resolve(self) -> impl Future<Output = T> + Send + 'static {
        self
    }
}

/// Values that convert to an outcome: an [`Outcome`], or a `Result` of serializable data.
pub trait IntoOutcome {
    /// Converts the value into an outcome.
    fn into_outcome(self) -> Outcome;
}

impl IntoOutcome for Outcome {
    fn into_outcome(self) -> Outcome {
        self
    }
}

impl From<Error> for Outcome {
    fn from(error: Error) -> Self {
        Self(Inner::Error(error))
    }
}

impl<T: Serialize, E: Into<Error>> IntoOutcome for Result<T, E> {
    fn into_outcome(self) -> Outcome {
        match self {
            Ok(data) => ok(data),
            Err(error) => Outcome(Inner::Error(error.into())),
        }
    }
}

impl<E: Into<Error>> IntoOutcome for Result<Outcome, E> {
    fn into_outcome(self) -> Outcome {
        self.unwrap_or_else(|error| Outcome(Inner::Error(error.into())))
    }
}

/// Where a command output may appear.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum OutputPolicy {
    /// Humans and agents see the data.
    #[default]
    All,
    /// Only agents see the data. Terminals see suggestions and errors only.
    AgentOnly,
}

/// The raw inputs a type-erased handler receives.
pub(crate) struct Invocation {
    /// Whether the consumer is an agent.
    pub(crate) agent: bool,
    /// Parsed arguments.
    pub(crate) args: Value,
    /// Display name.
    pub(crate) display_name: String,
    /// Parsed command environment.
    pub(crate) env: Value,
    /// Output format.
    pub(crate) format: Format,
    /// Whether the format was explicit.
    pub(crate) format_explicit: bool,
    /// Parsed globals.
    pub(crate) globals: Value,
    /// CLI name.
    pub(crate) name: String,
    /// Parsed options.
    pub(crate) options: Value,
    /// The HTTP request.
    pub(crate) request: Option<Arc<http::request::Parts>>,
    /// Variables.
    pub(crate) vars: Vars,
    /// CLI version.
    pub(crate) version: Option<String>,
}

impl Invocation {
    /// Builds a handler context around deserialized inputs.
    pub(crate) fn into_context<A, O, E>(self, args: A, options: O, env: E) -> Context<A, O, E> {
        Context {
            agent: self.agent,
            args,
            display_name: self.display_name,
            env,
            format: self.format,
            format_explicit: self.format_explicit,
            globals: self.globals,
            name: self.name,
            options,
            request: self.request,
            vars: self.vars,
            version: self.version,
        }
    }
}

/// A type-erased handler.
pub(crate) type Handler = Arc<dyn Fn(Invocation) -> BoxFuture<Outcome> + Send + Sync>;

/// Type-erased middleware: runs around command handlers in registration order.
pub(crate) type Middleware =
    Arc<dyn Fn(MiddlewareContext, Next) -> BoxFuture<Result<(), Error>> + Send + Sync>;

/// Erases a middleware function.
pub(crate) fn middleware<F, R>(f: F) -> Middleware
where
    F: Fn(MiddlewareContext, Next) -> R + Send + Sync + 'static,
    R: Future<Output = Result<(), Error>> + Send + 'static,
{
    Arc::new(move |context, next| Box::pin(f(context, next)))
}

/// A command definition.
#[derive(Clone, Default)]
pub struct Command {
    /// Alternative names.
    pub(crate) aliases: Vec<String>,
    /// Positional arguments schema.
    pub(crate) args: Option<Type>,
    /// Whether the command changes or deletes state.
    pub(crate) destructive: bool,
    /// Description.
    pub(crate) description: Option<String>,
    /// Environment schema.
    pub(crate) env: Option<Type>,
    /// Examples.
    pub(crate) examples: Vec<Example>,
    /// Default output format.
    pub(crate) format: Option<Format>,
    /// The handler.
    pub(crate) handler: Option<Handler>,
    /// Extra guidance.
    pub(crate) hint: Option<String>,
    /// MCP tool settings.
    pub(crate) mcp: Option<crate::mcp::Tool>,
    /// Per-command middleware.
    pub(crate) middleware: Vec<Middleware>,
    /// Options schema.
    pub(crate) options: Option<Type>,
    /// Output schema.
    pub(crate) output: Option<Type>,
    /// Output policy.
    pub(crate) output_policy: Option<OutputPolicy>,
    /// Alternative usage lines.
    pub(crate) usage: Vec<Usage>,
}

impl fmt::Debug for Command {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Command")
            .field("description", &self.description)
            .finish_non_exhaustive()
    }
}

impl Command {
    /// Creates a command without a handler.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the handler. The argument, option, and environment schemas come from the context
    /// type the closure declares.
    ///
    /// The handler returns any [`HandlerOutput`]: serializable data, a `Result` of it, an
    /// [`Outcome`], or a future that resolves to one of these, such as an `async` block.
    ///
    /// ```
    /// use incur::{Command, Context, Schema};
    /// use serde::{Deserialize, Serialize};
    ///
    /// #[derive(Deserialize, Schema)]
    /// struct Args {
    ///     /// Name to greet.
    ///     name: String,
    /// }
    ///
    /// #[derive(Serialize)]
    /// struct Greeting {
    ///     message: String,
    /// }
    ///
    /// let greet = Command::new().run(|c: Context<Args>| Greeting {
    ///     message: format!("hello {}", c.args.name),
    /// });
    ///
    /// let fetch = Command::new().run(|c: Context<Args>| async move {
    ///     // Await IO here.
    ///     Greeting { message: c.args.name }
    /// });
    ///
    /// let check = Command::new().run(|c: Context<Args>| -> incur::Result<Greeting> {
    ///     if c.args.name.is_empty() {
    ///         return Err(incur::Error::new("EMPTY", "Name is empty"));
    ///     }
    ///     Ok(Greeting { message: c.args.name })
    /// });
    /// ```
    #[must_use]
    pub fn run<A, O, E, F, R, M>(mut self, f: F) -> Self
    where
        A: Input + 'static,
        O: Input + 'static,
        E: Input + 'static,
        F: Fn(Context<A, O, E>) -> R + Send + Sync + 'static,
        R: HandlerOutput<M>,
    {
        self.args = A::schema();
        self.options = O::schema();
        self.env = E::schema();
        self.handler = Some(Arc::new(
            move |mut input: Invocation| -> BoxFuture<Outcome> {
                let inputs = (|| {
                    Ok::<_, Error>((
                        A::from_value(std::mem::take(&mut input.args))?,
                        O::from_value(std::mem::take(&mut input.options))?,
                        E::from_value(std::mem::take(&mut input.env))?,
                    ))
                })();
                match inputs {
                    Ok((args, options, env)) => {
                        Box::pin(f(input.into_context(args, options, env)).resolve())
                    }
                    Err(error) => Box::pin(std::future::ready(error.into())),
                }
            },
        ));
        self
    }

    /// Sets alternative names, such as `ext` for `extension`.
    #[must_use]
    pub fn aliases(mut self, aliases: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.aliases = aliases.into_iter().map(Into::into).collect();
        self
    }

    /// Marks the command as destructive in generated agent skills.
    #[must_use]
    pub fn destructive(mut self) -> Self {
        self.destructive = true;
        self
    }

    /// Sets the description.
    #[must_use]
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Adds an example: the arguments after the command name and an optional description.
    #[must_use]
    pub fn example(mut self, command: impl Into<String>, description: Option<&str>) -> Self {
        self.examples.push(Example {
            command: command.into(),
            description: description.map(str::to_owned),
        });
        self
    }

    /// Sets the default output format.
    #[must_use]
    pub fn format(mut self, format: Format) -> Self {
        self.format = Some(format);
        self
    }

    /// Sets guidance shown after examples.
    #[must_use]
    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// Adds per-command middleware, which runs after CLI and group middleware. See
    /// [`Cli::middleware`](crate::Cli::middleware).
    #[must_use]
    pub fn middleware<F, R>(mut self, f: F) -> Self
    where
        F: Fn(MiddlewareContext, Next) -> R + Send + Sync + 'static,
        R: Future<Output = Result<(), Error>> + Send + 'static,
    {
        self.middleware.push(middleware(f));
        self
    }

    /// Sets the output schema.
    #[must_use]
    pub fn output<T: Schema>(mut self) -> Self {
        self.output = Some(T::schema());
        self
    }

    /// Sets the output policy.
    #[must_use]
    pub fn output_policy(mut self, policy: OutputPolicy) -> Self {
        self.output_policy = Some(policy);
        self
    }

    /// Configures the command's MCP tool: its name, description, annotations, and
    /// instructions. `false` hides the command from MCP clients.
    #[must_use]
    pub fn mcp(mut self, tool: impl Into<crate::mcp::Tool>) -> Self {
        self.mcp = Some(tool.into());
        self
    }

    /// Adds an alternative usage line.
    #[must_use]
    pub fn usage(mut self, usage: Usage) -> Self {
        self.usage.push(usage);
        self
    }
}

/// The context middleware receives. Middleware owns it and passes it on with [`Next::run`], so
/// variables it sets reach downstream middleware and the handler.
#[derive(Debug)]
pub struct MiddlewareContext {
    /// Whether the consumer is an agent.
    pub agent: bool,
    /// The resolved command path.
    pub command: String,
    /// The binary name the user invoked.
    pub display_name: String,
    /// CLI-level environment variables, as parsed JSON.
    pub env: Value,
    /// The resolved output format.
    pub format: Format,
    /// Whether the user passed `--format` or `--json`.
    pub format_explicit: bool,
    /// Global options, as parsed JSON.
    pub globals: Value,
    /// The CLI name.
    pub name: String,
    /// The HTTP request, when the command runs through [`Cli::fetch`](crate::Cli::fetch) or MCP
    /// over HTTP.
    pub request: Option<Arc<http::request::Parts>>,
    /// Variables for downstream middleware and handlers.
    pub vars: Vars,
    /// The CLI version.
    pub version: Option<String>,
}

impl MiddlewareContext {
    /// Sets a variable for downstream middleware and handlers.
    pub fn set<T: Any + Send + Sync>(&mut self, value: T) {
        self.vars.set(value);
    }

    /// Returns a variable.
    pub fn var<T: Any + Send + Sync>(&self) -> Option<&T> {
        self.vars.get()
    }
}

/// The final step of a middleware chain: parses input and runs the command.
pub(crate) type Terminal =
    Box<dyn FnOnce(MiddlewareContext) -> BoxFuture<Result<(), Error>> + Send>;

/// Runs the rest of the middleware chain and the command.
pub struct Next {
    /// The middleware that has not run yet.
    rest: std::vec::IntoIter<Middleware>,
    /// The command step.
    terminal: Terminal,
}

impl Next {
    /// Creates a chain that runs `middleware` in order around `terminal`.
    pub(crate) fn new(middleware: Vec<Middleware>, terminal: Terminal) -> Self {
        Self {
            rest: middleware.into_iter(),
            terminal,
        }
    }

    /// Runs downstream middleware and the command handler with the given context.
    ///
    /// Resolves to the first error downstream middleware returns. Handler failures are the
    /// command's result, not middleware errors, so they resolve to `Ok(())`. A streamed result
    /// resolves after the stream has been written.
    pub fn run(
        mut self,
        context: MiddlewareContext,
    ) -> impl Future<Output = Result<(), Error>> + Send + 'static {
        match self.rest.next() {
            Some(middleware) => middleware(context, self),
            None => (self.terminal)(context),
        }
    }
}

impl fmt::Debug for Next {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Next")
            .field("remaining", &self.rest.len())
            .finish_non_exhaustive()
    }
}
