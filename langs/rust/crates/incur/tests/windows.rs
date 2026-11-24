//! Windows-only behavior the Linux differential suite cannot reach: package-manager commands
//! that are `.cmd` scripts, as npm, npx, pnpm, and pnpx are on Windows.

#![cfg(windows)]

use incur::{Cli, Io};

/// `mcp add` runs an npm-style `npx.cmd`, which forwards `%*` to its program, from a directory
/// whose name needs quoting, and every argument reaches the program intact.
#[test]
fn mcp_add_runs_command_scripts() {
    let dir = std::env::temp_dir().join(format!("incur windows ({})", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("record.js"),
        "const { join } = require('path')\n\
         require('fs').writeFileSync(join(__dirname, 'calls'), JSON.stringify(process.argv.slice(2)))\n\
         console.log('\u{2502} \u{2713} Codex: added')\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("npx.cmd"),
        "@ECHO off\r\nnode \"%~dp0\\record.js\" %*\r\n",
    )
    .unwrap();
    let path = format!("{};{}", dir.display(), std::env::var("PATH").unwrap());
    let home = dir.display().to_string();
    let agents = [
        "a&b|c<d>e^f",
        "100%",
        "%PATH%",
        "!bang! (x) ;semi, comma",
        "q\\\"uote",
        "dir\\",
    ];
    let mut argv = vec!["mcp".to_owned(), "add".to_owned()];
    for agent in agents {
        argv.extend(["--agent".to_owned(), agent.to_owned()]);
    }
    let env = |key: &str| match key {
        "HOME" => Some(home.clone()),
        "PATH" => Some(path.clone()),
        _ => None,
    };
    let mut stdout = Vec::new();
    let exit = Cli::new("kit").update(false).sync(false).serve_with(
        &argv,
        &mut Io {
            env: &env,
            stderr: &mut Vec::new(),
            stdin: &mut futures::stream::empty(),
            stdout: &mut stdout,
            tty: false,
        },
    );
    assert_eq!(exit, 0, "{}", String::from_utf8_lossy(&stdout));
    let calls: Vec<String> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("calls")).unwrap()).unwrap();
    let expected = agents
        .iter()
        .flat_map(|agent| ["-a", agent])
        .collect::<Vec<_>>();
    assert_eq!(calls[6..], expected);
    std::fs::remove_dir_all(&dir).unwrap();
}
