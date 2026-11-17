//! Locates the ffmpeg/ffprobe executables (spec 4.2). Port of desktop-app/src/main/ffmpeg/
//! binaries.ts: bundled when packaged, PATH / env override in development.
//!
//! The function takes the resource directory explicitly (and the platform and environment as
//! values), so it can be tested for every platform without a Tauri runtime.

use std::path::Path;

/// Platform flavour of the paths that are built (Electron's `process.platform === 'win32'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Other,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Other
        }
    }

    fn separator(self) -> char {
        match self {
            Platform::Windows => '\\',
            Platform::Other => '/',
        }
    }

    fn exe_suffix(self) -> &'static str {
        match self {
            Platform::Windows => ".exe",
            Platform::Other => "",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binaries {
    pub ffmpeg: String,
    pub ffprobe: String,
}

pub struct ResolveBinariesInput<'a> {
    pub platform: Platform,
    /// Directory that holds the bundled `bin/` folder: Tauri's `resource_dir()` of the packaged
    /// app (the Electron app's `process.resourcesPath`). Unused in development.
    pub resources_dir: &'a str,
    /// Environment lookup (`FFMPEG_PATH` / `FFPROBE_PATH`).
    pub env: &'a dyn Fn(&str) -> Option<String>,
    pub is_packaged: bool,
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.trim().is_empty())
}

/// `<dir>/bin/<name>` with the separator of `platform` (like `path.win32.join` / `path.posix.join`).
fn bundled(platform: Platform, resources_dir: &str, name: &str) -> String {
    let sep = platform.separator();
    let base = resources_dir.trim_end_matches(['/', '\\']);

    format!("{base}{sep}bin{sep}{name}")
}

/// Packaged: absolute `<resources>/bin/ffmpeg(.exe)` and `ffprobe(.exe)`; PATH is never used.
/// Development: `FFMPEG_PATH` / `FFPROBE_PATH`, otherwise the bare names (resolved through PATH).
pub fn resolve_binaries(input: &ResolveBinariesInput<'_>) -> Binaries {
    let suffix = input.platform.exe_suffix();
    let ffmpeg_name = format!("ffmpeg{suffix}");
    let ffprobe_name = format!("ffprobe{suffix}");

    if input.is_packaged {
        return Binaries {
            ffmpeg: bundled(input.platform, input.resources_dir, &ffmpeg_name),
            ffprobe: bundled(input.platform, input.resources_dir, &ffprobe_name),
        };
    }

    Binaries {
        ffmpeg: non_empty((input.env)("FFMPEG_PATH")).unwrap_or(ffmpeg_name),
        ffprobe: non_empty((input.env)("FFPROBE_PATH")).unwrap_or(ffprobe_name),
    }
}

/// True when `command` names an existing file, or (a bare name) is found on `PATH`.
/// Used by tests and diagnostics to decide whether a real tool is available.
pub fn command_exists(command: &str) -> bool {
    let path = Path::new(command);

    if path.components().count() > 1 || path.is_absolute() {
        return path.is_file();
    }

    std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|dir| dir.join(command).is_file()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |key| {
            pairs
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| (*v).to_string())
        }
    }

    #[test]
    fn uses_absolute_bundled_paths_on_windows_when_packaged() {
        let env = env_of(&[("FFMPEG_PATH", "D:\\other\\ffmpeg.exe")]);
        let got = resolve_binaries(&ResolveBinariesInput {
            platform: Platform::Windows,
            resources_dir: "C:\\Users\\Me\\AppData\\Local\\Programs\\App\\resources",
            env: &env,
            is_packaged: true,
        });

        assert_eq!(
            got,
            Binaries {
                ffmpeg: "C:\\Users\\Me\\AppData\\Local\\Programs\\App\\resources\\bin\\ffmpeg.exe"
                    .into(),
                ffprobe:
                    "C:\\Users\\Me\\AppData\\Local\\Programs\\App\\resources\\bin\\ffprobe.exe"
                        .into(),
            }
        );
    }

    #[test]
    fn uses_bin_ffmpeg_without_a_suffix_on_posix_when_packaged_and_ignores_env() {
        let env = env_of(&[("FFMPEG_PATH", "/x/ffmpeg"), ("FFPROBE_PATH", "/x/ffprobe")]);
        let got = resolve_binaries(&ResolveBinariesInput {
            platform: Platform::Other,
            resources_dir: "/Applications/App.app/Contents/Resources",
            env: &env,
            is_packaged: true,
        });

        assert_eq!(
            got,
            Binaries {
                ffmpeg: "/Applications/App.app/Contents/Resources/bin/ffmpeg".into(),
                ffprobe: "/Applications/App.app/Contents/Resources/bin/ffprobe".into(),
            }
        );
    }

    #[test]
    fn does_not_double_the_separator_of_a_trailing_slash() {
        let env = env_of(&[]);
        let got = resolve_binaries(&ResolveBinariesInput {
            platform: Platform::Windows,
            resources_dir: "C:\\App\\resources\\",
            env: &env,
            is_packaged: true,
        });

        assert_eq!(got.ffmpeg, "C:\\App\\resources\\bin\\ffmpeg.exe");
    }

    #[test]
    fn prefers_the_env_overrides_in_development() {
        let env = env_of(&[
            ("FFMPEG_PATH", "/opt/ff/ffmpeg"),
            ("FFPROBE_PATH", "/opt/ff/ffprobe"),
        ]);
        let got = resolve_binaries(&ResolveBinariesInput {
            platform: Platform::Other,
            resources_dir: "/unused",
            env: &env,
            is_packaged: false,
        });

        assert_eq!(got.ffmpeg, "/opt/ff/ffmpeg");
        assert_eq!(got.ffprobe, "/opt/ff/ffprobe");
    }

    #[test]
    fn falls_back_to_bare_names_path_in_development() {
        let none = env_of(&[]);
        let got = resolve_binaries(&ResolveBinariesInput {
            platform: Platform::Other,
            resources_dir: "",
            env: &none,
            is_packaged: false,
        });

        assert_eq!(got.ffmpeg, "ffmpeg");
        assert_eq!(got.ffprobe, "ffprobe");

        let blank = env_of(&[("FFMPEG_PATH", "  ")]);
        let got = resolve_binaries(&ResolveBinariesInput {
            platform: Platform::Windows,
            resources_dir: "",
            env: &blank,
            is_packaged: false,
        });

        assert_eq!(got.ffmpeg, "ffmpeg.exe");
        assert_eq!(got.ffprobe, "ffprobe.exe");
    }

    #[test]
    fn command_exists_checks_files_and_path() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("tool");
        std::fs::write(&file, "x").unwrap();

        assert!(command_exists(file.to_str().unwrap()));
        assert!(!command_exists(
            dir.path().join("missing").to_str().unwrap()
        ));
        assert!(!command_exists("definitely-not-a-real-command-xyz"));
    }
}
