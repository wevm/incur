//! A port of the TypeScript `examples/npm` CLI: `cargo run -p incur --example npm -- --help`.

use incur::{Parser, Schema, SkillSync};
use serde::{Deserialize, Serialize};

/// Package access level.
#[derive(Clone, Copy, Deserialize, Schema, Serialize)]
#[serde(rename_all = "lowercase")]
enum Access {
    Public,
    Restricted,
}

/// The package manager for JavaScript.
#[derive(Parser)]
#[incur(name = "npm", version = "10.9.2")]
#[expect(
    dead_code,
    reason = "Like the TypeScript example, handlers ignore most inputs."
)]
enum Npm {
    /// Install a package
    #[incur(
        output = Installed,
        example(command = "express", description = "Install a package"),
        example(command = "vitest --saveDev true", description = "Install as dev dependency"),
        example(command = "tsx --global true", description = "Install globally")
    )]
    Install {
        /// Package name to install
        #[incur(arg)]
        package: Option<String>,
        /// Save as dev dependency
        #[incur(alias = 'D')]
        save_dev: Option<bool>,
        /// Save exact version
        #[incur(alias = 'E')]
        save_exact: Option<bool>,
        /// Install globally
        #[incur(alias = 'g')]
        global: Option<bool>,
    },
    /// View registry info for a package
    #[incur(
        output = Info,
        example(command = "express", description = "View info for express")
    )]
    Info {
        /// Package name
        #[incur(arg)]
        package: String,
    },
    /// Create a package.json file
    #[incur(
        output = Created,
        example(command = "--yes true", description = "Create with defaults")
    )]
    Init {
        /// Skip prompts and use defaults
        #[incur(alias = 'y')]
        yes: Option<bool>,
        /// Package scope
        scope: Option<String>,
    },
    /// Publish a package to the registry
    #[incur(
        output = Published,
        example(command = "", description = "Publish with latest tag"),
        example(command = "--tag beta", description = "Publish as beta"),
        example(command = "--dryRun true", description = "Dry run")
    )]
    Publish {
        /// Authentication token
        #[incur(env)]
        npm_token: Option<String>,
        /// Registry URL
        #[incur(env, default = "https://registry.npmjs.org")]
        npm_registry: String,
        /// Distribution tag
        #[incur(default = "latest")]
        tag: String,
        /// Package access level
        #[incur(default = Access::Public)]
        access: Access,
        /// Report what would be published
        dry_run: Option<bool>,
        /// One-time password for 2FA
        otp: Option<String>,
    },
    /// Run a script defined in package.json
    #[incur(
        output = Ran,
        example(command = "test", description = "Run tests"),
        example(command = "build", description = "Run build")
    )]
    Run {
        /// Script name to run
        #[incur(arg)]
        script: String,
    },
    /// Remove a package
    #[incur(
        output = Uninstalled,
        example(command = "express", description = "Remove a package")
    )]
    Uninstall {
        /// Package name to remove
        #[incur(arg)]
        package: String,
        /// Remove global package
        #[incur(alias = 'g')]
        global: Option<bool>,
    },
    /// Check for outdated packages
    #[incur(
        output = Outdated,
        example(command = "", description = "Check for outdated packages"),
        example(command = "--global true", description = "Check global packages")
    )]
    Outdated {
        /// Check global packages
        #[incur(alias = 'g')]
        global: Option<bool>,
        /// Show extended information
        #[incur(alias = 'l')]
        long: Option<bool>,
    },
}

/// `install` output.
#[derive(Schema, Serialize)]
struct Installed {
    /// Number of packages added
    added: f64,
    /// Number of packages removed
    removed: f64,
    /// Number of packages changed
    changed: f64,
    // A doc comment would need backticks around `node_modules`, which the description lacks.
    #[incur(description = "Total packages in node_modules")]
    packages: f64,
}

/// `info` output.
#[derive(Schema, Serialize)]
struct Info {
    name: String,
    /// Latest version
    version: String,
    description: String,
    license: String,
    homepage: String,
}

/// `init` output.
#[derive(Schema, Serialize)]
struct Created {
    /// Path to created package.json
    created: String,
}

/// `publish` output.
#[derive(Schema, Serialize)]
struct Published {
    name: String,
    version: String,
    tag: String,
}

/// `run` output.
#[derive(Schema, Serialize)]
#[serde(rename_all = "camelCase")]
struct Ran {
    script: String,
    exit_code: f64,
}

/// `uninstall` output.
#[derive(Schema, Serialize)]
struct Uninstalled {
    removed: f64,
    /// Remaining packages
    packages: f64,
}

/// `outdated` output.
#[derive(Schema, Serialize)]
struct Outdated {
    packages: Vec<Package>,
}

/// An outdated package.
#[derive(Schema, Serialize)]
struct Package {
    name: String,
    current: String,
    wanted: String,
    latest: String,
}

impl Package {
    /// Returns a package entry.
    fn new(name: &str, current: &str, wanted: &str, latest: &str) -> Self {
        Self {
            name: name.into(),
            current: current.into(),
            wanted: wanted.into(),
            latest: latest.into(),
        }
    }
}

fn main() {
    Npm::cli()
        .sync(SkillSync::new().suggestions([
            "install react as a dependency",
            "check for outdated packages",
            "audit my repo",
        ]))
        .handle(|command, _| match command {
            Npm::Install { package, .. } if package.as_deref().unwrap_or_default().is_empty() => {
                incur::ok(Installed {
                    added: 120.0,
                    removed: 0.0,
                    changed: 0.0,
                    packages: 450.0,
                })
            }
            Npm::Install { .. } => incur::ok(Installed {
                added: 1.0,
                removed: 0.0,
                changed: 0.0,
                packages: 451.0,
            }),
            Npm::Info { package } => incur::ok(Info {
                name: package,
                version: "4.21.2".into(),
                description: "Fast, unopinionated, minimalist web framework".into(),
                license: "MIT".into(),
                homepage: "https://expressjs.com/".into(),
            }),
            Npm::Init { .. } => incur::ok(Created {
                created: "./package.json".into(),
            }),
            Npm::Publish { tag, .. } => incur::ok(Published {
                name: "my-package".into(),
                version: "1.0.0".into(),
                tag,
            }),
            Npm::Run { script } => incur::ok(Ran {
                script,
                exit_code: 0.0,
            }),
            Npm::Uninstall { .. } => incur::ok(Uninstalled {
                removed: 1.0,
                packages: 449.0,
            }),
            Npm::Outdated { .. } => incur::ok(Outdated {
                packages: vec![
                    Package::new("express", "4.18.0", "4.21.2", "4.21.2"),
                    Package::new("typescript", "5.3.0", "5.7.3", "5.7.3"),
                ],
            }),
        })
        .serve();
}
