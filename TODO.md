# TODO

Items below are deferred and are not part of the current milestone (no sync of queue/progress/job state between the desktop app and the site; that state lives only locally in the app).

## Desktop app: manage videos (like the site)

- [ ] List the user's videos in the app using the site API.
- [ ] Edit a video title from the app (same capability as the site dashboard).
- [ ] Delete a processed video from the app; deletion must remove the R2 prefix and the database row, same as the site does today.
- [ ] Keep behavior consistent with the site (same validation, same delete semantics).
- [ ] Reuse the existing site API endpoints rather than adding parallel ones.

## Site dashboard: show app job state

- [ ] Optionally show the app's queue / progress / job state on the site dashboard (requires the app to report state to the site; currently not synced on purpose).
- [ ] If implemented: periodic heartbeat from the app to the site.
- [ ] If implemented: stale-job rule that marks jobs as failed after a timeout.
- [ ] If implemented: cleanup of orphaned R2 objects left by failed uploads.

## macOS app

- [ ] Build the macOS app after the Windows app is stable.
- [ ] Prefer sharing the same codebase if the chosen stack is cross-platform; only the ffmpeg/ffprobe binaries, code signing/notarization and packaging differ.

## Desktop app: auto-update

- [ ] Add auto-update for the Windows app (e.g. electron-updater with a generic provider); needs a place to host update files (GitHub Releases or an R2 public bucket). Until then, users reinstall manually (the installer upgrades in place and keeps settings).

## Desktop app: GPL source offer for external distribution

- [ ] Before distributing the installer outside the owning organization: attach the complete corresponding source to each GitHub Release (FFmpeg source AND the source of the statically linked GPL/LGPL libraries such as libx264, libx265, libvpx, libmp3lame, plus the build scripts of the gyan.dev essentials build), or provide a working contact address and keep the sources available for 3 years. See `desktop-app/docs/PACKAGING.md`.
