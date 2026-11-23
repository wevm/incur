"""YAML serialization of JSON data, ported from `yaml` 2.8.2 `stringify` with its defaults.

String folding indexes UTF-16 code units, as the JavaScript implementation does.
"""

from __future__ import annotations

import contextvars
import itertools
import re
from dataclasses import dataclass, field, replace

from . import _js
from ._js import Json

LINE_WIDTH = 80
MIN_CONTENT_WIDTH = 20

#: The line width of the current `stringify` call; 0 disables folding.
_width = contextvars.ContextVar("width", default=LINE_WIDTH)

_BLOCK, _FLOW, _QUOTED = 0, 1, 2

_DIGITS = r"[0-9]+"
_FLOAT = r"(?:\.[0-9]+|[0-9]+\.[0-9]*)"
_NON_STRING = re.compile(
    "|".join(
        (
            r"~|null|Null|NULL|true|True|TRUE|false|False|FALSE",
            rf"[+-]?{_DIGITS}",
            r"0o[0-7]+",
            r"0x[0-9a-fA-F]+",
            r"[+-]?\.(?:inf|Inf|INF)",
            r"\.nan|\.NaN|\.NAN",
            rf"[+-]?(?:{_DIGITS}|{_FLOAT})[eE][+-]?{_DIGITS}",
            rf"[+-]?{_FLOAT}",
        )
    ),
    re.ASCII,
)


@dataclass
class _Ctx:
    """The stringify context of one node."""

    implicit_key: bool = False
    indent: str = ""
    indent_at_start: int | None = None
    force_block_indent: bool = False
    anchors: dict[int, str] = field(default_factory=dict[int, str])
    emitted: set[int] = field(default_factory=set[int])


def stringify(value: Json, line_width: int = LINE_WIDTH) -> str:
    """Serializes a value as a YAML document, ending with a newline.

    A list or object that appears more than once is written once with an anchor (`&a1`) and
    referenced by alias (`*a1`) elsewhere. A `line_width` of 0 disables line folding.

    >>> shared, empty = [1], {}
    >>> print(stringify({"a": [shared, shared], "b": empty, "c": empty}), end="")
    a:
      - &a1
        - 1
      - *a1
    b: &a2 {}
    c: *a2
    """
    token = _width.set(line_width)
    try:
        return _node(value, _Ctx(anchors=_anchors(value))) + "\n"
    finally:
        _width.reset(token)


def _anchors(value: Json) -> dict[int, str]:
    """Names repeated lists and objects in order of their first repeat, as `yaml` does."""
    seen: set[int] = set()
    anchors: dict[int, str] = {}

    def visit(node: Json) -> None:
        if not isinstance(node, (list, dict)):
            return
        if id(node) in seen:
            anchors.setdefault(id(node), f"a{len(anchors) + 1}")
            return
        seen.add(id(node))
        for child in node.values() if isinstance(node, dict) else node:
            visit(child)

    visit(value)
    return anchors


def _anchor(value: Json, ctx: _Ctx) -> tuple[str | None, bool]:
    """Returns the anchor of a node, and whether this occurrence is an alias."""
    name = ctx.anchors.get(id(value)) if isinstance(value, (list, dict)) else None
    if name is None:
        return None, False
    if id(value) in ctx.emitted:
        return name, True
    ctx.emitted.add(id(value))
    return name, False


def _item(value: Json, ctx: _Ctx) -> str:
    """Writes a sequence item."""
    name, alias = _anchor(value, ctx)
    if name is None:
        return f"- {_node(value, ctx)}"
    if alias:
        return f"- *{name}"
    text = _node(value, ctx)
    return f"- &{name} {text}" if not value else f"- &{name}\n{ctx.indent}{text}"


def _node(value: Json, ctx: _Ctx) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _js.number_to_string(value)
    if isinstance(value, str):
        return _string_scalar(value, ctx)
    if isinstance(value, list):
        if not value:
            return "[]"
        item_ctx = replace(ctx, indent=ctx.indent + "  ", indent_at_start=None)
        return f"\n{ctx.indent}".join(_item(item, item_ctx) for item in value)
    if not value:
        return "{}"
    return f"\n{ctx.indent}".join(_pair(k, v, ctx) for k, v in value.items())


def _pair(key: str, value: Json, ctx: _Ctx) -> str:
    pair_ctx = replace(ctx, implicit_key=True, indent=ctx.indent + "  ", indent_at_start=None)
    key_str = _string_scalar(key, pair_ctx)
    # Keys longer than 1024 characters need explicit `? key` syntax.
    explicit = _js.utf16_len(key_str) > 1024
    out = f"? {key_str}\n{ctx.indent}:" if explicit else f"{key_str}:"
    pair_ctx.implicit_key = False
    collection = isinstance(value, (list, dict))
    name, alias = _anchor(value, ctx)
    if name is not None:
        if alias:
            return f"{out} *{name}"
        value_str = _node(value, pair_ctx)
        if not value:
            return f"{out} &{name} {value_str}"
        return f"{out} &{name}\n{pair_ctx.indent}{value_str}"
    if not explicit and not collection:
        pair_ctx.indent_at_start = _js.utf16_len(out) + 1
    value_str = _node(value, pair_ctx)
    if not explicit and collection:
        ws = f"\n{pair_ctx.indent}" if "\n" in value_str or value else " "
    elif not value_str or value_str.startswith("\n"):
        ws = ""
    else:
        ws = " "
    return out + ws + value_str


def _document_marker(value: str) -> bool:
    r"""Whether a string matches `/^(%|---|\\.\\.\\.)/m`."""
    return any(line.startswith(("%", "---", "...")) for line in value.split("\n"))


def _string_scalar(value: str, ctx: _Ctx) -> str:
    for ch in value:
        code = ord(ch)
        if code <= 0x08 or 0x0B <= code <= 0x1F or 0x7F <= code <= 0x9F:
            return _double_quoted(value, ctx)
    return _plain(value, ctx)


def _plain(value: str, ctx: _Ctx) -> str:
    if ctx.implicit_key and "\n" in value:
        return _quoted(value, ctx)
    if _needs_quotes(value):
        if ctx.implicit_key or "\n" not in value:
            return _quoted(value, ctx)
        return _block(value, ctx)
    if not ctx.implicit_key and "\n" in value:
        return _block(value, ctx)
    if _document_marker(value):
        if not ctx.indent:
            return _block(value, replace(ctx, force_block_indent=True))
        if ctx.implicit_key and ctx.indent == "  ":
            return _quoted(value, ctx)
    if value == "" or _NON_STRING.fullmatch(value):
        return _quoted(value, ctx)
    if ctx.implicit_key:
        return value
    return _fold(value, ctx.indent, _FLOW, ctx.indent_at_start)


def _needs_quotes(value: str) -> bool:
    """Matches the indicator characters that forbid a plain scalar."""
    if not value:
        return False
    first = value[0]
    if first in "\n\t ,[]{}#&*!|>'\"%@`":
        return True
    if first in "?-" and (len(value) == 1 or value[1] in " \t"):
        return True
    for a, b in itertools.pairwise(value):
        if (a in "\n:" and b in " \t") or (a in " \t" and b == "\n") or (a in "\n\t " and b == "#"):
            return True
    return value[-1] in "\n\t :"


def _quoted(value: str, ctx: _Ctx) -> str:
    if '"' in value and "'" not in value:
        return _single_quoted(value, ctx)
    return _double_quoted(value, ctx)


def _single_quoted(value: str, ctx: _Ctx) -> str:
    # Multiline strings reach here only as implicit keys or with whitespace around a line
    # break, and single quotes can hold neither.
    if "\n" in value:
        return _double_quoted(value, ctx)
    indent = "  " if not ctx.indent and _document_marker(value) else ctx.indent
    res = "'" + value.replace("'", "''") + "'"
    if ctx.implicit_key:
        return res
    return _fold(res, indent, _FLOW, ctx.indent_at_start)


def _double_quoted(value: str, ctx: _Ctx) -> str:
    indent = "  " if not ctx.indent and _document_marker(value) else ctx.indent
    json = _js.utf16(_js.stringify(value))
    size = len(json)

    def at(i: int) -> int:
        return json[i] if i < size else 0

    def part(a: int, b: int) -> str:
        return _js.from_utf16(json[a:b])

    out = ""
    start = 0
    i = 0
    space, backslash, quote = ord(" "), ord("\\"), ord('"')
    while i < size:
        ch = at(i)
        if ch == space and at(i + 1) == backslash and at(i + 2) == ord("n"):
            out += part(start, i) + "\\ "
            i += 1
            start = i
            ch = backslash
        if ch == backslash:
            nxt = at(i + 1)
            if nxt == ord("u"):
                out += part(start, i)
                code = part(i + 2, i + 6)
                special = {"0000": "\\0", "0007": "\\a", "000b": "\\v", "001b": "\\e"}
                # `JSON.stringify` escapes only C0 controls, so `code` is `00XX`.
                out += special.get(code, "\\x" + code[2:])
                i += 5
                start = i + 1
            elif nxt == ord("n"):
                if ctx.implicit_key or at(i + 2) == quote or size < 40:
                    i += 1
                else:
                    out += part(start, i) + "\n\n"
                    while at(i + 2) == backslash and at(i + 3) == ord("n") and at(i + 4) != quote:
                        out += "\n"
                        i += 2
                    out += indent
                    if at(i + 2) == space:
                        out += "\\"
                    i += 1
                    start = i + 1
            else:
                i += 1
        i += 1
    result = out + part(start, size) if start > 0 else part(0, size)
    if ctx.implicit_key:
        return result
    return _fold(result, indent, _QUOTED, ctx.indent_at_start)


def _block(value: str, ctx: _Ctx) -> str:
    """Stringifies a block scalar (`|` literal or `>` folded)."""
    newline = value.rfind("\n")
    tail = value[newline + 1 :]
    if newline >= 0 and tail and all(ch in " \t" for ch in tail):
        return _quoted(value, ctx)
    if ctx.indent:
        indent = ctx.indent
    elif ctx.force_block_indent or _document_marker(value):
        indent = "  "
    else:
        indent = ""
    literal = not _line_over_limit(value, len(indent))

    # Chomping from trailing whitespace.
    end_start = len(value)
    while end_start > 0 and value[end_start - 1] in "\n\t ":
        end_start -= 1
    end = value[end_start:]
    body = value[:end_start]
    pos = end.find("\n")
    if pos < 0:
        chomp = "-"
    elif not body or pos != len(end) - 1:
        chomp = "+"
    else:
        chomp = ""
    if end:
        end = _indent_runs(end.removesuffix("\n"), indent, inner=True)

    # Indentation indicator from leading whitespace.
    start_with_space = False
    start_nl = -1
    for index, ch in enumerate(body):
        if ch == " ":
            start_with_space = True
        elif ch == "\n":
            start_nl = index
        else:
            break
    start = body[: start_nl + 1]
    if start:
        body = body[start_nl + 1 :]
        start = _indent_runs(start, indent, inner=False)
    header = ("2" if indent else "1") if start_with_space else ""
    header += chomp

    if not literal:
        folded = _fold_block_body(body, indent)
        overflow = [False]
        folded = _fold(start + folded + end, indent, _BLOCK, len(indent), overflow)
        if not overflow[0]:
            return f">{header}\n{indent}{folded}"
    return f"|{header}\n{indent}{start}{_indent_runs(body, indent, inner=False)}{end}"


def _indent_runs(value: str, indent: str, *, inner: bool) -> str:
    """Follows each run of newlines with `indent`; with `inner`, not a trailing run."""
    out: list[str] = []
    run = 0
    for ch in value:
        if ch == "\n":
            run += 1
            continue
        if run:
            out.append("\n" * run + indent)
            run = 0
        out.append(ch)
    if run:
        out.append("\n" * run + ("" if inner else indent))
    return "".join(out)


def _fold_block_body(value: str, indent: str) -> str:
    """Prepares a folded block body: doubles line breaks and keeps more-indented lines literal."""
    doubled = re.sub(r"\n+", lambda m: "\n" + m.group(0), value)
    return _indent_runs(_keep_more_indented(doubled), indent, inner=False)


def _keep_more_indented(value: str) -> str:
    """Undoes the doubled line breaks around more-indented lines."""
    out: list[str] = []
    size = len(value)
    i = 0
    while i < size:
        if i == 0 and value[0] in "\t ":
            line = 0
        elif value[i] == "\n" and i + 1 < size and value[i + 1] in "\t ":
            line = i + 1
        else:
            out.append(value[i])
            i += 1
            continue
        # `.` stops at JavaScript line terminators.
        end = line
        while end < size and value[end] not in "\n\r\u2028\u2029":
            end += 1
        out.append(value[line:end])
        run = end
        while run < size and value[run] in "\n\t ":
            run += 1
        # The optional group matches only when the blank run ends with a line break.
        if run > end and value[run - 1] == "\n":
            out.append(value[end : run - 1])
            i = run
        else:
            i = end
    return "".join(out)


def _line_over_limit(value: str, indent: int) -> bool:
    width = _width.get()
    if not width:
        return False
    limit = width - indent
    units = _js.utf16(value)
    if len(units) <= limit:
        return False
    start = 0
    for i, unit in enumerate(units):
        if unit == 0x0A:
            if i - start > limit:
                return True
            start = i + 1
            if len(units) - start <= limit:
                return False
    return True


def _fold(
    text: str,
    indent: str,
    mode: int,
    indent_at_start: int | None,
    on_overflow: list[bool] | None = None,
) -> str:
    """Folds long lines at spaces, as `foldFlowLines` does."""
    if not _width.get():
        return text
    units = _js.utf16(text)
    size = len(units)

    def at(i: int) -> int | None:
        return units[i] if 0 <= i < size else None

    indent_len = len(indent)
    end_step = max(1 + MIN_CONTENT_WIDTH, 1 + LINE_WIDTH - indent_len)
    if size <= end_step:
        return text
    folds: list[int] = []
    escaped: list[int] = []
    end = LINE_WIDTH - indent_len
    if indent_at_start is not None:
        if indent_at_start > LINE_WIDTH - MIN_CONTENT_WIDTH:
            folds.append(0)
        else:
            end = LINE_WIDTH - indent_at_start
    split: int | None = None
    prev: int | None = None
    overflow = False
    i = -1
    esc_start = -1
    esc_end = -1
    if mode == _BLOCK:
        i = _consume_more_indented(units, i, indent_len)
        if i != -1:
            end = i + end_step
    sp, nl, tab = 0x20, 0x0A, 0x09
    while True:
        i += 1
        ch = at(i)
        if ch is None:
            break
        if mode == _QUOTED and ch == 0x5C:
            esc_start = i
            # Only `\xXX` escapes are longer than two units after `_double_quoted`.
            i += 3 if at(i + 1) == 0x78 else 1
            esc_end = i
        if ch == nl:
            if mode == _BLOCK:
                i = _consume_more_indented(units, i, indent_len)
            end = i + indent_len + end_step
            split = None
        else:
            if ch == sp and prev is not None and prev not in (sp, nl, tab):
                nxt = at(i + 1)
                if nxt is not None and nxt not in (sp, nl, tab):
                    split = i
            if i >= end:
                if split is not None:
                    folds.append(split)
                    end = split + end_step
                    split = None
                elif mode == _QUOTED:
                    while prev in (sp, tab):
                        prev = ch
                        i += 1
                        ch = at(i) or 0
                        overflow = True
                    j = max(i - 2 if i > esc_end + 1 else esc_start - 1, 0)
                    folds.append(j)
                    escaped.append(j)
                    end = j + end_step
                    split = None
                else:
                    overflow = True
        prev = ch
    if overflow and on_overflow is not None:
        on_overflow[0] = True
    if not folds:
        return text

    def part(a: int, b: int) -> str:
        return _js.from_utf16(units[max(a, 0) : b])

    res = part(0, folds[0])
    for k, fold_at in enumerate(folds):
        following = folds[k + 1] if k + 1 < len(folds) else 0
        stop = following if following != 0 else size
        if fold_at == 0:
            res = f"\n{indent}{part(0, stop)}"
        else:
            if mode == _QUOTED and fold_at in escaped:
                res += part(fold_at, fold_at + 1) + "\\"
            res += f"\n{indent}{part(fold_at + 1, stop)}"
    return res


def _consume_more_indented(units: list[int], i: int, indent: int) -> int:
    """Skips more-indented lines of a block scalar. Returns the last newline consumed."""

    def at(k: int) -> int | None:
        return units[k] if 0 <= k < len(units) else None

    end = i
    start = i + 1
    ch = at(start)
    while ch in (0x20, 0x09):
        if i < start + indent:
            i += 1
            ch = at(i)
        else:
            while True:
                i += 1
                ch = at(i)
                if ch is None or ch == 0x0A:
                    break
            end = i
            start = i + 1
            ch = at(start)
    return end


_PAIR = re.compile(r"^([^\s#'\"][^:]*?|\"[^\"]*\"|'[^']*'):(?:\s+(.*))?$")


def _scalar(text: str) -> Json:
    """Reads a flow scalar: quoted text, or a plain scalar resolved by the core schema."""
    if text.startswith("'") and text.endswith("'") and len(text) > 1:
        return text[1:-1].replace("''", "'")
    if text.startswith('"') and text.endswith('"') and len(text) > 1:
        if _js.json_parse_error(text) is not None:
            raise ValueError(f"Invalid double-quoted scalar: {text}")
        return _js.parse_json(text)
    plain = re.sub(r"\s+#.*$", "", text).strip()
    if plain in ("", "~", "null", "Null", "NULL"):
        return None
    if plain in ("true", "True", "TRUE"):
        return True
    if plain in ("false", "False", "FALSE"):
        return False
    if re.fullmatch(r"[-+]?[0-9]+", plain):
        return int(plain)
    return plain


_BLOCK_HEADER = re.compile(r"^([|>])([1-9+-]{0,2})(?:\s+#.*)?$")


def _fold_lines(lines: list[str]) -> str:
    """Folds lines as a folded scalar does.

    A break between two normal lines becomes a space, empty lines keep their breaks, and breaks
    around more-indented lines stay as written.
    """
    parts: list[str] = []
    previous: str | None = None
    empty = 0
    for line in lines:
        if not line:
            empty += 1
            continue
        kind = "more" if line[0] in " \t" else "normal"
        if previous is None:
            parts.append("\n" * empty)
        elif previous == kind == "normal":
            parts.append("\n" * empty or " ")
        else:
            parts.append("\n" * (empty + 1))
        parts.append(line)
        previous, empty = kind, 0
    return "".join(parts)


def _block_scalar(header: re.Match[str], lines: list[str]) -> str:
    """Reads the body of a top-level block scalar (`|` literal or `>` folded)."""
    style, indicators = header[1], header[2]
    digits = [c for c in indicators if c.isdigit()]
    chomp = next((c for c in indicators if c in "+-"), "")
    width = int(digits[0]) if digits else None
    if width is None:
        # The first non-empty line sets the indentation.
        width = next((len(ln) - len(ln.lstrip(" ")) for ln in lines if ln.strip()), 0)
    body = [ln[width:] if ln.strip() else "" for ln in lines]
    trailing = len(body) - len([*itertools.dropwhile(lambda ln: not ln, reversed(body))])
    body = body[: len(body) - trailing]
    content = "\n".join(body) if style == "|" else _fold_lines(body)
    if chomp == "-" or not content:
        return content
    return content + "\n" * (1 + (trailing if chomp == "+" else 0))


def parse_mapping(text: str) -> dict[str, Json]:
    r"""Parses a block mapping of scalars, such as skill frontmatter, as `yaml` reads it.

    Supports `key: value` lines with plain, single-quoted, and double-quoted scalars, plain
    scalars continued on indented lines, and `|` literal and `>` folded block scalars with
    chomping and indentation indicators. Comments and lines of any other form are skipped.

    >>> parse_mapping('name: demo\ndescription: "Say \\"hi\\""')
    {'name': 'demo', 'description': 'Say "hi"'}
    >>> parse_mapping("'a b': 'it''s'\n\"k\": ~\non: true\noff: FALSE\nn: -3\nx: y # c\n- z")
    {'a b': "it's", 'k': None, 'on': True, 'off': False, 'n': -3, 'x': 'y'}
    >>> parse_mapping("a: |\n  one\n   two\n\nb: >-\n  folded\n  text\n\n  more\nc: |+\n  kept\n\n")
    {'a': 'one\n two\n', 'b': 'folded text\nmore', 'c': 'kept\n\n'}
    >>> parse_mapping("d: >\n  a\n    indented\n  b\ne: |2-\n    x\nf: |\ng: a\n  b\n\n\n  c")
    {'d': 'a\n  indented\nb\n', 'e': '  x', 'f': '', 'g': 'a b\n\nc'}

    Raises:
        ValueError: When a double-quoted scalar has an invalid escape, as `yaml` rejects it.
    """
    out: dict[str, Json] = {}
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        match = _PAIR.match(lines[i].rstrip())
        i += 1
        if match is None:
            continue
        # A value's continuation: the indented and empty lines that follow its key.
        start = i
        while i < len(lines) and (not lines[i].strip() or lines[i][0] in " \t"):
            i += 1
        rest = lines[start:i]
        key = match[1].strip()
        name = str(_scalar(key)) if key[0] in "'\"" else key
        value = match[2] or ""
        header = _BLOCK_HEADER.match(value)
        if header is not None:
            out[name] = _block_scalar(header, rest)
        elif value[:1] not in ("'", '"') and any(ln.strip() for ln in rest):
            # A multi-line plain scalar folds its lines.
            out[name] = _scalar(_fold_lines([value, *(ln.strip() for ln in rest)]))
        else:
            out[name] = _scalar(value)
    return out
