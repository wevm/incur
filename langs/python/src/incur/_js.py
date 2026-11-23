"""JavaScript string, number, and object semantics that reach output.

The TypeScript package formats values with `String(number)`, `JSON.stringify`, and
`localeCompare`, and JavaScript objects list integer-like keys first. Every module that formats
output reuses these functions, so the Python port prints the same bytes. Floats format as
JavaScript numbers do; integers keep their exact value.
"""

from __future__ import annotations

import json
import math
from typing import TypeAlias

#: JSON data as this package handles it.
Json: TypeAlias = "bool | int | float | str | list[Json] | dict[str, Json] | None"

_WHITESPACE = frozenset(
    "\t\n\x0b\x0c\r \xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009"
    "\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def is_whitespace(ch: str) -> bool:
    """Whether a character is ECMAScript white space or a line terminator."""
    return ch in _WHITESPACE


def trim(value: str) -> str:
    """Trims ECMAScript whitespace, as `String.prototype.trim` does."""
    start = 0
    end = len(value)
    while start < end and value[start] in _WHITESPACE:
        start += 1
    while end > start and value[end - 1] in _WHITESPACE:
        end -= 1
    return value[start:end]


def utf16_len(value: str) -> int:
    """Returns the length of a string in UTF-16 code units."""
    return len(value) + sum(1 for ch in value if ord(ch) > 0xFFFF)


def utf16(value: str) -> list[int]:
    """Returns the UTF-16 code units of a string."""
    data = value.encode("utf-16-le", "surrogatepass")
    return [data[i] | (data[i + 1] << 8) for i in range(0, len(data), 2)]


def from_utf16(units: list[int]) -> str:
    """Decodes UTF-16 code units, replacing unpaired surrogates as `from_utf16_lossy` does."""
    data = bytearray()
    for unit in units:
        data += bytes((unit & 0xFF, unit >> 8))
    return bytes(data).decode("utf-16-le", "replace")


def number_to_string(value: float) -> str:
    """Formats a number as ECMAScript `Number.prototype.toString` does, and integers exactly."""
    if isinstance(value, int):
        return str(value)
    # Data is finite: `normalize` and `to_json` store non-finite numbers as `None`.
    if not value:
        return "0"
    sign = "-" if value < 0 else ""
    mantissa, _, exp = repr(abs(value)).partition("e")
    exponent = int(exp) if exp else 0
    whole, _, frac = mantissa.partition(".")
    if frac == "0":
        frac = ""
    n = exponent - (len(frac) - len(frac.lstrip("0"))) if whole == "0" else len(whole) + exponent
    digits = (whole + frac).lstrip("0").rstrip("0")
    k = len(digits)
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return f"{sign}{digits[:n]}.{digits[n:]}"
    if -6 < n <= 0:
        return f"{sign}0.{'0' * -n}{digits}"
    e = n - 1
    rest = f".{digits[1:]}" if k > 1 else ""
    return f"{sign}{digits[0]}{rest}e{'+' if e >= 0 else '-'}{abs(e)}"


_PREFIXES = {"0x": 16, "0X": 16, "0o": 8, "0O": 8, "0b": 2, "0B": 2}
_RADIX_DIGITS = {16: "0123456789abcdefABCDEF", 8: "01234567", 2: "01"}


def to_number(text: str) -> float:
    """Converts a string to a number as ECMAScript `Number(string)` does."""
    text = trim(text)
    if not text:
        return 0.0
    radix = _PREFIXES.get(text[:2])
    if radix is not None:
        digits = text[2:]
        if not digits or any(ch not in _RADIX_DIGITS[radix] for ch in digits):
            return math.nan
        return float(int(digits, radix))
    unsigned = text[1:] if text[0] in "+-" else text
    if unsigned == "Infinity":
        return -math.inf if text[0] == "-" else math.inf
    if not _is_decimal_literal(unsigned):
        return math.nan
    return float(text)


def _is_decimal_literal(text: str) -> bool:
    """Whether `text` matches ECMAScript's `StrUnsignedDecimalLiteral` without `Infinity`."""
    index = 0
    size = len(text)

    def digits() -> int:
        nonlocal index
        start = index
        while index < size and text[index] in "0123456789":
            index += 1
        return index - start

    mantissa = digits()
    if index < size and text[index] == ".":
        index += 1
        mantissa += digits()
    if mantissa == 0:
        return False
    if index < size and text[index] in "eE":
        index += 1
        if index < size and text[index] in "+-":
            index += 1
        if digits() == 0:
            return False
    return index == size


def _quote(value: str) -> str:
    """Returns a JSON string literal with `JSON.stringify` escaping."""
    return json.dumps(value, ensure_ascii=False)


def stringify(value: Json, step: str | None = None, indent: str = "") -> str:
    """Serializes a value as `JSON.stringify(value)`, or with an indentation step."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return number_to_string(value) if math.isfinite(value) else "null"
    if isinstance(value, str):
        return _quote(value)
    inner = None if step is None else indent + step
    open_, close = ("[", "]") if isinstance(value, list) else ("{", "}")
    if not value:
        return open_ + close
    if isinstance(value, list):
        parts = [stringify(item, step, inner or "") for item in value]
    else:
        colon = ":" if inner is None else ": "
        parts = [
            _quote(key) + colon + stringify(item, step, inner or "") for key, item in value.items()
        ]
    if inner is None:
        return open_ + ",".join(parts) + close
    return f"{open_}\n{inner}" + f",\n{inner}".join(parts) + f"\n{indent}{close}"


def stringify_pretty(value: Json) -> str:
    """Serializes a value as `JSON.stringify(value, null, 2)` does."""
    return stringify(value, "  ")


def array_index(key: str) -> int | None:
    """Parses a canonical array index, the keys JavaScript orders first."""
    if not key or (len(key) > 1 and key[0] == "0") or any(ch not in "0123456789" for ch in key):
        return None
    index = int(key)
    return index if index < 2**32 - 1 else None


def normalize(value: Json) -> Json:
    """Reorders object keys as JavaScript stores them: integer-like keys first, ascending."""
    if isinstance(value, list):
        return [normalize(item) for item in value]
    if isinstance(value, dict):
        indices: list[tuple[int, str, Json]] = []
        rest: dict[str, Json] = {}
        for key, item in value.items():
            index = array_index(key)
            if index is None:
                rest[key] = normalize(item)
            else:
                indices.append((index, key, normalize(item)))
        indices.sort(key=lambda entry: entry[0])
        out = {key: item for _, key, item in indices}
        out.update(rest)
        return out
    return value


def relative_index(value: float, length: int) -> int:
    """Resolves a `slice` bound as JavaScript does: truncated, from the end when negative."""
    value = 0.0 if math.isnan(value) else min(max(value, -length), length)
    index = math.trunc(value)
    if index < 0:
        index += length
    return min(max(index, 0), length)


def element(items: list[str], value: float) -> str | None:
    """Returns the element JavaScript reads at `array[value]`."""
    if value >= 0 and value == math.floor(value) and value < len(items):
        return items[int(value)]
    return None


def to_string(value: Json) -> str:
    """Formats a value as `String(value)` does for JSON data."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return number_to_string(value)
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return ",".join("" if item is None else to_string(item) for item in value)
    return "[object Object]"


def to_kebab(value: str) -> str:
    """Converts a camelCase name to kebab-case."""
    return "".join(f"-{ch.lower()}" if "A" <= ch <= "Z" else ch for ch in value)


_SYMBOLS = "\t\n\x0b\x0c\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$"


def _primary(ch: str) -> int:
    """Returns the primary collation weight of a character."""
    index = _SYMBOLS.find(ch)
    if index >= 0:
        return index
    if "0" <= ch <= "9":
        return 100 + ord(ch)
    if ch.isascii() and ch.isalpha():
        return 200 + ord(ch.lower())
    return 1000 + ord(ch)


def locale_key(value: str) -> tuple[list[int], list[bool], str]:
    """Returns a sort key matching `String.prototype.localeCompare` under the ICU root collation."""
    return ([_primary(ch) for ch in value], [ch.isupper() for ch in value], value)


class _SyntaxError(Exception):
    """A JSON syntax failure: `None` for an early end, a located message, or a bad token."""

    def __init__(self, message: str | None = None, *, token: bool = False) -> None:
        super().__init__(message)
        self.message = message
        self.token = token


class _Syntax:
    """A JSON syntax checker that reports failures the way V8 does."""

    def __init__(self, units: list[int]) -> None:
        self.units = units
        self.pos = 0

    def peek(self) -> int | None:
        return self.units[self.pos] if self.pos < len(self.units) else None

    def is_(self, ch: str) -> bool:
        return self.peek() == ord(ch)

    def digit(self) -> bool:
        unit = self.peek()
        return unit is not None and 0x30 <= unit <= 0x39

    def whitespace(self) -> None:
        while self.peek() in (0x20, 0x09, 0x0A, 0x0D):
            self.pos += 1

    def at(self, message: str) -> _SyntaxError:
        before = self.units[: self.pos]
        line = before.count(0x0A) + 1
        last = len(before) - 1 - before[::-1].index(0x0A) if 0x0A in before else -1
        column = self.pos - (last + 1) + 1
        return _SyntaxError(f"{message} at position {self.pos} (line {line} column {column})")

    def value(self) -> None:
        self.whitespace()
        unit = self.peek()
        if unit is None:
            raise _SyntaxError()
        ch = chr(unit)
        if ch == "{":
            self.object()
        elif ch == "[":
            self.array()
        elif ch == '"':
            self.string()
        elif ch == "-" or "0" <= ch <= "9":
            self.number()
        elif ch in "tfn":
            self.literal({"t": "true", "f": "false", "n": "null"}[ch])
        else:
            raise _SyntaxError(token=True)

    def object(self) -> None:
        self.pos += 1
        self.whitespace()
        if self.is_("}"):
            self.pos += 1
            return
        first = True
        while True:
            if not self.is_('"'):
                raise self.at(
                    "Expected property name or '}' in JSON"
                    if first
                    else "Expected double-quoted property name in JSON"
                )
            first = False
            self.string()
            self.whitespace()
            if not self.is_(":"):
                raise self.at("Expected ':' after property name in JSON")
            self.pos += 1
            self.value()
            self.whitespace()
            if self.is_(","):
                self.pos += 1
                self.whitespace()
            elif self.is_("}"):
                self.pos += 1
                return
            else:
                raise self.at("Expected ',' or '}' after property value in JSON")

    def array(self) -> None:
        self.pos += 1
        self.whitespace()
        if self.is_("]"):
            self.pos += 1
            return
        while True:
            self.value()
            self.whitespace()
            if self.is_(","):
                self.pos += 1
            elif self.is_("]"):
                self.pos += 1
                return
            else:
                raise self.at("Expected ',' or ']' after array element in JSON")

    def string(self) -> None:
        self.pos += 1
        while True:
            unit = self.peek()
            if unit is None:
                raise self.at("Unterminated string in JSON")
            if unit == 0x22:
                self.pos += 1
                return
            if unit < 0x20:
                raise self.at("Bad control character in string literal in JSON")
            if unit == 0x5C:
                self.pos += 1
                escape = self.peek()
                if escape == ord("u"):
                    for _ in range(4):
                        self.pos += 1
                        hexdigit = self.peek()
                        if hexdigit is None or chr(hexdigit) not in "0123456789abcdefABCDEF":
                            raise self.at("Bad Unicode escape in JSON")
                elif escape is None or chr(escape) not in '"\\/bfnrt':
                    raise self.at("Bad escaped character in JSON")
            self.pos += 1

    def number(self) -> None:
        if self.is_("-"):
            self.pos += 1
            if not self.digit():
                raise self.at("No number after minus sign in JSON")
        if self.is_("0"):
            self.pos += 1
        else:
            while self.digit():
                self.pos += 1
        if self.is_("."):
            self.pos += 1
            if not self.digit():
                raise self.at("Unterminated fractional number in JSON")
            while self.digit():
                self.pos += 1
        if self.is_("e") or self.is_("E"):
            self.pos += 1
            if self.is_("+") or self.is_("-"):
                self.pos += 1
            if not self.digit():
                raise self.at("Exponent part is missing a number in JSON")
            while self.digit():
                self.pos += 1

    def literal(self, word: str) -> None:
        for expected in word:
            unit = self.peek()
            if unit is None:
                raise _SyntaxError()
            if unit != ord(expected):
                raise _SyntaxError(token=True)
            self.pos += 1


def json_parse_error(source: str) -> str | None:
    """Returns the message V8's `JSON.parse` throws for invalid JSON, or `None` if it accepts."""
    units = utf16(source)
    parser = _Syntax(units)
    try:
        parser.value()
        parser.whitespace()
        if parser.digit():
            raise parser.at("Unexpected number in JSON")
        if parser.peek() is not None:
            raise parser.at("Unexpected non-whitespace character after JSON")
    except _SyntaxError as failure:
        if failure.message is not None:
            return failure.message
        if not failure.token:
            return "Unexpected end of JSON input"
        pos = parser.pos
        token = from_utf16(units[pos : pos + 1])
        if len(units) < 21:
            context = f'"{source}"'
        else:
            start = max(pos - 10, 0)
            end = min(pos + 10, len(units))
            before = "..." if start > 0 else ""
            after = "..." if end < len(units) else ""
            context = f'{before}"{from_utf16(units[start:end])}"{after}'
        return f"Unexpected token '{token}', {context} is not valid JSON"
    return None


def parse_json(source: str) -> Json:
    """Parses JSON text that `json_parse_error` accepts, as `JSON.parse` does."""
    return normalize(json.loads(source))


def as_object(value: Json) -> dict[str, Json]:
    """Returns a JSON object, or an empty one for any other value."""
    return value if isinstance(value, dict) else {}


def as_list(value: Json) -> list[Json]:
    """Returns a JSON array, or an empty one for any other value."""
    return value if isinstance(value, list) else []
