#!/usr/bin/env node

/**
 * Release Management Script
 *
 * This script automates the release process:
 * 1. Updates version in package.json and tauri.conf.json
 * 2. Updates CHANGELOG.md with new version entry
 * 3. Creates a git commit and tag
 * 4. Pushes to remote repository
 *
 * Usage:
 *   node scripts/release.js patch  # 1.0.0 -> 1.0.1
 *   node scripts/release.js minor  # 1.0.0 -> 1.1.0
 *   node scripts/release.js major  # 1.0.0 -> 2.0.0
 *   node scripts/release.js 1.2.3  # Set specific version
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import readline from 'readline';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function error(message) {
  log(`❌ Error: ${message}`, 'red');
  process.exit(1);
}

function success(message) {
  log(`✓ ${message}`, 'green');
}

function info(message) {
  log(`ℹ ${message}`, 'blue');
}

function warn(message) {
  log(`⚠ ${message}`, 'yellow');
}

/**
 * Get current version from package.json
 */
function getCurrentVersion() {
  const packageJsonPath = path.join(__dirname, '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  return packageJson.version;
}

/**
 * Calculate new version based on bump type or specific version
 */
function getNewVersion(currentVersion, bumpType) {
  const parts = currentVersion.split('.').map(Number);

  if (['major', 'minor', 'patch'].includes(bumpType)) {
    if (bumpType === 'major') {
      return `${parts[0] + 1}.0.0`;
    } else if (bumpType === 'minor') {
      return `${parts[0]}.${parts[1] + 1}.0`;
    } else if (bumpType === 'patch') {
      return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
    }
  } else {
    // Validate specific version format
    const versionRegex = /^\d+\.\d+\.\d+$/;
    if (!versionRegex.test(bumpType)) {
      error('Invalid version format. Use X.Y.Z format.');
    }
    return bumpType;
  }
}

/**
 * Update version in package.json
 */
function updatePackageJson(newVersion) {
  const packageJsonPath = path.join(__dirname, '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  packageJson.version = newVersion;

  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2) + '\n'
  );

  success(`Updated package.json to version ${newVersion}`);
}

/**
 * Update version in tauri.conf.json
 */
function updateTauriConf(newVersion) {
  const tauriConfPath = path.join(
    __dirname,
    '..',
    'src-tauri',
    'tauri.conf.json'
  );
  const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));

  tauriConf.version = newVersion;

  fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');

  success(`Updated tauri.conf.json to version ${newVersion}`);
}

/**
 * Update CHANGELOG.md with new version entry
 */
function updateChangelog(newVersion) {
  const changelogPath = path.join(__dirname, '..', 'CHANGELOG.md');
  const changelogContent = fs.readFileSync(changelogPath, 'utf8');

  const today = new Date().toISOString().split('T')[0];
  const newEntry = `## [${newVersion}] - ${today}\n\n### Added\n- \n\n### Changed\n- \n\n### Fixed\n- \n\n`;

  // Insert new version entry after [Unreleased] section
  const updatedContent = changelogContent.replace(
    /(## \[Unreleased\]\n\n)/,
    `$1${newEntry}`
  );

  fs.writeFileSync(changelogPath, updatedContent);

  success(`Updated CHANGELOG.md with version ${newVersion}`);
  warn('Please update the changelog with actual changes before committing.');
}

/**
 * Create git commit and tag
 */
function createGitCommitAndTag(newVersion) {
  try {
    // Check if there are uncommitted changes
    const status = execSync('git status --porcelain', { encoding: 'utf8' });

    if (status.trim()) {
      info('Creating git commit...');
      execSync('git add package.json src-tauri/tauri.conf.json CHANGELOG.md', {
        encoding: 'utf8',
      });
      execSync(`git commit -m "chore: release version ${newVersion}"`, {
        encoding: 'utf8',
      });
      success('Created git commit');
    }

    // Create and push tag
    info(`Creating git tag v${newVersion}...`);
    execSync(`git tag -a v${newVersion} -m "Release version ${newVersion}"`, {
      encoding: 'utf8',
    });
    success(`Created git tag v${newVersion}`);
  } catch (err) {
    error(`Git operation failed: ${err.message}`);
  }
}

/**
 * Push to remote repository
 */
function pushToRemote(newVersion) {
  try {
    info('Pushing to remote repository...');

    // Get current branch name
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
    }).trim();

    // Push current branch with upstream if needed
    execSync(`git push --set-upstream origin ${currentBranch}`, {
      encoding: 'utf8',
    });

    // Push tag
    execSync(`git push origin v${newVersion}`, { encoding: 'utf8' });
    success('Pushed to remote repository');
  } catch (err) {
    error(`Push failed: ${err.message}`);
  }
}

/**
 * Main function
 */
function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    log('Usage: node scripts/release.js <bump-type|version>', 'cyan');
    log('');
    log('Bump types:', 'cyan');
    log('  patch   - Increment patch version (1.0.0 -> 1.0.1)', 'cyan');
    log('  minor   - Increment minor version (1.0.0 -> 1.1.0)', 'cyan');
    log('  major   - Increment major version (1.0.0 -> 2.0.0)', 'cyan');
    log('');
    log('Specific version:', 'cyan');
    log('  1.2.3   - Set specific version', 'cyan');
    log('');
    log('Example:', 'cyan');
    log('  node scripts/release.js patch', 'cyan');
    log('  node scripts/release.js 1.2.3', 'cyan');
    process.exit(1);
  }

  const bumpType = args[0];
  const currentVersion = getCurrentVersion();
  const newVersion = getNewVersion(currentVersion, bumpType);

  log('', 'reset');
  log('═══════════════════════════════════════════════════════════', 'cyan');
  log(`  Release Management Script`, 'cyan');
  log('═══════════════════════════════════════════════════════════', 'cyan');
  log('', 'reset');
  info(`Current version: ${currentVersion}`);
  info(`New version: ${newVersion}`);
  log('', 'reset');

  // Confirm release
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question('Do you want to proceed? (y/N): ', answer => {
    rl.close();

    if (answer.toLowerCase() !== 'y') {
      warn('Release cancelled.');
      process.exit(0);
    }

    log('', 'reset');
    log('Step 1: Updating version files...', 'cyan');
    updatePackageJson(newVersion);
    updateTauriConf(newVersion);

    log('', 'reset');
    log('Step 2: Updating CHANGELOG.md...', 'cyan');
    updateChangelog(newVersion);

    log('', 'reset');
    log('Step 3: Creating git commit and tag...', 'cyan');
    createGitCommitAndTag(newVersion);

    log('', 'reset');
    log('Step 4: Pushing to remote repository...', 'cyan');
    pushToRemote(newVersion);

    log('', 'reset');
    log('═══════════════════════════════════════════════════════════', 'green');
    log(`  ✓ Release ${newVersion} created successfully!`, 'green');
    log('═══════════════════════════════════════════════════════════', 'green');
    log('', 'reset');
    info('GitHub Actions will now build and create the release.');
    info('You can monitor the progress at:');
    log(
      `  https://github.com/${process.env.GITHUB_REPOSITORY}/actions`,
      'cyan'
    );
    log('', 'reset');
  });
}

// Run main function
main();
