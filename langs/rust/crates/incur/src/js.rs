//! JavaScript string, number, and object semantics that reach output.
//!
//! The TypeScript package formats values with `String(number)`, `JSON.stringify`, and
//! `localeCompare`, and JavaScript objects list integer-like keys first. Every module that formats
//! output reuses these functions, so the Rust port prints the same bytes.

use std::cmp::Ordering;
use std::fmt::Write as _;

use serde_json::{Map, Number, Value};

/// Formats a number as ECMAScript `Number.prototype.toString` does.
pub(crate) fn number_to_string(value: f64) -> String {
    ryu_js::Buffer::new().format(value).to_owned()
}

/// Converts a finite number to a JSON value, storing integral values as integers.
///
/// Non-finite numbers become `null`, as in `JSON.stringify`.
pub(crate) fn number(value: f64) -> Value {
    #[expect(
        clippy::cast_possible_truncation,
        reason = "The value is integral and within the i64 range."
    )]
    if value.fract() == 0.0 && value.abs() < 9.0e15 {
        return Value::from(value as i64);
    }
    Number::from_f64(value).map_or(Value::Null, Value::Number)
}

/// Formats a JSON number as JavaScript does.
pub(crate) fn format_number(number: &Number) -> String {
    // JavaScript numbers are doubles, so integers beyond 2^53 print rounded.
    number_to_string(number.as_f64().unwrap_or(f64::NAN))
}

/// Converts a string to a number as ECMAScript `Number(string)` does.
pub(crate) fn to_number(input: &str) -> f64 {
    let text = input.trim_matches(is_whitespace);
    if text.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = text.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|ch| ch.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |acc, ch| {
                acc * f64::from(radix) + f64::from(ch.to_digit(radix).unwrap_or_default())
            });
        }
    }
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned == "Infinity" {
        return if text.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    if !is_decimal_literal(unsigned) {
        return f64::NAN;
    }
    text.parse().unwrap_or(f64::NAN)
}

/// Whether `text` matches ECMAScript's `StrUnsignedDecimalLiteral` without `Infinity`.
fn is_decimal_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut index = 0;
    let digits = |index: &mut usize| {
        let start = *index;
        while bytes.get(*index).is_some_and(u8::is_ascii_digit) {
            *index += 1;
        }
        *index - start
    };
    let mut mantissa = digits(&mut index);
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        mantissa += digits(&mut index);
    }
    if mantissa == 0 {
        return false;
    }
    if matches!(bytes.get(index), Some(b'e' | b'E')) {
        index += 1;
        if matches!(bytes.get(index), Some(b'+' | b'-')) {
            index += 1;
        }
        if digits(&mut index) == 0 {
            return false;
        }
    }
    index == bytes.len()
}

/// Whether a character is ECMAScript white space or a line terminator, as `String.prototype.trim`
/// and `\s` match.
pub(crate) fn is_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// Returns the length of a string in UTF-16 code units, as `String.prototype.length` does.
pub(crate) fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// Serializes a value as `JSON.stringify(value)` does.
pub(crate) fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_json(&mut out, value, None, "");
    out
}

/// Serializes a value as `JSON.stringify(value, null, 2)` does.
pub(crate) fn stringify_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_json(&mut out, value, Some("  "), "");
    out
}

/// Writes JSON with an optional indentation step.
fn write_json(out: &mut String, value: &Value, step: Option<&str>, indent: &str) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&format_number(number)),
        Value::String(string) => quote(out, string),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            let inner = step.map(|step| format!("{indent}{step}"));
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                if let Some(inner) = &inner {
                    out.push('\n');
                    out.push_str(inner);
                }
                write_json(out, item, step, inner.as_deref().unwrap_or(""));
            }
            if inner.is_some() {
                out.push('\n');
                out.push_str(indent);
            }
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            let inner = step.map(|step| format!("{indent}{step}"));
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                if let Some(inner) = &inner {
                    out.push('\n');
                    out.push_str(inner);
                }
                quote(out, key);
                out.push(':');
                if inner.is_some() {
                    out.push(' ');
                }
                write_json(out, item, step, inner.as_deref().unwrap_or(""));
            }
            if inner.is_some() {
                out.push('\n');
                out.push_str(indent);
            }
            out.push('}');
        }
    }
}

/// Writes a JSON string literal with `JSON.stringify` escaping.
fn quote(out: &mut String, value: &str) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if u32::from(ch) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(ch));
            }
            ch => out.push(ch),
        }
    }
    out.push('"');
}

/// Reorders object keys as JavaScript objects store them: integer-like keys first in ascending
/// order, then other keys in insertion order. Applies recursively.
pub(crate) fn normalize(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(normalize).collect()),
        Value::Object(map) => {
            let mut indices = Vec::new();
            let mut rest = Map::new();
            for (key, item) in map {
                let item = normalize(item);
                match array_index(&key) {
                    Some(index) => indices.push((index, key, item)),
                    None => {
                        rest.insert(key, item);
                    }
                }
            }
            if indices.is_empty() {
                return Value::Object(rest);
            }
            indices.sort_by_key(|(index, ..)| *index);
            let mut out = Map::new();
            for (_, key, item) in indices {
                out.insert(key, item);
            }
            out.extend(rest);
            Value::Object(out)
        }
        value => value,
    }
}

/// Resolves a `slice` bound as JavaScript does: truncated toward zero, counted from the end when
/// negative, and clamped to `0..=len`. NaN resolves to 0.
pub(crate) fn relative_index(value: f64, len: usize) -> usize {
    #[expect(clippy::cast_precision_loss, reason = "Lengths are far below 2^52.")]
    let len = len as f64;
    // `ToIntegerOrInfinity` maps NaN to 0.
    let value = if value.is_nan() { 0.0 } else { value.trunc() };
    let index = if value < 0.0 { len + value } else { value };
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "The index is clamped to `0..=len`."
    )]
    let index = index.clamp(0.0, len) as usize;
    index
}

/// Returns the element JavaScript reads at `array[value]`: only exact non-negative integers
/// index an array.
pub(crate) fn element<T>(items: &[T], value: f64) -> Option<&T> {
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "The value is a non-negative integer."
    )]
    let index = (value >= 0.0 && value.fract() == 0.0).then_some(value as usize)?;
    items.get(index)
}

/// Parses a canonical array index, the keys JavaScript orders first.
pub(crate) fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

/// Formats a value as `String(value)` does for JSON data.
pub(crate) fn to_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(number) => format_number(number),
        Value::String(string) => string.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                item => to_string(item),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// Converts a camelCase name to kebab-case.
pub(crate) fn to_kebab(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 4);
    for ch in value.chars() {
        if ch.is_ascii_uppercase() {
            out.push('-');
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// Compares strings as `String.prototype.localeCompare` does under the ICU root collation.
///
/// Compares case-insensitive primary weights first, where whitespace, punctuation, and symbols
/// sort before digits and digits before letters. Lowercase letters then sort before uppercase,
/// and code points break remaining ties.
pub(crate) fn locale_compare(a: &str, b: &str) -> Ordering {
    let primary = |value: &str| value.chars().map(primary_weight).collect::<Vec<_>>();
    primary(a)
        .cmp(&primary(b))
        .then_with(|| {
            let tertiary = |value: &str| value.chars().map(char::is_uppercase).collect::<Vec<_>>();
            tertiary(a).cmp(&tertiary(b))
        })
        .then_with(|| a.cmp(b))
}

/// Returns the primary collation weight of a character.
fn primary_weight(ch: char) -> u32 {
    // Root collation order of ASCII whitespace, punctuation, and symbols.
    const SYMBOLS: &str = "\t\n\u{b}\u{c}\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    if let Some(index) = SYMBOLS.find(ch) {
        #[expect(clippy::cast_possible_truncation, reason = "The table is short.")]
        return index as u32;
    }
    if ch.is_ascii_digit() {
        return 100 + u32::from(ch);
    }
    if ch.is_ascii_alphabetic() {
        return 200 + u32::from(ch.to_ascii_lowercase());
    }
    1000 + u32::from(ch)
}

/// Returns the message V8's `JSON.parse` throws for invalid JSON text, or `None` when V8 accepts
/// the text.
pub(crate) fn json_parse_error(source: &str) -> Option<String> {
    let chars = source.encode_utf16().collect::<Vec<_>>();
    let mut parser = JsonSyntax {
        chars: &chars,
        pos: 0,
    };
    let result = parser.value().and_then(|()| {
        parser.whitespace();
        match parser.peek() {
            None => Ok(()),
            Some(ch) if (0x30..=0x39).contains(&ch) => Err(parser.at("Unexpected number in JSON")),
            Some(_) => Err(parser.at("Unexpected non-whitespace character after JSON")),
        }
    });
    let failure = result.err()?;
    Some(match failure {
        Failure::End => "Unexpected end of JSON input".into(),
        Failure::Message(message) => message,
        Failure::Token => {
            let token = String::from_utf16_lossy(&chars[parser.pos..=parser.pos]);
            let context = if chars.len() < 21 {
                format!("\"{source}\"")
            } else {
                let start = parser.pos.saturating_sub(10);
                let end = (parser.pos + 10).min(chars.len());
                format!(
                    "{}\"{}\"{}",
                    if start > 0 { "..." } else { "" },
                    String::from_utf16_lossy(&chars[start..end]),
                    if end < chars.len() { "..." } else { "" }
                )
            };
            format!("Unexpected token '{token}', {context} is not valid JSON")
        }
    })
}

/// A JSON syntax failure.
enum Failure {
    /// The input ended early.
    End,
    /// A located message.
    Message(String),
    /// An unexpected character at the current position.
    Token,
}

/// A JSON syntax checker that reports failures the way V8 does.
struct JsonSyntax<'a> {
    /// UTF-16 code units.
    chars: &'a [u16],
    /// Current position.
    pos: usize,
}

impl JsonSyntax<'_> {
    /// Returns the current code unit.
    fn peek(&self) -> Option<u16> {
        self.chars.get(self.pos).copied()
    }

    /// Whether the current code unit is `ch`.
    fn is(&self, ch: u8) -> bool {
        self.peek() == Some(u16::from(ch))
    }

    /// Whether the current code unit is an ASCII digit.
    fn digit(&self) -> bool {
        self.peek().is_some_and(|c| (0x30..=0x39).contains(&c))
    }

    /// Skips JSON whitespace.
    fn whitespace(&mut self) {
        while matches!(self.peek(), Some(0x20 | 0x09 | 0x0a | 0x0d)) {
            self.pos += 1;
        }
    }

    /// Builds a message located at the current position.
    fn at(&self, message: &str) -> Failure {
        let before = &self.chars[..self.pos];
        let line = before.iter().filter(|c| **c == 0x0a).count() + 1;
        let column = self.pos - before.iter().rposition(|c| *c == 0x0a).map_or(0, |i| i + 1) + 1;
        Failure::Message(format!(
            "{message} at position {} (line {line} column {column})",
            self.pos
        ))
    }

    /// Checks one value.
    fn value(&mut self) -> Result<(), Failure> {
        self.whitespace();
        let Some(ch) = self.peek() else {
            return Err(Failure::End);
        };
        match u8::try_from(ch).unwrap_or(0) {
            b'{' => self.object(),
            b'[' => self.array(),
            b'"' => self.string(),
            b'-' | b'0'..=b'9' => self.number(),
            b't' => self.literal("true"),
            b'f' => self.literal("false"),
            b'n' => self.literal("null"),
            _ => Err(Failure::Token),
        }
    }

    /// Checks an object.
    fn object(&mut self) -> Result<(), Failure> {
        self.pos += 1;
        self.whitespace();
        if self.is(b'}') {
            self.pos += 1;
            return Ok(());
        }
        let mut first = true;
        loop {
            if !self.is(b'"') {
                return Err(self.at(if first {
                    "Expected property name or '}' in JSON"
                } else {
                    "Expected double-quoted property name in JSON"
                }));
            }
            first = false;
            self.string()?;
            self.whitespace();
            if !self.is(b':') {
                return Err(self.at("Expected ':' after property name in JSON"));
            }
            self.pos += 1;
            self.value()?;
            self.whitespace();
            if self.is(b',') {
                self.pos += 1;
                self.whitespace();
            } else if self.is(b'}') {
                self.pos += 1;
                return Ok(());
            } else {
                return Err(self.at("Expected ',' or '}' after property value in JSON"));
            }
        }
    }

    /// Checks an array.
    fn array(&mut self) -> Result<(), Failure> {
        self.pos += 1;
        self.whitespace();
        if self.is(b']') {
            self.pos += 1;
            return Ok(());
        }
        loop {
            self.value()?;
            self.whitespace();
            if self.is(b',') {
                self.pos += 1;
            } else if self.is(b']') {
                self.pos += 1;
                return Ok(());
            } else {
                return Err(self.at("Expected ',' or ']' after array element in JSON"));
            }
        }
    }

    /// Checks a string.
    fn string(&mut self) -> Result<(), Failure> {
        self.pos += 1;
        loop {
            match self.peek() {
                None => return Err(self.at("Unterminated string in JSON")),
                Some(0x22) => {
                    self.pos += 1;
                    return Ok(());
                }
                Some(ch) if ch < 0x20 => {
                    return Err(self.at("Bad control character in string literal in JSON"));
                }
                Some(0x5c) => {
                    self.pos += 1;
                    let escape = self.peek().and_then(|c| u8::try_from(c).ok()).unwrap_or(0);
                    if escape == b'u' {
                        for _ in 0..4 {
                            self.pos += 1;
                            if !self.peek().is_some_and(|c| {
                                u8::try_from(c).is_ok_and(|c| c.is_ascii_hexdigit())
                            }) {
                                return Err(self.at("Bad Unicode escape in JSON"));
                            }
                        }
                    } else if !b"\"\\/bfnrt".contains(&escape) {
                        return Err(self.at("Bad escaped character in JSON"));
                    }
                    self.pos += 1;
                }
                Some(_) => self.pos += 1,
            }
        }
    }

    /// Checks a number.
    fn number(&mut self) -> Result<(), Failure> {
        if self.is(b'-') {
            self.pos += 1;
            if !self.digit() {
                return Err(self.at("No number after minus sign in JSON"));
            }
        }
        if self.is(b'0') {
            self.pos += 1;
        } else {
            while self.digit() {
                self.pos += 1;
            }
        }
        if self.is(b'.') {
            self.pos += 1;
            if !self.digit() {
                return Err(self.at("Unterminated fractional number in JSON"));
            }
            while self.digit() {
                self.pos += 1;
            }
        }
        if self.is(b'e') || self.is(b'E') {
            self.pos += 1;
            if self.is(b'+') || self.is(b'-') {
                self.pos += 1;
            }
            if !self.digit() {
                return Err(self.at("Exponent part is missing a number in JSON"));
            }
            while self.digit() {
                self.pos += 1;
            }
        }
        Ok(())
    }

    /// Checks a literal such as `true`.
    fn literal(&mut self, word: &str) -> Result<(), Failure> {
        for expected in word.bytes() {
            match self.peek() {
                None => return Err(Failure::End),
                Some(ch) if ch == u16::from(expected) => self.pos += 1,
                Some(_) => return Err(Failure::Token),
            }
        }
        Ok(())
    }
}
