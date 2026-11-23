#![doc = include_str!("../README.md")]

mod body;
mod cli;
mod command;
pub mod completions;
mod convert;
mod errors;
mod execute;
mod fetch;
pub mod filter;
pub mod formatter;
pub mod help;
mod js;
pub mod json;
pub mod mcp;
pub mod openapi;
pub mod parser;
mod remote;
pub mod schema;
mod server;
pub mod skill;
mod sync;
mod tokens;
mod toon;
pub mod update;
mod url;
mod yaml;

pub use body::Body;
pub use cli::{BannerMode, Cli, Config, Io};
pub use command::{
    Command, Context, HandlerOutput, Input, IntoOutcome, MaybeFuture, MiddlewareContext, Next,
    Outcome, OutputPolicy, Vars, marker, ok, stream,
};
pub use errors::{Cta, CtaBlock, Error, FieldError};
pub use fetch::{Fetch, FetchCommand};
pub use formatter::Format;
pub use incur_macros::Schema;
pub use mcp::Mcp;
pub use openapi::Openapi;
pub use remote::McpSource;
pub use schema::Schema;
pub use sync::SkillSync;
pub use update::Update;

#[doc(hidden)]
pub mod __private {
    //! Support code for the derive macro.

    use crate::schema::Type;

    /// Applies a serialized default to a field schema. `null` defaults, such as `None`, are
    /// ignored.
    pub fn default<T: serde::Serialize>(ty: Type, value: &T) -> Type {
        match serde_json::to_value(value) {
            Ok(serde_json::Value::Null) | Err(_) => ty,
            Ok(value) => ty.default_value(value),
        }
    }
}
