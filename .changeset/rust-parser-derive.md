---
'incur': minor
---

Added `#[derive(Parser)]` to the Rust port: declare a CLI as a struct or an enum of commands and groups, then call `MyCli::parse()` for the typed command or `MyCli::serve(handler)` for incur-formatted output, `--mcp`, and HTTP. Rust handlers now return any `Serialize` value, `incur::Result<T>` aliases results, and `tokio` became a default feature with a std-only executor when disabled. A Rust handler returning `Result<T, E>` where `E` is itself `Serialize` now needs `Result<T, incur::Error>`.
