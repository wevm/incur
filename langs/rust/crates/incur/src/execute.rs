//! Command execution shared by the command line, HTTP, and MCP transports: runs middleware
//! around a handler and returns its data, error, or stream.

use std::future::poll_fn;
use std::task::Poll;

use futures_channel::oneshot;
use serde_json::{Map, Value};

use crate::command::{
    BoxFuture, Chunks, Handler, Inner, Invocation, Middleware, MiddlewareContext, Next, Outcome,
    Terminal,
};
use crate::elicit::Elicit;
use crate::errors::{CtaBlock, Error};
use crate::parser::{self, Parsed};
use crate::schema::Type;

/// Input parsed for a handler: arguments and options, and the command's environment.
pub(crate) type Input = Result<(Parsed, Value), Error>;

/// A command result.
pub(crate) enum Executed {
    /// Returned data.
    Data {
        /// Suggested next commands.
        cta: Option<CtaBlock>,
        /// The data, or `None` for none.
        data: Option<Value>,
    },
    /// A failure from parsing, middleware, or the handler.
    Error(Error),
    /// Streamed chunks. Consume them, then call [`Rest::finish`].
    Stream {
        /// The chunks, ending early at the first error.
        chunks: Chunks,
        /// Suggested next commands, shown after the stream.
        cta: Option<CtaBlock>,
        /// The middleware chain, waiting for the stream to be consumed.
        rest: Rest,
    },
}

/// The rest of a middleware chain around a streamed result.
pub(crate) struct Rest {
    /// Dropped to tell the handler step that the stream was consumed.
    done: oneshot::Sender<()>,
    /// The suspended chain.
    chain: Option<crate::command::BoxFuture<Result<(), Error>>>,
}

impl Rest {
    /// Lets middleware code after `next.run(c)` run, and returns the first middleware error.
    pub(crate) async fn finish(self) -> Result<(), Error> {
        drop(self.done);
        match self.chain {
            Some(chain) => chain.await,
            None => Ok(()),
        }
    }
}

/// A stream handed from the handler step, with its suggestions and the consumption signal.
type Handover = (Chunks, Option<CtaBlock>, oneshot::Sender<()>);

/// How far a middleware chain got before it yielded.
enum Step {
    /// The chain finished.
    Finished(Result<(), Error>),
    /// The handler handed over a stream, and the chain waits for it.
    Handover(Handover),
}

/// The result of a handed-over stream: middleware that already failed replaces it, and a chain
/// still running resumes after the stream is consumed.
fn handed_over(
    (chunks, cta, done): Handover,
    finished: Option<Result<(), Error>>,
    chain: BoxFuture<Result<(), Error>>,
) -> Executed {
    match finished {
        // A middleware error replaces the stream.
        Some(Err(error)) => Executed::Error(error),
        Some(Ok(())) => Executed::Stream {
            chunks,
            cta,
            rest: Rest { done, chain: None },
        },
        None => Executed::Stream {
            chunks,
            cta,
            rest: Rest {
                done,
                chain: Some(chain),
            },
        },
    }
}

/// Runs `chain` around `handler` with the parsed input. The input is reported after middleware
/// runs, as TypeScript parses inside the chain.
pub(crate) async fn execute(
    chain: Vec<Middleware>,
    context: MiddlewareContext,
    handler: Option<Handler>,
    input: Input,
    elicit: Elicit,
) -> Executed {
    execute_tracked(chain, context, handler, input, false, elicit)
        .await
        .0
}

/// Runs `chain` around `handler` and reports whether a returned `Executed::Error` came from
/// argument parsing rather than middleware or the handler.
pub(crate) async fn execute_tracked(
    chain: Vec<Middleware>,
    context: MiddlewareContext,
    handler: Option<Handler>,
    input: Input,
    input_parse_error: bool,
    elicit: Elicit,
) -> (Executed, bool) {
    let (outcome_tx, mut outcome_rx) = oneshot::channel();
    let (stream_tx, mut stream_rx) = oneshot::channel();
    let terminal = terminal(handler, input, elicit, outcome_tx, stream_tx);

    // Run the chain until it finishes or hands over a stream. The chain then waits until the
    // stream is consumed, so middleware code after `next.run(c)` runs after the stream ends.
    let mut chain: BoxFuture<Result<(), Error>> = Box::pin(Next::new(chain, terminal).run(context));
    let step = poll_fn(|cx| {
        if let Poll::Ready(result) = chain.as_mut().poll(cx) {
            return Poll::Ready(Step::Finished(result));
        }
        match stream_rx.try_recv().ok().flatten() {
            Some(handover) => Poll::Ready(Step::Handover(handover)),
            None => Poll::Pending,
        }
    })
    .await;
    let result = match step {
        Step::Handover(handover) => return (handed_over(handover, None, chain), false),
        // Middleware may abandon the chain after the handler hands over its stream.
        Step::Finished(result) => match stream_rx.try_recv().ok().flatten() {
            Some(handover) => return (handed_over(handover, Some(result), chain), false),
            None => result,
        },
    };
    match result {
        // A middleware error replaces the result.
        Err(error) => (Executed::Error(error), false),
        // Middleware that skips `next.run(c)` leaves no result.
        Ok(()) => match outcome_rx.try_recv().ok().flatten() {
            Some(Inner::Data { cta, data }) => (Executed::Data { cta, data }, false),
            Some(Inner::Error(error)) => (Executed::Error(error), input_parse_error),
            Some(Inner::Stream { .. }) | None => (
                Executed::Data {
                    cta: None,
                    data: None,
                },
                false,
            ),
        },
    }
}

/// Builds the final step of the middleware chain: reports the parse result, runs the handler,
/// and sends its result. A stream is handed over, and the step waits until it is consumed.
fn terminal(
    handler: Option<Handler>,
    input: Input,
    elicit: Elicit,
    outcome_tx: oneshot::Sender<Inner>,
    stream_tx: oneshot::Sender<Handover>,
) -> Terminal {
    Box::new(move |c| -> BoxFuture<Result<(), Error>> {
        Box::pin(async move {
            let outcome = match (input, handler) {
                (Err(error), _) => Outcome::from(error),
                (Ok(_), None) => Outcome(Inner::Data {
                    cta: None,
                    data: None,
                }),
                (Ok((parsed, env)), Some(handler)) => {
                    handler(Invocation {
                        agent: c.agent,
                        args: parsed.args,
                        display_name: c.display_name,
                        elicit,
                        env,
                        format: c.format,
                        format_explicit: c.format_explicit,
                        globals: c.globals,
                        name: c.name,
                        options: parsed.options,
                        request: c.request,
                        vars: c.vars,
                        version: c.version,
                    })
                    .await
                }
            };
            if let Inner::Stream { chunks, cta } = outcome.0 {
                let (done_tx, done_rx) = oneshot::channel();
                let _ = stream_tx.send((chunks, cta, done_tx));
                // Resolves with `Canceled` once the consumer drops the sender.
                let _ = done_rx.await;
            } else {
                let _ = outcome_tx.send(outcome.0);
            }
            Ok(())
        })
    })
}

/// Parses MCP tool arguments: one flat object split into arguments and options by the argument
/// schema's keys.
pub(crate) fn parse_flat(
    params: &Map<String, Value>,
    args: Option<&Type>,
    options: Option<&Type>,
) -> Result<Parsed, Error> {
    let (mut arg_input, mut option_input) = (Map::new(), Map::new());
    for (key, value) in params {
        if args.and_then(|a| a.field(key)).is_some() {
            arg_input.insert(key.clone(), value.clone());
        } else {
            option_input.insert(key.clone(), value.clone());
        }
    }
    let validate = |schema: Option<&Type>, input: &Map<String, Value>| match schema {
        Some(schema) => parser::validate(schema, input),
        None => Ok(Value::Object(Map::new())),
    };
    Ok(Parsed {
        args: validate(args, &arg_input)?,
        options: validate(options, &option_input)?,
    })
}

/// Parses an HTTP invocation: arguments from path segments, options from the query or body.
pub(crate) fn parse_split_tracked(
    rest: &[String],
    params: &Map<String, Value>,
    args: Option<&Type>,
    options: Option<&Type>,
) -> Result<Parsed, (Error, bool)> {
    let parsed = parser::parse(rest, args, None, None).map_err(|e| (e, true))?;
    Ok(Parsed {
        args: parsed.args,
        options: match options {
            Some(schema) => parser::validate(schema, params).map_err(|e| (e, false))?,
            None => Value::Object(Map::new()),
        },
    })
}

#[allow(dead_code)]
pub(crate) fn parse_split(
    rest: &[String],
    params: &Map<String, Value>,
    args: Option<&Type>,
    options: Option<&Type>,
) -> Result<Parsed, Error> {
    let parsed = parser::parse(rest, args, None, None)?;
    Ok(Parsed {
        args: parsed.args,
        options: match options {
            Some(schema) => parser::validate(schema, params)?,
            None => Value::Object(Map::new()),
        },
    })
}

/// Parses a command environment from a lookup.
pub(crate) fn parse_env(
    schema: Option<&Type>,
    env: &(dyn Fn(&str) -> Option<String> + Sync),
) -> Result<Value, Error> {
    match schema {
        Some(schema) => parser::parse_env(schema, env),
        None => Ok(Value::Object(Map::new())),
    }
}
