//! Agent integrations: `skills add` and `skills list` install generated skill files for coding
//! agents, and `mcp add` registers the CLI as an MCP server.

use std::path::{Component, Path, PathBuf};

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::errors::Error;
use crate::js;
use crate::skill::{self, CommandInfo};
use crate::update;

/// An environment lookup.
pub(crate) type Env<'a> = &'a (dyn Fn(&str) -> Option<String> + Sync);

/// Returns the home directory as Node's `os.homedir()` finds it: `HOME`, then the user
/// database.
pub(crate) fn home(env: &dyn Fn(&str) -> Option<String>) -> PathBuf {
    env("HOME")
        .map(PathBuf::from)
        .or_else(std::env::home_dir)
        .unwrap_or_default()
}

/// Settings for the built-in skills integration: `skills add`, `skills list`, and the notice
/// that installed skills are out of date.
///
/// ```
/// use incur::{Cli, SkillSync};
///
/// let cli = Cli::new("tool").sync(
///     SkillSync::new()
///         .include(["skills/*"])
///         .suggestions(["Show my status"]),
/// );
/// let disabled = Cli::new("tool").sync(false);
/// ```
#[derive(Clone, Debug)]
pub struct SkillSync {
    /// Text printed after the synced skills.
    pub(crate) body: Option<String>,
    /// Directory `include` globs resolve against.
    pub(crate) cwd: Option<PathBuf>,
    /// Default grouping depth.
    pub(crate) depth: Option<f64>,
    /// Whether the integration is enabled.
    pub(crate) enabled: bool,
    /// Globs of directories holding extra `SKILL.md` files.
    pub(crate) include: Vec<String>,
    /// Example prompts shown after syncing.
    pub(crate) suggestions: Vec<String>,
}

impl Default for SkillSync {
    fn default() -> Self {
        Self::new()
    }
}

impl From<bool> for SkillSync {
    fn from(enabled: bool) -> Self {
        Self {
            enabled,
            ..Self::new()
        }
    }
}

impl SkillSync {
    /// Creates enabled settings with defaults.
    pub fn new() -> Self {
        Self {
            body: None,
            cwd: None,
            depth: None,
            enabled: true,
            include: Vec::new(),
            suggestions: Vec::new(),
        }
    }

    /// Sets text printed after the synced skills, before the suggestions, for steps installing
    /// skills cannot do itself, such as authorizing an app.
    #[must_use]
    pub fn body(mut self, body: impl Into<String>) -> Self {
        self.body = Some(body.into());
        self
    }

    /// Sets the directory `include` globs resolve against, for `skills add` and `skills list`.
    /// Defaults to the directory of the nearest `package.json` above the program. Project
    /// installs (`skills add --no-global`) always go to the working directory.
    #[must_use]
    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    /// Sets the default grouping depth for skill files: commands sharing their first `depth`
    /// segments share a file. `--depth` overrides it. Defaults to 1.
    #[must_use]
    pub fn depth(mut self, depth: u32) -> Self {
        self.depth = Some(f64::from(depth));
        self
    }

    /// Adds globs of directories containing `SKILL.md` files to install alongside the generated
    /// skills, such as `skills/*`. `_root` names a `SKILL.md` in the directory itself.
    #[must_use]
    pub fn include(mut self, patterns: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.include = patterns.into_iter().map(Into::into).collect();
        self
    }

    /// Sets example prompts shown after syncing.
    #[must_use]
    pub fn suggestions(mut self, prompts: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.suggestions = prompts.into_iter().map(Into::into).collect();
        self
    }
}

/// A coding agent's skills directories.
struct Agent {
    /// Display name.
    name: &'static str,
    /// The global skills directory.
    global: PathBuf,
    /// The project skills directory, relative to the project.
    project: &'static str,
    /// Whether the agent reads the canonical `.agents/skills` directory.
    universal: bool,
    /// The path whose existence shows the agent is installed.
    marker: PathBuf,
}

/// The machine paths agents resolve against.
struct Paths {
    /// The home directory.
    home: PathBuf,
    /// The user configuration directory.
    config: PathBuf,
    /// Claude Code's configuration directory.
    claude: PathBuf,
    /// Codex's home directory.
    codex: PathBuf,
}

impl Paths {
    /// Resolves the paths from the environment.
    fn new(env: Env<'_>) -> Self {
        let var = |key: &str| env(key).filter(|v| !v.trim().is_empty());
        let home = home(env);
        Self {
            config: env("XDG_CONFIG_HOME")
                .filter(|v| !v.is_empty())
                .map_or_else(|| home.join(".config"), PathBuf::from),
            claude: var("CLAUDE_CONFIG_DIR")
                .map_or_else(|| home.join(".claude"), |v| PathBuf::from(v.trim())),
            codex: var("CODEX_HOME")
                .map_or_else(|| home.join(".codex"), |v| PathBuf::from(v.trim())),
            home,
        }
    }
}

/// Lists every supported agent.
fn agents(paths: &Paths) -> Vec<Agent> {
    let Paths {
        home,
        config,
        claude,
        codex,
    } = paths;
    let agent = |name, global: PathBuf, project, universal, marker: PathBuf| Agent {
        name,
        global,
        project,
        universal,
        marker,
    };
    let universal = ".agents/skills";
    vec![
        agent(
            "Amp",
            config.join("agents/skills"),
            universal,
            true,
            config.join("amp"),
        ),
        agent(
            "Cline",
            home.join(".agents/skills"),
            universal,
            true,
            home.join(".cline"),
        ),
        agent(
            "Codex",
            codex.join("skills"),
            universal,
            true,
            codex.clone(),
        ),
        agent(
            "Cursor",
            home.join(".cursor/skills"),
            universal,
            true,
            home.join(".cursor"),
        ),
        agent(
            "Gemini CLI",
            home.join(".gemini/skills"),
            universal,
            true,
            home.join(".gemini"),
        ),
        agent(
            "GitHub Copilot",
            home.join(".copilot/skills"),
            universal,
            true,
            home.join(".copilot"),
        ),
        agent(
            "Kimi CLI",
            config.join("agents/skills"),
            universal,
            true,
            home.join(".kimi"),
        ),
        agent(
            "OpenCode",
            config.join("opencode/skills"),
            universal,
            true,
            config.join("opencode"),
        ),
        agent(
            "Claude Code",
            claude.join("skills"),
            ".claude/skills",
            false,
            claude.clone(),
        ),
        agent(
            "Windsurf",
            home.join(".codeium/windsurf/skills"),
            ".windsurf/skills",
            false,
            home.join(".codeium/windsurf"),
        ),
        agent(
            "Continue",
            home.join(".continue/skills"),
            ".continue/skills",
            false,
            home.join(".continue"),
        ),
        agent(
            "Roo",
            home.join(".roo/skills"),
            ".roo/skills",
            false,
            home.join(".roo"),
        ),
        agent(
            "Kilo",
            home.join(".kilocode/skills"),
            ".kilocode/skills",
            false,
            home.join(".kilocode"),
        ),
        agent(
            "Goose",
            config.join("goose/skills"),
            ".goose/skills",
            false,
            config.join("goose"),
        ),
        agent(
            "Augment",
            home.join(".augment/skills"),
            ".augment/skills",
            false,
            home.join(".augment"),
        ),
        agent(
            "Trae",
            home.join(".trae/skills"),
            ".trae/skills",
            false,
            home.join(".trae"),
        ),
        agent(
            "Junie",
            home.join(".junie/skills"),
            ".junie/skills",
            false,
            home.join(".junie"),
        ),
        agent(
            "Crush",
            config.join("crush/skills"),
            ".crush/skills",
            false,
            config.join("crush"),
        ),
        agent(
            "Kiro CLI",
            home.join(".kiro/skills"),
            ".kiro/skills",
            false,
            home.join(".kiro"),
        ),
        agent(
            "Qwen Code",
            home.join(".qwen/skills"),
            ".qwen/skills",
            false,
            home.join(".qwen"),
        ),
        agent(
            "OpenHands",
            home.join(".openhands/skills"),
            ".openhands/skills",
            false,
            home.join(".openhands"),
        ),
    ]
}

/// Lists the installed agents.
fn detect(paths: &Paths) -> Vec<Agent> {
    agents(paths)
        .into_iter()
        .filter(|agent| agent.marker.exists())
        .collect()
}

/// A skill found in a directory.
struct Found {
    /// The skill name.
    name: String,
    /// The directory holding its `SKILL.md`.
    dir: PathBuf,
    /// Whether it is the root-level `SKILL.md`, copied alone.
    root: bool,
}

/// A link or copy made for a non-universal agent.
struct Linked {
    /// The agent name.
    agent: &'static str,
    /// The link path.
    path: PathBuf,
    /// `symlink` or `copy`.
    mode: &'static str,
}

/// Returns the name a `SKILL.md` declares on a `name:` line.
fn declared_name(content: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let rest = line.strip_prefix("name:")?;
        let value = rest.trim_start_matches(js::is_whitespace);
        (!value.is_empty()).then(|| value.to_owned())
    })
}

/// Makes a skill name safe as a directory name.
fn sanitize(name: &str) -> String {
    let name = name
        .trim_matches(js::is_whitespace)
        .replace(['/', '\\'], "-")
        .replace("..", "");
    let units = name.encode_utf16().take(255).collect::<Vec<_>>();
    String::from_utf16_lossy(&units)
}

/// Finds every `SKILL.md` below a directory, then the directory's own.
fn discover(root: &Path) -> Vec<Found> {
    fn visit(dir: &Path, out: &mut Vec<Found>) {
        // Node lists directories sorted by name.
        let mut entries = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .collect::<Vec<_>>();
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let sub = entry.path();
            if let Ok(content) = std::fs::read_to_string(sub.join("SKILL.md")) {
                let fallback = entry.file_name().to_string_lossy().into_owned();
                out.push(Found {
                    name: sanitize(&declared_name(&content).unwrap_or(fallback)),
                    dir: sub.clone(),
                    root: false,
                });
            }
            visit(&sub, out);
        }
    }
    let mut out = Vec::new();
    visit(root, &mut out);
    if let Ok(content) = std::fs::read_to_string(root.join("SKILL.md")) {
        let name = sanitize(&declared_name(&content).unwrap_or_else(|| "skill".into()));
        if !out.iter().any(|f| f.name == name) {
            out.push(Found {
                name,
                dir: root.to_owned(),
                root: true,
            });
        }
    }
    out
}

/// Removes a file, link, or directory, ignoring failures.
fn remove_force(target: &Path) {
    match std::fs::symlink_metadata(target) {
        Ok(meta) if meta.is_dir() => {
            let _ = std::fs::remove_dir_all(target);
        }
        Ok(_) => {
            let _ = std::fs::remove_file(target);
        }
        Err(_) => {}
    }
}

/// Copies the files of a skill directory. Staged skill directories hold only `SKILL.md`.
fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        std::fs::copy(entry.path(), to.join(entry.file_name()))?;
    }
    Ok(())
}

/// Writes a staged `SKILL.md` into a directory.
fn write_skill(dir: &Path, content: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir).and_then(|()| std::fs::write(dir.join("SKILL.md"), content))
}

/// Resolves a path through symlinks, or its parent when it does not exist.
fn resolve_parent(dir: &Path) -> PathBuf {
    std::fs::canonicalize(dir).unwrap_or_else(|_| {
        dir.parent()
            .zip(dir.file_name())
            .and_then(|(parent, name)| Some(std::fs::canonicalize(parent).ok()?.join(name)))
            .unwrap_or_else(|| dir.to_owned())
    })
}

/// Returns `to` relative to `from`, both absolute.
fn relative(from: &Path, to: &Path) -> PathBuf {
    let from = from.components().collect::<Vec<_>>();
    let to = to.components().collect::<Vec<_>>();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut out = PathBuf::new();
    for _ in common..from.len() {
        out.push(Component::ParentDir);
    }
    for part in &to[common..] {
        out.push(part);
    }
    out
}

/// Installs the skills found under `source` into the canonical directory, and links them for
/// detected non-universal agents. Returns the canonical paths and the links.
fn install(source: &Path, global: bool, cwd: &Path, paths: &Paths) -> (Vec<PathBuf>, Vec<Linked>) {
    let base = if global { &paths.home } else { cwd };
    let canonical_base = base.join(".agents").join("skills");
    let detected = detect(paths);
    let mut installed = Vec::new();
    let mut linked = Vec::new();
    for skill in discover(source) {
        let canonical = canonical_base.join(&skill.name);
        remove_force(&canonical);
        let _ = std::fs::create_dir_all(&canonical);
        let _ = if skill.root {
            std::fs::copy(skill.dir.join("SKILL.md"), canonical.join("SKILL.md")).map(|_| ())
        } else {
            copy_dir(&skill.dir, &canonical)
        };
        installed.push(canonical.clone());
        for agent in detected.iter().filter(|a| !a.universal) {
            let skills = if global {
                agent.global.clone()
            } else {
                cwd.join(agent.project)
            };
            let link = skills.join(&skill.name);
            if resolve_parent(&link) == resolve_parent(&canonical) {
                continue;
            }
            remove_force(&link);
            let parent = link.parent().unwrap_or(&link).to_owned();
            let _ = std::fs::create_dir_all(&parent);
            let target = relative(&resolve_parent(&parent), &resolve_parent(&canonical));
            #[cfg(unix)]
            let symlinked = std::os::unix::fs::symlink(&target, &link).is_ok();
            #[cfg(windows)]
            let symlinked = std::os::windows::fs::symlink_dir(&target, &link).is_ok();
            // Copying is the fallback where links fail.
            let mode = if symlinked {
                Some("symlink")
            } else {
                copy_dir(&canonical, &link).is_ok().then_some("copy")
            };
            if let Some(mode) = mode {
                linked.push(Linked {
                    agent: agent.name,
                    path: link,
                    mode,
                });
            }
        }
    }
    (installed, linked)
}

/// Removes an installed skill and its agent links.
fn uninstall(name: &str, global: bool, cwd: &Path, paths: &Paths) {
    let base = if global { &paths.home } else { cwd };
    remove_force(&base.join(".agents").join("skills").join(name));
    for agent in detect(paths).iter().filter(|a| !a.universal) {
        let skills = if global {
            agent.global.clone()
        } else {
            cwd.join(agent.project)
        };
        remove_force(&skills.join(name));
    }
}

/// Returns the skills metadata path for a CLI.
fn meta_path(name: &str, env: Env<'_>) -> PathBuf {
    let dir = env("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map_or_else(|| home(env).join(".local").join("share"), PathBuf::from);
    dir.join("incur").join(format!("{name}.json"))
}

/// Reads the skills metadata of a CLI.
fn read_meta(name: &str, env: Env<'_>) -> Option<Value> {
    let text = std::fs::read_to_string(meta_path(name, env)).ok()?;
    js::json_parse(&text, |_| Value::Null).ok()
}

/// Returns the stored skills hash of a CLI.
pub(crate) fn read_hash(name: &str, env: Env<'_>) -> Option<String> {
    read_meta(name, env)?
        .get("hash")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// Returns the strings of a metadata array.
fn strings(meta: &Value, key: &str) -> Vec<String> {
    meta.get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// Returns the names of previously synced skills still installed.
fn installed_skills(name: &str, env: Env<'_>) -> Vec<String> {
    let Some(meta) = read_meta(name, env) else {
        return Vec::new();
    };
    let skills = strings(&meta, "skills");
    if skills.is_empty() {
        return Vec::new();
    }
    let present = |dir: &Path| dir.join("SKILL.md").exists();
    let paths = strings(&meta, "paths");
    if !paths.is_empty() {
        return paths
            .iter()
            .map(PathBuf::from)
            .filter(|p| present(p))
            .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .collect();
    }
    let home = home(env);
    let cwd = std::env::current_dir().unwrap_or_default();
    let bases = [home.join(".agents/skills"), cwd.join(".agents/skills")];
    skills
        .into_iter()
        .filter(|skill| bases.iter().any(|base| present(&base.join(skill))))
        .collect()
}

/// Whether any previously synced skill is still installed.
pub(crate) fn has_installed(name: &str, env: Env<'_>) -> bool {
    !installed_skills(name, env).is_empty()
}

/// Writes the skills metadata.
fn write_meta(name: &str, env: Env<'_>, hash: &str, skills: &[String], paths: &[PathBuf]) {
    let file = meta_path(name, env);
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut meta = Map::new();
    meta.insert("hash".into(), hash.into());
    meta.insert("skills".into(), skills.to_vec().into());
    meta.insert(
        "paths".into(),
        paths
            .iter()
            .map(|p| Value::String(p.to_string_lossy().into_owned()))
            .collect(),
    );
    meta.insert("at".into(), iso_now().into());
    let _ = std::fs::write(&file, format!("{}\n", js::stringify(&Value::Object(meta))));
}

/// Returns the current time as an ISO 8601 UTC timestamp with milliseconds.
fn iso_now() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let (secs, ms) = (millis / 1000, millis % 1000);
    let days = i64::try_from(secs / 86_400).unwrap_or_default();
    let rem = secs % 86_400;
    // Civil date from days since the epoch (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Finds the directory of the nearest `package.json` above the program, or the working
/// directory.
fn package_root(cwd: &Path) -> PathBuf {
    let entry = update::program().map(|program| std::fs::canonicalize(&program).unwrap_or(program));
    // The search stops below the filesystem root, as the reference does.
    entry
        .iter()
        .flat_map(|entry| entry.ancestors().skip(1))
        .take_while(|dir| dir.parent().is_some())
        .find(|dir| dir.join("package.json").exists())
        .unwrap_or(cwd)
        .to_owned()
}

/// Lists the `SKILL.md` files an include pattern matches, relative to `cwd`.
fn glob(pattern: &str, cwd: &Path) -> Vec<PathBuf> {
    let full = if pattern == "_root" {
        "SKILL.md".to_owned()
    } else {
        format!("{}/SKILL.md", pattern.trim_end_matches('/'))
    };
    let mut matches = vec![PathBuf::new()];
    for segment in full.split('/').filter(|s| !s.is_empty() && *s != ".") {
        let mut next = Vec::new();
        for base in matches {
            if segment.contains('*') {
                let Ok(entries) = std::fs::read_dir(cwd.join(&base)) else {
                    continue;
                };
                let mut names = entries
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|n| !n.starts_with('.') && crate::mcp::glob(segment, n))
                    .collect::<Vec<_>>();
                names.sort();
                next.extend(names.into_iter().map(|n| base.join(n)));
            } else if std::fs::symlink_metadata(cwd.join(&base).join(segment)).is_ok() {
                next.push(base.join(segment));
            }
        }
        matches = next;
    }
    matches
}

/// A skill reported by `skills add` or `skills list`.
pub(crate) struct Skill {
    /// The skill name.
    pub(crate) name: String,
    /// The frontmatter description.
    pub(crate) description: Option<String>,
    /// Whether it is installed, for `skills list`.
    pub(crate) installed: bool,
}

/// What `skills add` and `skills list` read.
pub(crate) struct Source<'a> {
    /// The CLI name.
    pub(crate) name: &'a str,
    /// Commands for skill files, from `collect` with the CLI description as a group.
    pub(crate) commands: &'a [CommandInfo],
    /// Groups and their descriptions.
    pub(crate) groups: &'a IndexMap<String, String>,
    /// Commands for the stored hash, collected without groups.
    pub(crate) hash: String,
    /// The environment.
    pub(crate) env: Env<'a>,
    /// Settings.
    pub(crate) settings: &'a SkillSync,
}

/// The result of `skills add`.
pub(crate) struct Synced {
    /// The synced skills, sorted by name.
    pub(crate) skills: Vec<Skill>,
    /// Canonical install paths.
    pub(crate) paths: Vec<PathBuf>,
    /// Agent links.
    agents: Vec<Linked>,
}

impl Synced {
    /// Returns the agent links as output data.
    pub(crate) fn agents(&self) -> Vec<Value> {
        self.agents
            .iter()
            .map(|link| {
                let mut out = Map::new();
                out.insert("agent".into(), link.agent.into());
                out.insert(
                    "path".into(),
                    link.path.to_string_lossy().into_owned().into(),
                );
                out.insert("mode".into(), link.mode.into());
                Value::Object(out)
            })
            .collect()
    }
}

/// Converts a depth to a grouping depth, as JavaScript treats non-integer and invalid depths.
fn depth(depth: f64) -> usize {
    if depth.is_nan() || depth <= 0.0 {
        0
    } else {
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "Depths are small and positive here."
        )]
        let depth = depth.ceil().min(1e6) as usize;
        depth
    }
}

/// Generates skill files and installs them for agents. Returns an error message on failure.
pub(crate) fn sync(source: &Source<'_>, depth_value: f64, global: bool) -> Result<Synced, Error> {
    let cwd = std::env::current_dir().unwrap_or_default();
    let root = source
        .settings
        .cwd
        .clone()
        .unwrap_or_else(|| package_root(&cwd));
    let files = skill::split(
        source.name,
        source.commands,
        depth(depth_value),
        source.groups,
    );
    let tmp = temp_dir(source.env, source.name)?;
    let result = (|| {
        let mut skills = Vec::new();
        for file in &files {
            write_skill(&tmp.join(&file.dir), &format!("{}\n", file.content))?;
            skills.push(Skill {
                name: file.name.clone(),
                description: Some(file.description.clone()).filter(|d| !d.is_empty()),
                installed: false,
            });
        }
        for pattern in &source.settings.include {
            for found in glob(pattern, &root) {
                let Ok(content) = std::fs::read_to_string(root.join(&found)) else {
                    continue;
                };
                let Some((name, description)) = included(pattern, &found, &content, source.name)
                else {
                    continue;
                };
                let _ = write_skill(&tmp.join(&name), &content);
                if !skills.iter().any(|s| s.name == name) {
                    skills.push(Skill {
                        name,
                        description,
                        installed: false,
                    });
                }
            }
        }
        let paths = Paths::new(source.env);
        let (installed, agents) = install(&tmp, global, &cwd, &paths);
        let current = installed
            .iter()
            .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .collect::<Vec<_>>();
        if let Some(meta) = read_meta(source.name, source.env) {
            for old in strings(&meta, "skills") {
                if !current.contains(&old) {
                    uninstall(&old, global, &cwd, &paths);
                }
            }
        }
        let mut all = installed.clone();
        all.extend(agents.iter().map(|a| a.path.clone()));
        let mut unique = Vec::new();
        for name in current {
            if !unique.contains(&name) {
                unique.push(name);
            }
        }
        write_meta(source.name, source.env, &source.hash, &unique, &all);
        skills.sort_by(|a, b| js::locale_compare(&a.name, &b.name));
        Ok::<_, std::io::Error>(Synced {
            skills,
            paths: installed,
            agents,
        })
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result.map_err(|error| Error::unknown(error.to_string()))
}

/// Names an included skill file and reads its description. A skill is named after its
/// directory, or for `_root`, after its frontmatter name or the CLI. Returns `None` when the file
/// is skipped: its frontmatter is not valid YAML, or a `_root` name is neither a string nor
/// null, which makes TypeScript's path join throw.
fn included(
    pattern: &str,
    found: &Path,
    content: &str,
    cli: &str,
) -> Option<(String, Option<String>)> {
    let (declared, description) = skill::frontmatter(content)?;
    let name = match (pattern, declared) {
        ("_root", None | Some(Value::Null)) => cli.to_owned(),
        ("_root", Some(Value::String(name))) => name,
        ("_root", Some(_)) => return None,
        _ => parent_name(found),
    };
    Some((name, description))
}

/// Returns the name of a match's parent directory.
fn parent_name(found: &Path) -> String {
    found
        .parent()
        .and_then(Path::file_name)
        .map_or_else(|| ".".into(), |n| n.to_string_lossy().into_owned())
}

/// Creates a fresh temporary directory.
fn temp_dir(env: Env<'_>, name: &str) -> Result<PathBuf, Error> {
    let base = env("TMPDIR")
        .filter(|v| !v.is_empty())
        .map_or_else(std::env::temp_dir, PathBuf::from);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    let dir = base.join(format!(
        "incur-skills-{name}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).map_err(|error| Error::unknown(error.to_string()))?;
    Ok(dir)
}

/// Lists generated and included skills with their install status.
pub(crate) fn list(source: &Source<'_>, depth_value: f64) -> Vec<Skill> {
    let root = source
        .settings
        .cwd
        .clone()
        .unwrap_or_else(|| package_root(&std::env::current_dir().unwrap_or_default()));
    let files = skill::split(
        source.name,
        source.commands,
        depth(depth_value),
        source.groups,
    );
    let installed = installed_skills(source.name, source.env);
    let mut skills = files
        .into_iter()
        .map(|file| Skill {
            installed: installed.contains(&file.name),
            name: file.name,
            description: Some(file.description).filter(|d| !d.is_empty()),
        })
        .collect::<Vec<_>>();
    for pattern in &source.settings.include {
        for found in glob(pattern, &root) {
            let Ok(content) = std::fs::read_to_string(root.join(&found)) else {
                continue;
            };
            let Some((name, description)) = included(pattern, &found, &content, source.name) else {
                continue;
            };
            if !skills.iter().any(|s| s.name == name) {
                skills.push(Skill {
                    installed: installed.contains(&name),
                    name,
                    description,
                });
            }
        }
    }
    skills.sort_by(|a, b| js::locale_compare(&a.name, &b.name));
    skills
}

/// Whether a name is a safe npm package name: lowercase, optionally scoped.
pub(crate) fn is_package_name(name: &str) -> bool {
    let part = |text: &str| {
        let mut chars = text.chars();
        chars
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c))
    };
    match name.strip_prefix('@') {
        Some(scoped) => scoped
            .split_once('/')
            .is_some_and(|(scope, name)| part(scope) && part(name)),
        None => part(name),
    }
}

/// Whether a version is an exact semantic version.
fn is_exact_version(version: &str) -> bool {
    let (core, build) = match version.split_once('+') {
        Some((core, build)) => (core, Some(build)),
        None => (version, None),
    };
    let (core, pre) = match core.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (core, None),
    };
    let identifiers = |text: &str| {
        text.split(['.', '-'])
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric()))
    };
    let numbers = core.split('.').collect::<Vec<_>>();
    numbers.len() == 3
        && numbers
            .iter()
            .all(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
        && pre.is_none_or(identifiers)
        && build.is_none_or(identifiers)
}

/// Returns the package specifier a runner installs: the package with its exact version.
///
/// # Errors
///
/// Returns an error for an invalid package name or a version that is not exact.
pub(crate) fn package_specifier(
    name: &str,
    package: Option<&str>,
    version: Option<&str>,
) -> Result<String, Error> {
    let Some(package) = package else {
        return Ok(name.to_owned());
    };
    if !is_package_name(package) {
        return Err(Error::unknown(format!(
            "Invalid npm package name: {package}"
        )));
    }
    match version {
        Some(version) if !is_exact_version(version) => Err(Error::unknown(format!(
            "Invalid exact package version: {version}"
        ))),
        Some(version) => Ok(format!("{package}@{version}")),
        None => Ok(package.to_owned()),
    }
}

/// What `mcp add` registers.
pub(crate) struct Register<'a> {
    /// The MCP server name.
    pub(crate) name: &'a str,
    /// The CLI name, when it differs from the server name.
    pub(crate) cli: &'a str,
    /// The command agents run, overriding the default.
    pub(crate) command: Option<String>,
    /// Whether to register globally.
    pub(crate) global: bool,
    /// Target agents.
    pub(crate) agents: Vec<String>,
    /// The package and version, when the CLI declares a package.
    pub(crate) package: Option<(&'a str, Option<&'a str>)>,
    /// The environment.
    pub(crate) env: Env<'a>,
}

/// Whether agents should run the CLI by its bare name instead of through a package runner.
fn bare_command(name: &str, package: Option<&str>) -> bool {
    let bin = update::program()
        .unwrap_or_default()
        .to_string_lossy()
        .replace('\\', "/");
    if let Some(index) = bin.find("/node_modules/") {
        let (root, entry) = (&bin[..index], &bin[index + "/node_modules/".len()..]);
        return !entry.starts_with(".bin/")
            && !depends_on(Path::new(root), package.unwrap_or(name));
    }
    let file = bin.rsplit('/').next().unwrap_or_default();
    file == name || file == format!("{name}.cmd") || file == format!("{name}.ps1")
}

/// Whether the `package.json` in `root` depends on a package.
fn depends_on(root: &Path, name: &str) -> bool {
    let Some(metadata) = std::fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|text| js::json_parse(&text, |_| Value::Null).ok())
    else {
        return false;
    };
    [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ]
    .iter()
    .any(|field| {
        metadata
            .get(field)
            .and_then(|deps| deps.get(name))
            .is_some()
    })
}

/// Splits a command line on spaces, honoring single and double quotes.
fn split_command(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for ch in input.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            None if ch == '"' || ch == '\'' => quote = Some(ch),
            None if ch == ' ' => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// Reads Amp's settings: an empty map when the file is missing, else the JSON object it holds.
fn read_amp(path: &Path) -> Result<Map<String, Value>, Error> {
    if !path.exists() {
        return Ok(Map::new());
    }
    match std::fs::read_to_string(path).map(|text| js::json_parse(&text, |_| Value::Null)) {
        Ok(Ok(Value::Object(config))) => Ok(config),
        _ => Err(Error::unknown(format!(
            "Invalid Amp settings at {}: expected a JSON object",
            path.display()
        ))),
    }
}

/// Registers the server in Amp's settings, keeping the other fields of an existing entry.
/// Returns whether it was registered.
fn register_amp(path: &Path, mut config: Map<String, Value>, name: &str, command: &str) -> bool {
    let mut tokens = split_command(command).into_iter();
    let Some(program) = tokens.next() else {
        return false;
    };
    let mut servers = take_object(&mut config, "amp.mcpServers");
    let mut server = take_object(&mut servers, name);
    server.insert("command".into(), program.into());
    server.insert("args".into(), tokens.map(Value::String).collect());
    servers.insert(name.into(), Value::Object(server));
    config.insert("amp.mcpServers".into(), Value::Object(servers));
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(
        path,
        format!("{}\n", js::stringify_pretty(&Value::Object(config))),
    )
    .is_ok()
}

/// Takes the object at `key`, leaving the key in place so a later insert keeps its position, or
/// an empty object when the value is missing or not an object.
fn take_object(map: &mut Map<String, Value>, key: &str) -> Map<String, Value> {
    match map.get_mut(key) {
        Some(Value::Object(object)) => std::mem::take(object),
        _ => Map::new(),
    }
}

/// Registers the CLI as an MCP server with agents through `add-mcp`, and with Amp directly.
/// Returns the command and the agents registered.
pub(crate) fn register(options: Register<'_>) -> Result<(String, Vec<String>), Error> {
    let runner = update::runner(options.env);
    let command = if let Some(command) = options.command {
        command
    } else {
        let (package, version) = options.package.unzip();
        let specifier = package
            .map(|p| package_specifier(options.cli, Some(p), version.flatten()))
            .transpose()?;
        if bare_command(options.cli, package)
            || (package.is_none() && !is_package_name(options.cli))
        {
            format!("{} --mcp", options.cli)
        } else {
            format!(
                "{runner} {} --mcp",
                specifier.unwrap_or_else(|| options.cli.to_owned())
            )
        }
    };
    // Amp is registered directly (`add-mcp` does not support it). Its settings are read first, so
    // invalid settings fail before any agent is configured.
    let amp_path = if options.global {
        home(options.env)
            .join(".config")
            .join("amp")
            .join("settings.json")
    } else {
        std::env::current_dir()
            .unwrap_or_default()
            .join(".amp")
            .join("settings.json")
    };
    let amp_config = if options.agents.is_empty() || options.agents.iter().any(|a| a == "amp") {
        Some(read_amp(&amp_path)?)
    } else {
        None
    };
    let amp_only = options.agents.len() == 1 && options.agents[0] == "amp";
    let mut agents = Vec::new();
    if !amp_only {
        let mut args = vec![
            "add-mcp".to_owned(),
            command.clone(),
            "--name".into(),
            options.name.to_owned(),
            "-y".into(),
        ];
        if options.global {
            args.push("-g".into());
        }
        for agent in options.agents.iter().filter(|a| *a != "amp") {
            args.push("-a".into());
            args.push(agent.clone());
        }
        let stdout = update::exec(runner, &args, options.env)?;
        for line in stdout.split('\n') {
            if !line.contains('\u{2713}') && !line.contains('\u{2714}') {
                continue;
            }
            let line = line.replace(['\u{2502}', '\u{2503}', '|'], "");
            let after = line
                .rfind(['\u{2713}', '\u{2714}'])
                .map_or(line.as_str(), |index| &line[index + 3..]);
            let after = after.trim_start_matches(js::is_whitespace);
            let name = after.split(':').next().unwrap_or_default();
            let name = name.trim_matches(js::is_whitespace);
            if !name.is_empty() {
                agents.push(name.to_owned());
            }
        }
    }
    if amp_config.is_some_and(|config| register_amp(&amp_path, config, options.name, &command)) {
        agents.push("Amp".into());
    }
    Ok((command, agents))
}
