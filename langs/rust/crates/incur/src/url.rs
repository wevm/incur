//! The parts of the WHATWG URL standard the HTTP features use: parsing absolute `http(s)` URLs,
//! resolving references against a base, and percent-encoding paths and query strings.

use std::fmt::{self, Write as _};

/// An absolute hierarchical URL.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Url {
    /// The scheme, such as `http`.
    pub(crate) scheme: String,
    /// The host and optional port.
    pub(crate) host: String,
    /// The path, starting with `/`.
    pub(crate) path: String,
    /// The query without `?`, when present.
    pub(crate) query: Option<String>,
}

impl Url {
    /// Parses an absolute URL. Returns `None` for anything without a scheme and host.
    pub(crate) fn parse(input: &str) -> Option<Self> {
        let input = input.trim();
        let (scheme, rest) = input.split_once("://")?;
        if scheme.is_empty()
            || !scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
        {
            return None;
        }
        let rest = rest.split('#').next().unwrap_or_default();
        let end = rest.find(['/', '?']).unwrap_or(rest.len());
        let host = rest[..end].to_ascii_lowercase();
        if host.is_empty() {
            return None;
        }
        let (path, query) = split_query(&rest[end..]);
        let path = if path.is_empty() { "/" } else { path };
        Some(Self {
            scheme: scheme.to_ascii_lowercase(),
            host,
            path: normalize_path(&encode_path(path)),
            query: query.map(encode_query),
        })
    }

    /// Resolves a reference, such as `openapi.json` or `/v1/users?x=1`, against this URL.
    pub(crate) fn join(&self, reference: &str) -> Option<Self> {
        if reference.contains("://") {
            return Self::parse(reference);
        }
        let reference = reference.split('#').next().unwrap_or_default();
        if let Some(rest) = reference.strip_prefix("//") {
            return Self::parse(&format!("{}://{rest}", self.scheme));
        }
        let (path, query) = split_query(reference);
        let path = if path.is_empty() {
            self.path.clone()
        } else if path.starts_with('/') {
            normalize_path(&encode_path(path))
        } else {
            let base = &self.path[..=self.path.rfind('/').unwrap_or(0)];
            normalize_path(&encode_path(&format!("{base}{path}")))
        };
        let query = match query {
            Some(query) => Some(encode_query(query)),
            None if reference.is_empty() => self.query.clone(),
            None => None,
        };
        Some(Self {
            scheme: self.scheme.clone(),
            host: self.host.clone(),
            path,
            query,
        })
    }

    /// Returns the origin, such as `http://localhost`.
    pub(crate) fn origin(&self) -> String {
        format!("{}://{}", self.scheme, self.host)
    }

    /// Returns the decoded query pairs.
    pub(crate) fn query_pairs(&self) -> Vec<(String, String)> {
        self.query.as_deref().map(form_decode).unwrap_or_default()
    }

    /// Replaces the query with serialized pairs.
    pub(crate) fn set_query(&mut self, pairs: &[(String, String)]) {
        self.query = (!pairs.is_empty()).then(|| form_encode(pairs));
    }
}

impl fmt::Display for Url {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}://{}{}", self.scheme, self.host, self.path)?;
        if let Some(query) = &self.query {
            write!(f, "?{query}")?;
        }
        Ok(())
    }
}

/// Splits `path?query`.
fn split_query(input: &str) -> (&str, Option<&str>) {
    match input.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (input, None),
    }
}

/// Removes `.` and `..` segments.
fn normalize_path(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let segments = path.split('/').skip(1).collect::<Vec<_>>();
    let last = segments.len().saturating_sub(1);
    for (index, segment) in segments.iter().enumerate() {
        match *segment {
            "." | "%2e" | "%2E" => {
                if index == last {
                    out.push("");
                }
            }
            ".." | ".%2e" | "%2e." | "%2e%2e" | ".%2E" | "%2E." | "%2E%2E" => {
                out.pop();
                if index == last {
                    out.push("");
                }
            }
            segment => out.push(segment),
        }
    }
    format!("/{}", out.join("/"))
}

/// Percent-encodes the bytes the URL path percent-encode set covers.
pub(crate) fn encode_path(path: &str) -> String {
    encode(path, |b| {
        b <= 0x20 || b >= 0x7f || matches!(b, b'"' | b'#' | b'<' | b'>' | b'?' | b'`' | b'{' | b'}')
    })
}

/// Percent-encodes the bytes the URL query percent-encode set covers.
fn encode_query(query: &str) -> String {
    encode(query, |b| {
        b <= 0x20 || b >= 0x7f || matches!(b, b'"' | b'#' | b'<' | b'>')
    })
}

/// Percent-encodes bytes matching `set`.
fn encode(input: &str, set: impl Fn(u8) -> bool) -> String {
    let mut out = String::with_capacity(input.len());
    for &byte in input.as_bytes() {
        if set(byte) {
            let _ = write!(out, "%{byte:02X}");
        } else {
            out.push(char::from(byte));
        }
    }
    out
}

/// Serializes pairs as `application/x-www-form-urlencoded`.
pub(crate) fn form_encode(pairs: &[(String, String)]) -> String {
    let component = |value: &str| {
        let mut out = String::new();
        for &byte in value.as_bytes() {
            match byte {
                b' ' => out.push('+'),
                b'*' | b'-' | b'.' | b'_' | b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z' => {
                    out.push(char::from(byte));
                }
                _ => {
                    let _ = write!(out, "%{byte:02X}");
                }
            }
        }
        out
    };
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", component(key), component(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// Parses `application/x-www-form-urlencoded` pairs.
pub(crate) fn form_decode(input: &str) -> Vec<(String, String)> {
    input
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let (key, value) = part.split_once('=').unwrap_or((part, ""));
            (
                decode(&key.replace('+', " ")),
                decode(&value.replace('+', " ")),
            )
        })
        .collect()
}

/// Decodes percent-encoded bytes, replacing invalid UTF-8.
pub(crate) fn decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| char::from(b).to_digit(16);
        if bytes[i] == b'%'
            && let (Some(hi), Some(lo)) = (
                bytes.get(i + 1).and_then(|b| hex(*b)),
                bytes.get(i + 2).and_then(|b| hex(*b)),
            )
        {
            out.push(u8::try_from(hi * 16 + lo).unwrap_or_default());
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Encodes a value as `encodeURIComponent` does.
pub(crate) fn encode_component(value: &str) -> String {
    encode(value, |b| {
        !(b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b))
    })
}
