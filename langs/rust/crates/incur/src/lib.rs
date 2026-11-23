#![doc = include_str!("../README.md")]

mod cli;
mod command;
pub mod completions;
mod errors;
pub mod filter;
pub mod formatter;
pub mod help;
mod js;
pub mod parser;
pub mod schema;
pub mod skill;
mod tokens;
mod toon;
mod yaml;

pub use cli::{BannerMode, Cli, Config, Io};
pub use command::{
    Command, Context, Input, IntoOutcome, Middleware, MiddlewareContext, Next, Outcome,
    OutputPolicy, Vars, ok, stream,
};
pub use errors::{Cta, CtaBlock, Error, FieldError};
pub use formatter::Format;
pub use incur_macros::Schema;
pub use schema::Schema;

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
