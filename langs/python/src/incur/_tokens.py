"""Token estimation and slicing, ported from `tokenx` 1.3.0 with its default options."""

from __future__ import annotations

import math

from . import _js

_PUNCTUATION = frozenset(".,!?;(){}[]<>:/\\|@#$%^&*+=`~_-")
_CJK = (
    (0x4E00, 0x9FFF),
    (0x3400, 0x4DBF),
    (0x3000, 0x303F),
    (0xFF00, 0xFFEF),
    (0x30A0, 0x30FF),
    (0x2E80, 0x2EFF),
    (0x31C0, 0x31EF),
    (0x3200, 0x32FF),
    (0x3300, 0x33FF),
    (0xAC00, 0xD7AF),
    (0x1100, 0x11FF),
    (0x3130, 0x318F),
    (0xA960, 0xA97F),
    (0xD7B0, 0xD7FF),
)


def _class(ch: str) -> int:
    if _js.is_whitespace(ch):
        return 0
    return 1 if ch in _PUNCTUATION else 2


def _segments(text: str) -> list[str]:
    """Splits text into whitespace runs, punctuation runs, and words."""
    out: list[str] = []
    current = ""
    last: int | None = None
    for ch in text:
        kind = _class(ch)
        if last is not None and kind != last:
            out.append(current)
            current = ""
        current += ch
        last = kind
    if current:
        out.append(current)
    return out


def _is_cjk(ch: str) -> bool:
    code = ord(ch)
    return any(low <= code <= high for low, high in _CJK)


def _is_numeric(segment: str) -> bool:
    r"""Matches `/^\\d+(?:[.,]\\d+)*$/`."""
    parts = segment.replace(",", ".").split(".")
    return all(part and all(ch in "0123456789" for ch in part) for part in parts)


def _language_ratio(segment: str) -> float | None:
    """Returns the characters-per-token ratio of accented text, if any."""
    lower = segment.lower()

    def has(chars: str) -> bool:
        return any(ch in chars for ch in lower)

    if has("äöüßẞ") or has("éèêëàâîïôûùüÿçœæáíóúñ"):
        return 3.0
    if has("ąćęłńóśźżěščřžýůúďťň"):
        return 3.5
    return None


def _segment_tokens(segment: str) -> int:
    if all(_js.is_whitespace(ch) for ch in segment):
        return 0
    if any(_is_cjk(ch) for ch in segment):
        return len(segment)
    if _is_numeric(segment):
        return 1
    length = _js.utf16_len(segment)
    if length <= 3:
        return 1
    if any(ch in _PUNCTUATION for ch in segment):
        return (length + 1) // 2
    ratio = _language_ratio(segment) or 6.0
    return math.ceil(length / ratio)


def estimate(text: str) -> int:
    """Estimates the number of tokens in a string."""
    return sum(_segment_tokens(s) for s in _segments(text))


def slice_tokens(text: str, start: float, end: float) -> str:
    """Returns the text between the nonnegative token positions `start` and `end`."""
    if start >= end:
        return ""
    out: list[str] = []
    position = 0.0
    for segment in _segments(text):
        if position >= end:
            break
        count = float(_segment_tokens(segment))
        out.append(_extract(segment, position, count, start, end))
        position += count
    return "".join(out)


def _extract(segment: str, seg_start: float, count: float, start: float, end: float) -> str:
    """Extracts the part of a segment that overlaps the target token range."""
    if count == 0:
        return segment if start <= seg_start < end else ""
    if seg_start >= end or seg_start + count <= start:
        return ""
    overlap_start = max(start - seg_start, 0.0)
    overlap_end = min(count, end - seg_start)
    if overlap_start == 0 and overlap_end == count:
        return segment
    units = _js.utf16(segment)
    a = math.floor(overlap_start / count * len(units))
    b = math.ceil(overlap_end / count * len(units))
    return _js.from_utf16(units[a:b])
