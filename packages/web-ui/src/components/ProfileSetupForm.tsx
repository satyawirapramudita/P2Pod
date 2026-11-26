import React, { useEffect, useRef, useState } from 'react';
import { Button, InputField, StatusBanner } from '../components/ui/Primitives';
import type { BridgeClientData } from '../hooks/useBridgeClient';

export interface ProfileSetupFormProps {
  bridge: BridgeClientData;
  submitLabel?: string;
  onCreated?: () => void;
}

export function ProfileSetupForm({
  bridge,
  submitLabel = 'Buat Profil & Buka Console',
  onCreated,
}: ProfileSetupFormProps): React.ReactElement {
  const defaultsApplied = useRef(false);
  const [displayName, setDisplayName] = useState('');
  const [discoveryUrl, setDiscoveryUrl] = useState(defaultsApplied.current ? '' : 'http://localhost:4000');
  const [listenPort, setListenPort] = useState('5000');
  const [publicHost, setPublicHost] = useState('');
  const [publicPort, setPublicPort] = useState('');
  const [discoveryToken, setDiscoveryToken] = useState('');
  const [podUrl, setPodUrl] = useState('');
  const [checkState, setCheckState] = useState<{ status: 'idle' | 'ok' | 'error'; message?: string }>({
    status: 'idle',
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);

  useEffect(() => {
    if (!bridge.defaults || defaultsApplied.current) return;
    defaultsApplied.current = true;
    if (bridge.defaults.discoveryUrl) setDiscoveryUrl(bridge.defaults.discoveryUrl);
    if (bridge.defaults.listenPort) setListenPort(String(bridge.defaults.listenPort));
    if (bridge.defaults.publicHost) setPublicHost(bridge.defaults.publicHost);
    if (bridge.defaults.publicPort) setPublicPort(String(bridge.defaults.publicPort));
  }, [bridge.defaults]);

  const handleCheck = async (): Promise<void> => {
    if (!discoveryUrl.trim()) {
      setCheckState({ status: 'error', message: 'URL discovery wajib diisi.' });
      return;
    }
    setCheckState({ status: 'idle' });
    try {
      const result = await bridge.checkDiscovery(discoveryUrl);
      setCheckState(
        result.ok
          ? { status: 'ok', message: `Discovery terjangkau: ${result.url}` }
          : { status: 'error', message: result.error ?? 'Discovery tidak menjawab.' }
      );
    } catch (err: any) {
      setCheckState({ status: 'error', message: err?.message ?? 'Gagal memeriksa discovery.' });
    }
  };

  const handleDetectIp = async (): Promise<void> => {
    setDetecting(true);
    try {
      const ip = await bridge.detectPublicIp();
      if (ip) setPublicHost(ip);
    } finally {
      setDetecting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFormError(null);
    setWarning(null);

    const name = displayName.trim();
    if (!name) {
      setFormError('Nama user wajib diisi.');
      return;
    }
    if (!discoveryUrl.trim()) {
      setFormError('URL Discovery Platform wajib diisi.');
      return;
    }

    const portNum = Number(listenPort);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setFormError('Port TCP harus berupa angka antara 1 sampai 65535.');
      return;
    }
    const publicPortNum = publicPort.trim() ? Number(publicPort) : undefined;
    if (
      publicPortNum !== undefined &&
      (!Number.isInteger(publicPortNum) || publicPortNum < 1 || publicPortNum > 65535)
    ) {
      setFormError('Port publik harus berupa angka antara 1 sampai 65535.');
      return;
    }

    try {
      const result = await bridge.createProfile({
        displayName: name,
        discoveryUrl: discoveryUrl.trim(),
        listenPort: portNum,
        publicHost: publicHost.trim() || undefined,
        publicPort: publicPortNum,
        discoveryToken: discoveryToken.trim() || undefined,
        podUrl: podUrl.trim() || undefined,
      });
      if (result.warning) setWarning(result.warning);
      onCreated?.();
    } catch (err: any) {
      setFormError(err?.message ?? 'Gagal membuat profil.');
    }
  };

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}
    >
      <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--ink-secondary)' }}>
        Buat identitas Ed25519 permanen di perangkat ini. Semua pengaturan lain bisa diubah lagi
        dari console.
      </p>

      <InputField
        label="Nama tampilan"
        placeholder="mis. satya"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        required
      />

      <InputField
        label="URL Discovery Platform"
        placeholder="http://localhost:4000 atau https://discovery.example.com"
        value={discoveryUrl}
        onChange={(e) => {
          setDiscoveryUrl(e.target.value);
          setCheckState({ status: 'idle' });
        }}
        helperText="Server yang menghubungkan Peer ID ke alamat TCP. Untuk lintas jaringan, gunakan discovery yang bisa diakses publik."
        required
      />

      <div className="sg-row">
        <Button variant="secondary" size="sm" onClick={() => void handleCheck()}>
          [CEK DISCOVERY]
        </Button>
        {checkState.status !== 'idle' ? (
          <span
            style={{
              fontSize: '0.75rem',
              color:
                checkState.status === 'ok'
                  ? 'var(--status-success)'
                  : 'var(--status-danger)',
            }}
          >
            {checkState.message}
          </span>
        ) : null}
      </div>

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
          value={listenPort}
          onChange={(e) => setListenPort(e.target.value)}
          helperText="Port lokal tempat peer menerima koneksi."
          required
        />
        <InputField
          label="Port publik (opsional)"
          type="number"
          min={1}
          max={65535}
          placeholder={listenPort || '5000'}
          value={publicPort}
          onChange={(e) => setPublicPort(e.target.value)}
          helperText="Jika router/Docker memetakan port eksternal yang berbeda."
        />
      </div>

      <InputField
        label="Public host / IP (opsional)"
        placeholder="mis. 203.0.113.10 atau p2pod.example.com"
        value={publicHost}
        onChange={(e) => setPublicHost(e.target.value)}
        helperText="Kosongkan agar Discovery memakai IP yang diamati dari koneksi Anda. Isi untuk Docker atau port-forward."
      />

      <div className="sg-row">
        <Button
          variant="secondary"
          size="sm"
          disabled={detecting}
          onClick={() => void handleDetectIp()}
        >
          {detecting ? '[MENDETEKSI...]' : '[DETEKSI IP PUBLIK]'}
        </Button>
        <span style={{ fontSize: '0.75rem', color: 'var(--ink-muted)' }}>
          Hasil deteksi hanya saran — pastikan port TCP sudah di-forward di router.
        </span>
      </div>

      <InputField
        label="Token Discovery (opsional)"
        type="password"
        placeholder={bridge.defaults?.hasDiscoveryToken ? 'Diatur oleh environment' : 'Kosongkan jika discovery publik tanpa token'}
        value={discoveryToken}
        onChange={(e) => setDiscoveryToken(e.target.value)}
      />

      <InputField
        label="URL Solid Pod (opsional)"
        placeholder="http://localhost:3000/nama/ atau https://pod.example.com/"
        value={podUrl}
        onChange={(e) => setPodUrl(e.target.value)}
        helperText="Kosongkan untuk mulai tanpa Solid Pod. Login/link Pod bisa dilakukan dari console."
      />

      {warning ? (
        <StatusBanner tone="warning" title="Profil dibuat dengan catatan" description={warning} />
      ) : null}

      {formError ? (
        <StatusBanner tone="error" title="Setup gagal" description={formError} />
      ) : null}

      <div className="sg-row" style={{ justifyContent: 'flex-end' }}>
        <Button type="submit" variant="primary" disabled={bridge.profileBusy}>
          {bridge.profileBusy ? 'Membuat profil...' : submitLabel}
        </Button>
      </div>
    </form>
  );
}