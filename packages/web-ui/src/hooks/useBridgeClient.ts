import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChatSummary,
  OnlinePeerItem,
  PeerAppState,
  PodLoginProgress,
  ProfileSummary,
  StoredMessage,
  SystemLogEntry,
} from '../types/bridge';

export interface SyncFeedback {
  status: string;
  pushed: number;
  pulled: number;
  chatsSynced?: number;
  error?: string;
  timestamp: number;
}

export interface BridgeClientData {
  wsConnected: boolean;
  loadingInitial: boolean;
  bridgeError: string | null;
  state: PeerAppState | null;
  onlinePeers: OnlinePeerItem[];
  peersLoading: boolean;
  peersError: string | null;
  chats: ChatSummary[];
  selectedChatId: string | null;
  displayedMessages: StoredMessage[];
  logs: SystemLogEntry[];
  profiles: ProfileSummary[];
  lastSync: SyncFeedback | null;
  syncBusy: boolean;
  podLogin: PodLoginProgress;
  selectOfflineChat: (chatId: string | null) => Promise<void>;
  refreshPeers: () => Promise<void>;
  refreshProfiles: () => Promise<void>;
  connectToPeer: (params: { peerId: string; label?: string; ip?: string; port?: number }) => Promise<void>;
  cancelConnect: () => Promise<void>;
  disconnectSession: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  triggerSync: (chatId?: string) => Promise<void>;
  switchProfile: (homeDir: string) => Promise<void>;
  startPodLogin: (params: {
    mode: 'browser' | 'account';
    issuerUrl?: string;
    email?: string;
    password?: string;
    podUrl?: string;
  }) => Promise<void>;
  linkPodIdentity: () => Promise<void>;
  clearBridgeError: () => void;
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${res.status}`);
  }
  return body as T;
}

export function useBridgeClient(): BridgeClientData {
  const [wsConnected, setWsConnected] = useState(false);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [bridgeError, setBridgeError] = useState<string | null>(null);

  const [state, setState] = useState<PeerAppState | null>(null);
  const [onlinePeers, setOnlinePeers] = useState<OnlinePeerItem[]>([]);
  const [peersLoading, setPeersLoading] = useState(false);
  const [peersError, setPeersError] = useState<string | null>(null);

  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [messagesByChat, setMessagesByChat] = useState<Record<string, StoredMessage[]>>({});
  const [logs, setLogs] = useState<SystemLogEntry[]>([]);
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);

  const [lastSync, setLastSync] = useState<SyncFeedback | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [podLogin, setPodLogin] = useState<PodLoginProgress>({ status: 'idle' });

  const activeSessionChatIdRef = useRef<string | null>(null);
  activeSessionChatIdRef.current = state?.session?.chatId ?? null;

  const refreshPeers = useCallback(async () => {
    setPeersLoading(true);
    try {
      const data = await apiFetch<{ peers: OnlinePeerItem[] }>('/api/peers');
      setOnlinePeers(data.peers);
      setPeersError(null);
    } catch (err: any) {
      setPeersError(err?.message ?? 'Gagal memuat daftar peer dari Discovery.');
    } finally {
      setPeersLoading(false);
    }
  }, []);

  const refreshProfiles = useCallback(async () => {
    try {
      const data = await apiFetch<{ profiles: ProfileSummary[] }>('/api/profiles');
      setProfiles(data.profiles);
    } catch {
      // abaikan bila belum tersedia
    }
  }, []);

  const loadMessagesForChat = useCallback(async (chatId: string) => {
    const data = await apiFetch<{ chatId: string; messages: StoredMessage[] }>(
      `/api/chats/${encodeURIComponent(chatId)}/messages`
    );
    setMessagesByChat((prev) => ({ ...prev, [chatId]: data.messages }));
  }, []);

  // Koneksi WebSocket real-time dengan auto-reconnect
  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let retryTimer: number | null = null;

    const connect = (): void => {
      if (disposed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${window.location.host}/ws`);

      ws.onopen = () => {
        if (disposed) return;
        setWsConnected(true);
        setLoadingInitial(false);
        setBridgeError(null);
      };

      ws.onmessage = (ev) => {
        if (disposed) return;
        try {
          const payload = JSON.parse(String(ev.data)) as Record<string, any>;
          switch (payload.type) {
            case 'init': {
              setState(payload.state as PeerAppState);
              setChats((payload.chats ?? []) as ChatSummary[]);
              setLogs((payload.logs ?? []) as SystemLogEntry[]);
              setLoadingInitial(false);
              const activeId = (payload.state as PeerAppState)?.session?.chatId;
              if (activeId) {
                setSelectedChatId(activeId);
                void loadMessagesForChat(activeId);
              }
              break;
            }
            case 'state': {
              const nextState = payload.state as PeerAppState;
              setState(nextState);
              if (nextState.session?.chatId) {
                setSelectedChatId(nextState.session.chatId);
              }
              break;
            }
            case 'system': {
              setLogs((prev) => [
                ...prev.slice(-199),
                { text: String(payload.text ?? ''), timestamp: Number(payload.timestamp ?? Date.now()) },
              ]);
              break;
            }
            case 'historyLoaded': {
              const cId = String(payload.chatId ?? '');
              if (cId && Array.isArray(payload.messages)) {
                setMessagesByChat((prev) => ({ ...prev, [cId]: payload.messages as StoredMessage[] }));
              }
              break;
            }
            case 'message': {
              const m = payload.message as {
                chatId: string;
                senderName: string;
                direction: 'sent' | 'received';
                text: string;
                timestamp: number;
                seq: number;
              };
              if (m?.chatId) {
                setMessagesByChat((prev) => {
                  const existing = prev[m.chatId] ?? [];
                  return {
                    ...prev,
                    [m.chatId]: [
                      ...existing,
                      {
                        senderName: m.senderName,
                        direction: m.direction,
                        text: m.text,
                        timestamp: m.timestamp,
                        seq: m.seq,
                      },
                    ],
                  };
                });
              }
              break;
            }
            case 'sessionStarted': {
              const cId = String(payload.session?.chatId ?? '');
              if (cId) {
                setSelectedChatId(cId);
                void loadMessagesForChat(cId);
              }
              break;
            }
            case 'chatsUpdated': {
              if (Array.isArray(payload.chats)) {
                setChats(payload.chats as ChatSummary[]);
              }
              break;
            }
            case 'sync': {
              setLastSync({
                status: String(payload.status ?? 'synced'),
                pushed: Number(payload.pushed ?? 0),
                pulled: Number(payload.pulled ?? 0),
                chatsSynced: typeof payload.chatsSynced === 'number' ? payload.chatsSynced : undefined,
                error: typeof payload.error === 'string' ? payload.error : undefined,
                timestamp: Date.now(),
              });
              if (Number(payload.pulled ?? 0) > 0 && payload.chatId) {
                void loadMessagesForChat(String(payload.chatId));
              }
              break;
            }
            case 'podLoginStatus': {
              setPodLogin({
                status: payload.status,
                authUrl: payload.authUrl,
                webId: payload.webId,
                podUrl: payload.podUrl,
                error: payload.error,
              });
              if (payload.status === 'completed') {
                void refreshProfiles();
              }
              break;
            }
          }
        } catch {
          // abaikan frame tidak dikenal
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        setWsConnected(false);
        setLoadingInitial(false);
        retryTimer = window.setTimeout(connect, 2500);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();
    void refreshPeers();
    void refreshProfiles();

    const peerPoll = window.setInterval(() => {
      void refreshPeers();
    }, 6000);

    return () => {
      disposed = true;
      window.clearInterval(peerPoll);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      ws?.close();
    };
  }, [loadMessagesForChat, refreshPeers, refreshProfiles]);

  const selectOfflineChat = useCallback(
    async (chatId: string | null) => {
      setSelectedChatId(chatId);
      if (chatId) {
        try {
          await loadMessagesForChat(chatId);
        } catch (err: any) {
          setBridgeError(err?.message ?? 'Gagal membaca riwayat chat lokal.');
        }
      }
    },
    [loadMessagesForChat]
  );

  const connectToPeer = useCallback(
    async (params: { peerId: string; label?: string; ip?: string; port?: number }) => {
      setBridgeError(null);
      try {
        await apiFetch('/api/session/connect', {
          method: 'POST',
          body: JSON.stringify(params),
        });
      } catch (err: any) {
        setBridgeError(err?.message ?? 'Gagal memulai koneksi ke peer.');
        throw err;
      }
    },
    []
  );

  const cancelConnect = useCallback(async () => {
    await apiFetch('/api/session/cancel', { method: 'POST', body: JSON.stringify({}) });
  }, []);

  const disconnectSession = useCallback(async () => {
    await apiFetch('/api/session/disconnect', { method: 'POST', body: JSON.stringify({}) });
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    setBridgeError(null);
    await apiFetch('/api/session/message', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  }, []);

  const triggerSync = useCallback(
    async (chatId?: string) => {
      setSyncBusy(true);
      setBridgeError(null);
      try {
        const data = await apiFetch<{ result: SyncFeedback; chats: ChatSummary[] }>('/api/sync', {
          method: 'POST',
          body: JSON.stringify(chatId ? { chatId } : { all: true }),
        });
        setChats(data.chats);
        if (chatId) {
          await loadMessagesForChat(chatId);
        } else if (selectedChatId) {
          await loadMessagesForChat(selectedChatId);
        }
      } catch (err: any) {
        setBridgeError(err?.message ?? 'Sinkronisasi Solid Pod gagal.');
      } finally {
        setSyncBusy(false);
      }
    },
    [loadMessagesForChat, selectedChatId]
  );

  const switchProfile = useCallback(
    async (homeDir: string) => {
      setBridgeError(null);
      await apiFetch('/api/profiles/switch', {
        method: 'POST',
        body: JSON.stringify({ homeDir }),
      });
      setSelectedChatId(null);
      setMessagesByChat({});
      await refreshProfiles();
      await refreshPeers();
    },
    [refreshPeers, refreshProfiles]
  );

  const startPodLogin = useCallback(
    async (params: {
      mode: 'browser' | 'account';
      issuerUrl?: string;
      email?: string;
      password?: string;
      podUrl?: string;
    }) => {
      setPodLogin({ status: params.mode === 'browser' ? 'awaiting_browser' : 'linking' });
      try {
        const res = await apiFetch<{ authUrl?: string }>('/api/pod/login', {
          method: 'POST',
          body: JSON.stringify(params),
        });
        if (params.mode === 'browser' && res.authUrl) {
          setPodLogin({ status: 'awaiting_browser', authUrl: res.authUrl });
        }
      } catch (err: any) {
        setPodLogin({ status: 'error', error: err?.message ?? 'Login Solid Pod gagal.' });
        throw err;
      }
    },
    []
  );

  const linkPodIdentity = useCallback(async () => {
    setBridgeError(null);
    await apiFetch('/api/pod/link', { method: 'POST', body: JSON.stringify({}) });
    await refreshProfiles();
  }, [refreshProfiles]);

  const effectiveChatId = state?.session?.chatId ?? selectedChatId;
  const displayedMessages = effectiveChatId ? (messagesByChat[effectiveChatId] ?? []) : [];

  return {
    wsConnected,
    loadingInitial,
    bridgeError,
    state,
    onlinePeers,
    peersLoading,
    peersError,
    chats,
    selectedChatId: effectiveChatId,
    displayedMessages,
    logs,
    profiles,
    lastSync,
    syncBusy,
    podLogin,
    selectOfflineChat,
    refreshPeers,
    refreshProfiles,
    connectToPeer,
    cancelConnect,
    disconnectSession,
    sendMessage,
    triggerSync,
    switchProfile,
    startPodLogin,
    linkPodIdentity,
    clearBridgeError: () => setBridgeError(null),
  };
}
