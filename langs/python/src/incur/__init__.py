"""Build CLIs for agents and humans: TOON output, LLM manifests, skills, and shell completions.

This package is the Python port of the TypeScript `incur` package. Its output matches the
TypeScript package byte for byte.
"""

from ._cli import BannerMode, Cli, CliOptions, Config, Writer
from ._command import Context, Middleware, MiddlewareContext, Next, Outcome, OutputPolicy, ok
from ._derive import Command, Group, Handler
from ._elicit import Elicit, Elicited
from ._errors import Cta, CtaBlock, Error, FieldError
from ._formatter import Format
from ._help import Example, Usage
from ._http import FetchHandler, Headers, Request, RequestSource, Response, from_request, set_fetch
from ._mcp import CacheHint, Icon, McpOptions, McpTool, ToolAnnotations, ToolFilter
from ._mcp_features import Completer
from ._model import FieldInfo, RenameRule, SchemaError, arg, dump, env, field, schema
from ._openapi import OpenapiConfig, OpenapiOperation, OpenapiSource
from ._sync import Sync
from ._update import Update, UpdateCheck, UpdateInstall

__all__ = [
    "BannerMode",
    "CacheHint",
    "Cli",
    "CliOptions",
    "Command",
    "Completer",
    "Config",
    "Context",
    "Cta",
    "CtaBlock",
    "Elicit",
    "Elicited",
    "Error",
    "Example",
    "FetchHandler",
    "FieldError",
    "FieldInfo",
    "Format",
    "Group",
    "Handler",
    "Headers",
    "Icon",
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
    "arg",
    "dump",
    "env",
    "field",
    "from_request",
    "ok",
    "schema",
    "set_fetch",
]
