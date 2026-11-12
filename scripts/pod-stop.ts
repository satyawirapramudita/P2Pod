// scripts/pod-stop.ts
// Hentikan CSS Pod lokal yang dijalankan otomatis oleh user-client (via file .css/<name>-css.pid).

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const cssRoot = path.join(process.cwd(), '.css');

function parseName(argv: string[]): string | undefined {
  const idx = argv.indexOf('--name');
  return idx >= 0 ? argv[idx + 1] : undefined;
}

function main(): void {
  const name = parseName(process.argv);

  if (!fs.existsSync(cssRoot)) {
    console.log('Tidak ada folder .css — tidak ada Pod lokal yang dikelola.');
    return;
  }

  const pidFiles = fs.readdirSync(cssRoot).filter((file) => file.endsWith('-css.pid'));
  const targets = pidFiles.filter((file) => !name || file === `${name}-css.pid`);
  if (targets.length === 0) {
    console.log('Tidak ada Pod lokal yang tercatat (file PID tidak ditemukan).');
    return;
  }

  for (const file of targets) {
    const pidPath = path.join(cssRoot, file);
    const podName = file.replace(/-css\.pid$/, '');
    const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);

    if (!Number.isInteger(pid) || pid <= 0) {
      fs.unlinkSync(pidPath);
      continue;
    }

    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGTERM');
      }
      console.log(`Pod "${podName}" dihentikan (PID ${pid}).`);
    } catch {
      console.log(`Proses Pod "${podName}" (PID ${pid}) sudah tidak berjalan.`);
    }
    fs.unlinkSync(pidPath);
  }
}

try {
  main();
} catch (err: any) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
}
