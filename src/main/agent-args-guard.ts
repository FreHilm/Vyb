import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Profile } from '../shared/types';

/** Resume/continue flags expect the agent's local state directory to exist
 * in the working directory. When it doesn't (e.g. a fresh worktree or a
 * brand-new repo), the CLI errors out and the PTY exits immediately. Strip
 * the offending flag so the agent starts a fresh session instead. */
export function applyAgentArgsGuards(profile: Profile): Profile {
  if (!profile.args || profile.args.length === 0) return profile;

  let cwd = profile.workingDirectory || os.homedir();
  if (cwd.startsWith('~')) cwd = cwd.replace(/^~/, os.homedir());

  let args = profile.args;

  // Claude Code: `claude --continue` requires .claude/
  if (profile.command === 'claude' && args.includes('--continue')) {
    if (!fs.existsSync(path.join(cwd, '.claude'))) {
      args = args.filter((a) => a !== '--continue');
    }
  }

  // Codex: `codex resume` requires .codex/
  if (profile.command === 'codex' && (args.includes('resume') || args.includes('--resume'))) {
    if (!fs.existsSync(path.join(cwd, '.codex'))) {
      args = args.filter((a) => a !== 'resume' && a !== '--resume');
    }
  }

  // Gemini: `gemini --resume` requires .gemini/
  if (profile.command === 'gemini' && (args.includes('resume') || args.includes('--resume'))) {
    if (!fs.existsSync(path.join(cwd, '.gemini'))) {
      args = args.filter((a) => a !== 'resume' && a !== '--resume');
    }
  }

  return args === profile.args ? profile : { ...profile, args };
}
