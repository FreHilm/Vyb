import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { Profile, AppSettings, DEFAULT_SETTINGS, SidebarLayout, ProfileMemoryMap } from '../shared/types';

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
    return { ...DEFAULT_SETTINGS, ...JSON.parse(content) };
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
