import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

// Modules that are externalized in vite.main.config.ts and need to be
// copied into the packaged app's node_modules so require() finds them.
const externalModules = ['node-pty', 'archiver', 'adm-zip', '@frehilm/ordna-core', '@frehilm/ordna-web'];

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
    name: 'AgentDispatch',
    icon: './build/icon',
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
