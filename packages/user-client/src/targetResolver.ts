// packages/user-client/src/targetResolver.ts
// Resolusi target chat: Peer ID langsung, atau nama display (harus unik) dari daftar user online.

import type { OnlinePeer } from '@p2pod/shared';
import { DiscoveryClient } from './discovery/discoveryClient';
import { fingerprintOf } from './identity/identity';

/** Peer ID = base64url dari SPKI DER Ed25519 → selalu diawali "MCowBQYDK2Vw". */
export function looksLikePeerId(value: string): boolean {
  return /^MCowBQYDK2Vw[A-Za-z0-9_-]{20,}$/.test(value.trim());
}

export interface ResolvedTarget {
  peerId: string;
  displayName?: string;
  via: 'peerId' | 'name';
}

/** Pilih peer dari daftar yang sudah diambil berdasarkan spesifikasi (nama atau Peer ID). */
export function pickPeerBySpec(spec: string, peers: OnlinePeer[]): ResolvedTarget {
  const trimmed = spec.trim();
  if (looksLikePeerId(trimmed)) return { peerId: trimmed, via: 'peerId' };

  const matches = peers.filter((peer) => (peer.displayName ?? '').toLowerCase() === trimmed.toLowerCase());
  if (matches.length === 0) {
    throw new Error(`user "${trimmed}" tidak ditemukan di daftar online. Cek daftar dengan: npm run user:list`);
  }
  if (matches.length > 1) {
    const detail = matches.map((peer) => `${peer.displayName} (${fingerprintOf(peer.peerId)})`).join(', ');
    throw new Error(`nama "${trimmed}" dipakai ${matches.length} user — gunakan Peer ID. Kandidat: ${detail}`);
  }
  return { peerId: matches[0].peerId, displayName: matches[0].displayName, via: 'name' };
}

/** Resolusi mandiri (dipakai CLI): fetch daftar user dari Discovery Platform lalu pilih. */
export async function resolveTarget(spec: string, discoveryUrl: string): Promise<ResolvedTarget> {
  const trimmed = spec.trim();
  if (looksLikePeerId(trimmed)) return { peerId: trimmed, via: 'peerId' };

  const discovery = new DiscoveryClient(discoveryUrl);
  let peers: OnlinePeer[];
  try {
    peers = await discovery.listPeers();
  } catch (err: any) {
    throw new Error(`tidak bisa mengambil daftar user dari Discovery Platform (${discoveryUrl}): ${err.message}`);
  }
  return pickPeerBySpec(trimmed, peers);
}
