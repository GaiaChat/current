# Current Server Updates

Current servers should update from a versioned release channel that each host pulls
and applies locally. Do not push arbitrary code into running community servers.
The central service should publish a versioned release, then local launchers,
systemd installs, and Gaia can ask the server host to download and apply it.

## Release Channel

Use GitHub Releases on `GaiaChat/current` as the first update channel:

1. Bump the root `package.json` version.
2. Run `pnpm release:server`.
3. Push a `current-server-v<version>` tag or run the
   `Publish Current Server Release` GitHub Actions workflow.
4. Keep `current-server-latest.json` and the matching
   `current-server-v<version>.tar.gz` together in that release.

The default release script points update clients at:

```sh
https://github.com/GaiaChat/current/releases/latest/download/current-server-latest.json
```

The generated manifest gives update clients the version, archive URL, size, and
SHA-256 digest. The archive intentionally excludes local config, SQLite data,
uploads, backups, and `node_modules`. Release archives are runtime packages, not
workspace checkouts, so first-run dependency installs avoid pnpm workspace
symlinks on mounted or Windows-backed filesystems.

## Server-Side Update Flow

Every server host should use the same apply sequence:

1. Check `current-server-latest.json`.
2. Compare the manifest version with the installed version.
3. Download the archive to a local cache.
4. Verify the archive SHA-256 before extraction.
5. Back up SQLite and config.
6. Extract into a new versioned app directory.
7. Install production dependencies inside the new app directory.
8. Atomically switch the service to the new app directory.
9. Restart the server.
10. Keep the previous version for rollback.

This is pull-based even when Gaia shows an "Update server" button. Gaia should
call a local/admin endpoint or run a local helper that performs the same checked
download and restart on the host machine.

## Install Layout

The durable Linux layout should separate app code from user state:

```text
/opt/current/
  versions/current-server-v0.3.1/
  current -> versions/current-server-v0.3.1
/etc/current/current.config.json
/var/lib/current/current.sqlite
/var/lib/current/uploads/
/var/lib/current/backups/
```

The native systemd installer uses this split now. App code is replaced under
`/opt/current/versions`, while messages, settings, uploads, and backups stay in
`/etc/current` and `/var/lib/current`.

Source-tree launchers can still use `apps/server/config`, `apps/server/data`,
and `apps/server/uploads` for development or one-click local testing.

Portable release bundles use the folder beside the extracted
`current-server-v<version>` directory as their install root. For example,
running `Update Current.mjs` from `/mnt/SSD4TB/current-server-v0.3.5` stages future
releases under `/mnt/SSD4TB/versions`, preserves local config, data, uploads,
and backups, then activates `/mnt/SSD4TB/current`.

If that drive supports symlinks, `current` points at the active version. On
symlinkless portable filesystems such as exFAT, the updater copies the active
release into a real `current` directory and moves the previous active directory
aside as `previous-current-<timestamp>`. Old versioned launchers are
refreshed so launching them redirects to `current` instead of staying pinned to
the old extracted folder.

## Launcher Behavior

For one-click local servers:

- Use the root Node launchers: `Install Current.mjs`, `Run Current.mjs`, and
  `Update Current.mjs`.
- Check the manifest before the normal-mode build/start step.
- Prompt in TTY launches: `Update available: vX.Y.Z. Install now?`.
- Skip update checks for dev mode unless explicitly requested.
- Never overwrite config, data, uploads, or backups.
- From portable release bundles, launch the active `current` directory when it
  exists instead of the versioned folder that originally started the process.

For systemd installs:

- Run `sudo pnpm update:server` from a checkout or
  `sudo node "Update Current.mjs"` from a checkout or
  `sudo node /opt/current/current/update-current-server.mjs`.
- Restart `current.service` only after the new version is staged and verified.
- On failure, keep running the old version and report the failed stage.

## Admin/Gaia Surface

Expose update state through admin-only APIs once the helper exists:

- `GET /api/v1/admin/updates` returns installed version, latest version,
  channel, and whether a restart is required.
- `POST /api/v1/admin/updates/stage` downloads and verifies the next version.
- `POST /api/v1/admin/updates/apply` restarts into the staged version.

These routes must require the host/admin permission path already used by server
settings. The apply route should only work on the host machine or with an
explicit server-owner token, because it restarts the process.

## Security Rules

- Fetch updates only over HTTPS.
- Verify SHA-256 before extraction.
- Add release signing before public auto-update is enabled.
- Refuse archives that contain absolute paths or `..` traversal.
- Back up SQLite before migrations or restart.
- Keep rollback metadata for at least one previous version.

## Current First Step

`pnpm release:server` creates the release archive and update manifest.
`pnpm update:server` consumes `current-server-latest.json`, downloads and
verifies the archive, backs up config and SQLite, stages
`/opt/current/versions/<version>`, switches the `current` symlink, and restarts
`current.service`. Portable bundles use the same checked flow, but default to
the bundle's parent directory and fall back to a real `current` directory when
the filesystem cannot create symlinks.
