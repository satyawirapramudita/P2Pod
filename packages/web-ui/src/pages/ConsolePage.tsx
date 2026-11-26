import React, { useMemo, useState } from 'react';
import {
  Button,
  CrtWindowFrame,
  InputField,
  ModalDialog,
  PixelHudMeter,
  PixelIdenticon,
  SelectField,
  StatusBanner,
  SyntaxTagBadge,
  Tabs,
} from '../components/ui/Primitives';
import { PeerTopologyGraph } from '../components/ui/PeerTopologyGraph';
import { NumberedTerminalStream } from '../components/ui/NumberedTerminalStream';
import { ProfileSetupForm } from '../components/ProfileSetupForm';
import { BridgeClientData } from '../hooks/useBridgeClient';
import { ChatSummary, ProbeResult } from '../types/bridge';

export interface ConsolePageProps {
  bridge: BridgeClientData;
}

function isValidHostInput(host: string): boolean {
  const value = host.trim().replace(/^\[|\]$/g, '');
  if (!value || value.length > 253 || /\s/.test(value)) return false;
  if (value === 'localhost') return true;
  if (value.includes(':')) return /^[0-9a-fA-F:]+$/.test(value);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
  }
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(
    value
  );
}

export function ConsolePage({ bridge }: ConsolePageProps): React.ReactElement {
  const {
    wsConnected,
    loadingInitial,
    bridgeError,
    state,
    defaults,
    onlinePeers,
    peersLoading,
    peersError,
    chats,
    selectedChatId,
    displayedMessages,
    logs,
    profiles,
    lastSync,
    syncBusy,
    profileBusy,
    probeBusy,
    podLogin,
    selectOfflineChat,
    refreshPeers,
    connectToPeer,
    cancelConnect,
    disconnectSession,
    sendMessage,
    triggerSync,
    switchProfile,
    createProfile,
    deleteProfile,
    updateProfileNetwork,
    detectPublicIp,
    probePublicEndpoint,
    startPodLogin,
    linkPodIdentity,
    clearBridgeError,
  } = bridge;

  const [leftTab, setLeftTab] = useState<'peers' | 'chats'>('peers');
  const [mobilePane, setMobilePane] = useState<'peers' | 'chat' | 'telemetry'>('chat');
  const [draftText, setDraftText] = useState('');
  const [sending, setSending] = useState(false);
  const [copiedPeerId, setCopiedPeerId] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  // Modals
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [podModalOpen, setPodModalOpen] = useState(false);
  const [directModalOpen, setDirectModalOpen] = useState(false);
  const [networkModalOpen, setNetworkModalOpen] = useState(false);
  const [showCreateProfile, setShowCreateProfile] = useState(false);

  // Direct Connect Form
  const [directIp, setDirectIp] = useState('');
  const [directPort, setDirectPort] = useState('5000');
  const [directPeerId, setDirectPeerId] = useState('');
  const [directError, setDirectError] = useState<string | null>(null);

  // Network settings form
  const [networkDiscoveryUrl, setNetworkDiscoveryUrl] = useState('');
  const [networkListenPort, setNetworkListenPort] = useState('5000');
  const [networkPublicHost, setNetworkPublicHost] = useState('');
  const [networkPublicPort, setNetworkPublicPort] = useState('');
  const [networkDiscoveryToken, setNetworkDiscoveryToken] = useState('');
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [detectingIp, setDetectingIp] = useState(false);

  // Pod Login Form
  const [podAuthMode, setPodAuthMode] = useState<'browser' | 'account'>('browser');
  const [podIssuer, setPodIssuer] = useState('https://solidcommunity.net');
  const [podEmail, setPodEmail] = useState('');
  const [podPassword, setPodPassword] = useState('');
  const [podFormError, setPodFormError] = useState<string | null>(null);

  const selectedOfflineSummary: ChatSummary | undefined = useMemo(
    () => chats.find((c) => c.chatId === selectedChatId),
    [chats, selectedChatId]
  );

  const totalUnsynced = useMemo(
    () => chats.reduce((acc, c) => acc + c.unsyncedSessions, 0),
    [chats]
  );

  const syncRatioSegments = useMemo(() => {
    if (!state?.pod.enabled) return 0;
    if (chats.length === 0) return state.pod.reachable ? 10 : 4;
    const syncedChats = chats.filter((c) => c.unsyncedSessions === 0).length;
    return Math.round((syncedChats / chats.length) * 10);
  }, [chats, state?.pod.enabled, state?.pod.reachable]);

  const handleCopyPeerId = async (): Promise<void> => {
    if (!state?.local.peerId) return;
    try {
      await navigator.clipboard.writeText(state.local.peerId);
      setCopiedPeerId(true);
      window.setTimeout(() => setCopiedPeerId(false), 1800);
    } catch {
      // clipboard mungkin dibatasi pada konteks tertentu
    }
  };

  const handleSendSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = draftText.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await sendMessage(trimmed);
      setDraftText('');
    } finally {
      setSending(false);
    }
  };

  const handleDirectSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!isValidHostInput(directIp)) {
      setDirectError('Masukkan alamat IPv4/IPv6 atau hostname yang valid.');
      return;
    }
    const portNum = Number(directPort);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setDirectError('Port TCP harus berupa angka antara 1 sampai 65535.');
      return;
    }
    if (directPeerId.trim().length < 24) {
      setDirectError('Masukkan Peer ID Ed25519 peer tujuan yang lengkap.');
      return;
    }
    setDirectError(null);
    await connectToPeer({
      peerId: directPeerId.trim(),
      ip: directIp.trim(),
      port: portNum,
    });
    setDirectModalOpen(false);
    setMobilePane('chat');
  };

  const handlePodLoginSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!podIssuer.trim()) {
      setPodFormError('URL Solid Provider wajib diisi.');
      return;
    }
    if (podAuthMode === 'account' && (!podEmail.trim() || !podPassword)) {
      setPodFormError('Email dan password akun Pod wajib diisi.');
      return;
    }
    setPodFormError(null);
    try {
      await startPodLogin({
        mode: podAuthMode,
        issuerUrl: podIssuer.trim(),
        email: podAuthMode === 'account' ? podEmail.trim() : undefined,
        password: podAuthMode === 'account' ? podPassword : undefined,
      });
    } catch {
      // status error sudah disimpan di podLogin
    }
  };

  const openNetworkModal = (): void => {
    setNetworkDiscoveryUrl(state?.local.discoveryUrl ?? defaults?.discoveryUrl ?? 'http://localhost:4000');
    setNetworkListenPort(String(state?.local.listenPort ?? defaults?.listenPort ?? 5000));
    setNetworkPublicHost(state?.local.publicHost ?? '');
    setNetworkPublicPort(state?.local.publicPort ? String(state.local.publicPort) : '');
    setNetworkDiscoveryToken('');
    setNetworkError(null);
    setProbeResult(null);
    setNetworkModalOpen(true);
  };

  const handleNetworkSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setNetworkError(null);
    const portNum = Number(networkListenPort);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setNetworkError('Port TCP harus berupa angka antara 1 sampai 65535.');
      return;
    }
    const publicPortNum = networkPublicPort.trim() ? Number(networkPublicPort) : null;
    if (
      publicPortNum !== null &&
      (!Number.isInteger(publicPortNum) || publicPortNum < 1 || publicPortNum > 65535)
    ) {
      setNetworkError('Port publik harus berupa angka antara 1 sampai 65535.');
      return;
    }
    if (networkPublicHost.trim() && !isValidHostInput(networkPublicHost)) {
      setNetworkError('Public host tidak valid. Gunakan IP, IPv6, atau hostname.');
      return;
    }

    try {
      await updateProfileNetwork({
        discoveryUrl: networkDiscoveryUrl.trim(),
        listenPort: portNum,
        publicHost: networkPublicHost.trim() || null,
        publicPort: publicPortNum,
        discoveryToken: networkDiscoveryToken.trim() ? networkDiscoveryToken.trim() : undefined,
      });
      setNetworkModalOpen(false);
    } catch (err: any) {
      setNetworkError(err?.message ?? 'Gagal menyimpan pengaturan jaringan.');
    }
  };

  const handleDetectPublicIp = async (): Promise<void> => {
    setDetectingIp(true);
    try {
      const ip = await detectPublicIp();
      if (ip) setNetworkPublicHost(ip);
    } finally {
      setDetectingIp(false);
    }
  };

  const handleProbe = async (): Promise<void> => {
    try {
      const result = await probePublicEndpoint();
      setProbeResult(result);
    } catch {
      // bridgeError sudah diisi
    }
  };

  const handleDeleteProfile = async (homeDir: string, name: string): Promise<void> => {
    if (!window.confirm(`Hapus profil "${name}" dari perangkat ini? Data Solid Pod tidak ikut terhapus.`)) {
      return;
    }
    try {
      await deleteProfile(homeDir);
    } catch {
      // bridgeError sudah diisi
    }
  };

  if (loadingInitial && !state) {
    return (
      <main className="console-shell">
        <CrtWindowFrame title="BOOT // P2POD LOCAL BRIDGE">
          <StatusBanner
            title="Menghubungkan ke Daemon Lokal..."
            description="Membuka saluran WebSocket ke P2Pod WebBridge di 127.0.0.1."
          />
        </CrtWindowFrame>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="console-shell">
        <CrtWindowFrame title="OFFLINE // DAEMON TIDAK TERJANGKAU">
          <StatusBanner
            tone="error"
            title="WebBridge Lokal Belum Aktif"
            description="Node lokal belum aktif. Jalankan aplikasi P2Pod (Docker atau npm run user:web) lalu muat ulang halaman ini."
            actionLabel="Muat Ulang Halaman"
            onAction={() => window.location.reload()}
          />
        </CrtWindowFrame>
      </main>
    );
  }

  const activeSession = state.session;
  const isConnected = state.sessionStatus === 'connected' && Boolean(activeSession);
  const isConnecting =
    state.sessionStatus === 'connecting' || state.sessionStatus === 'handshaking';

  return (
    <div className="console-shell">
      {/* TOP HUD BAR */}
      <header className="console-hud-header">
        <div className="console-brand-group">
          <PixelIdenticon seed={state.local.fingerprint} size={36} />
          <div>
            <div className="console-wordmark">
              <span>P2POD</span>
              <span className="console-wordmark-slash">//</span>
              <span>{state.local.displayName}</span>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--ink-secondary)' }}>
              {`FP: ${state.local.fingerprint} · TCP:${state.local.boundPort ?? state.local.listenPort} · PUB:${state.local.publicEndpoint ?? 'auto'} · LAN:${state.local.localIp || 'loopback'}`}
            </div>
          </div>
          <SyntaxTagBadge
            label={wsConnected ? 'DAEMON LIVE' : 'RECONNECTING'}
            tone={wsConnected ? 'success' : 'warning'}
          />
        </div>

        <nav className="console-hud-actions" aria-label="Kontrol utama P2Pod">
          <Button variant="secondary" size="sm" onClick={() => void handleCopyPeerId()}>
            {copiedPeerId ? '[PEER ID DISALIN]' : '[SALIN PEER ID]'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setProfileModalOpen(true)}>
            {`[PROFIL: ${profiles.length || 1}]`}
          </Button>
          <Button variant={state.local.publicEndpoint ? 'cyan' : 'secondary'} size="sm" onClick={openNetworkModal}>
            {state.local.publicEndpoint ? '[NETWORK: PUBLIK]' : '[NETWORK]'}
          </Button>
          <Button
            variant={state.pod.enabled && state.pod.reachable ? 'cyan' : 'secondary'}
            size="sm"
            onClick={() => setPodModalOpen(true)}
          >
            {state.pod.enabled ? '[SOLID POD: AKTIF]' : '[SETUP POD]'}
          </Button>
        </nav>
      </header>

      {bridgeError ? (
        <StatusBanner
          tone="error"
          title="Kendala Operasi"
          description={bridgeError}
          actionLabel="Tutup Pesan"
          onAction={clearBridgeError}
        />
      ) : null}

      {/* 3-PANE WORKSPACE */}
      <main className="console-workspace-grid">
        {/* LEFT PANE: PEERS & ARCHIVE */}
        <aside
          className="console-pane"
          data-mobile-hidden={mobilePane !== 'peers'}
          aria-label="Daftar peer dan arsip chat"
        >
          <CrtWindowFrame
            title="01 // PEERS"
            fill
            headerRight={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDirectModalOpen(true)}
                aria-label="Hubungkan langsung via host/IP dan Peer ID"
              >
                [+HOST]
              </Button>
            }
            statusBarLeft={`DISCOVERY: ${state.local.discoveryUrl}`}
          >
            <Tabs
              ariaLabel="Pilih daftar peer online atau arsip chat"
              activeTab={leftTab}
              onSelect={setLeftTab}
              tabs={[
                { id: 'peers', label: 'Online', count: onlinePeers.length },
                { id: 'chats', label: 'Chats', count: chats.length },
              ]}
            />

            {leftTab === 'peers' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)', flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--ink-secondary)' }}>
                    {peersLoading ? 'Memindai Discovery...' : `${onlinePeers.length} peer aktif di discovery`}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => void refreshPeers()}>
                    [SEGARKAN]
                  </Button>
                </div>

                {peersError ? (
                  <StatusBanner
                    tone="error"
                    title="Discovery Tidak Terjangkau"
                    description={`${peersError} Anda tetap bisa memakai tombol [+HOST] untuk koneksi TCP langsung.`}
                    actionLabel="Coba Lagi"
                    onAction={() => void refreshPeers()}
                  />
                ) : onlinePeers.length === 0 ? (
                  <StatusBanner
                    title="Belum Ada Peer Lain Online"
                    description="Pastikan rekan memakai URL Discovery yang sama dan port publiknya bisa dijangkau, atau gunakan Direct Host/IP."
                    actionLabel="Hubungkan Direct Host/IP"
                    onAction={() => setDirectModalOpen(true)}
                  />
                ) : (
                  <div className="roster-list">
                    {onlinePeers.map((peer) => {
                      const peerActive = activeSession?.remotePeerId === peer.peerId;
                      const peerConnecting = state.connectingTarget?.peerId === peer.peerId;

                      return (
                        <button
                          key={peer.peerId}
                          type="button"
                          className={`roster-item ${peerActive ? 'roster-item--selected' : ''}`.trim()}
                          onClick={() => {
                            void connectToPeer({
                              peerId: peer.peerId,
                              label: peer.displayName,
                            });
                            setMobilePane('chat');
                          }}
                        >
                          <div className="roster-item__main">
                            <PixelIdenticon seed={peer.fingerprint} size={32} />
                            <div className="roster-item__info">
                              <div className="roster-item__name">
                                {peer.displayName ?? '(tanpa nama)'}
                              </div>
                              <div className="roster-item__sub">
                                {peer.fingerprint}
                                {peer.webId ? ` · WebID` : ''}
                              </div>
                            </div>
                          </div>
                          <SyntaxTagBadge
                            label={peerActive ? 'LIVE' : peerConnecting ? 'WAIT' : 'CONNECT'}
                            tone={peerActive ? 'success' : peerConnecting ? 'warning' : 'cyan'}
                          />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)', flex: 1 }}>
                {chats.length === 0 ? (
                  <StatusBanner
                    title="Arsip Lokal Kosong"
                    description="Percakapan yang Anda lakukan akan otomatis disimpan ke disk lokal dalam format JSON-LD."
                    actionLabel="Lihat Peer Online"
                    onAction={() => setLeftTab('peers')}
                  />
                ) : (
                  <div className="roster-list">
                    {chats.map((chat) => {
                      const isSelected = selectedChatId === chat.chatId;
                      return (
                        <button
                          key={chat.chatId}
                          type="button"
                          className={`roster-item ${isSelected ? 'roster-item--selected' : ''}`.trim()}
                          onClick={() => {
                            void selectOfflineChat(chat.chatId);
                            setMobilePane('chat');
                          }}
                        >
                          <div className="roster-item__main">
                            <PixelIdenticon seed={chat.chatId.slice(0, 16)} size={32} />
                            <div className="roster-item__info">
                              <div className="roster-item__name">{chat.with}</div>
                              <div className="roster-item__sub">
                                {chat.lastMessage
                                  ? `${chat.lastMessage.senderName}: ${chat.lastMessage.text}`
                                  : `${chat.messageCount} pesan`}
                              </div>
                            </div>
                          </div>
                          <SyntaxTagBadge
                            label={`${chat.messageCount}`}
                            tone={chat.unsyncedSessions > 0 ? 'warning' : 'muted'}
                          />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </CrtWindowFrame>
        </aside>

        {/* CENTER PANE: E2EE CHAT TERMINAL */}
        <section
          className="console-pane"
          data-mobile-hidden={mobilePane !== 'chat'}
          aria-label="Jendela percakapan terenkripsi"
        >
          <CrtWindowFrame
            title={
              isConnected && activeSession
                ? `02 // E2EE SESSION :: ${activeSession.remoteDisplayName}`
                : isConnecting
                  ? '02 // HANDSHAKE & DISCOVERY RETRY'
                  : selectedOfflineSummary
                    ? `02 // ARSIP LOKAL :: ${selectedOfflineSummary.with}`
                    : '02 // P2POD E2EE TERMINAL'
            }
            variant={isConnected ? 'magenta' : 'default'}
            active={isConnected}
            fill
            flushBody={isConnected || Boolean(selectedOfflineSummary && !isConnecting)}
            headerRight={
              isConnected ? (
                <div className="sg-row">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={syncBusy}
                    onClick={() => void triggerSync(activeSession?.chatId)}
                  >
                    {syncBusy ? '[SYNC...]' : '[SYNC POD]'}
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => void disconnectSession()}>
                    [PUTUSKAN]
                  </Button>
                </div>
              ) : isConnecting ? (
                <Button variant="danger" size="sm" onClick={() => void cancelConnect()}>
                  [BATALKAN]
                </Button>
              ) : selectedOfflineSummary ? (
                <div className="sg-row">
                  {selectedOfflineSummary.withPeerId ? (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() =>
                        void connectToPeer({
                          peerId: selectedOfflineSummary.withPeerId,
                          label: selectedOfflineSummary.with,
                        })
                      }
                    >
                      [HUBUNGKAN KE PEER]
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" onClick={() => void selectOfflineChat(null)}>
                    [TUTUP ARSIP]
                  </Button>
                </div>
              ) : null
            }
            statusBarLeft={
              isConnected && activeSession
                ? `VERIFIED FP: ${activeSession.remoteFingerprint}${activeSession.remoteWebId ? ` · WEBID: ${activeSession.remoteWebId}` : ''}`
                : `CIPHER: ECDH + Ed25519 + AES-256-GCM`
            }
            statusBarRight={
              isConnected && activeSession
                ? `CHAT_ID: ${activeSession.chatId.slice(0, 16)}...`
                : 'STORAGE: LOCAL-FIRST JSON-LD'
            }
          >
            {isConnected && activeSession ? (
              <>
                <NumberedTerminalStream
                  messages={displayedMessages}
                  localDisplayName={state.local.displayName}
                  emptyHint={`Sesi aman terbentuk dengan ${activeSession.remoteDisplayName}. Ketik pesan di bawah.`}
                />
                <form className="terminal-composer" onSubmit={(e) => void handleSendSubmit(e)}>
                  <span className="terminal-composer__prompt">{`${state.local.displayName}>`}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <label htmlFor="chat-message-input" className="ui-field__label" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
                      Tulis pesan terenkripsi
                    </label>
                    <input
                      id="chat-message-input"
                      className="ui-input"
                      placeholder={`Kirim pesan terenkripsi ke ${activeSession.remoteDisplayName}...`}
                      value={draftText}
                      onChange={(e) => setDraftText(e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                  <Button type="submit" variant="primary" disabled={sending || !draftText.trim()}>
                    {sending ? '...' : 'KIRIM'}
                  </Button>
                </form>
              </>
            ) : isConnecting ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
                <StatusBanner
                  tone="warning"
                  title={`Menghubungi ${state.connectingTarget?.label ?? state.connectingTarget?.fingerprint ?? 'Peer'}...`}
                  description={
                    state.sessionStatus === 'handshaking'
                      ? 'Koneksi TCP terbuka. Memverifikasi tanda tangan identitas Ed25519 dan menurunkan kunci sesi.'
                      : 'Mencari alamat peer melalui Discovery Platform secara berkala setiap 3 detik sampai target online.'
                  }
                  actionLabel="Batalkan Panggilan"
                  onAction={() => void cancelConnect()}
                />
                <PixelHudMeter
                  label="TAHAP KONEKSI P2P"
                  valueText={state.sessionStatus === 'handshaking' ? 'HANDSHAKE' : 'DISCOVERY LOOKUP'}
                  filledSegments={state.sessionStatus === 'handshaking' ? 7 : 4}
                  tone="warning"
                />
              </div>
            ) : selectedOfflineSummary ? (
              <>
                <div style={{ padding: 'var(--space-xs) var(--space-sm)', backgroundColor: 'var(--surface-muted)', borderBottom: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-xs)' }}>
                  <SyntaxTagBadge
                    label="MODE BACA OFFLINE"
                    meta={`${displayedMessages.length} PESAN TERSIMPAN`}
                    tone="cyan"
                  />
                  {selectedOfflineSummary.unsyncedSessions > 0 ? (
                    <SyntaxTagBadge
                      label={`${selectedOfflineSummary.unsyncedSessions} SESI BELUM SYNC`}
                      tone="warning"
                    />
                  ) : null}
                </div>
                <NumberedTerminalStream
                  messages={displayedMessages}
                  localDisplayName={state.local.displayName}
                  emptyHint="Tidak ada pesan di dalam berkas arsip ini."
                />
              </>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)', justifyContent: 'center', flex: 1 }}>
                <div>
                  <SyntaxTagBadge label="NODE LISTENING" meta={`PORT ${state.local.boundPort ?? state.local.listenPort}`} tone="success" />
                  <h1
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 'clamp(1.3rem, 2.5vw, 1.95rem)',
                      margin: 'var(--space-xs) 0',
                      lineHeight: 1.2,
                    }}
                  >
                    // READY FOR E2EE SESSION !
                  </h1>
                  <p style={{ margin: 0, color: 'var(--ink-secondary)', maxWidth: '60ch' }}>
                    Pilih salah satu rekan di panel Online untuk memulai sesi terenkripsi langsung
                    antar perangkat, atau buka tab Chats untuk membaca arsip lokal tanpa koneksi internet.
                  </p>
                </div>

                <div
                  style={{
                    backgroundColor: 'var(--surface-canvas)',
                    border: '1px solid var(--border-default)',
                    padding: 'var(--space-sm)',
                    fontSize: '0.8125rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                  }}
                >
                  <div>
                    <span style={{ color: 'var(--accent-secondary)' }}>DISPLAY_NAME :</span>{' '}
                    {state.local.displayName}
                  </div>
                  <div>
                    <span style={{ color: 'var(--accent-secondary)' }}>PUBLIC_ENDPOINT :</span>{' '}
                    {state.local.publicEndpoint ?? '(auto — belum terlihat publik; atur di Network)'}
                  </div>
                  <div>
                    <span style={{ color: 'var(--accent-secondary)' }}>LAN_ENDPOINT :</span>{' '}
                    {`${state.local.localIp || '127.0.0.1'}:${state.local.boundPort ?? state.local.listenPort}`}
                  </div>
                  <div style={{ wordBreak: 'break-all' }}>
                    <span style={{ color: 'var(--accent-secondary)' }}>PEER_ID      :</span>{' '}
                    {state.local.peerId}
                  </div>
                </div>

                <div className="sg-row">
                  <Button
                    variant="primary"
                    onClick={() => {
                      setLeftTab('peers');
                      void refreshPeers();
                      setMobilePane('peers');
                    }}
                  >
                    Cari Peer Online
                  </Button>
                  <Button variant="secondary" onClick={() => setDirectModalOpen(true)}>
                    Hubungkan Direct Host/IP
                  </Button>
                  <Button variant="secondary" onClick={openNetworkModal}>
                    Pengaturan Network
                  </Button>
                  <Button variant="cyan" onClick={() => setPodModalOpen(true)}>
                    Kelola Solid Pod
                  </Button>
                </div>
              </div>
            )}
          </CrtWindowFrame>
        </section>

        {/* RIGHT PANE: TOPOLOGY & SOLID POD VAULT */}
        <aside
          className="console-pane console-pane--telemetry"
          data-mobile-hidden={mobilePane !== 'telemetry'}
          aria-label="Topologi jaringan dan status Solid Pod"
        >
          <CrtWindowFrame
            title="03 // TOPOLOGY"
            headerRight={
              <Button variant="ghost" size="sm" onClick={() => setShowLogs((v) => !v)}>
                {showLogs ? '[GRAF]' : `[LOG:${logs.length}]`}
              </Button>
            }
            statusBarLeft={`PEERS: ${onlinePeers.length}`}
            statusBarRight={isConnected ? 'TUNNEL: ENCRYPTED' : 'TUNNEL: STANDBY'}
          >
            {!showLogs ? (
              <PeerTopologyGraph
                localName={state.local.displayName}
                localFingerprint={state.local.fingerprint}
                discoveryOnline={!peersError}
                podEnabled={state.pod.enabled}
                podReachable={state.pod.reachable}
                activePeerId={activeSession?.remotePeerId}
                connectingPeerId={state.connectingTarget?.peerId}
                peers={onlinePeers}
                onSelectPeer={(peer) => {
                  void connectToPeer({ peerId: peer.peerId, label: peer.displayName });
                  setMobilePane('chat');
                }}
              />
            ) : (
              <div
                style={{
                  backgroundColor: 'var(--surface-canvas)',
                  border: '1px solid var(--border-subtle)',
                  padding: 'var(--space-xs)',
                  maxHeight: '212px',
                  overflowY: 'auto',
                  fontSize: '0.75rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                }}
              >
                {logs.length === 0 ? (
                  <span style={{ color: 'var(--ink-muted)' }}>Belum ada log sistem.</span>
                ) : (
                  logs.slice(-25).map((entry, idx) => (
                    <div key={`${entry.timestamp}-${idx}`} style={{ color: 'var(--ink-secondary)' }}>
                      <span style={{ color: 'var(--accent-secondary)' }}>//</span> {entry.text}
                    </div>
                  ))
                )}
              </div>
            )}
          </CrtWindowFrame>

          <CrtWindowFrame
            title="04 // SOLID POD"
            fill
            statusBarLeft={state.pod.authMode ? `AUTH: ${state.pod.authMode.toUpperCase()}` : 'AUTH: NONE'}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
              <SyntaxTagBadge
                label={
                  !state.pod.enabled
                    ? 'POD NONAKTIF'
                    : state.pod.reachable
                      ? 'POD TERHUBUNG'
                      : 'POD OFFLINE'
                }
                meta={totalUnsynced > 0 ? `${totalUnsynced} PENDING` : 'LOCAL SAFE'}
                tone={
                  !state.pod.enabled
                    ? 'muted'
                    : state.pod.reachable
                      ? 'success'
                      : 'warning'
                }
              />

              {state.pod.enabled && state.pod.podUrl ? (
                <div style={{ fontSize: '0.75rem', color: 'var(--ink-secondary)', wordBreak: 'break-all' }}>
                  <div>
                    <strong style={{ color: 'var(--ink-primary)' }}>Pod:</strong> {state.pod.podUrl}
                  </div>
                  {state.pod.webId ? (
                    <div style={{ marginTop: '4px' }}>
                      <strong style={{ color: 'var(--ink-primary)' }}>WebID:</strong> {state.pod.webId}
                    </div>
                  ) : null}
                </div>
              ) : (
                <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--ink-secondary)' }}>
                  Percakapan disimpan di disk lokal. Hubungkan Solid Pod untuk mencadangkan JSON-LD
                  dan menautkan WebID kriptografis.
                </p>
              )}

              <PixelHudMeter
                label="VAULT SYNC STATUS"
                valueText={
                  !state.pod.enabled
                    ? 'LOCAL ONLY'
                    : `${chats.length - chats.filter((c) => c.unsyncedSessions > 0).length}/${chats.length} CHATS`
                }
                filledSegments={syncRatioSegments}
                tone={totalUnsynced > 0 ? 'warning' : 'success'}
              />

              {lastSync ? (
                <div style={{ fontSize: '0.75rem', color: 'var(--ink-secondary)' }}>
                  {`Sync terakhir: status=${lastSync.status}, +${lastSync.pushed} push, +${lastSync.pulled} pull`}
                </div>
              ) : null}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)', marginTop: 'var(--space-2xs)' }}>
                <Button
                  variant="cyan"
                  fullWidth
                  disabled={!state.pod.enabled || syncBusy}
                  onClick={() => void triggerSync()}
                >
                  {syncBusy ? 'Menyinkronkan...' : 'Sync Semua Chat ke Pod'}
                </Button>
                <Button variant="secondary" fullWidth onClick={() => setPodModalOpen(true)}>
                  {state.pod.enabled ? 'Ganti Akun / Link WebID' : 'Login Solid Pod'}
                </Button>
              </div>
            </div>
          </CrtWindowFrame>
        </aside>
      </main>

      {/* MOBILE BOTTOM NAVIGATION (< 768px) */}
      <nav className="mobile-bottom-nav" aria-label="Navigasi layar ponsel">
        <button
          type="button"
          className="ui-tab"
          aria-selected={mobilePane === 'peers'}
          onClick={() => setMobilePane('peers')}
        >
          {`PEERS [${onlinePeers.length}]`}
        </button>
        <button
          type="button"
          className="ui-tab"
          aria-selected={mobilePane === 'chat'}
          onClick={() => setMobilePane('chat')}
        >
          {isConnected ? 'CHAT [LIVE]' : 'TERMINAL'}
        </button>
        <button
          type="button"
          className="ui-tab"
          aria-selected={mobilePane === 'telemetry'}
          onClick={() => setMobilePane('telemetry')}
        >
          POD &amp; NET
        </button>
      </nav>

      {/* MODAL 1: SWITCH / CREATE / DELETE PROFILE */}
      <ModalDialog
        open={profileModalOpen}
        title="PROFILES // IDENTITAS LOKAL"
        onClose={() => {
          setShowCreateProfile(false);
          setProfileModalOpen(false);
        }}
      >
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--ink-secondary)' }}>
          Pilih profil lokal untuk mengganti identitas Ed25519, port TCP, dan ruang penyimpanan
          tanpa mematikan Web UI.
        </p>

        {!showCreateProfile ? (
          <div className="sg-row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="cyan" size="sm" onClick={() => setShowCreateProfile(true)}>
              [+ PROFIL BARU]
            </Button>
          </div>
        ) : (
          <div
            style={{
              border: '1px solid var(--border-subtle)',
              padding: 'var(--space-sm)',
              backgroundColor: 'var(--surface-canvas)',
            }}
          >
            <ProfileSetupForm
              bridge={bridge}
              submitLabel="Buat & Aktifkan Profil"
              onCreated={() => {
                setShowCreateProfile(false);
                setProfileModalOpen(false);
              }}
            />
          </div>
        )}

        <div className="roster-list">
          {profiles.map((prof) => (
            <div
              key={prof.homeDir}
              style={{ display: 'flex', alignItems: 'stretch', gap: 'var(--space-xs)' }}
            >
              <button
                type="button"
                disabled={!prof.complete || profileBusy}
                className={`roster-item ${prof.isActive ? 'roster-item--selected' : ''}`.trim()}
                style={{ flex: 1 }}
                onClick={async () => {
                  if (!prof.isActive && prof.complete) {
                    await switchProfile(prof.homeDir);
                  }
                  setProfileModalOpen(false);
                }}
              >
                <div className="roster-item__main">
                  <PixelIdenticon seed={prof.fingerprint} size={32} />
                  <div className="roster-item__info">
                    <div className="roster-item__name">{prof.name}</div>
                    <div className="roster-item__sub">
                      {`${prof.fingerprint || 'tanpa-key'} · port ${prof.listenPort ?? '-'}`}
                    </div>
                    <div className="roster-item__sub">
                      {prof.publicHost
                        ? `public: ${prof.publicHost}:${prof.publicPort ?? prof.listenPort ?? '-'}`
                        : 'public: auto'}
                    </div>
                  </div>
                </div>
                <SyntaxTagBadge
                  label={prof.isActive ? 'AKTIF' : prof.complete ? 'PILIH' : 'BELUM SIAP'}
                  tone={prof.isActive ? 'success' : prof.complete ? 'cyan' : 'muted'}
                />
              </button>
              <Button
                variant="danger"
                size="sm"
                disabled={prof.isActive || !prof.complete || profileBusy}
                onClick={() => void handleDeleteProfile(prof.homeDir, prof.name)}
                title={prof.isActive ? 'Pindah profil sebelum menghapus' : 'Hapus profil'}
              >
                [HAPUS]
              </Button>
            </div>
          ))}
        </div>
      </ModalDialog>

      {/* MODAL 2: DIRECT IP CONNECT */}
      <ModalDialog
        open={directModalOpen}
        title="DIRECT TCP // KONEKSI TANPA DISCOVERY"
        onClose={() => setDirectModalOpen(false)}
      >
        <form
          onSubmit={(e) => void handleDirectSubmit(e)}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}
        >
          <InputField
            label="Host / IP Peer Tujuan"
            placeholder="192.168.1.15 atau peer.example.com"
            value={directIp}
            onChange={(e) => setDirectIp(e.target.value)}
          />
          <InputField
            label="Port TCP Tujuan"
            placeholder="5000 (atau port publik hasil port-forward)"
            value={directPort}
            onChange={(e) => setDirectPort(e.target.value)}
          />
          <InputField
            label="Peer ID Ed25519 Tujuan"
            placeholder="MCowBQYDK2VwAyEA..."
            value={directPeerId}
            onChange={(e) => setDirectPeerId(e.target.value)}
            errorText={directError ?? undefined}
          />
          <div className="sg-row" style={{ justifyContent: 'flex-end', marginTop: 'var(--space-xs)' }}>
            <Button variant="ghost" onClick={() => setDirectModalOpen(false)}>
              Batal
            </Button>
            <Button type="submit" variant="primary">
              Hubungkan Sekarang
            </Button>
          </div>
        </form>
      </ModalDialog>

      {/* MODAL 3: NETWORK / PUBLIC ENDPOINT */}
      <ModalDialog
        open={networkModalOpen}
        title="NETWORK // DISCOVERY & PUBLIC ENDPOINT"
        onClose={() => setNetworkModalOpen(false)}
      >
        <form
          onSubmit={(e) => void handleNetworkSubmit(e)}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}
        >
          <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--ink-secondary)' }}>
            Agar peer di jaringan lain bisa menghubungi Anda, port TCP ini harus bisa dijangkau dari
            internet (port-forward router atau publish Docker). Menyimpan perubahan akan me-restart
            node dan memutus sesi chat yang sedang aktif.
          </p>

          <div
            style={{
              border: '1px solid var(--border-subtle)',
              backgroundColor: 'var(--surface-canvas)',
              padding: 'var(--space-sm)',
              fontSize: '0.8125rem',
            }}
          >
            <div>
              <span style={{ color: 'var(--accent-secondary)' }}>PUBLIC_ENDPOINT :</span>{' '}
              {state.local.publicEndpoint ?? '(auto — belum publik)'}
            </div>
            <div>
              <span style={{ color: 'var(--accent-secondary)' }}>OBSERVED_IP :</span>{' '}
              {state.local.observedIp ?? '(belum terdaftar)'}
            </div>
            <div>
              <span style={{ color: 'var(--accent-secondary)' }}>PEER_ID :</span>{' '}
              <span style={{ wordBreak: 'break-all' }}>{state.local.peerId}</span>
            </div>
          </div>

          <InputField
            label="URL Discovery Platform"
            value={networkDiscoveryUrl}
            onChange={(e) => setNetworkDiscoveryUrl(e.target.value)}
            helperText="Server yang sama harus dipakai semua peer."
          />
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 'var(--space-sm)',
            }}
          >
            <InputField
              label="Port TCP listener"
              type="number"
              min={1}
              max={65535}
              value={networkListenPort}
              onChange={(e) => setNetworkListenPort(e.target.value)}
            />
            <InputField
              label="Port publik"
              type="number"
              min={1}
              max={65535}
              placeholder="kosong = sama dengan port listener"
              value={networkPublicPort}
              onChange={(e) => setNetworkPublicPort(e.target.value)}
            />
          </div>

          <InputField
            label="Public host / IP"
            placeholder="203.0.113.10 atau p2pod.example.com"
            value={networkPublicHost}
            onChange={(e) => setNetworkPublicHost(e.target.value)}
            helperText="Kosongkan untuk memakai IP yang diamati Discovery. Isi manual untuk Docker/port-forward."
          />

          <div className="sg-row">
            <Button
              variant="secondary"
              size="sm"
              disabled={detectingIp}
              onClick={() => void handleDetectPublicIp()}
            >
              {detectingIp ? '[MENDETEKSI...]' : '[DETEKSI IP PUBLIK]'}
            </Button>
            <Button variant="cyan" size="sm" disabled={probeBusy} onClick={() => void handleProbe()}>
              {probeBusy ? '[MENGUJI...]' : '[UJI PORT PUBLIK]'}
            </Button>
            {probeResult ? (
              <span
                style={{
                  fontSize: '0.75rem',
                  color: probeResult.reachable ? 'var(--status-success)' : 'var(--status-danger)',
                }}
              >
                {probeResult.reachable
                  ? `Port terjangkau (${probeResult.host}:${probeResult.port})`
                  : `Tidak terjangkau: ${probeResult.error ?? 'timeout'}`}
              </span>
            ) : null}
          </div>

          <InputField
            label="Token Discovery (opsional)"
            type="password"
            placeholder="Kosongkan untuk mempertahankan token yang tersimpan"
            value={networkDiscoveryToken}
            onChange={(e) => setNetworkDiscoveryToken(e.target.value)}
          />

          {probeResult && !probeResult.reachable ? (
            <StatusBanner
              tone="warning"
              title="Port publik belum terjangkau"
              description="Periksa firewall, port-forward router (TCP listener → host), dan pastikan public host/port benar. Jika Anda di CGNAT, koneksi masuk tidak akan bekerja tanpa relay."
            />
          ) : null}

          {networkError ? (
            <StatusBanner tone="error" title="Pengaturan gagal" description={networkError} />
          ) : null}

          <div className="sg-row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setNetworkModalOpen(false)}>
              Batal
            </Button>
            <Button type="submit" variant="primary" disabled={profileBusy}>
              {profileBusy ? 'Menyimpan...' : 'Simpan & Restart Node'}
            </Button>
          </div>
        </form>
      </ModalDialog>

      {/* MODAL 4: SOLID POD LOGIN & LINK */}
      <ModalDialog
        open={podModalOpen}
        title="SOLID POD // LOGIN & WEBID LINKING"
        onClose={() => setPodModalOpen(false)}
      >
        <form
          onSubmit={(e) => void handlePodLoginSubmit(e)}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}
        >
          <SelectField
            label="Mode Autentikasi Solid"
            value={podAuthMode}
            onChange={(e) => setPodAuthMode(e.target.value as 'browser' | 'account')}
            options={[
              { value: 'browser', label: 'Browser Solid-OIDC (solidcommunity.net / PKCE)' },
              { value: 'account', label: 'Akun Langsung CSS (Email & Password)' },
            ]}
          />

          <InputField
            label="URL Solid Provider / Issuer"
            placeholder="https://solidcommunity.net"
            value={podIssuer}
            onChange={(e) => setPodIssuer(e.target.value)}
            errorText={podFormError ?? undefined}
          />

          {podAuthMode === 'account' ? (
            <>
              <InputField
                label="Email Akun Pod"
                type="email"
                placeholder="email@example.com"
                value={podEmail}
                onChange={(e) => setPodEmail(e.target.value)}
              />
              <InputField
                label="Password Akun Pod"
                type="password"
                placeholder="Masukkan password Pod"
                value={podPassword}
                onChange={(e) => setPodPassword(e.target.value)}
              />
            </>
          ) : null}

          {podLogin.status === 'awaiting_browser' ? (
            <StatusBanner
              tone="warning"
              title="Menunggu Otorisasi di Browser..."
              description="Selesaikan login Solid-OIDC pada tab browser yang terbuka. Identitas Ed25519 akan ditautkan otomatis setelah disetujui."
            />
          ) : null}

          {podLogin.status === 'awaiting_browser' && podLogin.authUrl ? (
            <div style={{ fontSize: '0.75rem' }}>
              Browser tidak terbuka otomatis?{' '}
              <a href={podLogin.authUrl} target="_blank" rel="noreferrer">
                Klik di sini untuk membuka halaman login Solid
              </a>
            </div>
          ) : null}

          {podLogin.status === 'completed' ? (
            <StatusBanner
              tone="success"
              title="Solid Pod Berhasil Ditautkan"
              description={`WebID aktif: ${podLogin.webId ?? state.pod.webId ?? ''}`}
            />
          ) : null}

          {podLogin.status === 'error' && podLogin.error ? (
            <StatusBanner
              tone="error"
              title="Autentikasi Gagal"
              description={podLogin.error}
            />
          ) : null}

          <div className="sg-row" style={{ justifyContent: 'space-between', marginTop: 'var(--space-xs)' }}>
            {state.pod.enabled && state.pod.podUrl ? (
              <Button variant="secondary" size="sm" onClick={() => void linkPodIdentity()}>
                [VERIFIKASI ULANG LINK ED25519]
              </Button>
            ) : (
              <span />
            )}
            <div className="sg-row">
              <Button variant="ghost" onClick={() => setPodModalOpen(false)}>
                Tutup
              </Button>
              <Button type="submit" variant="primary">
                {podAuthMode === 'browser' ? 'Login via Browser' : 'Login & Link Pod'}
              </Button>
            </div>
          </div>
        </form>
      </ModalDialog>
    </div>
  );
}
