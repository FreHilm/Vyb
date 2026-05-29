import { spawn } from 'child_process';
import * as path from 'path';

// ConPTY on current Windows builds does not reliably deliver the byte `\x03`
// written into the PTY input as a real CTRL_C_EVENT to processes attached to
// the pseudo-console. Node-based children (npm, the agent CLIs) survive
// because libuv installs its own console-ctrl handler that reacts to the
// byte, but python.exe (and other apps that only listen for the OS-level
// console signal) just keep running. To match macOS/Linux behavior — where
// the PTY's line discipline turns `\x03` into SIGINT for the foreground
// process group — we fire-and-forget a detached PowerShell helper that
// AttachConsole's the target PTY's hidden conhost and calls
// GenerateConsoleCtrlEvent on it.
//
// Even after the event is delivered, Python scripts blocked in a C-level
// syscall (socket.accept, blocking I/O) can't run their signal handler until
// the syscall returns — so we escalate: a second Ctrl+C within ESCALATION_MS
// taskkill's the descendant tree of the PTY shell. The shell itself is
// deliberately spared: if enumeration returns no descendants (because the
// foreground process already died on a previous press, or the user is
// continuing to mash Ctrl+C after a successful kill), we no-op rather than
// nuke the PTY. Escalation state is reset after every force-kill attempt so
// the next press goes back to gentle CTRL_C_EVENT instead of compounding.
//
// Reference: microsoft/terminal#19030, microsoft/vscode#71793, microsoft/node-pty#454.

const THROTTLE_MS = 350;         // ignore keyboard auto-repeat
const ESCALATION_MS = 5000;      // gap beyond this resets the series
const ENUM_TIMEOUT_MS = 4000;

type Level = 0 | 1;

interface State {
  lastSent: number;
  level: Level;
}
const states = new Map<number, State>();

// Resolve full path to system32 utilities — detached helpers don't inherit
// the user's PATH reliably and a bare "taskkill" can fail with ENOENT.
const SYSTEM32 = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32')
  : 'C:\\Windows\\System32';
const POWERSHELL = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const TASKKILL = path.join(SYSTEM32, 'taskkill.exe');

function buildCtrlEventScript(targetPid: number): string {
  // Single-quoted PowerShell here-string keeps the C# verbatim, then
  // GenerateConsoleCtrlEvent(0, 0) sends CTRL_C_EVENT to the entire
  // process group attached to the pseudo-console — same as physically
  // pressing Ctrl+C in a real Windows console.
  return [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `Add-Type -Namespace Vyb -Name Ctrl -MemberDefinition @'`,
    `[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();`,
    `[DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint dwProcessId);`,
    `[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(System.IntPtr HandlerRoutine, bool Add);`,
    `[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);`,
    `'@`,
    `[Vyb.Ctrl]::FreeConsole() | Out-Null`,
    `if ([Vyb.Ctrl]::AttachConsole(${targetPid})) {`,
    `  [Vyb.Ctrl]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $true) | Out-Null`,
    `  [Vyb.Ctrl]::GenerateConsoleCtrlEvent(0, 0) | Out-Null`,
    `  Start-Sleep -Milliseconds 50`,
    `}`,
  ].join('\n');
}

function spawnCtrlEventHelper(targetPid: number): void {
  // -EncodedCommand expects UTF-16LE base64 — sidesteps every cmd.exe / PS
  // command-line quoting gotcha (newlines, embedded quotes, here-strings).
  const encoded = Buffer.from(buildCtrlEventScript(targetPid), 'utf16le').toString('base64');
  try {
    const child = spawn(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { detached: true, windowsHide: true, stdio: 'ignore' },
    );
    child.on('error', (err) => {
      console.warn('[ctrlc] CTRL_C helper spawn error:', err.message);
    });
    child.unref();
  } catch (err) {
    console.warn('[ctrlc] CTRL_C helper spawn threw:', err);
  }
}

interface ProcRow {
  pid: number;
  ppid: number;
  name: string;
}

function enumerateProcesses(): Promise<ProcRow[]> {
  // Single PowerShell invocation that dumps every process as
  // "pid,ppid,name" — parsed in Node so we can log it and BFS the tree
  // without any further PowerShell calls. Bounded by ENUM_TIMEOUT_MS so a
  // wedged WMI repository can't hang the kill path forever.
  return new Promise((resolve, reject) => {
    const script =
      `Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name | ` +
      `ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.Name)" }`;
    let out = '';
    let err = '';
    let settled = false;
    const child = spawn(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true },
    );
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* already dead */ }
      reject(new Error(`process enumeration timed out after ${ENUM_TIMEOUT_MS}ms`));
    }, ENUM_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`PowerShell exit ${code}: ${err.trim()}`));
        return;
      }
      const rows: ProcRow[] = [];
      for (const line of out.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const idx1 = trimmed.indexOf(',');
        const idx2 = trimmed.indexOf(',', idx1 + 1);
        if (idx1 < 0 || idx2 < 0) continue;
        const pid = parseInt(trimmed.slice(0, idx1), 10);
        const ppid = parseInt(trimmed.slice(idx1 + 1, idx2), 10);
        const name = trimmed.slice(idx2 + 1);
        if (!isFinite(pid) || !isFinite(ppid)) continue;
        rows.push({ pid, ppid, name });
      }
      resolve(rows);
    });
  });
}

function descendantsOf(rootPid: number, rows: ProcRow[]): ProcRow[] {
  const byParent = new Map<number, ProcRow[]>();
  for (const r of rows) {
    let arr = byParent.get(r.ppid);
    if (!arr) { arr = []; byParent.set(r.ppid, arr); }
    arr.push(r);
  }
  const out: ProcRow[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = byParent.get(current) || [];
    for (const c of children) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      out.push(c);
      queue.push(c.pid);
    }
  }
  return out;
}

function killOne(pid: number, name?: string): void {
  try {
    const child = spawn(TASKKILL, ['/F', '/PID', String(pid)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      const label = name ? `${pid} (${name})` : String(pid);
      if (code === 0) {
        console.info(`[ctrlc]   killed ${label}`);
      } else {
        console.warn(`[ctrlc]   taskkill ${label} exit=${code} ${stderr.trim()}`);
      }
    });
    child.on('error', (e) => console.warn(`[ctrlc]   taskkill ${pid} spawn error:`, e.message));
  } catch (err) {
    console.warn(`[ctrlc]   taskkill ${pid} threw:`, err);
  }
}

async function forceKillDescendants(rootPid: number): Promise<void> {
  try {
    const rows = await enumerateProcesses();
    const self = rows.find((r) => r.pid === rootPid);
    console.info(`[ctrlc] target pid=${rootPid} name=${self?.name ?? '?'} ppid=${self?.ppid ?? '?'} (scanned ${rows.length} processes)`);
    const descendants = descendantsOf(rootPid, rows);
    if (descendants.length === 0) {
      // Likely the foreground process already died on a previous press and
      // the user is continuing to mash Ctrl+C. Deliberately do nothing —
      // killing the shell here is the bug the previous version had.
      console.info(`[ctrlc] no descendants of ${rootPid} — shell left alive`);
    } else {
      console.info(`[ctrlc] killing ${descendants.length} descendant(s) of ${rootPid}:`);
      for (const d of descendants) {
        console.info(`[ctrlc]   ${d.pid} ${d.name} (ppid=${d.ppid})`);
        killOne(d.pid, d.name);
      }
    }
  } catch (err) {
    console.warn('[ctrlc] process enumeration failed:', (err as Error).message);
  } finally {
    // Reset escalation regardless of outcome so the next press starts
    // fresh at level 0 (CTRL_C_EVENT) rather than re-firing the kill path.
    // Continued mashing then bounces harmlessly off an idle shell.
    states.delete(rootPid);
  }
}

export function sendCtrlCToPty(targetPid: number | undefined): void {
  if (process.platform !== 'win32') return;
  if (!targetPid || targetPid <= 0) {
    console.warn('[ctrlc] no pid for active PTY — skipping helper');
    return;
  }

  const now = Date.now();
  const prev = states.get(targetPid);
  const gap = prev ? now - prev.lastSent : Infinity;
  if (gap < THROTTLE_MS) return;

  // First press OR press after the escalation window expired → gentle.
  // Quick second press → forceful taskkill of the shell's descendants.
  let level: Level;
  if (!prev || gap > ESCALATION_MS) {
    level = 0;
  } else {
    level = 1;
  }
  states.set(targetPid, { lastSent: now, level });

  if (level === 0) {
    console.info(`[ctrlc] CTRL_C_EVENT -> pid=${targetPid}`);
    spawnCtrlEventHelper(targetPid);
  } else {
    console.info(`[ctrlc] force-kill descendants -> pid=${targetPid}`);
    forceKillDescendants(targetPid).catch((err) => {
      console.warn('[ctrlc] force-kill failed:', err);
    });
  }
}

export function clearCtrlCState(targetPid: number | undefined): void {
  if (targetPid) states.delete(targetPid);
}
