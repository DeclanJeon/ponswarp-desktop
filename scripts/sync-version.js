const fs = require('fs');
const path = require('path');

// Paths
const packageJsonPath = path.resolve(__dirname, '../package.json');
const tauriConfPath = path.resolve(__dirname, '../src-tauri/tauri.conf.json');
const cargoTomlPath = path.resolve(__dirname, '../src-tauri/Cargo.toml');

// Read new version from package.json (npm version already updated it)
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const newVersion = packageJson.version;

console.log(`Syncing version ${newVersion} to Tauri files...`);

// 1. Update tauri.conf.json
if (fs.existsSync(tauriConfPath)) {
  const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
  tauriConf.version = newVersion;
  fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');
  console.log(`✓ Updated tauri.conf.json`);
} else {
  console.error(`❌ tauri.conf.json not found at ${tauriConfPath}`);
  process.exit(1);
}

// 2. Update Cargo.toml
if (fs.existsSync(cargoTomlPath)) {
  let cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
  // Regex to match version = "x.y.z" at the top level (package section)
  // Assuming standard Cargo.toml format
  const versionRegex = /^version\s*=\s*".*"/m;

  if (versionRegex.test(cargoToml)) {
    cargoToml = cargoToml.replace(versionRegex, `version = "${newVersion}"`);
    fs.writeFileSync(cargoTomlPath, cargoToml);
    console.log(`✓ Updated Cargo.toml`);
  } else {
    console.warn(`⚠ Could not find version field in Cargo.toml`);
  }
} else {
  console.warn(`⚠ Cargo.toml not found at ${cargoTomlPath}`);
}

console.log(`✓ Version sync complete.`);
