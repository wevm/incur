# Language ports

incur for other languages. Each port matches the TypeScript package's output byte for byte.

## [Rust](./rust)

### Install

```sh
cargo add incur serde -F serde/derive
```

### Usage

```rust
use incur::Parser;

/// A greeting CLI
#[derive(Parser)]
#[incur(name = "greet")]
struct Greet {
    /// Name to greet
    #[incur(arg)]
    name: String,
}

#[derive(serde::Serialize)]
struct Greeting {
    message: String,
}

fn main() {
    Greet::serve(|greet, _| Greeting { message: format!("hello {}", greet.name) });
}
```

```sh
$ greet world
# → message: hello world
```

## [Python](./python)

### Install

```sh
pip install incur-cli
```

### Usage

```python
from typing import Annotated

import incur


class Greet(incur.Command, name="greet"):
    """A greeting CLI"""

    name: Annotated[str, incur.arg("Name to greet")]


if __name__ == "__main__":
    Greet.serve(lambda greet, _: {"message": f"hello {greet.name}"})
```

```sh
$ greet world
# → message: hello world
```

## [Zig](./zig)

### Install

Requires Zig 0.17.1.

```sh
zig fetch --save https://github.com/wevm/incur/releases/download/incur@0.10.0/incur-zig-0.10.0.tar.gz
```

```zig
// build.zig
const incur = b.dependency("incur", .{ .target = target, .optimize = optimize });
exe.root_module.addImport("incur", incur.module("incur"));
```

### Usage

```zig
const std = @import("std");
const incur = @import("incur");

const Greet = struct {
    name: []const u8,

    pub const incur = .{
        .name = "greet",
        .description = "A greeting CLI",
        .fields = .{ .name = .{ .arg = true, .description = "Name to greet" } },
    };
};

fn run(c: *incur.Context(.{}), greet: Greet) !incur.Outcome {
    return c.ok(.{ .message = try std.fmt.allocPrint(c.allocator, "hello {s}", .{greet.name}) });
}

pub fn main(init: std.process.Init) !void {
    try incur.serve(Greet, init, run);
}
```

```sh
$ greet world
# → message: hello world
```

To work on a port, see [CONTRIBUTING.md](./CONTRIBUTING.md).
