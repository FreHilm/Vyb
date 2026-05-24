import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { PublisherGithub } from '@electron-forge/publisher-github';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

// macOS signing + notarization only run when the env vars are present
// (i.e. inside CI or when explicitly exported locally). Lets
// `npm run make` continue to produce unsigned local builds during
// development without failing the signer.
const macSigningEnabled =
  !!process.env.APPLE_ID &&
  !!process.env.APPLE_PASSWORD &&
  !!process.env.APPLE_TEAM_ID;

// Modules that are externalized in vite.main.config.ts and need to be
// copied into the packaged app's node_modules so require() finds them.
const externalModules = ['node-pty', 'archiver', 'adm-zip', '@frehilm/ordna-core', '@frehilm/ordna-web', 'electron-updater', 'electron-log'];

function copyModuleWithDeps(moduleName: string, srcBase: string, destBase: string) {
  const srcDir = path.join(srcBase, 'node_modules', moduleName);
  const destDir = path.join(destBase, 'node_modules', moduleName);
  if (!fs.existsSync(srcDir)) return;
  if (fs.existsSync(destDir)) return;

  fs.cpSync(srcDir, destDir, { recursive: true });

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf-8'));
    for (const dep of Object.keys(pkg.dependencies || {})) {
      copyModuleWithDeps(dep, srcBase, destBase);
    }
  } catch {
    // ignore
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      unpack: '**/node_modules/node-pty/**/{*.node,spawn-helper}',
    },
    name: 'Vyb',
    icon: './build/icon',
    // Ship vendor/ alongside the asar (at <app>/Contents/Resources/vendor/).
    // Holds the isolated @frehilm/ordna-cli dep tree (Ink + React 18) that
    // can't live inside the main asar without colliding with the app's
    // React 19. Resolved at runtime via process.resourcesPath.
    extraResource: ['./vendor'],
    // macOS TCC (privacy) usage strings. macOS gates folder access
    // per-app; the first time `git status` (or any file read) hits
    // ~/Documents, ~/Desktop, ~/Downloads, the OS prompts. Without
    // these strings the prompt shows generic text and the grant
    // doesn't always stick. With them macOS knows we have a
    // legitimate reason and the user's choice persists for the
    // signed bundle. Mirror in scripts/postinstall.js so dev mode
    // gets the same treatment.
    extendInfo: {
      NSDocumentsFolderUsageDescription: 'Vyb reads files from your project directory to provide git status, file tree, and editor functionality.',
      NSDesktopFolderUsageDescription: 'Vyb reads files from your project directory to provide git status, file tree, and editor functionality.',
      NSDownloadsFolderUsageDescription: 'Vyb reads files from your project directory to provide git status, file tree, and editor functionality.',
      NSRemovableVolumesUsageDescription: 'Vyb reads files from your project directory when it lives on an external volume.',
      NSNetworkVolumesUsageDescription: 'Vyb reads files from your project directory when it lives on a network share.',
    },
    // macOS code signing + notarization. Skipped entirely unless the
    // APPLE_* env vars are set so local `npm start` / `npm run make`
    // remain unsigned (and fast). In CI the GitHub Actions workflow
    // injects these from secrets before invoking `npm run publish`.
    ...(macSigningEnabled
      ? {
        osxSign: {
          identity: process.env.APPLE_SIGNING_IDENTITY,
          optionsForFile: () => ({
            // Hardened runtime is required for notarization. The
            // entitlements file relaxes a few sandbox restrictions
            // that node-pty / child agent CLIs need.
            hardenedRuntime: true,
            entitlements: 'build/entitlements.mac.plist',
            'entitlements-inherit': 'build/entitlements.mac.plist',
            'signature-flags': 'library',
          }),
        },
        osxNotarize: {
          appleId: process.env.APPLE_ID!,
          appleIdPassword: process.env.APPLE_PASSWORD!,
          teamId: process.env.APPLE_TEAM_ID!,
        },
      }
      : {}),
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    // DMG is a nicer macOS installer than just a zip — produces the
    // standard "drag to Applications" window.
    new MakerDMG({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  publishers: [
    new PublisherGithub({
      repository: {
        owner: 'FreHilm',
        name: 'vyb',
      },
      // Drafts the release on first upload so we can review/edit the
      // notes before flipping it to published. Existing drafts are
      // reused across the three platform jobs so all artifacts land
      // on the same release.
      draft: true,
      // Pre-releases (e.g. v1.2.0-beta.3) are surfaced separately on
      // GitHub. Off here so v1.2.0 tags publish as stable; flip per
      // tag from the GitHub UI if needed.
      prerelease: false,
    }),
  ],
  hooks: {
    packageAfterCopy: async (_config, buildPath) => {
      // Rebuild node-pty against Electron's headers
      const projectRoot = process.cwd();
      try {
        execSync('npx electron-rebuild -f -w node-pty', {
          cwd: projectRoot,
          stdio: 'inherit',
        });
      } catch (e) {
        console.error('electron-rebuild failed:', e);
      }

      // Copy externalized modules into the packaged app
      for (const mod of externalModules) {
        copyModuleWithDeps(mod, projectRoot, buildPath);
      }
    },
  },
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // Status-detection worker thread (regex/ANSI-strip work moved off the
          // Electron main thread). Output: .vite/build/status-worker.js.
          entry: 'src/main/status-worker.ts',
          config: 'vite.worker.config.ts',
          target: 'main',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // FusesPlugin intentionally omitted — its Hardened Runtime restrictions
    // prevent child CLI tools (like claude) from running in the packaged app.
  ],
};

export default config;
