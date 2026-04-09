export type AgentStatus = 'ready' | 'working' | 'needs-input' | 'offline';

export interface StatusPatterns {
  ready: string[];
  needsInput: string[];
}

export interface Profile {
  id: string;
  name: string;
  icon: string;
  workingDirectory: string;
  command: string;
  args: string[];
  statusPatterns?: StatusPatterns;
}

export interface AppSettings {
  baseHue: number; // 0-360, default 240 (purple), 360 = grayscale
  darkness: number; // 0-100, default 0. Scales lightness down toward black.
  profileFontSize: number; // 10-20, default 13
  agentFontSize: number; // 10-24, default 14
  shellFontSize: number; // 10-24, default 14
  geminiApiKey: string; // Google Gemini API key for icon generation
  iconPromptPrefix: string; // Universe/style description for generated icons
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseHue: 240,
  darkness: 0,
  profileFontSize: 13,
  agentFontSize: 14,
  shellFontSize: 14,
  geminiApiKey: '',
  iconPromptPrefix: 'A minimal, modern flat icon with a dark background, clean geometric shapes, suitable as a project avatar',
};

export interface SidebarFolder {
  id: string;
  name: string;
  isOpen: boolean;
  profileIds: string[];
}

export type SidebarItem =
  | { type: 'profile'; profileId: string }
  | { type: 'folder'; folderId: string };

export interface SidebarLayout {
  items: SidebarItem[];
  folders: SidebarFolder[];
}

export const IPC_CHANNELS = {
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_DESTROY: 'terminal:destroy',
  TERMINAL_DATA: 'terminal:data',
  SHELL_TERMINAL_CREATE: 'shell-terminal:create',
  SHELL_TERMINAL_EXITED: 'shell-terminal:exited',
  PROFILES_LOAD: 'profiles:load',
  PROFILES_SAVE: 'profiles:save',
  PROFILE_STATUS_CHANGE: 'profile:status-change',
  SHELL_SHOW_IN_FOLDER: 'shell:showInFolder',
  SHELL_OPEN_VSCODE: 'shell:openVSCode',
  DIALOG_SELECT_DIRECTORY: 'dialog:selectDirectory',
  DIALOG_SELECT_FILE: 'dialog:selectFile',
  SETTINGS_LOAD: 'settings:load',
  SETTINGS_SAVE: 'settings:save',
  SETTINGS_OPEN_DIALOG: 'settings:openDialog',
  PROFILE_SET_ACTIVE: 'profile:setActive',
  GENERATE_ICON: 'icon:generate',
  LAYOUT_LOAD: 'layout:load',
  LAYOUT_SAVE: 'layout:save',
} as const;
