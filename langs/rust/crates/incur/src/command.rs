//! Commands, their run context, results, and middleware.

use std::any::{Any, TypeId};
use std::fmt;
use std::sync::Arc;

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
        chunks: Box<dyn Iterator<Item = Result<Value, Error>>>,
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

/// Streams chunks. Human and TOON output writes each chunk as it arrives; JSONL writes one
/// `chunk` record per item; other explicit formats buffer the chunks into one array.
pub fn stream<I, T>(chunks: I) -> Outcome
where
    I: IntoIterator<Item = Result<T, Error>>,
    I::IntoIter: 'static,
    T: Serialize,
{
    let chunks = chunks
        .into_iter()
        .map(|chunk| chunk.and_then(|value| Ok(js::normalize(serde_json::to_value(value)?))));
    Outcome(Inner::Stream {
        chunks: Box::new(chunks),
        cta: None,
    })
}

/// Values a handler may return.
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
    /// Variables.
    pub(crate) vars: Vars,
    /// CLI version.
    pub(crate) version: Option<String>,
}

/// A type-erased handler.
pub(crate) type Handler = Arc<dyn Fn(Invocation) -> Outcome + Send + Sync>;

/// Middleware: runs around command handlers in registration order.
pub type Middleware =
    Arc<dyn Fn(&mut MiddlewareContext, Next<'_>) -> Result<(), Error> + Send + Sync>;

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
    /// ```
    /// use incur::{Command, Context, Schema};
    /// use serde::Deserialize;
    ///
    /// #[derive(Deserialize, Schema)]
    /// struct Args {
    ///     /// Name to greet.
    ///     name: String,
    /// }
    ///
    /// let command = Command::new().run(|c: Context<Args>| {
    ///     Ok::<_, incur::Error>(serde_json::json!({ "message": format!("hello {}", c.args.name) }))
    /// });
    /// ```
    #[must_use]
    pub fn run<A, O, E, F, R>(mut self, f: F) -> Self
    where
        A: Input + 'static,
        O: Input + 'static,
        E: Input + 'static,
        F: Fn(Context<A, O, E>) -> R + Send + Sync + 'static,
        R: IntoOutcome,
    {
        self.args = A::schema();
        self.options = O::schema();
        self.env = E::schema();
        self.handler = Some(Arc::new(move |input: Invocation| {
            let context = (|| {
                Ok::<_, Error>(Context {
                    agent: input.agent,
                    args: A::from_value(input.args)?,
                    display_name: input.display_name,
                    env: E::from_value(input.env)?,
                    format: input.format,
                    format_explicit: input.format_explicit,
                    globals: input.globals,
                    name: input.name,
                    options: O::from_value(input.options)?,
                    vars: input.vars,
                    version: input.version,
                })
            })();
            match context {
                Ok(context) => f(context).into_outcome(),
                Err(error) => error.into(),
            }
        }));
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

    /// Adds per-command middleware, which runs after CLI and group middleware.
    #[must_use]
    pub fn middleware<F>(mut self, f: F) -> Self
    where
        F: Fn(&mut MiddlewareContext, Next<'_>) -> Result<(), Error> + Send + Sync + 'static,
    {
        self.middleware.push(Arc::new(f));
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

    /// Adds an alternative usage line.
    #[must_use]
    pub fn usage(mut self, usage: Usage) -> Self {
        self.usage.push(usage);
        self
    }
}

/// The context middleware receives.
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

/// Runs the rest of the middleware chain and the command.
pub struct Next<'a>(&'a mut dyn FnMut(&mut MiddlewareContext));

impl Next<'_> {
    /// Runs downstream middleware and the command handler.
    pub fn run(self, context: &mut MiddlewareContext) {
        (self.0)(context);
    }
}

/// Runs a middleware chain around `last`. A middleware error replaces the result, and the
/// outermost error wins, as the last `c.error()` call does in TypeScript.
pub(crate) fn run_chain(
    chain: &[Middleware],
    context: &mut MiddlewareContext,
    error: &mut Option<Error>,
    last: &mut dyn FnMut(&mut MiddlewareContext),
) {
    let Some((first, rest)) = chain.split_first() else {
        last(context);
        return;
    };
    let mut inner_error = None;
    let result = {
        let mut next = |c: &mut MiddlewareContext| run_chain(rest, c, &mut inner_error, last);
        first(context, Next(&mut next))
    };
    if inner_error.is_some() {
        *error = inner_error;
    }
    if let Err(failure) = result {
        *error = Some(failure);
    }
}
