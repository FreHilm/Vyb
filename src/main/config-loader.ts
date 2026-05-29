import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { Profile, AppSettings, DEFAULT_SETTINGS, DEFAULT_AGENTS, SidebarLayout, ProfileMemoryMap } from '../shared/types';

export function loadProfiles(): Profile[] {
  const userDataPath = app.getPath('userData');
  const configPath = path.join(userDataPath, 'profiles.json');

  if (!fs.existsSync(configPath)) {
    const examplePath = path.join(app.getAppPath(), 'profiles.example.json');
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, configPath);
    } else {
      const defaultProfiles: Profile[] = [
        {
          id: 'claude-default',
          name: 'Claude Code',
          icon: '',
          workingDirectory: app.getPath('home'),
          command: 'claude',
          args: [],
        },
      ];
      fs.writeFileSync(configPath, JSON.stringify(defaultProfiles, null, 2));
      return defaultProfiles;
    }
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const profiles = JSON.parse(content) as Profile[];
    // Resolve ~ in workingDirectory
    return profiles.map((p) => ({
      ...p,
      workingDirectory: p.workingDirectory.replace(/^~/, app.getPath('home')),
    }));
  } catch (error) {
    console.error('Failed to load profiles:', error);
    return [];
  }
}

export function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'profiles.json');
}

export function saveProfiles(profiles: Profile[]): void {
  const configPath = getConfigPath();
  // Store with ~ for home dir to keep the file portable
  const home = app.getPath('home');
  const toSave = profiles.map((p) => ({
    ...p,
    workingDirectory: p.workingDirectory.startsWith(home)
      ? p.workingDirectory.replace(home, '~')
      : p.workingDirectory,
  }));
  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2));
}

export function loadSettings(): AppSettings {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const content = fs.readFileSync(settingsPath, 'utf-8');
    const merged: AppSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(content) };
    // Soft-migrate: fill in default permissionModeArgs for built-in agent ids
    // that pre-date this field, so existing users get the defaults.
    if (Array.isArray(merged.agents)) {
      const defaultsById = new Map(DEFAULT_AGENTS.map((a) => [a.id, a]));
      merged.agents = merged.agents.map((a) => {
        if (a.permissionModeArgs !== undefined) return a;
        const def = defaultsById.get(a.id);
        if (!def) return a;
        return { ...a, permissionModeArgs: [...(def.permissionModeArgs ?? [])] };
      });
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

export function loadLayout(): SidebarLayout {
  const layoutPath = path.join(app.getPath('userData'), 'layout.json');
  if (!fs.existsSync(layoutPath)) {
    return { items: [], folders: [] };
  }
  try {
    const content = fs.readFileSync(layoutPath, 'utf-8');
    return JSON.parse(content) as SidebarLayout;
  } catch {
    return { items: [], folders: [] };
  }
}

export function saveLayout(layout: SidebarLayout): void {
  const layoutPath = path.join(app.getPath('userData'), 'layout.json');
  fs.writeFileSync(layoutPath, JSON.stringify(layout, null, 2));
}

export function loadProfileMemory(): ProfileMemoryMap {
  const memPath = path.join(app.getPath('userData'), 'profile-memory.json');
  if (!fs.existsSync(memPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(memPath, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveProfileMemory(memory: ProfileMemoryMap): void {
  const memPath = path.join(app.getPath('userData'), 'profile-memory.json');
  fs.writeFileSync(memPath, JSON.stringify(memory, null, 2));
}

const MAX_SCROLLBACK_SIZE = 512 * 1024; // 512KB cap per profile

// Shell terminal ids are `shell:<profileId>:<n>` — the colons are reserved
// on Windows (NTFS alternate-data-stream marker) and writeFileSync fails
// with ENOENT. Map every Windows-reserved character to `_` so the same
// scrollback works across platforms. Backslash, slash, etc. included so
// profile ids with paths in them can't escape the scrollback dir either.
function scrollbackFilename(profileId: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = profileId.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  return `${safe}.log`;
}

export function loadScrollback(profileId: string): string | null {
  const dir = path.join(app.getPath('userData'), 'scrollback');
  const filePath = path.join(dir, scrollbackFilename(profileId));
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export function saveScrollback(profileId: string, data: string): void {
  const dir = path.join(app.getPath('userData'), 'scrollback');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Strip ANSI codes to count meaningful content
  const stripped = data
    .replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/\r/g, '');

  // Count non-empty lines
  const meaningfulLines = stripped.split('\n').filter((l) => l.trim().length > 0);
  if (meaningfulLines.length < 10) return;

  // Strip screen-clearing and cursor-positioning escape sequences
  // that would mess up replay, but keep colors and text formatting
  let cleaned = data
    .replace(/\x1B\[2J/g, '')        // clear screen
    .replace(/\x1B\[H/g, '')         // cursor home
    .replace(/\x1B\[\d+;\d+H/g, '')  // cursor position
    .replace(/\x1B\[J/g, '')         // clear to end of screen
    .replace(/\x1B\[\?25[hl]/g, '')  // show/hide cursor
    .replace(/\x1B\[\?1049[hl]/g, '') // alternate screen buffer
    .replace(/\x1B\[\?1047[hl]/g, '') // alternate screen buffer
    .replace(/\x1B\[s/g, '')         // save cursor
    .replace(/\x1B\[u/g, '')         // restore cursor
    .replace(/\x1B\[\d+A/g, '')      // cursor up
    .replace(/\x1B\[\d+B/g, '')      // cursor down
    .replace(/\x1B\[\d+C/g, '')      // cursor forward
    .replace(/\x1B\[\d+D/g, '');     // cursor back

  // Cap size — keep the tail
  if (cleaned.length > MAX_SCROLLBACK_SIZE) {
    cleaned = cleaned.slice(-MAX_SCROLLBACK_SIZE);
  }
  // Guarded: a single failed scrollback write (permission denied, disk full,
  // path too long, character we forgot to sanitize) shouldn't take down the
  // whole main process. This runs from a PTY-exit event listener, so an
  // unhandled throw surfaces as an "Uncaught Exception" dialog at app quit.
  try {
    fs.writeFileSync(path.join(dir, scrollbackFilename(profileId)), cleaned);
  } catch (err) {
    console.warn(`[scrollback] failed to save ${profileId}:`, (err as Error).message);
  }
}
