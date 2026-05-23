// Root postinstall: runs after every `npm install` / `npm ci`.
//
// 1) macOS dev convenience — patch the vendored Electron.app's Info.plist so
//    the menu bar / dock show "Vyb" instead of "Electron" during `npm start`.
// 2) Copy our app icon over Electron's default icon (dev only).
// 3) Build the vendor tree at vendor/ordna-cli/ — an isolated dep graph for
//    @frehilm/ordna-cli, kept separate from the project's main node_modules
//    so Ink 5's React 18 never collides with Vyb's React 19. The packaged app
//    ships this whole tree via Forge's `extraResource`.
//
// All steps are best-effort — failures are logged but do not abort install.

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectRoot = path.join(__dirname, '..');

function patchElectronAppForDev() {
  let eBase;
  try {
    eBase = path.join(require('electron'), '../../..');
  } catch {
    return;
  }
  const plist = path.join(eBase, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist)) return;
  try {
    execSync(`/usr/libexec/PlistBuddy -c 'Set :CFBundleName Vyb' '${plist}'`);
    execSync(`/usr/libexec/PlistBuddy -c 'Set :CFBundleDisplayName Vyb' '${plist}'`);
    // TCC (macOS privacy) usage strings. Vyb runs `git status` and
    // friends from inside the user's project — which on most setups
    // lives under ~/Documents, ~/Desktop, or ~/Downloads. macOS now
    // gates folder access per-app and shows a permission prompt the
    // first time we read from those paths. Declaring the usage
    // descriptions here lets macOS show a sensible reason in the
    // prompt + lets a granted permission stick to this bundle.
    // `:Add` fails if the key already exists, so each one is in its
    // own try-block.
    const usage = [
      ['NSDocumentsFolderUsageDescription', 'Vyb reads files from your project directory to provide git status, file tree, and editor functionality.'],
      ['NSDesktopFolderUsageDescription', 'Vyb reads files from your project directory to provide git status, file tree, and editor functionality.'],
      ['NSDownloadsFolderUsageDescription', 'Vyb reads files from your project directory to provide git status, file tree, and editor functionality.'],
      ['NSRemovableVolumesUsageDescription', 'Vyb reads files from your project directory when it lives on an external volume.'],
      ['NSNetworkVolumesUsageDescription', 'Vyb reads files from your project directory when it lives on a network share.'],
    ];
    for (const [key, value] of usage) {
      try {
        execSync(`/usr/libexec/PlistBuddy -c 'Add :${key} string ${JSON.stringify(value)}' '${plist}'`);
      } catch {
        // Key exists — overwrite via Set.
        try {
          execSync(`/usr/libexec/PlistBuddy -c 'Set :${key} ${JSON.stringify(value)}' '${plist}'`);
        } catch { /* best-effort */ }
      }
    }
  } catch {
    // non-macOS or non-PlistBuddy environment — fine
  }
  const src = path.join(projectRoot, 'build', 'icon.icns');
  const dst = path.join(eBase, 'Contents', 'Resources', 'electron.icns');
  if (fs.existsSync(src)) {
    try { fs.copyFileSync(src, dst); } catch { /* best-effort */ }
  }
}

function installVendorTree(name) {
  const dir = path.join(projectRoot, 'vendor', name);
  const pkg = path.join(dir, 'package.json');
  if (!fs.existsSync(pkg)) return;

  // Skip if it's already installed and the package.json is unchanged. This
  // makes repeat `npm install`s in the project root cheap.
  const stamp = path.join(dir, 'node_modules', '.vyb-installed');
  try {
    const pkgMtime = fs.statSync(pkg).mtimeMs;
    const stampMtime = fs.statSync(stamp).mtimeMs;
    if (stampMtime >= pkgMtime) return;
  } catch {
    // missing stamp -> install
  }

  console.log(`[postinstall] installing vendor/${name}/...`);
  const result = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--silent'], {
    cwd: dir,
    stdio: 'inherit',
    env: { ...process.env, npm_config_loglevel: 'error' },
  });
  if (result.status === 0) {
    try { fs.writeFileSync(stamp, ''); } catch { /* ignore */ }
  } else {
    console.error(`[postinstall] vendor/${name} install failed (exit ${result.status})`);
  }
}

patchElectronAppForDev();
installVendorTree('ordna-cli');
