// src/crypto/cryptoEngine.ts

import * as crypto from 'crypto';
import { ChatMessage, IdentityProofMessage } from '../types/messages';

const PROOF_LABEL = 'p2pod-identity-proof-v1';
const SESSION_KEY_LABEL = 'p2pod-session-key-v1';

export class CryptoEngine {
  private ecdh: crypto.ECDH | null = null;
  private tempKey: Buffer | null = null;
  private sessionKey: Buffer | null = null;

  initEphemeralKeyPair(): { publicKeyBase64: string } {
    this.ecdh = crypto.createECDH('prime256v1');
    this.ecdh.generateKeys();
    this.tempKey = null;
    this.sessionKey = null;
    return { publicKeyBase64: this.getEphemeralPublicKeyBase64() };
  }

  getEphemeralPublicKeyBase64(): string {
    if (!this.ecdh) throw new Error('ECDH belum diinisialisasi');
    return this.ecdh.getPublicKey().toString('base64');
  }

  deriveTempKey(peerPublicKeyBase64: string): void {
    if (!this.ecdh) throw new Error('ECDH belum diinisialisasi');
    const peerPublicKey = Buffer.from(peerPublicKeyBase64, 'base64');
    const sharedSecret = this.ecdh.computeSecret(peerPublicKey);
    this.tempKey = crypto.createHash('sha256').update(sharedSecret).digest();
  }

  isTempKeyReady(): boolean {
    return this.tempKey !== null;
  }

  /** Transcript deterministik: urutan elemen di-sort agar kedua peer menghitung string yang sama. */
  buildTranscript(remoteEphemeralKeyBase64: string, localPeerId: string, remotePeerId: string): string {
    const localEphemeralKey = this.getEphemeralPublicKeyBase64();
    const [e1, e2] = [localEphemeralKey, remoteEphemeralKeyBase64].sort();
    const [p1, p2] = [localPeerId, remotePeerId].sort();
    return [PROOF_LABEL, e1, e2, p1, p2].join('|');
  }

  buildProof(localPeerId: string, transcript: string, sign: (data: Buffer) => Buffer): IdentityProofMessage {
    const payload = JSON.stringify({
      peerId: localPeerId,
      signature: sign(Buffer.from(transcript, 'utf8')).toString('base64'),
    });
    return this.encryptWithTempKey(payload);
  }

  parseProof(msg: IdentityProofMessage): { peerId: string; signature: Buffer } {
    const payload = JSON.parse(this.decryptWithTempKey(msg)) as { peerId?: string; signature?: string };
    if (!payload.peerId || !payload.signature) {
      throw new Error('Identity-proof tidak lengkap');
    }
    return { peerId: payload.peerId, signature: Buffer.from(payload.signature, 'base64') };
  }

  activateSessionKey(transcript: string): void {
    if (!this.tempKey) throw new Error('K_temp belum tersedia');
    this.sessionKey = crypto
      .createHash('sha256')
      .update(Buffer.concat([this.tempKey, Buffer.from(transcript, 'utf8'), Buffer.from(SESSION_KEY_LABEL)]))
      .digest();
  }

  isSessionReady(): boolean {
    return this.sessionKey !== null;
  }

  /** Bersihkan seluruh state kripto (dipakai saat koneksi ditolak dan app kembali menunggu). */
  reset(): void {
    this.ecdh = null;
    this.tempKey = null;
    this.sessionKey = null;
  }

  /** chat_id deterministik: SHA256 dari pasangan Peer ID yang di-sort. */
  deriveChatId(localPeerId: string, remotePeerId: string): string {
    const [a, b] = [localPeerId, remotePeerId].sort();
    return crypto.createHash('sha256').update(`${a}|${b}`).digest('hex');
  }

  encryptChat(from: string, plaintext: string, seq: number): ChatMessage {
    if (!this.sessionKey) throw new Error('Session key belum terbentuk');

    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.sessionKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      type: 'chat',
      from,
      timestamp: Date.now(),
      seq,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
    };
  }

  decryptChat(msg: ChatMessage): string {
    if (!this.sessionKey) throw new Error('Session key belum terbentuk');

    const nonce = Buffer.from(msg.nonce, 'base64');
    const ciphertext = Buffer.from(msg.ciphertext, 'base64');
    const tag = Buffer.from(msg.tag, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.sessionKey, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  }

  private encryptWithTempKey(plaintext: string): IdentityProofMessage {
    if (!this.tempKey) throw new Error('K_temp belum tersedia');

    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.tempKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      type: 'identity-proof',
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
    };
  }

  private decryptWithTempKey(msg: IdentityProofMessage): string {
    if (!this.tempKey) throw new Error('K_temp belum tersedia');

    const nonce = Buffer.from(msg.nonce, 'base64');
    const ciphertext = Buffer.from(msg.ciphertext, 'base64');
    const tag = Buffer.from(msg.tag, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.tempKey, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  }
}
