//! Derive macros for `incur`.
//!
//! `#[derive(Schema)]` implements `incur::Schema` for structs with named fields and for enums with
//! unit variants. It reads the `serde` attributes that change field names or defaults, so a schema
//! names every field the way `serde` deserializes it, and the `incur` attributes that only matter
//! on the command line. See the `incur::schema` module documentation for examples.

use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::quote;
use syn::{
    Attribute, Data, DeriveInput, Expr, ExprLit, Fields, Ident, Lit, LitStr, Meta, MetaNameValue,
    Path, parse_macro_input, spanned::Spanned,
};

/// Derives `incur::Schema`.
///
/// Container attributes:
///
/// - `#[serde(rename_all = "...")]` renames every field or variant, as in `serde`.
/// - `#[serde(default)]` takes missing field defaults from `Default::default()`.
///
/// Field and variant attributes:
///
/// - Doc comments become the description. `#[incur(description = "...")]` overrides them.
/// - `#[serde(rename = "...")]`, `#[serde(skip)]`, and `#[serde(skip_deserializing)]`, as in
///   `serde`.
/// - `#[serde(default)]` and `#[serde(default = "path")]` set the default the schema reports. The
///   field type must implement `serde::Serialize`.
/// - `#[incur(alias = 'x')]` sets a single-character option alias.
/// - `#[incur(count)]` counts repeated flags, such as `-vvv`.
/// - `#[incur(deprecated)]` marks an option as deprecated.
/// - `#[incur(min = 1, max = 10)]` bounds a number, string length, or array length.
#[proc_macro_derive(Schema, attributes(incur))]
pub fn derive_schema(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    expand(&input)
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

/// Expands the derive for a struct or enum.
fn expand(input: &DeriveInput) -> syn::Result<TokenStream2> {
    let container = Container::parse(&input.attrs)?;
    let body = match &input.data {
        Data::Struct(data) => {
            let Fields::Named(fields) = &data.fields else {
                return Err(syn::Error::new(
                    input.ident.span(),
                    "Schema can only be derived for structs with named fields",
                ));
            };
            let mut entries = Vec::new();
            for field in &fields.named {
                if let Some(entry) = expand_field(&container, field)? {
                    entries.push(entry);
                }
            }
            quote!(::incur::schema::Type::object(::std::vec![#(#entries),*]))
        }
        Data::Enum(data) => {
            let mut names = Vec::new();
            for variant in &data.variants {
                if !matches!(variant.fields, Fields::Unit) {
                    return Err(syn::Error::new(
                        variant.span(),
                        "Schema can only be derived for enums with unit variants",
                    ));
                }
                let attrs = FieldAttrs::parse(&variant.attrs)?;
                if attrs.skip {
                    continue;
                }
                let name = attrs.rename.unwrap_or_else(|| {
                    container
                        .rename_all
                        .apply_to_variant(&unraw(&variant.ident))
                });
                names.push(name);
            }
            quote! {
                ::incur::schema::Type::new(::incur::schema::Kind::Enum(
                    ::std::vec![#(::std::string::String::from(#names)),*],
                ))
            }
        }
        Data::Union(_) => {
            return Err(syn::Error::new(
                input.ident.span(),
                "Schema cannot be derived for unions",
            ));
        }
    };
    let name = &input.ident;
    let (impl_generics, ty_generics, where_clause) = input.generics.split_for_impl();
    Ok(quote! {
        impl #impl_generics ::incur::Schema for #name #ty_generics #where_clause {
            fn schema() -> ::incur::schema::Type {
                #body
            }
        }
    })
}

/// Expands one struct field into an `incur::schema::Field` expression.
fn expand_field(container: &Container, field: &syn::Field) -> syn::Result<Option<TokenStream2>> {
    let attrs = FieldAttrs::parse(&field.attrs)?;
    if attrs.skip {
        return Ok(None);
    }
    // Named fields always have an identifier.
    let ident = &field.ident;
    let name = attrs.rename.clone().unwrap_or_else(|| {
        container
            .rename_all
            .apply_to_field(&ident.as_ref().map(unraw).unwrap_or_default())
    });
    let ty = &field.ty;

    let mut modifiers = Vec::new();
    let default = match &attrs.default {
        Some(Default::Trait) => Some(quote!(<#ty as ::core::default::Default>::default())),
        Some(Default::Path(path)) => Some(quote!(#path())),
        None if container.default => {
            Some(quote!(<Self as ::core::default::Default>::default().#ident))
        }
        None => None,
    };
    if let Some(default) = default {
        modifiers.push(quote!(.map(|ty| ::incur::__private::default(ty, &#default))));
    }
    if let Some(description) = attrs.description.or_else(|| doc(&field.attrs)) {
        modifiers.push(quote!(.map(|ty| ty.describe(#description))));
    }
    if attrs.count {
        modifiers.push(quote!(.map(::incur::schema::Type::count)));
    }
    if attrs.deprecated {
        modifiers.push(quote!(.map(::incur::schema::Type::deprecated)));
    }
    if let Some(min) = attrs.min {
        modifiers.push(quote!(.map(|ty| ty.min(#min))));
    }
    if let Some(max) = attrs.max {
        modifiers.push(quote!(.map(|ty| ty.max(#max))));
    }
    if let Some(alias) = attrs.alias {
        modifiers.push(quote!(.alias(#alias)));
    }
    Ok(Some(quote! {
        ::incur::schema::Field::new(#name, <#ty as ::incur::Schema>::schema()) #(#modifiers)*
    }))
}

/// Container-level attributes.
#[derive(Default)]
struct Container {
    /// Whether missing fields take their value from `Default::default()`.
    default: bool,
    /// The rule that renames every field or variant.
    rename_all: RenameRule,
}

impl Container {
    /// Reads `#[serde(...)]` container attributes.
    fn parse(attrs: &[Attribute]) -> syn::Result<Self> {
        let mut container = Self::default();
        for attr in attrs.iter().filter(|attr| attr.path().is_ident("serde")) {
            attr.parse_nested_meta(|meta| {
                if meta.path.is_ident("rename_all") {
                    let value: LitStr = meta.value()?.parse()?;
                    container.rename_all = RenameRule::parse(&value)?;
                } else if meta.path.is_ident("default") {
                    container.default = true;
                    if meta.input.peek(syn::Token![=]) {
                        return Err(meta.error("incur supports only `#[serde(default)]` here"));
                    }
                } else {
                    skip_value(&meta)?;
                }
                Ok(())
            })?;
        }
        Ok(container)
    }
}

/// A field default.
enum Default {
    /// `#[serde(default = "path")]`.
    Path(Path),
    /// `#[serde(default)]`.
    Trait,
}

/// Field and variant attributes.
#[derive(Default)]
struct FieldAttrs {
    /// Single-character option alias.
    alias: Option<char>,
    /// Whether the option counts repeated flags.
    count: bool,
    /// The default value source.
    default: Option<Default>,
    /// Whether the option is deprecated.
    deprecated: bool,
    /// Description override.
    description: Option<String>,
    /// Upper bound.
    max: Option<f64>,
    /// Lower bound.
    min: Option<f64>,
    /// Explicit name.
    rename: Option<String>,
    /// Whether the field is absent from input.
    skip: bool,
}

impl FieldAttrs {
    /// Reads `#[serde(...)]` and `#[incur(...)]` field attributes.
    fn parse(attrs: &[Attribute]) -> syn::Result<Self> {
        let mut out = Self::default();
        for attr in attrs {
            if attr.path().is_ident("serde") {
                attr.parse_nested_meta(|meta| {
                    if meta.path.is_ident("rename") {
                        if meta.input.peek(syn::Token![=]) {
                            let value: LitStr = meta.value()?.parse()?;
                            out.rename = Some(value.value());
                        } else {
                            skip_value(&meta)?;
                        }
                    } else if meta.path.is_ident("default") {
                        out.default = Some(if meta.input.peek(syn::Token![=]) {
                            let value: LitStr = meta.value()?.parse()?;
                            Default::Path(value.parse()?)
                        } else {
                            Default::Trait
                        });
                    } else if meta.path.is_ident("skip") || meta.path.is_ident("skip_deserializing")
                    {
                        out.skip = true;
                    } else if meta.path.is_ident("flatten") {
                        return Err(meta.error("incur schemas do not support `flatten`"));
                    } else {
                        skip_value(&meta)?;
                    }
                    Ok(())
                })?;
            } else if attr.path().is_ident("incur") {
                attr.parse_nested_meta(|meta| {
                    if meta.path.is_ident("alias") {
                        let value: Lit = meta.value()?.parse()?;
                        out.alias = Some(match value {
                            Lit::Char(value) => value.value(),
                            Lit::Str(value) if value.value().chars().count() == 1 => {
                                value.value().chars().next().unwrap_or_default()
                            }
                            other => {
                                return Err(syn::Error::new(
                                    other.span(),
                                    "`alias` takes a single character",
                                ));
                            }
                        });
                    } else if meta.path.is_ident("count") {
                        out.count = true;
                    } else if meta.path.is_ident("deprecated") {
                        out.deprecated = true;
                    } else if meta.path.is_ident("description") {
                        let value: LitStr = meta.value()?.parse()?;
                        out.description = Some(value.value());
                    } else if meta.path.is_ident("min") {
                        out.min = Some(number(&meta.value()?.parse()?)?);
                    } else if meta.path.is_ident("max") {
                        out.max = Some(number(&meta.value()?.parse()?)?);
                    } else {
                        return Err(meta.error("unknown incur attribute"));
                    }
                    Ok(())
                })?;
            }
        }
        Ok(out)
    }
}

/// Reads a numeric literal, accepting a leading minus sign.
fn number(expr: &Expr) -> syn::Result<f64> {
    match expr {
        Expr::Lit(ExprLit {
            lit: Lit::Int(value),
            ..
        }) => value.base10_parse(),
        Expr::Lit(ExprLit {
            lit: Lit::Float(value),
            ..
        }) => value.base10_parse(),
        Expr::Unary(unary) if matches!(unary.op, syn::UnOp::Neg(_)) => {
            number(&unary.expr).map(|value| -value)
        }
        other => Err(syn::Error::new(other.span(), "expected a number")),
    }
}

/// Consumes the value of an attribute this macro ignores.
fn skip_value(meta: &syn::meta::ParseNestedMeta<'_>) -> syn::Result<()> {
    if meta.input.peek(syn::Token![=]) {
        let _: Expr = meta.value()?.parse()?;
    } else if meta.input.peek(syn::token::Paren) {
        meta.parse_nested_meta(|nested| skip_value(&nested))?;
    }
    Ok(())
}

/// Joins the doc comment lines of an item into one description.
fn doc(attrs: &[Attribute]) -> Option<String> {
    let lines = attrs
        .iter()
        // rustc expands macros in `#[doc = ...]` before derives run, so values are literals.
        .filter_map(|attr| match &attr.meta {
            Meta::NameValue(MetaNameValue {
                path,
                value:
                    Expr::Lit(ExprLit {
                        lit: Lit::Str(value),
                        ..
                    }),
                ..
            }) if path.is_ident("doc") => Some(value.value().trim().to_owned()),
            _ => None,
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    (!lines.is_empty()).then(|| lines.join(" "))
}

/// Returns an identifier without its `r#` prefix.
fn unraw(ident: &Ident) -> String {
    let name = ident.to_string();
    name.strip_prefix("r#").map(str::to_owned).unwrap_or(name)
}

/// A `serde` `rename_all` rule.
#[derive(Clone, Copy, Default)]
enum RenameRule {
    /// `camelCase`.
    Camel,
    /// `kebab-case`.
    Kebab,
    /// `lowercase`.
    Lower,
    /// Names stay as written.
    #[default]
    None,
    /// `PascalCase`.
    Pascal,
    /// `SCREAMING-KEBAB-CASE`.
    ScreamingKebab,
    /// `SCREAMING_SNAKE_CASE`.
    ScreamingSnake,
    /// `snake_case`.
    Snake,
    /// `UPPERCASE`.
    Upper,
}

impl RenameRule {
    /// Parses a rule name.
    fn parse(value: &LitStr) -> syn::Result<Self> {
        Ok(match value.value().as_str() {
            "camelCase" => Self::Camel,
            "kebab-case" => Self::Kebab,
            "lowercase" => Self::Lower,
            "PascalCase" => Self::Pascal,
            "SCREAMING-KEBAB-CASE" => Self::ScreamingKebab,
            "SCREAMING_SNAKE_CASE" => Self::ScreamingSnake,
            "snake_case" => Self::Snake,
            "UPPERCASE" => Self::Upper,
            _ => return Err(syn::Error::new(value.span(), "unknown rename rule")),
        })
    }

    /// Renames a `snake_case` field, as `serde` does.
    fn apply_to_field(self, field: &str) -> String {
        match self {
            Self::None | Self::Lower | Self::Snake => field.to_owned(),
            Self::Upper | Self::ScreamingSnake => field.to_ascii_uppercase(),
            Self::Pascal | Self::Camel => {
                let mut out = String::new();
                let mut capitalize = matches!(self, Self::Pascal);
                for ch in field.chars() {
                    if ch == '_' {
                        capitalize = true;
                    } else if capitalize {
                        out.push(ch.to_ascii_uppercase());
                        capitalize = false;
                    } else {
                        out.push(ch);
                    }
                }
                out
            }
            Self::Kebab => field.replace('_', "-"),
            Self::ScreamingKebab => field.to_ascii_uppercase().replace('_', "-"),
        }
    }

    /// Renames a `PascalCase` variant, as `serde` does.
    fn apply_to_variant(self, variant: &str) -> String {
        match self {
            Self::None | Self::Pascal => variant.to_owned(),
            Self::Lower => variant.to_ascii_lowercase(),
            Self::Upper => variant.to_ascii_uppercase(),
            Self::Camel => {
                let mut chars = variant.chars();
                chars.next().map_or_else(String::new, |first| {
                    first.to_ascii_lowercase().to_string() + chars.as_str()
                })
            }
            Self::Snake | Self::Kebab | Self::ScreamingSnake | Self::ScreamingKebab => {
                let mut snake = String::new();
                for (index, ch) in variant.char_indices() {
                    if index > 0 && ch.is_uppercase() {
                        snake.push('_');
                    }
                    snake.push(ch.to_ascii_lowercase());
                }
                match self {
                    Self::Kebab => snake.replace('_', "-"),
                    Self::ScreamingSnake => snake.to_ascii_uppercase(),
                    Self::ScreamingKebab => snake.to_ascii_uppercase().replace('_', "-"),
                    _ => snake,
                }
            }
        }
    }
}
