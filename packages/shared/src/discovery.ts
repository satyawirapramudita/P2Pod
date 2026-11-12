// packages/shared/src/discovery.ts
// Kontrak API Discovery Platform — dipakai bersama oleh discovery-platform & user-client.

export interface PeerEndpoint {
  peerId: string;
  ip: string;
  port: number;
  targetPeerId?: string;
}
