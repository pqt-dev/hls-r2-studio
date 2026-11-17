//! Build script. Mirrors the intent of electron.vite.config.ts: a production (release) build must
//! have a valid https `HLS_SITE_URL`; dev builds and `cargo test` do not need it.

#[path = "src/site_url.rs"]
mod site_url;

fn main() {
    println!("cargo:rerun-if-env-changed=HLS_SITE_URL");
    println!("cargo:rerun-if-env-changed=PROFILE");

    // `tauri build` compiles the app with the release profile; `tauri dev` and `cargo test` use dev.
    let is_release = std::env::var("PROFILE").is_ok_and(|profile| profile == "release");

    if is_release {
        match std::env::var("HLS_SITE_URL") {
            Ok(raw) if !raw.trim().is_empty() => {
                if let Err(reason) = site_url::normalize(&raw) {
                    panic!("HLS_SITE_URL is not valid: {reason}");
                }
            }
            _ => panic!(
                "HLS_SITE_URL is not set. Set it to the https URL of your HLS site before \
                 building, for example: HLS_SITE_URL=https://admin.example.com npm run build"
            ),
        }
    }

    tauri_build::build();
}
