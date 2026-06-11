import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerAppX } from '@electron-forge/maker-appx';
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

// macOS signing + notarization only run when all four env vars are
// present. APPLE_SIGNING_IDENTITY is required — without it
// electron-osx-sign silently falls back to ad-hoc, the binaries
// upload to notarytool unsigned, and notarization rejects the whole
// bundle. Better to skip signing entirely than to ship an
// ad-hoc-signed app that fails notarization.
const macSigningEnabled =
  !!process.env.APPLE_ID &&
  !!process.env.APPLE_PASSWORD &&
  !!process.env.APPLE_TEAM_ID &&
  !!process.env.APPLE_SIGNING_IDENTITY;

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
    // The product name (capitalized) controls the .app bundle name on
    // macOS and the installer's display name on Windows/Linux. The
    // executable inside MUST be lowercase for the Linux makers
    // (electron-installer-debian / -redhat compute the binary path
    // from package.json `name` which is "vyb"). Without this, the .deb
    // / .rpm makers fail with "could not find the Electron app binary
    // at .../vyb" because the actual binary is named Vyb.
    executableName: 'vyb',
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
          // Explicit keychain path so codesign uses the temp keychain
          // we imported the cert into, not the runner's default
          // login.keychain. Without this, codesign may not find the
          // cert + private key reliably even though `security
          // find-identity` lists them.
          keychain: process.env.MAC_KEYCHAIN_PATH,
          // Per-file options use the v2 @electron/osx-sign API
          // (camelCase, no `entitlements-inherit` — v2 uses the same
          // entitlements for the bundle and inherited helpers).
          optionsForFile: () => ({
            hardenedRuntime: true,
            entitlements: 'build/entitlements.mac.plist',
            signatureFlags: ['library'],
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
    new MakerSquirrel({
      // Icon for Setup.exe itself.
      setupIcon: './build/icon.ico',
      // Icon Windows shows in Add/Remove Programs — must be a remote URL
      // (Squirrel quirk). Without it, this DEFAULTS TO THE ATOM ICON.
      iconUrl: 'https://raw.githubusercontent.com/FreHilm/Vyb/main/build/icon.ico',
    }),
    new MakerZIP({}, ['darwin']),
    // DMG is a nicer macOS installer than just a zip — produces the
    // standard "drag to Applications" window.
    new MakerDMG({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
    // MSIX/AppX for the Microsoft Store. Only included when BUILD_MSIX=1 so
    // it stays OUT of the normal `npm run publish` (which would otherwise
    // try to build it on every platform and upload it to the GitHub
    // release). Built on Windows only (the maker no-ops elsewhere) by the
    // dedicated msix.yml workflow, which generates a self-signed cert whose
    // publisher matches the Partner Center identity below — the Store
    // re-signs on submission, so this cert is throwaway.
    //
    // Identity values come straight from Partner Center → Product identity
    // and MUST match exactly or the Store rejects the upload.
    ...(process.env.BUILD_MSIX === '1'
      ? [
          new MakerAppX({
            packageName: 'FreHilm.Vyb',
            packageDisplayName: 'Vyb',
            packageDescription: 'Manage multiple AI agent terminal sessions in one place',
            publisher: 'CN=2980D3E3-168B-4604-9E12-2A29E0B67F92',
            // Not in the typed config but passed through to
            // electron-windows-store and written into the manifest's
            // <Properties><PublisherDisplayName>.
            publisherDisplayName: 'FreHilm',
            // IMPORTANT: the files in build/appx MUST be named
            // SampleAppx.44x44 / .50x50 / .150x150 / .310x150 — those exact
            // names are hardcoded in electron-windows-store's manifest
            // template. Differently-named files are packaged but never
            // referenced, so the tiles fall back to the tool's default
            // sample images — which fails Store certification ("tile icons
            // include a default image", rejected 2026-06-11).
            assets: 'build/appx',
            makeVersionWinStoreCompatible: true,
            // Throwaway self-signed cert (publisher must match the CN above).
            // The msix.yml workflow generates it and sets these env vars.
            devCert: process.env.APPX_DEV_CERT,
            certPass: process.env.APPX_CERT_PASS,
          } as ConstructorParameters<typeof MakerAppX>[0]),
        ]
      : []),
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
