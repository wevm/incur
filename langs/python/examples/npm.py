"""The npm example: a port of `examples/npm/cli.ts`.

Run it with `uv run examples/npm.py <args>`.
"""

from __future__ import annotations

from typing import Annotated, Literal

import incur
from incur import Example, arg, env, field


@incur.schema
class InstallOutput:
    """What `install` changed."""

    added: Annotated[float, field("Number of packages added")]
    removed: Annotated[float, field("Number of packages removed")]
    changed: Annotated[float, field("Number of packages changed")]
    packages: Annotated[float, field("Total packages in node_modules")]


class Install(
    incur.Command,
    output=InstallOutput,
    examples=[
        Example("express", "Install a package"),
        Example("vitest --saveDev true", "Install as dev dependency"),
        Example("tsx --global true", "Install globally"),
    ],
):
    """Install a package"""

    package: Annotated[str | None, arg("Package name to install")] = None
    save_dev: Annotated[bool | None, field("Save as dev dependency", alias="D")] = None
    save_exact: Annotated[bool | None, field("Save exact version", alias="E")] = None
    global_: Annotated[bool | None, field("Install globally", alias="g", name="global")] = None


@incur.schema
class InfoOutput:
    """Registry info of a package."""

    name: str
    version: Annotated[str, field("Latest version")]
    description: str
    license: str
    homepage: str


class Info(
    incur.Command,
    output=InfoOutput,
    examples=[Example("express", "View info for express")],
):
    """View registry info for a package"""

    package: Annotated[str, arg("Package name")]


@incur.schema
class InitOutput:
    """The created package.json."""

    created: Annotated[str, field("Path to created package.json")]


class Init(
    incur.Command,
    output=InitOutput,
    examples=[Example("--yes true", "Create with defaults")],
):
    """Create a package.json file"""

    yes: Annotated[bool | None, field("Skip prompts and use defaults", alias="y")] = None
    scope: Annotated[str | None, field("Package scope")] = None


@incur.schema
class PublishOutput:
    """The published package."""

    name: str
    version: str
    tag: str


class Publish(
    incur.Command,
    output=PublishOutput,
    examples=[
        Example("", "Publish with latest tag"),
        Example("--tag beta", "Publish as beta"),
        Example("--dryRun true", "Dry run"),
    ],
):
    """Publish a package to the registry"""

    npm_token: Annotated[str | None, env("Authentication token")] = None
    npm_registry: Annotated[str, env("Registry URL")] = "https://registry.npmjs.org"
    tag: Annotated[str, field("Distribution tag")] = "latest"
    access: Annotated[Literal["public", "restricted"], field("Package access level")] = "public"
    dry_run: Annotated[bool | None, field("Report what would be published")] = None
    otp: Annotated[str | None, field("One-time password for 2FA")] = None


@incur.schema
class RunOutput:
    """The script that ran."""

    script: str
    exit_code: Annotated[float, field(name="exitCode")]


class Run(
    incur.Command,
    output=RunOutput,
    examples=[Example("test", "Run tests"), Example("build", "Run build")],
):
    """Run a script defined in package.json"""

    script: Annotated[str, arg("Script name to run")]


@incur.schema
class UninstallOutput:
    """What `uninstall` removed."""

    removed: float
    packages: Annotated[float, field("Remaining packages")]


class Uninstall(
    incur.Command,
    output=UninstallOutput,
    examples=[Example("express", "Remove a package")],
):
    """Remove a package"""

    package: Annotated[str, arg("Package name to remove")]
    global_: Annotated[bool | None, field("Remove global package", alias="g", name="global")] = None


@incur.schema
class OutdatedPackage:
    """An outdated package."""

    name: str
    current: str
    wanted: str
    latest: str


@incur.schema
class OutdatedOutput:
    """The outdated packages."""

    packages: list[OutdatedPackage]


class Outdated(
    incur.Command,
    output=OutdatedOutput,
    examples=[
        Example("", "Check for outdated packages"),
        Example("--global true", "Check global packages"),
    ],
):
    """Check for outdated packages"""

    global_: Annotated[bool | None, field("Check global packages", alias="g", name="global")] = None
    long: Annotated[bool | None, field("Show extended information", alias="l")] = None


class Npm(
    incur.Group[Install | Info | Init | Publish | Run | Uninstall | Outdated],
    name="npm",
    version="10.9.2",
):
    """The package manager for JavaScript."""


def run(command: Install | Info | Init | Publish | Run | Uninstall | Outdated, _: object) -> object:
    """Returns the data of a parsed command."""
    match command:
        case Install() if not command.package:
            return {"added": 120, "removed": 0, "changed": 0, "packages": 450}
        case Install():
            return {"added": 1, "removed": 0, "changed": 0, "packages": 451}
        case Info():
            return {
                "name": command.package,
                "version": "4.21.2",
                "description": "Fast, unopinionated, minimalist web framework",
                "license": "MIT",
                "homepage": "https://expressjs.com/",
            }
        case Init():
            return {"created": "./package.json"}
        case Publish():
            return {"name": "my-package", "version": "1.0.0", "tag": command.tag}
        case Run():
            return {"script": command.script, "exitCode": 0}
        case Uninstall():
            return {"removed": 1, "packages": 449}
        case Outdated():
            return {
                "packages": [
                    {
                        "name": "express",
                        "current": "4.18.0",
                        "wanted": "4.21.2",
                        "latest": "4.21.2",
                    },
                    {
                        "name": "typescript",
                        "current": "5.3.0",
                        "wanted": "5.7.3",
                        "latest": "5.7.3",
                    },
                ]
            }


def main() -> None:
    """Serves the CLI."""
    suggestions = ["install react as a dependency", "check for outdated packages", "audit my repo"]
    incur.Cli(Npm, sync=incur.Sync(suggestions=suggestions)).handle(run).serve()


if __name__ == "__main__":
    main()
