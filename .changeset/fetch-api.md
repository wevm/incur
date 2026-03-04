---
"incur": patch
---

Added Fetch API integration — mount any HTTP server as a CLI command.

- **Fetch gateway**: `.command('api', { fetch: app.fetch })` translates argv into HTTP requests using curl-style flags (`-X`, `-d`, `-H`, `--key value` query params)
- **Streaming**: NDJSON responses (`application/x-ndjson`) are streamed incrementally
- **OpenAPI support**: `.command('api', { fetch, openapi: spec })` generates typed subcommands with args, options, and descriptions from an OpenAPI 3.x spec
- Works with any framework exposing a Web Fetch API handler (Hono, Elysia, etc.)
