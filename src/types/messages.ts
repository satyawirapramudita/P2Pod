// src/types/messages.ts

export type MessageType = 'handshake' | 'identity-proof' | 'chat';

export interface BaseMessage {
  type: MessageType;
}

export interface HandshakeMessage extends BaseMessage {
  type: 'handshake';
  displayName: string;
  peerId: string;       // base64url — Ed25519 public key (SPKI DER), identitas permanen
  ephemeralKey: string; // base64 — ECDH P-256 ephemeral public key
  fingerprint: string;  // hex pendek dari peerId
}

export interface IdentityProofMessage extends BaseMessage {
  type: 'identity-proof';
  nonce: string;      // base64
  ciphertext: string; // base64 — payload {peerId, signature} terenkripsi K_temp
  tag: string;        // base64 (AES-GCM auth tag)
}

export interface ChatMessage extends BaseMessage {
  type: 'chat';
  from: string;
  timestamp: number;  // Date.now()
  seq: number;        // sequence number dari pengirim
  nonce: string;      // base64
  ciphertext: string; // base64
  tag: string;        // base64 (AES-GCM auth tag)
}

export type AnyMessage = HandshakeMessage | IdentityProofMessage | ChatMessage;
