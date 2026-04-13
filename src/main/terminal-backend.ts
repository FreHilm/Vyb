/**
 * TerminalBackend — headless xterm.js instances that mirror PTY output.
 * Used for terminal state serialization (replay buffers) so that switching
 * profiles preserves the exact terminal appearance.
 *
 * Runs in the main process (xterm.js works headless in Node.js).
 */
import { Terminal } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';

interface BackendTerminal {
  terminal: Terminal;
  serializeAddon: SerializeAddon;
}

export class TerminalBackend {
  private terminals: Map<string, BackendTerminal> = new Map();

  create(profileId: string, cols: number, rows: number): void {
    if (this.terminals.has(profileId)) this.destroy(profileId);

    const terminal = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 5000,
    });
    const serializeAddon = new SerializeAddon();
    terminal.loadAddon(serializeAddon);

    this.terminals.set(profileId, { terminal, serializeAddon });
  }

  write(profileId: string, data: string): void {
    this.terminals.get(profileId)?.terminal.write(data);
  }

  resize(profileId: string, cols: number, rows: number): void {
    try {
      this.terminals.get(profileId)?.terminal.resize(cols, rows);
    } catch {
      // Terminal may not exist yet
    }
  }

  serialize(profileId: string): string | null {
    const bt = this.terminals.get(profileId);
    if (!bt) return null;
    return bt.serializeAddon.serialize();
  }

  destroy(profileId: string): void {
    const bt = this.terminals.get(profileId);
    if (bt) {
      bt.terminal.dispose();
      this.terminals.delete(profileId);
    }
  }

  destroyAll(): void {
    for (const [id] of this.terminals) this.destroy(id);
  }
}
