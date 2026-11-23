"""Build CLIs for agents and humans: TOON output, LLM manifests, skills, and shell completions.

This package is the Python port of the TypeScript `incur` package. Its output matches the
TypeScript package byte for byte.
"""

from ._cli import BannerMode, Cli, Config, Writer
from ._command import Context, Middleware, MiddlewareContext, Next, Outcome, OutputPolicy, ok
from ._errors import Cta, CtaBlock, Error, FieldError
from ._formatter import Format
from ._help import Example, Usage
from ._model import FieldInfo, RenameRule, SchemaError, dump, field, schema

__all__ = [
    "BannerMode",
    "Cli",
    "Config",
    "Context",
    "Cta",
    "CtaBlock",
    "Error",
    "Example",
    "FieldError",
    "FieldInfo",
    "Format",
    "Middleware",
    "MiddlewareContext",
    "Next",
    "Outcome",
    "OutputPolicy",
    "RenameRule",
    "SchemaError",
    "Usage",
    "Writer",
    "dump",
    "field",
    "ok",
    "schema",
]
