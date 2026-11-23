//! Inputs `#[derive(Parser)]` rejects, one per item.

use incur::{Parser, Schema};

#[derive(Parser)]
union Bits {
    int: u32,
}

#[derive(Parser)]
struct Tuple(u8);

#[derive(Parser)]
struct Generic<T> {
    value: T,
}

#[derive(Parser)]
enum Pair {
    Both(u8, u8),
}

#[derive(Parser)]
struct Both {
    #[incur(arg, env)]
    value: String,
}

#[derive(Parser)]
#[incur(about = "text")]
struct Unknown {
    value: String,
}

#[derive(Parser)]
enum VariantVersion {
    #[incur(version = "1.0.0")]
    Status,
}

#[derive(Parser)]
#[incur(aliases = [1])]
struct NumberAlias {
    value: String,
}

#[derive(Schema)]
struct SchemaName {
    #[incur(name = "other")]
    value: u8,
}

#[derive(Parser)]
enum Group {
    Status,
}

#[derive(Parser)]
enum GroupAttributes {
    #[incur(aliases = ["g"])]
    Aliased(Group),
    #[incur(hint = "Commands")]
    Hinted(Group),
    #[incur(name = "x", destructive)]
    Destructive(Group),
    #[incur(output = Group)]
    Output(Group),
    #[incur(middleware = noop)]
    Middleware(Group),
    #[incur(example = "status")]
    Example(Group),
    #[incur(usage(args = ["name"]))]
    Usage(Group),
}

#[derive(Parser)]
#[incur(hint = "Commands")]
enum EnumHint {
    Status,
}

#[derive(Parser)]
#[incur(middleware = noop, example = "status")]
enum EnumExample {
    Status,
}

#[derive(Parser)]
enum BadExample {
    #[incur(example(text = "status"))]
    Status,
}

#[derive(Parser)]
enum BadUsage {
    #[incur(usage(flags = ["a"]))]
    Status,
}

async fn noop(c: incur::MiddlewareContext, next: incur::Next) -> Result<(), incur::Error> {
    next.run(c).await
}

fn main() {}
