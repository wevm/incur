//! `#[derive(Schema)]` reads the `serde` attributes that shape input and the `incur` attributes
//! that describe options. Rejected inputs are compile-fail fixtures in `tests/ui`.

use incur::Schema;
use incur::schema::json_schema;
use insta::assert_snapshot;
use serde::{Deserialize, Serialize};

/// Returns a type's JSON Schema as incur prints it.
fn schema<T: Schema>() -> String {
    incur::formatter::format(&json_schema(&T::schema()), incur::Format::Json)
}

/// Returns the field names of a type's schema.
fn names<T: Schema>() -> String {
    T::schema()
        .fields()
        .iter()
        .map(|f| f.name.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Default, Schema, Serialize)]
#[serde(default, deny_unknown_fields)]
struct Options {
    /// Output directory.
    ///
    /// Created when missing.
    out_dir: String,
    /// Overridden by `description`.
    #[incur(description = "Explicit description", alias = "v", count, deprecated)]
    verbose: f64,
    #[incur(alias = 'j', min = -1.5, max = 2.5)]
    #[serde(rename = "jobs", alias = "j")]
    r#jobs_count: Option<f64>,
    #[serde(default = "three", rename(serialize = "ignored"))]
    retries: f64,
    #[serde(skip)]
    #[expect(dead_code, reason = "Skipped fields are absent from input.")]
    cache: Vec<String>,
    #[serde(skip_deserializing)]
    computed: bool,
    #[serde(with = "plain", default)]
    nothing: Option<String>,
}

fn three() -> f64 {
    3.0
}

mod plain {
    //! A no-op `serde(with)` module, to show the attribute is ignored.

    #[expect(
        clippy::ref_option,
        reason = "`serde(with)` passes the field by reference."
    )]
    pub(super) fn serialize<S: serde::Serializer>(
        value: &Option<String>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        serde::Serialize::serialize(value, s)
    }
}

#[test]
fn reads_serde_and_incur_attributes() {
    assert_snapshot!(schema::<Options>(), @r#"
    {
      "type": "object",
      "properties": {
        "out_dir": {
          "default": "",
          "description": "Output directory. Created when missing.",
          "type": "string"
        },
        "verbose": {
          "default": 0,
          "description": "Explicit description",
          "count": true,
          "deprecated": true,
          "type": "number"
        },
        "jobs": {
          "type": "number",
          "minimum": -1.5,
          "maximum": 2.5
        },
        "retries": {
          "default": 3,
          "type": "number"
        },
        "nothing": {
          "type": "string"
        }
      },
      "required": [
        "out_dir",
        "verbose",
        "retries"
      ],
      "additionalProperties": false
    }
    "#);
}

#[derive(Deserialize, Schema)]
#[serde(rename_all = "kebab-case")]
enum Level {
    LowPriority,
    #[serde(rename = "HIGH")]
    High,
    #[serde(skip)]
    #[expect(dead_code, reason = "Skipped variants never parse.")]
    Hidden,
}

#[test]
fn describes_unit_enums() {
    assert_snapshot!(schema::<Level>(), @r#"
    {
      "type": "string",
      "enum": [
        "low-priority",
        "HIGH"
      ]
    }
    "#);
}

macro_rules! rename_all {
    ($($rule:literal),*) => {{
        let mut lines = Vec::new();
        $({
            #[derive(Deserialize, Schema)]
            #[serde(rename_all = $rule)]
            #[expect(dead_code, reason = "Only the schema is used.")]
            struct Fields {
                first_field: u8,
            }

            #[derive(Deserialize, Schema)]
            #[serde(rename_all = $rule)]
            enum Variants {
                FirstVariant,
            }

            let variants = serde_json::to_string(&json_schema(&Variants::schema())["enum"]).unwrap();
            lines.push(format!("{}: {} {variants}", $rule, names::<Fields>()));
        })*
        lines.join("\n")
    }};
}

#[test]
fn renames_like_serde() {
    let lines = rename_all!(
        "camelCase",
        "kebab-case",
        "lowercase",
        "PascalCase",
        "SCREAMING-KEBAB-CASE",
        "SCREAMING_SNAKE_CASE",
        "snake_case",
        "UPPERCASE"
    );
    assert_snapshot!(lines, @r#"
    camelCase: firstField ["firstVariant"]
    kebab-case: first-field ["first-variant"]
    lowercase: first_field ["firstvariant"]
    PascalCase: FirstField ["FirstVariant"]
    SCREAMING-KEBAB-CASE: FIRST-FIELD ["FIRST-VARIANT"]
    SCREAMING_SNAKE_CASE: FIRST_FIELD ["FIRST_VARIANT"]
    snake_case: first_field ["first_variant"]
    UPPERCASE: FIRST_FIELD ["FIRSTVARIANT"]
    "#);
}

#[test]
fn compile_errors() {
    trybuild::TestCases::new().compile_fail("tests/ui/*.rs");
}
