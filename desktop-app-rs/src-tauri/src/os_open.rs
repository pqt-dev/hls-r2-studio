//! Opens a folder in the system file manager (Electron's `shell.openPath`). Uses the OS command
//! directly (no shell, the path is one argument) so no Tauri plugin and no webview permission is
//! needed: the webview can only trigger it through the `app_open_logs_folder` command.

use std::io;
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
fn launcher() -> &'static str {
    "explorer"
}

#[cfg(target_os = "macos")]
fn launcher() -> &'static str {
    "open"
}

#[cfg(not(any(windows, target_os = "macos")))]
fn launcher() -> &'static str {
    "xdg-open"
}

pub fn open_folder(path: &Path) -> io::Result<()> {
    let mut command = Command::new(launcher());

    command.arg(path);

    // `explorer.exe` returns exit code 1 even when it opened the folder, so on Windows only a
    // failure to start counts; the child is reaped in the background.
    #[cfg(windows)]
    {
        let mut child = command.spawn()?;

        std::thread::spawn(move || {
            let _ = child.wait();
        });

        Ok(())
    }

    #[cfg(not(windows))]
    {
        let status = command.status()?;

        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!("{} failed", launcher())))
        }
    }
}
