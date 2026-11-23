"""Build CLIs for agents and humans: TOON output, LLM manifests, skills, and shell completions.

This package is the Python port of the TypeScript `incur` package. Its output matches the
TypeScript package byte for byte.
"""

from ._cli import BannerMode, Cli, Config, Writer
from ._command import Context, Middleware, MiddlewareContext, Next, Outcome, OutputPolicy, ok
from ._errors import Cta, CtaBlock, Error, FieldError
from ._formatter import Format
from ._help import Example, Usage
from ._http import FetchHandler, Headers, Request, RequestSource, Response, from_request, set_fetch
from ._mcp import McpOptions, McpTool, ToolAnnotations, ToolFilter
from ._model import FieldInfo, RenameRule, SchemaError, dump, field, schema
from ._openapi import OpenapiConfig, OpenapiOperation, OpenapiSource
from ._sync import Sync
from ._update import Update, UpdateCheck, UpdateInstall

__all__ = [
    "BannerMode",
    "Cli",
    "Config",
    "Context",
    "Cta",
    "CtaBlock",
    "Error",
    "Example",
    "FetchHandler",
    "FieldError",
    "FieldInfo",
    "Format",
    "Headers",
    "McpOptions",
    "McpTool",
    "Middleware",
    "MiddlewareContext",
    "Next",
    "OpenapiConfig",
    "OpenapiOperation",
    "OpenapiSource",
    "Outcome",
    "OutputPolicy",
    "RenameRule",
    "Request",
    "RequestSource",
    "Response",
    "SchemaError",
    "Sync",
    "ToolAnnotations",
    "ToolFilter",
    "Update",
    "UpdateCheck",
    "UpdateInstall",
    "Usage",
    "Writer",
    "dump",
    "field",
    "from_request",
    "ok",
    "schema",
    "set_fetch",
]
