# Release Guide

This guide explains how to create and manage releases for PonsWarp.

## Prerequisites

Before creating a release, ensure you have:

1. **Git access** with push permissions to the repository
2. **Node.js** and **pnpm** installed locally
3. **Tauri private key** configured in GitHub Secrets (for signing releases)
4. **Clean working directory** with no uncommitted changes

## GitHub Secrets Configuration

Configure the following secrets in your GitHub repository settings (`Settings > Secrets and variables > Actions`):

| Secret Name | Description | Required |
|-------------|-------------|----------|
| `TAURI_PRIVATE_KEY` | Private key for signing Tauri applications | Yes |
| `TAURI_KEY_PASSWORD` | Password for the Tauri private key | Yes |
| `CODECOV_TOKEN` | Token for uploading code coverage reports | Optional |

### Generating Tauri Private Key

If you don't have a Tauri private key, generate one:

```bash
cd src-tauri
pnpm tauri signer generate
```

This will create:
- `key.priv` - Private key (add to GitHub Secrets as `TAURI_PRIVATE_KEY`)
- `key.pub` - Public key (add to `src-tauri/tauri.conf.json`)

## Release Process

### Automated Release (Recommended)

Use the automated release script to create a new version:

```bash
# Patch release (1.0.0 -> 1.0.1)
pnpm release:patch

# Minor release (1.0.0 -> 1.1.0)
pnpm release:minor

# Major release (1.0.0 -> 2.0.0)
pnpm release:major

# Specific version
pnpm release 1.2.3
```

The script will:
1. Update version in [`package.json`](package.json:4)
2. Update version in [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json:4)
3. Create a new entry in [`CHANGELOG.md`](CHANGELOG.md)
4. Create a git commit
5. Create and push a git tag (e.g., `v1.2.3`)
6. Trigger the GitHub Actions release workflow

### Manual Release

If you prefer to create releases manually:

1. **Update version files:**
   ```bash
   # Update package.json
   npm version 1.2.3 --no-git-tag-version
   
   # Update tauri.conf.json
   jq --arg v "1.2.3" '.version = $v' src-tauri/tauri.conf.json > tmp.json
   mv tmp.json src-tauri/tauri.conf.json
   ```

2. **Update CHANGELOG.md:**
   - Add a new version entry with the date
   - Document all changes (Added, Changed, Fixed, etc.)

3. **Commit and tag:**
   ```bash
   git add package.json src-tauri/tauri.conf.json CHANGELOG.md
   git commit -m "chore: release version 1.2.3"
   git tag -a v1.2.3 -m "Release version 1.2.3"
   git push
   git push origin v1.2.3
   ```

## CI/CD Pipeline

### CI Workflow ([`.github/workflows/ci.yml`](.github/workflows/ci.yml))

Runs on every push and pull request to `main` or `develop` branches:

- **Lint:** ESLint and TypeScript type checking
- **Test:** Unit tests with coverage reporting
- **Build Frontend:** Vite build
- **Build Rust:** Cross-platform compilation check

### Release Workflow ([`.github/workflows/release.yml`](.github/workflows/release.yml))

Triggered when a version tag is pushed (e.g., `v1.2.3`):

1. **Prepare Release:**
   - Extract version from tag
   - Generate changelog from [`CHANGELOG.md`](CHANGELOG.md)

2. **Build:**
   - Builds for multiple platforms:
     - Linux (x86_64, aarch64)
     - macOS (x86_64, aarch64)
     - Windows (x86_64)
   - Creates platform-specific installers:
     - Linux: DEB, AppImage, RPM
     - macOS: DMG, app.tar.gz
     - Windows: MSI, NSIS

3. **Create Release:**
   - Creates GitHub release with changelog
   - Uploads all build artifacts

4. **Update Version:**
   - Commits version updates back to repository

## Build Artifacts

After a successful release, the following artifacts are available in the GitHub release:

### Linux
- `ponswarp_1.2.3_amd64.deb` - Debian package
- `ponswarp_1.2.3_amd64.AppImage` - AppImage package
- `ponswarp-1.2.3-1.x86_64.rpm` - RPM package

### macOS
- `PonsWarp_1.2.3_x64.dmg` - DMG installer (Intel)
- `PonsWarp_1.2.3_aarch64.dmg` - DMG installer (Apple Silicon)
- `PonsWarp.app.tar.gz` - Application bundle

### Windows
- `PonsWarp_1.2.3_x64_en-US.msi` - MSI installer
- `PonsWarp_1.2.3_x64-setup.exe` - NSIS installer

## Versioning

PonsWarp follows [Semantic Versioning](https://semver.org/):

- **MAJOR** (X.0.0): Incompatible API changes
- **MINOR** (1.X.0): Backward-compatible functionality additions
- **PATCH** (1.0.X): Backward-compatible bug fixes

## Changelog

Maintain [`CHANGELOG.md`](CHANGELOG.md) using the following format:

```markdown
## [1.2.3] - 2025-01-02

### Added
- New feature description

### Changed
- Description of changes to existing functionality

### Fixed
- Bug fix description

### Security
- Security vulnerability fix

### Performance
- Performance improvement description
```

## Troubleshooting

### Build Failures

If the release workflow fails:

1. Check the workflow logs in GitHub Actions
2. Verify all GitHub Secrets are configured correctly
3. Ensure the tag format is correct (`vX.Y.Z`)
4. Check that [`CHANGELOG.md`](CHANGELOG.md) has an entry for the version

### Version Conflicts

If version files are out of sync:

```bash
# Check current versions
grep '"version"' package.json
grep '"version"' src-tauri/tauri.conf.json

# Manually sync if needed
npm version 1.2.3 --no-git-tag-version
jq --arg v "1.2.3" '.version = $v' src-tauri/tauri.conf.json > tmp.json
mv tmp.json src-tauri/tauri.conf.json
```

### Rollback

If you need to rollback a release:

```bash
# Delete the tag locally and remotely
git tag -d v1.2.3
git push origin :refs/tags/v1.2.3

# Delete the GitHub release manually from the releases page
```

## Best Practices

1. **Always update CHANGELOG.md** before creating a release
2. **Test locally** before pushing the tag
3. **Use semantic versioning** consistently
4. **Review the release** after it's created
5. **Keep dependencies updated** using Dependabot
6. **Monitor build logs** for any warnings or errors

## Additional Resources

- [Tauri Documentation](https://tauri.app/v1/guides/distribution/sign-updates/)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Semantic Versioning](https://semver.org/)
- [Keep a Changelog](https://keepachangelog.com/)
