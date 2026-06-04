# Release Readiness

brainbox is currently documented as an educational/local-first project, not production software for sensitive data. Use this checklist before treating any build as release-ready.

## Automated Gates

Run these from a clean checkout:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run test:run
pnpm run test:e2e
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
pnpm run smoke:tauri
pnpm audit --prod
```

`pnpm run smoke:tauri` builds the real Tauri debug binary, starts the Vite dev server expected by the debug app, launches the desktop process with an isolated temporary `BRAINBOX_DATA_DIR`, waits for the SQLite DB and search index to initialize, and then closes both processes.

Release builds also run `scripts/write-release-checksums.ps1` in GitHub Actions. The generated `release-checksums-<platform>.txt` files are uploaded as workflow artifacts and attached to the GitHub release.

## Manual Desktop Smoke

- Install or unpack the release artifact on a clean Windows machine.
- Launch with no existing `brainbox.sqlite`.
- Create one passwordless vault and one password-protected vault.
- Capture a note and a URL.
- Search for both captured items and open the result from the correct vault.
- Export sync data with a sync file passphrase, confirm vault names, item titles, content, summaries, covers, and device name are not plaintext in `brainbox.sync`.
- Import the sync file into a clean profile and confirm items restore.
- Close and reopen; confirm vault list, search, tray behavior, and update check do not regress.

## Signing And Update Gates

- Windows code-signing certificate available and configured.
- macOS signing/notarization credentials available before advertising macOS as production-ready.
- Release artifact checksums generated and attached.
- Portable updater behavior tested against a published release asset.
- Update failure path tested with a missing or unavailable asset.

## Security Posture

- New sync exports require a sync file passphrase and write an encrypted sync-file envelope. Legacy plaintext sync files remain importable for migration.
- Standalone capture files are not exported by encrypted sync because they live outside the sync JSON envelope.
- Keep the README educational/security warning until a dedicated security review covers key storage, key rotation, backup/recovery, and platform keychain integration.

## Retained Code Decisions

- The unused screenshot capture helper module was deleted. Current capture support is the modal, hotkey, local HTTP bridge, and Windows protocol handler.
- `src-tauri/src/lib.rs` now delegates app-data paths and sync command wrappers to smaller modules; keep moving future command groups out before adding major backend features.
