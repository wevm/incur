# Language ports

incur for other languages. Each port matches the TypeScript package's output byte for byte.

## [Rust](./rust)

```sh
cargo add incur serde -F serde/derive
```

## [Python](./python)

```sh
pip install incur-cli
```

## [Zig](./zig)

Requires Zig 0.17.1.

```sh
zig fetch --save https://github.com/wevm/incur/releases/download/incur@0.10.0/incur-zig-0.10.0.tar.gz
```

To work on a port, see [CONTRIBUTING.md](./CONTRIBUTING.md).
