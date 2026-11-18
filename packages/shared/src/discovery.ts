// packages/shared/src/discovery.ts
// Kontrak API Discovery Platform — dipakai bersama oleh discovery-platform & user-client.

export interface PeerEndpoint {
  peerId: string;
  ip: string;
  port: number;
  targetPeerId?: string;
  webId?: string;
}

/** Payload POST /register. */
export interface RegisterRequest {
  peerId: string;
  port: number;
  displayName?: string;
  targetPeerId?: string;
  ip?: string;
  webId?: string;
}

/** Item daftar user online (GET /peers). */
export interface OnlinePeer {
  peerId: string;
  displayName?: string;
  webId?: string;
  lastSeen: number;
}

export interface PeersResponse {
  peers: OnlinePeer[];
}
