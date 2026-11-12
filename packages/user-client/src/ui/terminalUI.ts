// src/ui/terminalUI.ts

import * as readline from 'readline';
import { formatHHMM } from '../utils/time';

export class TerminalUI {
  private rl: readline.Interface | null = null;

  constructor(
    private readonly username: string,
    private readonly onClose?: () => void
  ) {}

  startInputLoop(onLine: (text: string) => void): void {
    if (this.rl) return;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    this.rl.setPrompt(`${this.username}> `);
    this.rl.prompt();

    this.rl.on('line', (line) => {
      const text = line.trim();

      // Setelah Enter, kursor readline sudah berada di baris baru; hapus baris
      // input yang baru disubmit agar tidak tampil ganda dengan versi ber-timestamp.
      this.eraseSubmittedLine();

      if (text.length > 0) {
        onLine(text);
      } else {
        this.refreshPrompt();
      }
    });

    this.rl.on('close', () => {
      this.rl = null;
      this.onClose?.();
    });
  }

  printChat(from: string, timestamp: number, text: string): void {
    this.printLine(`[${formatHHMM(timestamp)}] ${from}: ${text}`);
  }

  printSystem(text: string): void {
    this.printLine(`[SYSTEM] ${text}`);
  }

  close(): Promise<void> {
    if (!this.rl) return Promise.resolve();

    const rl = this.rl;
    return new Promise((resolve) => {
      rl.once('close', () => resolve());
      rl.close();
    });
  }

  /** Hapus baris input yang baru disubmit: naik satu baris lalu bersihkan. */
  private eraseSubmittedLine(): void {
    if (!process.stdout.isTTY) return;

    readline.moveCursor(process.stdout, 0, -1);
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }

  /** Render ulang prompt; preserveInput=true menjaga ketikan yang sedang berjalan. */
  private refreshPrompt(preserveInput = false): void {
    if (!this.rl) return;

    this.rl.setPrompt(`${this.username}> `);
    this.rl.prompt(preserveInput);
  }

  private printLine(line: string): void {
    if (!this.rl) {
      console.log(line);
      return;
    }

    if (process.stdout.isTTY) {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
    }

    console.log(line);

    this.refreshPrompt(true);
  }
}
