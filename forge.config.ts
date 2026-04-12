import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import * as path from 'path';
import * as fs from 'fs';

// Modules that are externalized in vite.main.config.ts and need to be
// copied into the packaged app's node_modules so require() finds them.
const externalModules = ['node-pty', '@slack/web-api', 'archiver', 'adm-zip'];

function copyModuleWithDeps(moduleName: string, srcBase: string, destBase: string) {
  const srcDir = path.join(srcBase, 'node_modules', moduleName);
  const destDir = path.join(destBase, 'node_modules', moduleName);
  if (!fs.existsSync(srcDir)) return;
  if (fs.existsSync(destDir)) return; // already copied

  fs.cpSync(srcDir, destDir, { recursive: true });

  // Also copy this module's production dependencies
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
      unpack: '**/node_modules/{node-pty,@slack}/**/*.node',
    },
    name: 'AgentDispatch',
    icon: './build/icon',
    extraResource: [],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  hooks: {
    packageAfterCopy: async (_config, buildPath) => {
      // Copy externalized modules into the packaged app so require() can find them
      const projectRoot = process.cwd();
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
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: false,
    }),
  ],
};

export default config;
