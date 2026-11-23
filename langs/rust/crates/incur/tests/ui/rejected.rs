//! Inputs `#[derive(Schema)]` rejects, one per item.

use incur::Schema;
use serde::Deserialize;

#[derive(Schema)]
struct Tuple(u8);

#[derive(Schema)]
enum Data {
    Value(u8),
}

#[derive(Schema)]
union Bits {
    int: u32,
}

#[derive(Deserialize, Schema)]
struct Flatten {
    #[serde(flatten)]
    inner: u8,
}

#[derive(Schema)]
struct Unknown {
    #[incur(short)]
    value: u8,
}

#[derive(Schema)]
struct LongAlias {
    #[incur(alias = "ab")]
    value: u8,
}

#[derive(Schema)]
struct NumberAlias {
    #[incur(alias = 1)]
    value: u8,
}

#[derive(Schema)]
struct TextBound {
    #[incur(min = "1")]
    value: u8,
}

#[derive(Deserialize, Schema)]
#[serde(rename_all = "Title Case")]
struct Rule {
    value: u8,
}

#[derive(Deserialize, Schema)]
#[serde(default = "make")]
struct DefaultPath {
    value: u8,
}

fn main() {}
