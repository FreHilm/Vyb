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
  slackChannel?: string; // Slack channel ID or name for this profile
}

export interface AppSettings {
  baseHue: number; // 0-360, default 240 (purple), 360 = grayscale
  darkness: number; // 0-100, default 0. Scales lightness down toward black.
  textLightness: number; // 0-100, default 50. Controls UI text brightness.
  profileFontSize: number; // 10-20, default 13
  agentFontSize: number; // 10-24, default 14
  shellFontSize: number; // 10-24, default 14
  iconProvider: 'gemini' | 'openai'; // Which AI to use for icon generation
  geminiModel: string; // Gemini model for image generation
  geminiApiKey: string; // Google Gemini API key
  openaiModel: string; // OpenAI model for image generation
  openaiApiKey: string; // OpenAI API key
  iconPromptPrefix: string; // Universe/style description for generated icons
  iconReferenceImage: string; // Path to reference image for style consistency
  sidebarWidth: number; // pixels, default 250
  terminalSplitPercent: number; // agent pane %, default 67
  externalApps: ExternalApp[];
  slackEnabled: boolean;
  slackBotToken: string; // xoxb-...
}

export interface ExternalApp {
  id: string;
  name: string;
  icon: string; // icon key from APP_ICONS (e.g. 'code', 'gitBranch')
  command: string; // e.g. 'open -a "Visual Studio Code" "{path}"' — use {path} as placeholder
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseHue: 240,
  darkness: 0,
  textLightness: 12,
  profileFontSize: 13,
  agentFontSize: 14,
  shellFontSize: 14,
  iconProvider: 'gemini',
  geminiModel: 'gemini-3.1-flash-image-preview',
  geminiApiKey: '',
  openaiModel: 'gpt-image-1',
  openaiApiKey: '',
  iconPromptPrefix: 'A minimal, modern flat icon with a dark background, clean geometric shapes, suitable as a project avatar',
  iconReferenceImage: '',
  sidebarWidth: 250,
  terminalSplitPercent: 67,
  externalApps: [
    { id: 'vscode', name: 'VS Code', icon: 'vscode', command: 'open -a "Visual Studio Code" "{path}"' },
    { id: 'fork', name: 'Fork', icon: 'gitBranch', command: 'open -a Fork "{path}"' },
  ],
  slackEnabled: false,
  slackBotToken: '',
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
  SHELL_OPEN_FORK: 'shell:openFork',
  SHELL_OPEN_EXTERNAL: 'shell:openExternal',
  SHELL_OPEN_URL: 'shell:openUrl',
  DIALOG_SELECT_DIRECTORY: 'dialog:selectDirectory',
  DIALOG_SELECT_FILE: 'dialog:selectFile',
  SETTINGS_LOAD: 'settings:load',
  SETTINGS_SAVE: 'settings:save',
  SETTINGS_OPEN_DIALOG: 'settings:openDialog',
  PROFILE_SET_ACTIVE: 'profile:setActive',
  GENERATE_ICON: 'icon:generate',
  LAYOUT_LOAD: 'layout:load',
  LAYOUT_SAVE: 'layout:save',
  README_LOAD: 'readme:load',
  GIT_STATUS: 'git:status',
  FILE_LIST_DIR: 'file:listDir',
  FILE_READ: 'file:read',
  FILE_SAVE: 'file:save',
  BACKUP_EXPORT: 'backup:export',
  BACKUP_IMPORT: 'backup:import',
} as const;

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface GitStatus {
  isGit: boolean;
  branch: string;
  modified: number;
  staged: number;
  untracked: number;
  ahead: number;
  behind: number;
  stashes: number;
  lastCommit: string;
  remoteUrl: string; // HTTPS URL to the repo (GitHub, GitLab, etc.)
}
