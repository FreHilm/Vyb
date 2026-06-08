// electron-updater wiring. On macOS this only works against
// SIGNED + NOTARIZED builds; an unsigned dev build will silently no-op
// (autoUpdater throws on the first check, which we swallow).
//
// Behaviour:
// - On app start (production only), check GitHub Releases for newer versions.
// - Download in the background.
// - When ready, prompt the user via a dialog. If they accept, the app
//   relaunches and installs the update.

import { app, dialog } from 'electron';
import log from 'electron-log';
import { autoUpdater } from 'electron-updater';

let started = false;

export function startAutoUpdater(): void {
  if (started) return;
  started = true;

  // Skip in dev — there's no signed bundle to update from and
  // electron-updater throws on missing app-update.yml.
  if (!app.isPackaged) return;

  // Skip when running as a Microsoft Store / MSIX package — the Store
  // owns updates, and self-updating an MSIX is forbidden (it would fail
  // and violates Store policy). `process.windowsStore` is true only for
  // the packaged AppX/MSIX build.
  if (process.windowsStore) return;

  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', async (info) => {
    const result = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Vyb ${info.version} has been downloaded.`,
      detail: 'Restart Vyb to install the update. Your open profiles will be restored.',
    });
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.warn('[updater]', err.message);
  });

  // First check on app start; subsequent ones every 4 hours so a
  // long-running session eventually picks up new releases.
  autoUpdater.checkForUpdatesAndNotify().catch((): void => undefined);
  setInterval((): void => {
    autoUpdater.checkForUpdatesAndNotify().catch((): void => undefined);
  }, 4 * 60 * 60 * 1000);
}
