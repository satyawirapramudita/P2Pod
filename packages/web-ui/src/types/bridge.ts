export interface ActiveSessionInfo {
  chatId: string;
  remotePeerId: string;
  remoteDisplayName: string;
  remoteFingerprint: string;
  remoteWebId?: string;
  startedAt: string;
  messageCount: number;
}

export interface PeerAppState {
  nodeStatus: 'stopped' | 'running';
  sessionStatus: 'idle' | 'connecting' | 'handshaking' | 'connected';
  local: {
    displayName: string;
    peerId: string;
    fingerprint: string;
    homeDir: string;
    discoveryUrl: string;
    listenPort: number;
    boundPort: number | null;
    localIp: string;
    publicHost?: string;
    publicPort?: number;
    publicEndpoint?: string;
    observedIp?: string;
  };
  pod: {
    enabled: boolean;
    reachable: boolean;
    podUrl?: string;
    webId?: string;
    authMode?: 'clientCredentials' | 'oidc';
    error?: string;
  };
  connectingTarget?: {
    peerId: string;
    fingerprint: string;
    label?: string;
    ip?: string;
    port?: number;
  };
  session: ActiveSessionInfo | null;
}

export interface OnlinePeerItem {
  peerId: string;
  fingerprint: string;
  displayName?: string;
  webId?: string;
  lastSeen?: number;
  publicEndpoint?: string;
  reachable?: boolean;
}

export interface ChatSummary {
  chatId: string;
  with: string;
  withPeerId: string;
  withWebId?: string;
  lastActivityAt: string;
  messageCount: number;
  unsyncedSessions: number;
  lastMessage?: {
    senderName: string;
    text: string;
    timestamp: number;
  };
}

export interface StoredMessage {
  senderName: string;
  timestamp: number;
  text: string;
  direction?: 'sent' | 'received';
  seq?: number;
}

export interface SystemLogEntry {
  text: string;
  timestamp: number;
}

export interface ProfileSummary {
  homeDir: string;
  name: string;
  peerId: string;
  fingerprint: string;
  discoveryUrl: string | null;
  listenPort: number | null;
  publicHost: string | null;
  publicPort: number | null;
  pod: {
    enabled: boolean;
    podUrl?: string;
    webId?: string;
    authMode?: 'clientCredentials' | 'oidc';
  } | null;
  isDefault: boolean;
  isActive: boolean;
  complete: boolean;
}

export interface BridgeDefaults {
  discoveryUrl: string;
  listenPort: number;
  publicHost?: string;
  publicPort?: number;
  hasDiscoveryToken: boolean;
}

export interface ProbeResult {
  reachable: boolean;
  host: string;
  port: number;
  checkedAt: number;
  error?: string;
}

export interface PodLoginProgress {
  status: 'idle' | 'awaiting_browser' | 'linking' | 'completed' | 'error';
  authUrl?: string;
  webId?: string;
  podUrl?: string;
  error?: string;
}
