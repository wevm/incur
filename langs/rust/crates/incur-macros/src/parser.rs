//! `#[derive(Parser)]`: a struct becomes a single-command CLI, an enum a CLI with a subcommand
//! per variant.

use proc_macro2::{Span, TokenStream as TokenStream2};
use quote::{ToTokens, quote, quote_spanned};
use syn::{
    Attribute, Data, DeriveInput, Expr, ExprArray, ExprLit, Fields, Lit, LitStr, Type,
    meta::ParseNestedMeta, spanned::Spanned,
};

use crate::{FieldAttrs, RenameRule, doc, field_schema, unraw};

/// Attributes that describe a command, which a command group does not take.
const COMMAND_ONLY: [&str; 7] = [
    "aliases",
    "destructive",
    "example",
    "hint",
    "middleware",
    "output",
    "usage",
];

/// Command and CLI attributes of a type or variant.
#[derive(Clone, Default)]
struct CommandAttrs {
    /// Alternative names: binary aliases on a CLI, command aliases on a variant.
    aliases: Vec<String>,
    /// Description override.
    description: Option<String>,
    /// Whether the command changes or deletes state.
    destructive: bool,
    /// Examples: the arguments after the command name and a description.
    examples: Vec<(String, Option<String>)>,
    /// Guidance shown after examples.
    hint: Option<String>,
    /// Every attribute key read, with its span, in order.
    keys: Vec<(String, Span)>,
    /// Middleware functions, in order.
    middleware: Vec<Expr>,
    /// The command or CLI name.
    name: Option<String>,
    /// The output schema type.
    output: Option<Type>,
    /// Alternative usage lines, as `incur::help::Usage` expressions.
    usages: Vec<TokenStream2>,
    /// The CLI version.
    version: Option<Version>,
}

/// A CLI version.
#[derive(Clone)]
enum Version {
    /// A literal version.
    Literal(String),
    /// The package version.
    Package,
}

/// Reads an array of string literals, as in `aliases = ["a", "b"]`.
fn strings(meta: &ParseNestedMeta<'_>, key: &str) -> syn::Result<Vec<String>> {
    let value: ExprArray = meta.value()?.parse()?;
    value
        .elems
        .into_iter()
        .map(|element| match element {
            Expr::Lit(ExprLit {
                lit: Lit::Str(value),
                ..
            }) => Ok(value.value()),
            other => Err(syn::Error::new(
                other.span(),
                format!("`{key}` takes string literals"),
            )),
        })
        .collect()
}

impl CommandAttrs {
    /// Reads `#[incur(...)]` attributes. `cli` accepts `version`, which only a type takes.
    fn parse(attrs: &[Attribute], cli: bool) -> syn::Result<Self> {
        let mut out = Self::default();
        for attr in attrs.iter().filter(|attr| attr.path().is_ident("incur")) {
            attr.parse_nested_meta(|meta| {
                let key = meta
                    .path
                    .get_ident()
                    .map(ToString::to_string)
                    .unwrap_or_default();
                out.keys.push((key.clone(), meta.path.span()));
                match key.as_str() {
                    "aliases" => out.aliases.extend(strings(&meta, "aliases")?),
                    "description" => {
                        out.description = Some(meta.value()?.parse::<LitStr>()?.value());
                    }
                    "destructive" => out.destructive = true,
                    "example" => out.examples.push(example(&meta)?),
                    "hint" => out.hint = Some(meta.value()?.parse::<LitStr>()?.value()),
                    "middleware" => out.middleware.push(meta.value()?.parse()?),
                    "name" => out.name = Some(meta.value()?.parse::<LitStr>()?.value()),
                    "output" => out.output = Some(meta.value()?.parse()?),
                    "usage" => out.usages.push(usage(&meta)?),
                    "version" if cli => {
                        out.version = Some(if meta.input.peek(syn::Token![=]) {
                            Version::Literal(meta.value()?.parse::<LitStr>()?.value())
                        } else {
                            Version::Package
                        });
                    }
                    _ => return Err(meta.error("unknown incur attribute")),
                }
                Ok(())
            })?;
        }
        Ok(out)
    }

    /// Returns the first attribute among `keys`, with its span.
    fn first(&self, keys: &[&str]) -> Option<&(String, Span)> {
        self.keys
            .iter()
            .find(|(key, _)| keys.contains(&key.as_str()))
    }

    /// Returns the `incur::__private::Meta` of a command with doc comments `attrs`.
    fn meta(&self, attrs: &[Attribute]) -> TokenStream2 {
        let aliases = &self.aliases;
        let description = option(self.description.clone().or_else(|| doc(attrs)));
        let destructive = self.destructive;
        let hint = option(self.hint.clone());
        let output = self.output.as_ref().map_or_else(
            || quote!(::core::option::Option::None),
            |ty| quote!(::core::option::Option::Some(<#ty as ::incur::Schema>::schema)),
        );
        let configure =
            if self.middleware.is_empty() && self.examples.is_empty() && self.usages.is_empty() {
                quote!(::core::option::Option::None)
            } else {
                let middleware = &self.middleware;
                let examples = self.examples.iter().map(|(command, description)| {
                    let description = option(description.clone());
                    quote!(.example(#command, #description))
                });
                let usages = &self.usages;
                quote! {
                    ::core::option::Option::Some(
                        (|command: ::incur::Command| {
                            command #(.middleware(#middleware))* #(#examples)* #(.usage(#usages))*
                        }) as fn(::incur::Command) -> ::incur::Command,
                    )
                }
            };
        quote! {
            ::incur::__private::Meta {
                aliases: &[#(#aliases),*],
                configure: #configure,
                description: #description,
                destructive: #destructive,
                hint: #hint,
                output: #output,
            }
        }
    }
}

/// Reads `example = "args"` or `example(command = "args", description = "...")`.
fn example(meta: &ParseNestedMeta<'_>) -> syn::Result<(String, Option<String>)> {
    if meta.input.peek(syn::Token![=]) {
        return Ok((meta.value()?.parse::<LitStr>()?.value(), None));
    }
    let (mut command, mut description) = (String::new(), None);
    meta.parse_nested_meta(|nested| {
        if nested.path.is_ident("command") {
            command = nested.value()?.parse::<LitStr>()?.value();
        } else if nested.path.is_ident("description") {
            description = Some(nested.value()?.parse::<LitStr>()?.value());
        } else {
            return Err(nested.error("expected `command` or `description`"));
        }
        Ok(())
    })?;
    Ok((command, description))
}

/// Reads `usage(args = [...], options = [...], prefix = "...", suffix = "...")` into an
/// `incur::help::Usage` expression.
fn usage(meta: &ParseNestedMeta<'_>) -> syn::Result<TokenStream2> {
    let (mut args, mut options, mut prefix, mut suffix) = (vec![], vec![], None, None);
    meta.parse_nested_meta(|nested| {
        if nested.path.is_ident("args") {
            args = strings(&nested, "args")?;
        } else if nested.path.is_ident("options") {
            options = strings(&nested, "options")?;
        } else if nested.path.is_ident("prefix") {
            prefix = Some(nested.value()?.parse::<LitStr>()?.value());
        } else if nested.path.is_ident("suffix") {
            suffix = Some(nested.value()?.parse::<LitStr>()?.value());
        } else {
            return Err(nested.error("expected `args`, `options`, `prefix`, or `suffix`"));
        }
        Ok(())
    })?;
    let text = |value: Option<String>| {
        value.map_or_else(
            || quote!(::core::option::Option::None),
            |value| quote!(::core::option::Option::Some(::std::string::String::from(#value))),
        )
    };
    let (prefix, suffix) = (text(prefix), text(suffix));
    Ok(quote! {
        ::incur::help::Usage {
            args: ::std::vec![#(::std::string::String::from(#args)),*],
            options: ::std::vec![#(::std::string::String::from(#options)),*],
            prefix: #prefix,
            suffix: #suffix,
        }
    })
}

/// Quotes an optional string literal.
fn option(value: Option<String>) -> TokenStream2 {
    value.map_or_else(
        || quote!(::core::option::Option::None),
        |value| quote!(::core::option::Option::Some(#value)),
    )
}

/// Gives every top-level token of `tokens` the span `span`, so errors about them point there.
fn respan(tokens: TokenStream2, span: Span) -> TokenStream2 {
    tokens
        .into_iter()
        .map(|mut token| {
            token.set_span(span);
            token
        })
        .collect()
}

/// Expands `#[derive(Parser)]`.
pub(crate) fn expand(input: &DeriveInput) -> syn::Result<TokenStream2> {
    if !input.generics.params.is_empty() {
        return Err(syn::Error::new(
            input.generics.span(),
            "Parser cannot be derived for generic types",
        ));
    }
    let ident = &input.ident;
    let attrs = CommandAttrs::parse(&input.attrs, true)?;
    let mut checks = Vec::new();
    let mut group_middleware = Vec::new();
    let node = match &input.data {
        Data::Struct(data) => {
            let (inputs, build) = fields(&data.fields, &quote!(Self))?;
            // The root command takes its description from the CLI, and aliases name the CLI.
            let own = CommandAttrs {
                aliases: Vec::new(),
                description: None,
                version: None,
                ..attrs.clone()
            };
            let meta = own.meta(&[]);
            quote! {
                fn attach(
                    cli: ::incur::Cli,
                    run: ::incur::__private::Run<Self>,
                ) -> ::incur::Cli {
                    let own = #meta;
                    cli.root(own.apply(::incur::__private::leaf(#inputs, |fields| #build, own, run)))
                }

                fn mount(
                    cli: ::incur::Cli,
                    name: &str,
                    meta: ::incur::__private::Meta,
                    run: ::incur::__private::Run<Self>,
                ) -> ::incur::Cli {
                    let own = #meta.or_description(<Self as ::incur::__private::Node>::DESCRIPTION);
                    let command = ::incur::__private::leaf(#inputs, |fields| #build, meta.or(own), run);
                    cli.command(name, meta.apply(own.apply(command)))
                }
            }
        }
        Data::Enum(data) => {
            // An enum is a command group: only its name, description, aliases (as a CLI),
            // version, and middleware apply.
            if let Some((key, span)) =
                attrs.first(&["destructive", "example", "hint", "output", "usage"])
            {
                return Err(syn::Error::new(
                    *span,
                    format!("`{key}` describes a command, but an enum is a command group"),
                ));
            }
            group_middleware.clone_from(&attrs.middleware);
            let mut variants = Vec::new();
            for variant in &data.variants {
                variants.push(register(variant, &mut checks)?);
            }
            quote! {
                fn attach(
                    cli: ::incur::Cli,
                    run: ::incur::__private::Run<Self>,
                ) -> ::incur::Cli {
                    #(let cli = #variants;)*
                    let _ = run;
                    cli
                }

                fn mount(
                    cli: ::incur::Cli,
                    name: &str,
                    meta: ::incur::__private::Meta,
                    run: ::incur::__private::Run<Self>,
                ) -> ::incur::Cli {
                    let group = ::incur::Cli::new(name) #(.middleware(#group_middleware))*;
                    meta.or_description(<Self as ::incur::__private::Node>::DESCRIPTION)
                        .group::<Self>(cli, group, run)
                }
            }
        }
        Data::Union(_) => {
            return Err(syn::Error::new(
                ident.span(),
                "Parser cannot be derived for unions",
            ));
        }
    };
    let leaf = matches!(input.data, Data::Struct(_))
        .then(|| quote!(#[automatically_derived] impl ::incur::__private::Leaf for #ident {}));
    let name = attrs.name.as_ref().map_or_else(
        || quote!(::core::env!("CARGO_PKG_NAME")),
        |name| quote!(#name),
    );
    let description = attrs.description.clone().or_else(|| doc(&input.attrs));
    let mut cli = quote!(::incur::Cli::new(#name));
    if let Some(description) = &description {
        cli = quote!(#cli.description(#description));
    }
    let description = option(description);
    match &attrs.version {
        Some(Version::Literal(version)) => cli = quote!(#cli.version(#version)),
        Some(Version::Package) => cli = quote!(#cli.version(::core::env!("CARGO_PKG_VERSION"))),
        None => {}
    }
    if !attrs.aliases.is_empty() {
        let aliases = &attrs.aliases;
        cli = quote!(#cli.aliases([#(#aliases),*]));
    }
    Ok(quote! {
        #[automatically_derived]
        impl ::incur::__private::Node for #ident {
            const DESCRIPTION: ::core::option::Option<&'static str> = #description;

            #node
        }

        #leaf

        #[automatically_derived]
        impl ::incur::Parser for #ident {
            fn cli() -> ::incur::Cli {
                #cli #(.middleware(#group_middleware))*
            }
        }

        #(#checks)*
    })
}

/// Expands the registration of one enum variant on `cli`. A tuple variant with command
/// attributes adds to `checks` an assertion that its type is a command, not a group.
fn register(variant: &syn::Variant, checks: &mut Vec<TokenStream2>) -> syn::Result<TokenStream2> {
    let attrs = CommandAttrs::parse(&variant.attrs, false)?;
    let ident = &variant.ident;
    let name = attrs
        .name
        .clone()
        .unwrap_or_else(|| RenameRule::Kebab.apply_to_variant(&unraw(ident)));
    let meta = attrs.meta(&variant.attrs);
    if let Fields::Unnamed(fields) = &variant.fields {
        let [field] = fields.unnamed.iter().collect::<Vec<_>>()[..] else {
            return Err(syn::Error::new(
                variant.span(),
                "a tuple variant holds exactly one Parser type",
            ));
        };
        let ty = &field.ty;
        if let Some((_, span)) = attrs.first(&COMMAND_ONLY) {
            let ty = respan(ty.to_token_stream(), *span);
            checks.push(quote_spanned! {*span=>
                const _: () = <#ty as ::incur::__private::Leaf>::COMMAND;
            });
        }
        return Ok(quote! {
            <#ty as ::incur::__private::Node>::mount(cli, #name, #meta, {
                let run = run.clone();
                ::std::sync::Arc::new(move |value: #ty, context: ::incur::Context| {
                    run(Self::#ident(value), context)
                })
            })
        });
    }
    let (inputs, build) = fields(&variant.fields, &quote!(Self::#ident))?;
    Ok(quote! {{
        let meta = #meta;
        cli.command(
            #name,
            meta.apply(::incur::__private::leaf(#inputs, |fields| #build, meta, run.clone())),
        )
    }})
}

/// Expands the input schemas of named or unit fields, as `[args, options, env]`, and the
/// expression that builds `path` from `incur::__private::Fields`.
fn fields(fields: &Fields, path: &TokenStream2) -> syn::Result<(TokenStream2, TokenStream2)> {
    let named = match fields {
        Fields::Named(named) => named.named.iter().collect::<Vec<_>>(),
        Fields::Unit => Vec::new(),
        Fields::Unnamed(unnamed) => {
            return Err(syn::Error::new(
                unnamed.span(),
                "Parser can only be derived for structs with named fields",
            ));
        }
    };
    let (mut args, mut options, mut env, mut init) = (vec![], vec![], vec![], vec![]);
    for field in named {
        let attrs = FieldAttrs::parse(&field.attrs, true)?;
        // Named fields always have an identifier.
        let ident = field.ident.clone();
        if attrs.skip {
            init.push(quote!(#ident: ::core::default::Default::default()));
            continue;
        }
        if attrs.arg && attrs.env {
            return Err(syn::Error::new(
                field.span(),
                "a field cannot be both `arg` and `env`",
            ));
        }
        let raw = ident.as_ref().map(unraw).unwrap_or_default();
        let name = attrs.rename.clone().unwrap_or_else(|| {
            if attrs.env {
                RenameRule::ScreamingSnake.apply_to_field(&raw)
            } else {
                RenameRule::Camel.apply_to_field(&raw)
            }
        });
        let (list, take) = if attrs.arg {
            (&mut args, quote!(arg))
        } else if attrs.env {
            (&mut env, quote!(env))
        } else {
            (&mut options, quote!(option))
        };
        init.push(quote!(#ident: fields.#take(#name)?));
        // Option flags and lists default to `false` and empty, as in clap.
        let fallback = match last_segment(&field.ty).as_str() {
            "bool" | "Vec" if !attrs.arg && !attrs.env => {
                let ty = &field.ty;
                Some(quote!(<#ty as ::core::default::Default>::default()))
            }
            _ => None,
        };
        let coerce = attrs.coerce;
        let schema = field_schema(&name, field, attrs, fallback);
        // The command line passes positional numbers as strings.
        list.push(if take.to_string() == "arg" && coerce.is_none() {
            quote!(#schema.map(::incur::__private::positional))
        } else {
            schema
        });
    }
    let build = if let Fields::Named(_) = fields {
        quote!(::core::result::Result::Ok(#path { #(#init),* }))
    } else {
        quote! {{
            let _ = fields;
            ::core::result::Result::Ok(#path)
        }}
    };
    Ok((
        quote!([
            ::std::vec![#(#args),*],
            ::std::vec![#(#options),*],
            ::std::vec![#(#env),*]
        ]),
        build,
    ))
}

/// Returns the last path segment of a type, such as `Vec` for `std::vec::Vec<String>`.
fn last_segment(ty: &Type) -> String {
    let text = quote!(#ty).to_string();
    let path = text.split('<').next().unwrap_or_default();
    path.rsplit("::")
        .next()
        .unwrap_or_default()
        .trim()
        .to_owned()
}
