//! JSON parsing with JavaScript's `JSON.parse` semantics.

use serde_json::Value;

use crate::errors::Error;
use crate::js;

/// Parses JSON as JavaScript's `JSON.parse` does: every document V8 accepts parses, numbers
/// beyond the double range become `null` (as `JSON.stringify` prints infinities), and failures
/// carry V8's message, so handlers report the same errors as TypeScript ones.
///
/// ```
/// let value = incur::json::parse(r#"{"a":1e999}"#).unwrap();
/// assert_eq!(value, serde_json::json!({ "a": null }));
///
/// let error = incur::json::parse("{bad").unwrap_err();
/// assert_eq!(error.message, "Expected property name or '}' in JSON at position 1 (line 1 column 2)");
/// ```
///
/// # Errors
///
/// Returns an `UNKNOWN` error with V8's message when the text is not valid JSON.
pub fn parse(text: &str) -> Result<Value, Error> {
    js::json_parse(text, |_| Value::Null).map_err(Error::unknown)
}
