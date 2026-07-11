# Release Readiness

brainbox is an educational/local-first project, not production software for sensitive data. A release is allowed only after every automated gate and both packaged-app smoke checks pass.

## Automated Gates

Run from a clean checkout:

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run test:run
pnpm run test:e2e
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
pnpm run test:tauri:qa
pnpm run smoke:tauri
pnpm audit
cargo audit --file src-tauri/Cargo.lock
```

CI runs these gates on pull requests and pushes to `main`/`dev`. Browser tests supplement, but do not replace, native WebView2 QA and the Tauri runtime smoke test.

## Release Contract

- Releases run only for an existing `vMAJOR.MINOR.PATCH` tag or an explicit manual dispatch naming that tag. A push to `main` never publishes.
- The tag must match `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` exactly.
- Repository variables `EVB_INSTALLER_URL` and `EVB_INSTALLER_SIGNER_THUMBPRINT` must identify the official Enigma Virtual Box endpoint and its operator-approved Authenticode certificate. The endpoint serves dynamically varied signed installers and intermittent block pages, so the workflow retries only that URL; every accepted download is size/product checked, must have a valid signature from the pinned signer, and has its observed SHA-256 logged for provenance. The protected `release` environment must provide `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`.
- Windows produces one unsigned `brainbox-portable.exe`; macOS produces one signed, notarized, and stapled Apple Silicon `.dmg`. Each platform also produces a SHA-256 manifest.
- Packaging fails on an invalid or wrong-publisher EVB installer, missing or implausibly small portable executable, missing or duplicate DMG, failed notarization, or checksum mismatch.
- Publishing creates a draft only after both platform jobs pass, verifies all four expected assets, then publishes once. Published tags and assets are immutable; fix forward with a new version.
- The Windows portable build is intentionally unsigned. SmartScreen and antivirus warnings are expected and must be disclosed in the release notes.

## Update Posture

The app only checks the latest published GitHub release and reports its version. Download, replacement, and install commands are disabled; users download releases manually.

Do not restore automatic installation until the official Tauri updater is configured with a committed public key, protected signing key, native updater bundles and `.sig` files for both platforms, atomic complete-release publication, signature-rejection tests, and a previous-version upgrade/persistence smoke test.

## Packaged-App Smoke

- Run the unsigned portable executable on a clean Windows machine and install the notarized DMG on a clean Apple Silicon Mac.
- Launch with no existing `brainbox.sqlite`; create passwordless and protected vaults, capture a note and URL, search, export/import an encrypted backup, restart, and confirm persistence.
- Install over the previous public version and confirm existing vaults, settings, tray behavior, protocol handling, and search still work.
- Disconnect networking and confirm the core capture/search workflow remains usable; reconnect and verify update checks fail safely when GitHub or the expected release is unavailable.

If packaging or publishing fails, leave any draft unpublished and keep the previous release available. Never replace assets on an already published tag.
