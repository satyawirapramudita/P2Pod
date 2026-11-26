// packages/shared/src/discovery.ts
// Kontrak API Discovery Platform — dipakai bersama oleh discovery-platform & user-client.

export interface PeerEndpoint {
  peerId: string;
  /** IPv4, IPv6, or hostname that other peers can dial. */
  ip: string;
  port: number;
  targetPeerId?: string;
  webId?: string;
  reachable?: boolean;
}

/** Payload POST /register. */
export interface RegisterRequest {
  peerId: string;
  port: number;
  displayName?: string;
  targetPeerId?: string;
  /** Optional self-reported public host (IP or DNS name). */
  publicHost?: string;
  /** Optional self-reported public TCP port (when router forwards a different port). */
  publicPort?: number;
  /** Legacy alias for publicHost. */
  ip?: string;
  webId?: string;
}

/** Response POST /register — includes the address observed by the discovery server. */
export interface RegisterResponse {
  ok: true;
  ip: string;
  port: number;
  observedIp: string;
  advertised: boolean;
}

/** Item daftar user online (GET /peers). */
export interface OnlinePeer {
  peerId: string;
  displayName?: string;
  webId?: string;
  lastSeen: number;
  publicEndpoint?: string;
  reachable?: boolean;
}

export interface PeersResponse {
  peers: OnlinePeer[];
}

/** Response GET /probe/:peerId — asks discovery to test inbound TCP reachability. */
export interface ProbeResponse {
  reachable: boolean;
  host: string;
  port: number;
  checkedAt: number;
  error?: string;
}
