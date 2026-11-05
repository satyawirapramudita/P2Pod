// src/identity/identity.ts

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface IdentityFile {
  peerId: string;
  privateKeyPem: string;
  publicKeyPem: string;
  displayName: string;
  createdAt: string;
}

export function defaultHomeDir(): string {
  return process.env.P2POD_HOME ?? path.join(os.homedir(), '.p2pod');
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function fingerprintOf(peerId: string): string {
  return crypto
    .createHash('sha256')
    .update(Buffer.from(peerId, 'base64url'))
    .digest('hex')
    .slice(0, 16);
}

export function verifyWithPeerId(peerId: string, data: Buffer, signature: Buffer): boolean {
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(peerId, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, data, publicKey, signature);
  } catch {
    return false;
  }
}

export class Identity {
  readonly peerId: string;
  readonly fingerprint: string;
  readonly createdAt: string;
  displayName: string;

  private readonly privateKey: crypto.KeyObject;

  private constructor(data: IdentityFile) {
    this.peerId = data.peerId;
    this.displayName = data.displayName;
    this.createdAt = data.createdAt;
    this.fingerprint = fingerprintOf(data.peerId);
    this.privateKey = crypto.createPrivateKey(data.privateKeyPem);
  }

  static loadOrCreate(homeDir: string, displayName?: string): Identity {
    ensureDir(homeDir);
    const filePath = path.join(homeDir, 'identity.json');

    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as IdentityFile;
      if (displayName && displayName !== data.displayName) {
        data.displayName = displayName;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      }
      return new Identity(data);
    }

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const peerId = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');

    const data: IdentityFile = {
      peerId,
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      displayName: displayName ?? `p2pod-${fingerprintOf(peerId).slice(0, 6)}`,
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    return new Identity(data);
  }

  sign(data: Buffer): Buffer {
    return crypto.sign(null, data, this.privateKey);
  }
}
