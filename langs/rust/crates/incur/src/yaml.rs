//! YAML serialization of JSON data, ported from `yaml` 2.8.2 `stringify` with its default
//! options (core schema, block collections, two-space indentation).
//!
//! String folding indexes UTF-16 code units, as the JavaScript implementation does.

use serde_json::Value;

use crate::js;

/// Maximum line width before folding.
const LINE_WIDTH: usize = 80;

/// Minimum content width of a folded line.
const MIN_CONTENT_WIDTH: usize = 20;

/// The stringify context of one node.
#[derive(Clone)]
struct Ctx {
    /// Whether the scalar is a mapping key.
    implicit_key: bool,
    /// Current indentation.
    indent: String,
    /// Columns already used on the scalar's first line.
    indent_at_start: Option<usize>,
    /// Whether a top-level block scalar must be indented.
    force_block_indent: bool,
}

/// Serializes a value as a YAML document, ending with a newline.
pub(crate) fn stringify(value: &Value) -> String {
    let ctx = Ctx {
        implicit_key: false,
        indent: String::new(),
        indent_at_start: None,
        force_block_indent: false,
    };
    format!("{}\n", node(value, &ctx))
}

/// Stringifies any node.
fn node(value: &Value, ctx: &Ctx) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(number) => js::format_number(number),
        Value::String(string) => string_scalar(string, ctx),
        Value::Array(items) => {
            if items.is_empty() {
                return "[]".into();
            }
            let item_ctx = Ctx {
                indent: format!("{}  ", ctx.indent),
                indent_at_start: None,
                ..ctx.clone()
            };
            let lines = items
                .iter()
                .map(|item| format!("- {}", node(item, &item_ctx)))
                .collect::<Vec<_>>();
            lines.join(&format!("\n{}", ctx.indent))
        }
        Value::Object(map) => {
            if map.is_empty() {
                return "{}".into();
            }
            let lines = map
                .iter()
                .map(|(key, value)| pair(key, value, ctx))
                .collect::<Vec<_>>();
            lines.join(&format!("\n{}", ctx.indent))
        }
    }
}

/// Stringifies a `key: value` pair.
fn pair(key: &str, value: &Value, ctx: &Ctx) -> String {
    let mut pair_ctx = Ctx {
        implicit_key: true,
        indent: format!("{}  ", ctx.indent),
        indent_at_start: None,
        ..ctx.clone()
    };
    let key_str = string_scalar(key, &pair_ctx);
    // Keys longer than 1024 characters need explicit `? key` syntax.
    let explicit = js::utf16_len(&key_str) > 1024;
    let mut out = if explicit {
        format!("? {key_str}\n{}:", ctx.indent)
    } else {
        format!("{key_str}:")
    };
    pair_ctx.implicit_key = false;
    let collection = matches!(value, Value::Array(_) | Value::Object(_));
    if !explicit && !collection {
        pair_ctx.indent_at_start = Some(js::utf16_len(&out) + 1);
    }
    let value_str = node(value, &pair_ctx);
    let ws = if !explicit && collection {
        let empty = matches!(value, Value::Array(items) if items.is_empty())
            || matches!(value, Value::Object(map) if map.is_empty());
        if value_str.contains('\n') || !empty {
            format!("\n{}", pair_ctx.indent)
        } else {
            " ".into()
        }
    } else if value_str.is_empty() || value_str.starts_with('\n') {
        String::new()
    } else {
        " ".into()
    };
    out.push_str(&ws);
    out.push_str(&value_str);
    out
}

/// Whether a string matches `/^(%|---|\.\.\.)/m`.
fn contains_document_marker(value: &str) -> bool {
    value
        .split('\n')
        .any(|line| line.starts_with('%') || line.starts_with("---") || line.starts_with("..."))
}

/// Stringifies a string scalar in the default plain style.
fn string_scalar(value: &str, ctx: &Ctx) -> String {
    let control = value.chars().any(|ch| {
        let code = u32::from(ch);
        code <= 0x08 || (0x0b..=0x1f).contains(&code) || (0x7f..=0x9f).contains(&code)
    });
    if control {
        return double_quoted(value, ctx);
    }
    plain(value, ctx)
}

/// Stringifies a string as a plain scalar when YAML allows it.
fn plain(value: &str, ctx: &Ctx) -> String {
    if ctx.implicit_key && value.contains('\n') {
        return quoted(value, ctx);
    }
    if needs_quotes(value) {
        return if ctx.implicit_key || !value.contains('\n') {
            quoted(value, ctx)
        } else {
            block(value, ctx)
        };
    }
    if !ctx.implicit_key && value.contains('\n') {
        return block(value, ctx);
    }
    if contains_document_marker(value) {
        if ctx.indent.is_empty() {
            let ctx = Ctx {
                force_block_indent: true,
                ..ctx.clone()
            };
            return block(value, &ctx);
        } else if ctx.implicit_key && ctx.indent == "  " {
            return quoted(value, ctx);
        }
    }
    if resolves_as_non_string(value) {
        return quoted(value, ctx);
    }
    if ctx.implicit_key {
        return value.to_owned();
    }
    fold(value, &ctx.indent, Mode::Flow, ctx.indent_at_start, None)
}

/// Matches the indicator characters that forbid a plain scalar.
fn needs_quotes(value: &str) -> bool {
    let chars = value.chars().collect::<Vec<_>>();
    let Some(&first) = chars.first() else {
        return false;
    };
    if "\n\t ,[]{}#&*!|>'\"%@`".contains(first) {
        return true;
    }
    if matches!(first, '?' | '-') && (chars.len() == 1 || matches!(chars[1], ' ' | '\t')) {
        return true;
    }
    for window in chars.windows(2) {
        let (a, b) = (window[0], window[1]);
        if (matches!(a, '\n' | ':') && matches!(b, ' ' | '\t'))
            || (matches!(a, ' ' | '\t') && b == '\n')
            || (matches!(a, '\n' | '\t' | ' ') && b == '#')
        {
            return true;
        }
    }
    chars
        .last()
        .is_some_and(|last| matches!(last, '\n' | '\t' | ' ' | ':'))
}

/// Whether a plain scalar would resolve to a non-string under the core schema.
fn resolves_as_non_string(value: &str) -> bool {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let signed = value.strip_prefix(['+', '-']).unwrap_or(value);
    // Floats: `.5`, `1.`, `1.5`, with an optional exponent.
    let float = |s: &str| match s.split_once('.') {
        Some((int, frac)) => {
            (int.is_empty() && digits(frac)) || (digits(int) && (frac.is_empty() || digits(frac)))
        }
        None => false,
    };
    let exp = |s: &str| match s.find(['e', 'E']) {
        Some(index) => {
            let (mantissa, rest) = (&s[..index], &s[index + 1..]);
            (digits(mantissa) || float(mantissa))
                && digits(rest.strip_prefix(['+', '-']).unwrap_or(rest))
        }
        None => false,
    };
    matches!(value, "" | "~" | "null" | "Null" | "NULL")
        || matches!(
            value,
            "true" | "True" | "TRUE" | "false" | "False" | "FALSE"
        )
        || digits(signed)
        || value
            .strip_prefix("0o")
            .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| (b'0'..=b'7').contains(&b)))
        || value
            .strip_prefix("0x")
            .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit()))
        || matches!(signed, ".inf" | ".Inf" | ".INF")
        || matches!(value, ".nan" | ".NaN" | ".NAN")
        || exp(signed)
        || float(signed)
}

/// Chooses single or double quotes.
fn quoted(value: &str, ctx: &Ctx) -> String {
    let double = value.contains('"');
    let single = value.contains('\'');
    if double && !single {
        single_quoted(value, ctx)
    } else {
        double_quoted(value, ctx)
    }
}

/// Stringifies a single-quoted scalar.
fn single_quoted(value: &str, ctx: &Ctx) -> String {
    // Multiline strings reach here only as implicit keys or with whitespace around a line
    // break, and single quotes can hold neither.
    if value.contains('\n') {
        return double_quoted(value, ctx);
    }
    let indent = if ctx.indent.is_empty() && contains_document_marker(value) {
        "  ".to_owned()
    } else {
        ctx.indent.clone()
    };
    let body = value.replace('\'', "''");
    let res = format!("'{body}'");
    if ctx.implicit_key {
        return res;
    }
    fold(&res, &indent, Mode::Flow, ctx.indent_at_start, None)
}

/// Stringifies a double-quoted scalar.
fn double_quoted(value: &str, ctx: &Ctx) -> String {
    let json = js::stringify(&Value::String(value.to_owned()));
    let indent = if ctx.indent.is_empty() && contains_document_marker(value) {
        "  ".to_owned()
    } else {
        ctx.indent.clone()
    };
    let json = json.encode_utf16().collect::<Vec<_>>();
    let at = |i: usize| json.get(i).copied().unwrap_or(0);
    let slice =
        |a: usize, b: usize| String::from_utf16_lossy(&json[a.min(json.len())..b.min(json.len())]);
    let mut out = String::new();
    let mut start = 0;
    let mut i = 0;
    while i < json.len() {
        let mut ch = at(i);
        if ch == u16::from(b' ') && at(i + 1) == u16::from(b'\\') && at(i + 2) == u16::from(b'n') {
            out.push_str(&slice(start, i));
            out.push_str("\\ ");
            i += 1;
            start = i;
            ch = u16::from(b'\\');
        }
        if ch == u16::from(b'\\') {
            match at(i + 1) {
                c if c == u16::from(b'u') => {
                    out.push_str(&slice(start, i));
                    let code = slice(i + 2, i + 6);
                    match code.as_str() {
                        "0000" => out.push_str("\\0"),
                        "0007" => out.push_str("\\a"),
                        "000b" => out.push_str("\\v"),
                        "001b" => out.push_str("\\e"),
                        // `JSON.stringify` escapes only C0 controls, so `code` is `00XX`.
                        _ => {
                            out.push_str("\\x");
                            out.push_str(&code[2..]);
                        }
                    }
                    i += 5;
                    start = i + 1;
                }
                c if c == u16::from(b'n') => {
                    if ctx.implicit_key || at(i + 2) == u16::from(b'"') || json.len() < 40 {
                        i += 1;
                    } else {
                        out.push_str(&slice(start, i));
                        out.push_str("\n\n");
                        while at(i + 2) == u16::from(b'\\')
                            && at(i + 3) == u16::from(b'n')
                            && at(i + 4) != u16::from(b'"')
                        {
                            out.push('\n');
                            i += 2;
                        }
                        out.push_str(&indent);
                        if at(i + 2) == u16::from(b' ') {
                            out.push('\\');
                        }
                        i += 1;
                        start = i + 1;
                    }
                }
                _ => i += 1,
            }
        }
        i += 1;
    }
    let out = if start > 0 {
        out + &slice(start, json.len())
    } else {
        String::from_utf16_lossy(&json)
    };
    if ctx.implicit_key {
        return out;
    }
    fold(&out, &indent, Mode::Quoted, ctx.indent_at_start, None)
}

/// Stringifies a block scalar (`|` literal or `>` folded).
fn block(value: &str, ctx: &Ctx) -> String {
    let trailing_ws_line = value.rfind('\n').is_some_and(|index| {
        let tail = &value[index + 1..];
        !tail.is_empty() && tail.chars().all(|ch| matches!(ch, ' ' | '\t'))
    });
    if trailing_ws_line {
        return quoted(value, ctx);
    }
    let indent = if !ctx.indent.is_empty() {
        ctx.indent.clone()
    } else if ctx.force_block_indent || contains_document_marker(value) {
        "  ".to_owned()
    } else {
        String::new()
    };
    let literal = !line_over_limit(value, indent.len());

    // Chomping from trailing whitespace.
    let units = value.encode_utf16().collect::<Vec<_>>();
    let mut end_start = units.len();
    while end_start > 0 && matches!(units[end_start - 1], 0x0a | 0x09 | 0x20) {
        end_start -= 1;
    }
    let mut end = String::from_utf16_lossy(&units[end_start..]);
    let mut body = String::from_utf16_lossy(&units[..end_start]);
    let chomp = match end.find('\n') {
        None => "-",
        Some(pos) if body.is_empty() || pos != end.len() - 1 => "+",
        Some(_) => "",
    };
    if !end.is_empty() {
        if end.ends_with('\n') {
            end.pop();
        }
        end = indent_newline_runs(&end, &indent, true);
    }

    // Indentation indicator from leading whitespace.
    let mut start_with_space = false;
    let mut start_nl = None;
    for (index, ch) in body.char_indices() {
        match ch {
            ' ' => start_with_space = true,
            '\n' => start_nl = Some(index),
            _ => break,
        }
    }
    // Leading spaces after the last leading newline stay in the body.
    let start_len = start_nl.map_or(0, |nl| nl + 1);
    let mut start = body[..start_len].to_owned();
    if !start.is_empty() {
        body = body[start_len..].to_owned();
        start = indent_newline_runs(&start, &indent, false);
    }
    let header = format!(
        "{}{chomp}",
        if start_with_space {
            if indent.is_empty() { "1" } else { "2" }
        } else {
            ""
        }
    );

    if !literal {
        let folded = fold_block_body(&body, &indent);
        let mut overflow = false;
        let folded = fold(
            &format!("{start}{folded}{end}"),
            &indent,
            Mode::Block,
            Some(indent.len()),
            Some(&mut overflow),
        );
        if !overflow {
            return format!(">{header}\n{indent}{folded}");
        }
    }
    let body = indent_newline_runs(&body, &indent, false);
    format!("|{header}\n{indent}{start}{body}{end}")
}

/// Replaces each run of newlines with itself followed by `indent`. With `inner`, only runs that
/// are not at the end and not preceded by a newline (`(^|(?<!\n))\n+(?!\n|$)`).
fn indent_newline_runs(value: &str, indent: &str, inner: bool) -> String {
    let mut out = String::new();
    let mut run = 0;
    for ch in value.chars() {
        if ch == '\n' {
            run += 1;
            continue;
        }
        if run > 0 {
            out.push_str(&"\n".repeat(run));
            out.push_str(indent);
            run = 0;
        }
        out.push(ch);
    }
    if run > 0 {
        out.push_str(&"\n".repeat(run));
        if !inner {
            out.push_str(indent);
        }
    }
    out
}

/// Prepares a folded block body: doubles line breaks and keeps more-indented lines literal.
fn fold_block_body(value: &str, indent: &str) -> String {
    // `.replace(/\n+/g, '\n$&')`
    let mut doubled = String::new();
    let mut run = 0;
    for ch in value.chars() {
        if ch == '\n' {
            run += 1;
            continue;
        }
        if run > 0 {
            doubled.push_str(&"\n".repeat(run + 1));
            run = 0;
        }
        doubled.push(ch);
    }
    indent_newline_runs(&keep_more_indented(&doubled), indent, false)
}

/// `.replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, '$1$2')`: undoes the doubled
/// line breaks around more-indented lines.
fn keep_more_indented(value: &str) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    let blank = |ch: char| matches!(ch, '\n' | '\t' | ' ');
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let line = if i == 0 && matches!(chars[0], '\t' | ' ') {
            0
        } else if chars[i] == '\n' && matches!(chars.get(i + 1), Some('\t' | ' ')) {
            i + 1
        } else {
            out.push(chars[i]);
            i += 1;
            continue;
        };
        // `.` stops at JavaScript line terminators.
        let mut end = line;
        while end < chars.len() && !matches!(chars[end], '\n' | '\r' | '\u{2028}' | '\u{2029}') {
            end += 1;
        }
        out.extend(&chars[line..end]);
        let mut run = end;
        while run < chars.len() && blank(chars[run]) {
            run += 1;
        }
        // The optional group matches only when the blank run ends with a line break.
        i = if run > end && chars[run - 1] == '\n' {
            out.extend(&chars[end..run - 1]);
            run
        } else {
            end
        };
    }
    out
}

/// Whether any line exceeds the width limit.
fn line_over_limit(value: &str, indent: usize) -> bool {
    let limit = LINE_WIDTH - indent;
    let units = value.encode_utf16().collect::<Vec<_>>();
    if units.len() <= limit {
        return false;
    }
    let mut start = 0;
    for (i, unit) in units.iter().enumerate() {
        if *unit == 0x0a {
            if i - start > limit {
                return true;
            }
            start = i + 1;
            if units.len() - start <= limit {
                return false;
            }
        }
    }
    true
}

/// The folding mode.
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    /// Block scalar content.
    Block,
    /// Plain or single-quoted flow scalar.
    Flow,
    /// Double-quoted scalar, which may fold inside escapes.
    Quoted,
}

/// Folds long lines at spaces, as `foldFlowLines` does.
fn fold(
    text: &str,
    indent: &str,
    mode: Mode,
    indent_at_start: Option<usize>,
    on_overflow: Option<&mut bool>,
) -> String {
    let units = text.encode_utf16().collect::<Vec<_>>();
    let at = |i: usize| units.get(i).copied();
    let indent_len = indent.len();
    let end_step = (1 + MIN_CONTENT_WIDTH).max(1 + LINE_WIDTH - indent_len);
    if units.len() <= end_step {
        return text.to_owned();
    }
    let mut folds: Vec<usize> = Vec::new();
    let mut escaped: Vec<usize> = Vec::new();
    let mut end = LINE_WIDTH - indent_len;
    if let Some(start) = indent_at_start {
        if start > LINE_WIDTH - MIN_CONTENT_WIDTH {
            folds.push(0);
        } else {
            end = LINE_WIDTH - start;
        }
    }
    let mut split: Option<usize> = None;
    let mut prev: Option<u16> = None;
    let mut overflow = false;
    let mut i: isize = -1;
    let mut esc_start: isize = -1;
    let mut esc_end: isize = -1;
    if mode == Mode::Block {
        i = consume_more_indented(&units, i, indent_len);
        if i != -1 {
            end = usize::try_from(i).unwrap_or(0) + end_step;
        }
    }
    let sp = 0x20;
    let nl = 0x0a;
    let tab = 0x09;
    loop {
        i += 1;
        let index = usize::try_from(i).unwrap_or(0);
        let Some(mut ch) = at(index) else { break };
        if mode == Mode::Quoted && ch == u16::from(b'\\') {
            esc_start = i;
            // Only `\xXX` escapes are longer than two units after `double_quoted`.
            i += if at(index + 1) == Some(0x78) { 3 } else { 1 };
            esc_end = i;
        }
        let index = usize::try_from(i).unwrap_or(0);
        if ch == nl {
            if mode == Mode::Block {
                i = consume_more_indented(&units, i, indent_len);
            }
            end = usize::try_from(i).unwrap_or(0) + indent_len + end_step;
            split = None;
        } else {
            if ch == sp && prev.is_some_and(|p| p != sp && p != nl && p != tab) {
                let next = at(index + 1);
                if next.is_some_and(|n| n != sp && n != nl && n != tab) {
                    split = Some(index);
                }
            }
            if index >= end {
                if let Some(at_split) = split {
                    folds.push(at_split);
                    end = at_split + end_step;
                    split = None;
                } else if mode == Mode::Quoted {
                    let mut cur = index;
                    while prev == Some(sp) || prev == Some(tab) {
                        prev = Some(ch);
                        cur += 1;
                        ch = at(cur).unwrap_or(0);
                        overflow = true;
                    }
                    i = isize::try_from(cur).unwrap_or(0);
                    let j = if i > esc_end + 1 {
                        i - 2
                    } else {
                        esc_start - 1
                    };
                    let j = usize::try_from(j).unwrap_or(0);
                    folds.push(j);
                    escaped.push(j);
                    end = j + end_step;
                    split = None;
                } else {
                    overflow = true;
                }
            }
        }
        prev = Some(ch);
    }
    if overflow && let Some(flag) = on_overflow {
        *flag = true;
    }
    if folds.is_empty() {
        return text.to_owned();
    }
    let s = |a: usize, b: usize| {
        String::from_utf16_lossy(&units[a.min(units.len())..b.min(units.len())])
    };
    let mut res = s(0, folds[0]);
    for (k, &fold_at) in folds.iter().enumerate() {
        let end = folds
            .get(k + 1)
            .copied()
            .filter(|v| *v != 0)
            .unwrap_or(units.len());
        if fold_at == 0 {
            res = format!("\n{indent}{}", s(0, end));
        } else {
            if mode == Mode::Quoted && escaped.contains(&fold_at) {
                res.push_str(&s(fold_at, fold_at + 1));
                res.push('\\');
            }
            res.push('\n');
            res.push_str(indent);
            res.push_str(&s(fold_at + 1, end));
        }
    }
    res
}

/// Skips more-indented lines of a block scalar. Returns the index of the last newline consumed.
fn consume_more_indented(units: &[u16], mut i: isize, indent: usize) -> isize {
    let at = |i: isize| usize::try_from(i).ok().and_then(|i| units.get(i).copied());
    let mut end = i;
    let mut start = i + 1;
    let mut ch = at(start);
    let indent = isize::try_from(indent).unwrap_or(0);
    while ch == Some(0x20) || ch == Some(0x09) {
        if i < start + indent {
            i += 1;
            ch = at(i);
        } else {
            loop {
                i += 1;
                ch = at(i);
                if ch.is_none() || ch == Some(0x0a) {
                    break;
                }
            }
            end = i;
            start = i + 1;
            ch = at(start);
        }
    }
    end
}
