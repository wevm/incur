//! Token estimation and slicing, ported from `tokenx` 1.3.0 with its default options.

use crate::js;

/// Splits text into whitespace runs, punctuation runs, and words, dropping empty pieces.
fn segments(text: &str) -> Vec<String> {
    #[derive(PartialEq, Clone, Copy)]
    enum Class {
        Punctuation,
        Space,
        Word,
    }
    let class = |ch: char| {
        if js::is_whitespace(ch) {
            Class::Space
        } else if is_punctuation(ch) {
            Class::Punctuation
        } else {
            Class::Word
        }
    };
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut last = None;
    for ch in text.chars() {
        let kind = class(ch);
        // Words split from separators; separators of one class form one run.
        if last.is_some() && (Some(kind) != last) {
            out.push(std::mem::take(&mut current));
        }
        current.push(ch);
        last = Some(kind);
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Matches ``/[.,!?;(){}[\]<>:/\\|@#$%^&*+=`~_-]/``.
fn is_punctuation(ch: char) -> bool {
    ".,!?;(){}[]<>:/\\|@#$%^&*+=`~_-".contains(ch)
}

/// Matches the CJK ranges `tokenx` counts one token per character.
fn is_cjk(ch: char) -> bool {
    matches!(u32::from(ch),
        0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x3000..=0x303F | 0xFF00..=0xFFEF | 0x30A0..=0x30FF
        | 0x2E80..=0x2EFF | 0x31C0..=0x31EF | 0x3200..=0x32FF | 0x3300..=0x33FF | 0xAC00..=0xD7AF
        | 0x1100..=0x11FF | 0x3130..=0x318F | 0xA960..=0xA97F | 0xD7B0..=0xD7FF)
}

/// Matches `/^\d+(?:[.,]\d+)*$/`.
fn is_numeric(segment: &str) -> bool {
    segment
        .split(['.', ','])
        .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

/// Returns the characters-per-token ratio of accented text, if any.
fn language_ratio(segment: &str) -> Option<f64> {
    let has = |set: &str| {
        segment
            .chars()
            .flat_map(char::to_lowercase)
            .any(|ch| set.contains(ch))
    };
    if has("äöüßẞ") || has("éèêëàâîïôûùüÿçœæáíóúñ") {
        Some(3.0)
    } else if has("ąćęłńóśźżěščřžýůúďťň") {
        Some(3.5)
    } else {
        None
    }
}

/// Estimates the tokens of one segment.
fn segment_tokens(segment: &str) -> usize {
    if segment.chars().all(js::is_whitespace) {
        return 0;
    }
    if segment.chars().any(is_cjk) {
        return segment.chars().count();
    }
    if is_numeric(segment) {
        return 1;
    }
    let len = js::utf16_len(segment);
    if len <= 3 {
        return 1;
    }
    if segment.chars().any(is_punctuation) {
        return len.div_ceil(2);
    }
    let ratio = language_ratio(segment).unwrap_or(6.0);
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "Token counts are small and non-negative."
    )]
    let tokens = (len as f64 / ratio).ceil() as usize;
    tokens
}

/// Estimates the number of tokens in a string.
pub(crate) fn estimate(text: &str) -> usize {
    segments(text).iter().map(|s| segment_tokens(s)).sum()
}

/// Returns the text between the nonnegative token positions `start` and `end`.
pub(crate) fn slice(text: &str, start: f64, end: f64) -> String {
    if start >= end {
        return String::new();
    }
    let mut out = String::new();
    let mut position = 0.0;
    for segment in segments(text) {
        if position >= end {
            break;
        }
        #[expect(clippy::cast_precision_loss, reason = "Token counts are small.")]
        let count = segment_tokens(&segment) as f64;
        out.push_str(&extract(&segment, position, count, start, end));
        position += count;
    }
    out
}

/// Extracts the part of a segment that overlaps the target token range.
fn extract(segment: &str, seg_start: f64, count: f64, start: f64, end: f64) -> String {
    if count == 0.0 {
        return if seg_start >= start && seg_start < end {
            segment.to_owned()
        } else {
            String::new()
        };
    }
    let seg_end = seg_start + count;
    if seg_start >= end || seg_end <= start {
        return String::new();
    }
    let overlap_start = (start - seg_start).max(0.0);
    let overlap_end = count.min(end - seg_start);
    #[expect(clippy::float_cmp, reason = "tokenx compares the exact values.")]
    let whole = overlap_start == 0.0 && overlap_end == count;
    if whole {
        return segment.to_owned();
    }
    let units = segment.encode_utf16().collect::<Vec<_>>();
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "Offsets are small and non-negative."
    )]
    let (a, b) = {
        let len = units.len() as f64;
        (
            (overlap_start / count * len).floor() as usize,
            (overlap_end / count * len).ceil() as usize,
        )
    };
    String::from_utf16_lossy(&units[a.min(units.len())..b.min(units.len())])
}
