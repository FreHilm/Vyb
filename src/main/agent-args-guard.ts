import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Profile } from '../shared/types';

/** True when Claude Code has at least one stored conversation for `cwd`, so
 * `claude --continue` has something to resume. Conversations live in
 * ~/.claude/projects/<encoded-cwd>/<session>.jsonl, where the encoding
 * replaces every non-alphanumeric char in the absolute path with `-`
 * (e.g. C:\project\Vyb → C--project-Vyb, /Users/me/app → -Users-me-app).
 * Note: a local `.claude/` dir in the cwd is NOT evidence — that holds
 * project settings/commands and exists even with zero conversations, which
 * is exactly what produced "No conversation found to continue". The match
 * is case-insensitive because the stored folder preserves whatever drive-
 * letter / path casing was first recorded, which need not match `cwd`. */
function hasClaudeConversation(cwd: string): boolean {
  try {
    const encoded = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    const match = fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .find((e) => e.isDirectory() && e.name.toLowerCase() === encoded);
    if (!match) return false;
    return fs
      .readdirSync(path.join(projectsDir, match.name))
      .some((f) => f.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

/** Resume/continue flags expect prior session state to exist. When it
 * doesn't (e.g. a fresh worktree, brand-new repo, or no past conversation),
 * the CLI errors out and the PTY exits immediately. Strip the offending flag
 * so the agent starts a fresh session instead. */
export function applyAgentArgsGuards(profile: Profile): Profile {
  if (!profile.args || profile.args.length === 0) return profile;

  let cwd = profile.workingDirectory || os.homedir();
  if (cwd.startsWith('~')) cwd = cwd.replace(/^~/, os.homedir());

  let args = profile.args;

  // Claude Code: `claude --continue` needs a stored conversation for this cwd.
  if (profile.command === 'claude' && args.includes('--continue')) {
    if (!hasClaudeConversation(cwd)) {
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
