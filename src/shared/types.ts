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
  command: string;       // kept for backwards compat — used if agentId is missing
  args: string[];        // kept for backwards compat
  agentId?: string;      // references AgentConfig.id from settings
  statusPatterns?: StatusPatterns;
}

export interface ProfileMemory {
  shellOpen: boolean;
  shellCount: number;
}

export interface ProfileMemoryMap {
  [profileId: string]: ProfileMemory;
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
  agents: AgentConfig[];
  externalApps: ExternalApp[];
  navModifierKey: 'meta' | 'alt'; // Modifier key for quick navigation
  dictationMode: 'toggle' | 'hold'; // toggle = click start/stop, hold = hold button to dictate
  dictationLang: string; // BCP 47 language code e.g. 'en-US'
  lastActiveProfileId: string; // Restored on app launch
  gpuAcceleration: 'auto' | 'canvas' | 'off'; // Terminal rendering: auto tries WebGL, canvas skips WebGL, off disables GPU
  flameIntensity: number; // 0-100, default 50. Controls flame brightness/opacity.
  flameSpread: number; // 0-100, default 50. Controls horizontal spread of flame spikes.
  flameLength: number; // 0-100, default 50. Controls how far flames extend from edge.
  flameSpeed: number; // 0-100, default 50. Controls animation speed.
  showAgentBadge: boolean; // Show agent logo badge on profile items
}

export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
}

export const DEFAULT_AGENTS: AgentConfig[] = [
  { id: 'claude', name: 'Claude', command: 'claude', args: ['--continue'] },
  { id: 'codex', name: 'Codex', command: 'codex', args: ['resume'] },
  { id: 'gemini', name: 'Gemini', command: 'gemini', args: ['--resume'] },
];

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
  agents: [...DEFAULT_AGENTS],
  externalApps: [
    { id: 'vscode', name: 'VS Code', icon: 'vscode', command: 'open -a "Visual Studio Code" "{path}"' },
    { id: 'fork', name: 'Fork', icon: 'gitBranch', command: 'open -a Fork "{path}"' },
  ],
  navModifierKey: 'meta',
  dictationMode: 'toggle',
  dictationLang: 'en-US',
  lastActiveProfileId: '',
  gpuAcceleration: 'auto',
  flameIntensity: 50,
  flameSpread: 50,
  flameLength: 50,
  flameSpeed: 50,
  showAgentBadge: true,
};

/** Resolve the command and args for a profile, looking up the agent config if set */
export function resolveAgent(profile: Profile, agents: AgentConfig[]): { command: string; args: string[] } {
  if (profile.agentId) {
    const agent = agents.find((a) => a.id === profile.agentId);
    if (agent) return { command: agent.command, args: [...agent.args] };
  }
  // Backwards compat: use profile's own command/args
  return { command: profile.command, args: [...profile.args] };
}

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
  TERMINAL_ACK: 'terminal:ack',
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
  PROFILE_ACTIVATE_REQUEST: 'profile:activateRequest',
  GENERATE_ICON: 'icon:generate',
  LAYOUT_LOAD: 'layout:load',
  LAYOUT_SAVE: 'layout:save',
  README_LOAD: 'readme:load',
  GIT_STATUS: 'git:status',
  GIT_FETCH: 'git:fetch',
  FILE_LIST_DIR: 'file:listDir',
  FILE_READ: 'file:read',
  FILE_SAVE: 'file:save',
  FILE_DELETE: 'file:delete',
  FILE_RENAME: 'file:rename',
  FILE_COPY: 'file:copy',
  FILE_CREATE_DIR: 'file:createDir',
  FILE_CREATE: 'file:create',
  FILE_SAVE_AS: 'file:saveAs',
  BACKUP_EXPORT: 'backup:export',
  BACKUP_IMPORT: 'backup:import',
  TRANSCRIBE_AUDIO: 'audio:transcribe',
  PROFILE_MEMORY_LOAD: 'profileMemory:load',
  PROFILE_MEMORY_SAVE: 'profileMemory:save',
  SCROLLBACK_LOAD: 'scrollback:load',
  SCROLLBACK_SAVE: 'scrollback:save',
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
