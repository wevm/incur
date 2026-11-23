//! Update notifications and installs: a cached latest version refreshed in the background, and
//! an installer run by `--update`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::body::Body;
use crate::command::{BoxFuture, MaybeFuture};
use crate::errors::Error;
use crate::fetch::{self, Handler};
use crate::js;
use crate::url::{self, Url};

/// The hidden flag a detached update check runs with.
pub(crate) const CHECK_FLAG: &str = "--incur-update-check";

/// The default time between update checks: one day, in milliseconds.
const DEFAULT_INTERVAL: f64 = 86_400_000.0;

/// What a custom update checker receives.
#[derive(Clone, Debug, Serialize)]
pub struct CheckContext {
    /// The current CLI version.
    pub current: String,
    /// The CLI name.
    pub name: String,
    /// The registry package name, when configured or inferred.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
}

/// What a custom update installer receives.
#[derive(Clone, Debug, Serialize)]
pub struct InstallContext {
    /// The current CLI version, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    /// The latest cached version, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    /// The CLI name.
    pub name: String,
    /// The registry package name, when configured or inferred.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
}

/// A type-erased update checker.
type Check = Arc<dyn Fn(CheckContext) -> BoxFuture<Result<Option<String>, Error>> + Send + Sync>;

/// A type-erased update installer.
type Install = Arc<dyn Fn(InstallContext) -> BoxFuture<Result<(), Error>> + Send + Sync>;

/// Update settings: automatic checks with a notice in terminal output, and the `--update` flag.
///
/// By default, the CLI infers an npm package from the `package.json` that declares the
/// executing program, checks the registry, and installs with the detected package manager.
/// Standalone distributions provide their own checker and installer.
///
/// ```
/// use incur::{Cli, Update};
///
/// let cli = Cli::new("tool").version("1.0.0").update(
///     Update::new()
///         .check(|c: incur::update::CheckContext| Ok(Some(format!("{}-next", c.current))))
///         .install(|_| async { Ok(()) }),
/// );
/// let disabled = Cli::new("tool").update(false);
/// ```
#[derive(Clone)]
pub struct Update {
    /// Custom checker.
    check: Option<Check>,
    /// Whether installation finishes after the process exits.
    deferred: bool,
    /// Whether updates are enabled.
    pub(crate) enabled: bool,
    /// Custom installer.
    install: Option<Install>,
    /// Minimum time between checks, in milliseconds.
    interval: Option<f64>,
    /// Registry package name.
    package: Option<String>,
}

impl Default for Update {
    fn default() -> Self {
        Self::new()
    }
}

impl From<bool> for Update {
    fn from(enabled: bool) -> Self {
        Self {
            enabled,
            ..Self::new()
        }
    }
}

impl Update {
    /// Creates enabled update settings with package inference.
    pub fn new() -> Self {
        Self {
            check: None,
            deferred: false,
            enabled: true,
            install: None,
            interval: None,
            package: None,
        }
    }

    /// Sets a custom checker that returns the latest version, or `None` when unknown.
    #[must_use]
    pub fn check<F, R, M>(mut self, f: F) -> Self
    where
        F: Fn(CheckContext) -> R + Send + Sync + 'static,
        R: MaybeFuture<Result<Option<String>, Error>, M>,
    {
        self.check = Some(Arc::new(move |context| Box::pin(f(context).resolve())));
        self
    }

    /// Marks installation as finishing after the updating process exits.
    #[must_use]
    pub fn deferred(mut self) -> Self {
        self.deferred = true;
        self
    }

    /// Sets a custom installer.
    #[must_use]
    pub fn install<F, R, M>(mut self, f: F) -> Self
    where
        F: Fn(InstallContext) -> R + Send + Sync + 'static,
        R: MaybeFuture<Result<(), Error>, M>,
    {
        self.install = Some(Arc::new(move |context| Box::pin(f(context).resolve())));
        self
    }

    /// Sets the minimum time between checks. Defaults to one day.
    #[must_use]
    pub fn interval(mut self, interval: std::time::Duration) -> Self {
        #[expect(
            clippy::cast_precision_loss,
            reason = "Intervals are far below 2^53 ms."
        )]
        let millis = interval.as_millis() as f64;
        self.interval = Some(millis);
        self
    }

    /// Sets the registry package name. Defaults to the package declaring the executing program.
    #[must_use]
    pub fn package(mut self, name: impl Into<String>) -> Self {
        self.package = Some(name.into());
        self
    }
}

/// The process facts updates read.
pub(crate) struct Machine<'a> {
    /// Environment lookup.
    pub(crate) env: &'a (dyn Fn(&str) -> Option<String> + Sync),
    /// The HTTP client.
    pub(crate) client: &'a Handler,
}

impl Machine<'_> {
    /// Reads a non-empty environment variable.
    fn var(&self, key: &str) -> Option<String> {
        (self.env)(key).filter(|value| !value.is_empty())
    }
}

/// An update source resolved from settings and the executing package.
struct Provider {
    /// The checker, when any.
    check: Option<Check>,
    /// The package-manager command shown after installing.
    command: Option<(String, Vec<String>)>,
    /// The current version.
    current: Option<String>,
    /// Whether installation is deferred.
    deferred: bool,
    /// Whether an installer exists.
    install: Option<Install>,
    /// The cache key and display name.
    name: String,
    /// The registry package.
    package: Option<String>,
}

/// An available update.
pub(crate) struct Available {
    /// The current version.
    pub(crate) current: String,
    /// The latest version.
    pub(crate) latest: String,
    /// The package or CLI name.
    pub(crate) name: String,
}

/// A completed install.
pub(crate) struct Installed {
    /// The package-manager command that ran.
    pub(crate) command: Option<String>,
    /// Whether installation finishes later.
    pub(crate) deferred: bool,
    /// The package or CLI name.
    pub(crate) name: String,
}

impl Installed {
    /// Returns the result as output data.
    pub(crate) fn to_value(&self) -> Value {
        let mut out = Map::new();
        if let Some(command) = &self.command {
            out.insert("command".into(), command.clone().into());
        }
        if self.deferred {
            out.insert("deferred".into(), true.into());
        }
        out.insert("name".into(), self.name.clone().into());
        Value::Object(out)
    }
}

/// Resolves the update provider for a CLI.
fn provider(
    name: &str,
    settings: &Update,
    version: Option<&str>,
    machine: &Machine<'_>,
) -> Option<Provider> {
    let executing = executing_package(name);
    let package = settings
        .package
        .clone()
        .or_else(|| executing.as_ref().map(|(name, _)| name.clone()));
    if package.as_deref().is_some_and(|p| !is_package_name(p)) {
        return None;
    }
    let current = version
        .map(str::to_owned)
        .or_else(|| executing.map(|(_, version)| version));
    let invocation = package.as_deref().map(|p| global_install(p, machine));
    let check = settings.check.clone().or_else(|| {
        let package = package.clone()?;
        let registry = machine
            .var("npm_config_registry")
            .unwrap_or_else(|| "https://registry.npmjs.org".into());
        let client = machine.client.clone();
        let check: Check = Arc::new(move |_| {
            Box::pin(fetch_latest(
                package.clone(),
                registry.clone(),
                client.clone(),
            ))
        });
        Some(check)
    });
    let install = settings.install.clone().or_else(|| {
        let (command, args) = invocation.clone()?;
        let inherited = ["PATH", "HOME"].map(|key| (key, machine.var(key)));
        let install: Install = Arc::new(move |_| {
            let (command, args, inherited) = (command.clone(), args.clone(), inherited.clone());
            Box::pin(async move {
                let env = |key: &str| inherited.iter().find(|(k, _)| *k == key)?.1.clone();
                exec(&command, &args, &env).map(|_| ())
            })
        });
        Some(install)
    });
    if check.is_none() && install.is_none() {
        return None;
    }
    Some(Provider {
        check,
        command: invocation.filter(|_| settings.install.is_none()),
        current,
        deferred: settings.deferred,
        install,
        name: package.clone().unwrap_or_else(|| name.to_owned()),
        package,
    })
}

/// Returns a cached available update, and schedules a background refresh when the cache is
/// missing or older than the interval.
pub(crate) fn check(
    name: &str,
    settings: &Update,
    version: Option<&str>,
    machine: &Machine<'_>,
) -> Option<Available> {
    if notifications_disabled(machine) {
        return None;
    }
    let provider = provider(name, settings, version, machine)?;
    provider.check.as_ref()?;
    let current = provider.current?;
    let file = cache_path(&provider.name, machine);
    let cached = read_cache(&file);
    let now = now();
    let interval = settings.interval.unwrap_or(DEFAULT_INTERVAL).max(0.0);
    if cached.as_ref().is_none_or(|c| now - c.0 >= interval) {
        schedule_refresh(&file, now, cached.as_ref().and_then(|c| c.1.as_deref()));
    }
    let latest = cached?.1?;
    is_newer(&latest, &current).then_some(Available {
        current,
        latest,
        name: provider.name,
    })
}

/// Refreshes the cached latest version through the provider.
pub(crate) async fn refresh(
    name: &str,
    settings: &Update,
    version: Option<&str>,
    machine: &Machine<'_>,
) {
    let Some(provider) = provider(name, settings, version, machine) else {
        return;
    };
    let (Some(check), Some(current)) = (provider.check, provider.current) else {
        return;
    };
    let latest = check(CheckContext {
        current,
        name: name.to_owned(),
        package: provider.package,
    })
    .await;
    let Ok(Some(latest)) = latest else {
        return;
    };
    if parse_version(&latest).is_none() {
        return;
    }
    let _ = write_cache(&cache_path(&provider.name, machine), now(), Some(&latest));
}

/// Installs the latest version through the provider.
pub(crate) async fn install(
    name: &str,
    settings: &Update,
    version: Option<&str>,
    machine: &Machine<'_>,
) -> Result<Installed, Error> {
    let provider = provider(name, settings, version, machine);
    let Some((provider, install)) =
        provider.and_then(|p| p.install.clone().map(|install| (p, install)))
    else {
        return Err(Error::unknown(format!(
            "No update installer is configured for '{name}'."
        )));
    };
    let cached = read_cache(&cache_path(&provider.name, machine));
    install(InstallContext {
        current: provider.current,
        latest: cached.and_then(|c| c.1),
        name: name.to_owned(),
        package: provider.package,
    })
    .await?;
    Ok(Installed {
        command: provider
            .command
            .map(|(command, args)| format!("{command} {}", args.join(" "))),
        deferred: provider.deferred,
        name: provider.name,
    })
}

/// Returns the current time in milliseconds since the epoch.
fn now() -> f64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    #[expect(
        clippy::cast_precision_loss,
        reason = "Timestamps are far below 2^53 ms."
    )]
    let millis = millis as f64;
    millis
}

/// Returns the path of the executing program, as the process received it.
pub(crate) fn program() -> Option<PathBuf> {
    std::env::args_os().next().map(PathBuf::from)
}

/// Finds the npm package declaring the executing program: the nearest `package.json` above it
/// whose name and version are strings and which provides the CLI name.
fn executing_package(name: &str) -> Option<(String, String)> {
    let entry = std::fs::canonicalize(program()?).ok()?;
    let mut directory = entry.parent()?;
    loop {
        if let Some(found) = std::fs::read_to_string(directory.join("package.json"))
            .ok()
            .and_then(|text| js::json_parse(&text, |_| Value::Null).ok())
            .and_then(|metadata| {
                let package = metadata.get("name")?.as_str()?;
                let version = metadata.get("version")?.as_str()?;
                provides(&metadata, name).then(|| (package.to_owned(), version.to_owned()))
            })
        {
            return Some(found);
        }
        directory = directory.parent()?;
    }
}

/// Whether package metadata declares the CLI name.
fn provides(metadata: &Value, name: &str) -> bool {
    let package = metadata.get("name").and_then(Value::as_str);
    if package == Some(name) {
        return true;
    }
    // A string `bin` is named after the unscoped package name.
    let bin = metadata.get("bin");
    bin.and_then(Value::as_object)
        .is_some_and(|bin| bin.contains_key(name))
        || (bin.is_some_and(Value::is_string)
            && package.and_then(|p| p.rsplit('/').next()) == Some(name))
}

/// Fetches the latest version of an npm package.
async fn fetch_latest(
    package: String,
    registry: String,
    client: Handler,
) -> Result<Option<String>, Error> {
    let base = if registry.ends_with('/') {
        registry
    } else {
        format!("{registry}/")
    };
    let url = Url::parse(&base)
        .and_then(|base| base.join(&url::encode_component(&package)))
        .ok_or_else(|| Error::unknown("Invalid URL"))?;
    let request = fetch::request(
        "GET",
        &url,
        &[(
            "accept".into(),
            "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*".into(),
        )],
        None::<Body>,
    );
    let response = client(request?).await?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let text = response.into_body().text().await;
    let metadata = js::json_parse(&text, |_| Value::Null).map_err(Error::unknown)?;
    Ok(metadata
        .get("dist-tags")
        .and_then(|tags| tags.get("latest"))
        .and_then(Value::as_str)
        .map(str::to_owned))
}

/// A parsed semantic version: numeric parts as digit strings, and prerelease identifiers.
struct Version {
    /// Major, minor, and patch.
    core: [String; 3],
    /// Prerelease identifiers: numbers (`true`) or strings.
    prerelease: Vec<(bool, String)>,
}

/// Parses a semantic version.
fn parse_version(version: &str) -> Option<Version> {
    let numeric = |part: &str| {
        !part.is_empty()
            && part.bytes().all(|b| b.is_ascii_digit())
            && (part == "0" || !part.starts_with('0'))
    };
    let identifiers = |text: &str| {
        text.split('.')
            .all(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
    };
    let (rest, build) = match version.split_once('+') {
        Some((rest, build)) => (rest, Some(build)),
        None => (version, None),
    };
    if build.is_some_and(|build| !identifiers(build)) {
        return None;
    }
    let (core, prerelease) = match rest.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (rest, None),
    };
    let parts = core.split('.').collect::<Vec<_>>();
    let [major, minor, patch] = parts.as_slice() else {
        return None;
    };
    if ![major, minor, patch].iter().all(|part| numeric(part)) {
        return None;
    }
    let mut ids = Vec::new();
    if let Some(prerelease) = prerelease {
        if !identifiers(prerelease) {
            return None;
        }
        for id in prerelease.split('.') {
            if id.bytes().all(|b| b.is_ascii_digit()) {
                if id.len() > 1 && id.starts_with('0') {
                    return None;
                }
                ids.push((true, id.to_owned()));
            } else {
                ids.push((false, id.to_owned()));
            }
        }
    }
    Some(Version {
        core: [
            (*major).to_owned(),
            (*minor).to_owned(),
            (*patch).to_owned(),
        ],
        prerelease: ids,
    })
}

/// Compares canonical digit strings numerically.
fn compare_digits(a: &str, b: &str) -> std::cmp::Ordering {
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

/// Whether `candidate` is a newer semantic version than `current`.
pub(crate) fn is_newer(candidate: &str, current: &str) -> bool {
    use std::cmp::Ordering;
    let (Some(candidate), Some(current)) = (parse_version(candidate), parse_version(current))
    else {
        return false;
    };
    for (a, b) in candidate.core.iter().zip(&current.core) {
        match compare_digits(a, b) {
            Ordering::Greater => return true,
            Ordering::Less => return false,
            Ordering::Equal => {}
        }
    }
    if candidate.prerelease.is_empty() {
        return !current.prerelease.is_empty();
    }
    if current.prerelease.is_empty() {
        return false;
    }
    let length = candidate.prerelease.len().max(current.prerelease.len());
    for index in 0..length {
        let (Some(a), Some(b)) = (
            candidate.prerelease.get(index),
            current.prerelease.get(index),
        ) else {
            return candidate.prerelease.len() > current.prerelease.len();
        };
        if a == b {
            continue;
        }
        return match (a.0, b.0) {
            (true, false) => false,
            (false, true) => true,
            (true, true) => compare_digits(&a.1, &b.1) == Ordering::Greater,
            (false, false) => a.1.encode_utf16().cmp(b.1.encode_utf16()) == Ordering::Greater,
        };
    }
    false
}

/// Whether a package name is safe to place in an install command.
pub(crate) fn is_package_name(name: &str) -> bool {
    let part = |text: &str| {
        let mut chars = text.chars();
        chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
            && chars.all(|c| c.is_ascii_alphanumeric() || "._~-".contains(c))
    };
    match name.strip_prefix('@') {
        Some(scoped) => scoped
            .split_once('/')
            .is_some_and(|(scope, name)| part(scope) && part(name)),
        None => part(name),
    }
}

/// Returns the update cache path for a key.
fn cache_path(key: &str, machine: &Machine<'_>) -> PathBuf {
    let root = machine
        .var("XDG_CACHE_HOME")
        .map_or_else(|| home(machine).join(".cache"), PathBuf::from);
    root.join("incur")
        .join("updates")
        .join(format!("{}.json", url::encode_component(key)))
}

/// Returns the home directory.
pub(crate) fn home(machine: &Machine<'_>) -> PathBuf {
    crate::sync::home(&|key| machine.var(key))
}

/// Reads the cached check time and latest version.
fn read_cache(file: &Path) -> Option<(f64, Option<String>)> {
    let text = std::fs::read_to_string(file).ok()?;
    let value = js::json_parse(&text, |_| Value::Null).ok()?;
    let checked = value.get("checkedAt")?.as_f64()?;
    let latest = match value.get("latest") {
        None => None,
        Some(Value::String(latest)) => Some(latest.clone()),
        Some(_) => return None,
    };
    Some((checked, latest))
}

/// Writes the update cache.
fn write_cache(file: &Path, checked: f64, latest: Option<&str>) -> std::io::Result<()> {
    let mut value = Map::new();
    value.insert("checkedAt".into(), js::number(checked));
    if let Some(latest) = latest {
        value.insert("latest".into(), latest.into());
    }
    file.parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(file, format!("{}\n", js::stringify(&Value::Object(value)))))
}

/// Marks a check and starts a detached run of this program with the check flag.
fn schedule_refresh(file: &Path, checked: f64, latest: Option<&str>) {
    if let Ok(program) = std::env::current_exe()
        && write_cache(file, checked, latest).is_ok()
    {
        let _ = std::process::Command::new(program)
            .arg(CHECK_FLAG)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}

/// Runs a program and returns its standard output. The child inherits the process environment
/// with `PATH` and `HOME` from the CLI's environment. Failures report standard error, else
/// standard output, else the command line, as Node's `execFile` does.
pub(crate) fn exec(
    program: &str,
    args: &[String],
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<String, Error> {
    let mut command = std::process::Command::new(program);
    command.args(args);
    for key in ["PATH", "HOME"] {
        if let Some(value) = env(key) {
            command.env(key, value);
        }
    }
    let output = command.output().map_err(|error| {
        let code = if error.kind() == std::io::ErrorKind::NotFound {
            "ENOENT"
        } else {
            "EACCES"
        };
        Error::unknown(format!("spawn {program} {code}"))
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let message = [
        stderr.trim_matches(js::is_whitespace),
        stdout.trim_matches(js::is_whitespace),
    ]
    .into_iter()
    .find(|text| !text.is_empty())
    .map_or_else(
        || format!("Command failed: {program} {}", args.join(" ")),
        str::to_owned,
    );
    Err(Error::unknown(message))
}

/// Whether the environment suppresses update notifications.
fn notifications_disabled(machine: &Machine<'_>) -> bool {
    if machine.var("NO_UPDATE_NOTIFIER").is_some() {
        return true;
    }
    if machine.var("npm_config_update_notifier").as_deref() == Some("false") {
        return true;
    }
    machine.var("CI").is_some_and(|ci| ci != "false")
}

/// The package manager the CLI runs under.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum PackageManager {
    /// Bun.
    Bun,
    /// npm.
    Npm,
    /// pnpm.
    Pnpm,
}

/// Detects the package manager from the environment and the program path.
pub(crate) fn package_manager(env: &(dyn Fn(&str) -> Option<String> + Sync)) -> PackageManager {
    let agent = env("npm_config_user_agent").unwrap_or_default();
    let exec_path = env("npm_execpath").unwrap_or_default();
    let entry = program()
        .map(|p| std::fs::canonicalize(&p).unwrap_or(p))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    if agent.contains("pnpm") {
        PackageManager::Pnpm
    } else if agent.contains("bun") {
        PackageManager::Bun
    } else if agent.starts_with("npm/") {
        PackageManager::Npm
    } else if exec_path.contains("pnpm") {
        PackageManager::Pnpm
    } else if exec_path.contains("bun") {
        PackageManager::Bun
    } else if exec_path.contains("npm") {
        PackageManager::Npm
    } else if entry.contains("/.pnpm/") {
        PackageManager::Pnpm
    } else if entry.contains("/.bun/") {
        PackageManager::Bun
    } else {
        PackageManager::Npm
    }
}

/// Returns the package runner: `npx`, `pnpx`, or `bunx`.
pub(crate) fn runner(env: &(dyn Fn(&str) -> Option<String> + Sync)) -> &'static str {
    match package_manager(env) {
        PackageManager::Pnpm => "pnpx",
        PackageManager::Bun => "bunx",
        PackageManager::Npm => "npx",
    }
}

/// Returns the global install command for a package.
fn global_install(package: &str, machine: &Machine<'_>) -> (String, Vec<String>) {
    let spec = format!("{package}@latest");
    match package_manager(machine.env) {
        PackageManager::Pnpm => ("pnpm".into(), vec!["add".into(), "--global".into(), spec]),
        PackageManager::Bun => ("bun".into(), vec!["add".into(), "--global".into(), spec]),
        PackageManager::Npm => (
            "npm".into(),
            vec!["install".into(), "--global".into(), spec],
        ),
    }
}
