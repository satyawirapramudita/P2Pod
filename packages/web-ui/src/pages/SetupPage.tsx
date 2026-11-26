import React from 'react';
import { CrtWindowFrame, PixelIdenticon, StatusBanner, SyntaxTagBadge } from '../components/ui/Primitives';
import { ProfileSetupForm } from '../components/ProfileSetupForm';
import type { BridgeClientData } from '../hooks/useBridgeClient';

export interface SetupPageProps {
  bridge: BridgeClientData;
}

export function SetupPage({ bridge }: SetupPageProps): React.ReactElement {
  return (
    <main className="console-shell">
      <header className="console-hud-header">
        <div className="console-brand-group">
          <PixelIdenticon seed="p2pod-first-run" size={36} />
          <div>
            <div className="console-wordmark">
              <span>P2POD</span>
              <span className="console-wordmark-slash">//</span>
              <span>FIRST RUN</span>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--ink-secondary)' }}>
              Web UI lokal · identitas Ed25519 · chat E2EE
            </div>
          </div>
          <SyntaxTagBadge label="SETUP MODE" tone="warning" />
        </div>
      </header>

      {!bridge.wsConnected ? (
        <StatusBanner
          tone="warning"
          title="Daemon Lokal Belum Terhubung"
          description="Pastikan aplikasi P2Pod berjalan (npm run user:web atau Docker) dan UI dibuka di http://127.0.0.1:3333. WebSocket akan mencoba menyambung ulang otomatis."
          actionLabel="Muat Ulang"
          onAction={() => window.location.reload()}
        />
      ) : null}

      {bridge.bridgeError ? (
        <StatusBanner
          tone="error"
          title="Kendala Setup"
          description={bridge.bridgeError}
          actionLabel="Tutup Pesan"
          onAction={bridge.clearBridgeError}
        />
      ) : null}

      <div className="setup-grid">
        <CrtWindowFrame
          title="01 // BUAT PROFIL LOKAL"
          variant="magenta"
          fill
          statusBarLeft="UI LOKAL: 127.0.0.1"
          statusBarRight="TIDAK ADA DATA YANG DIKIRIM KE UI PUBLIK"
        >
          <ProfileSetupForm bridge={bridge} />
        </CrtWindowFrame>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
          <CrtWindowFrame title="02 // CARA KERJA" statusBarLeft="QUICK START" statusBarRight="E2EE">
            <ol
              style={{
                margin: 0,
                paddingLeft: '1.2rem',
                fontSize: '0.8125rem',
                color: 'var(--ink-secondary)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-xs)',
              }}
            >
              <li>Isi nama dan URL Discovery Platform yang sama dengan peer lain.</li>
              <li>Biarkan public host kosong bila Discovery dapat melihat IP publik Anda.</li>
              <li>Untuk Docker/NAT, isi public host dan forward port TCP yang dipakai.</li>
              <li>Setelah profil dibuat, buka tab Online untuk menghubungi peer.</li>
            </ol>
          </CrtWindowFrame>

          <CrtWindowFrame title="03 // LINTAS JARINGAN" statusBarLeft="PUBLIC IP" statusBarRight="PORT FORWARD">
            <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--ink-secondary)' }}>
              Chat langsung memerlukan port TCP yang bisa dijangkau dari luar. Discovery hanya
              memetakan Peer ID ke alamat; pesan tetap terenkripsi end-to-end dan tidak disimpan
              di server discovery.
            </p>
            <p style={{ margin: 'var(--space-sm) 0 0', fontSize: '0.75rem', color: 'var(--ink-muted)' }}>
              Tanpa port forwarding, peer masih bisa chat pada jaringan lokal. CGNAT memerlukan
              relay — belum termasuk dalam versi ini.
            </p>
          </CrtWindowFrame>
        </div>
      </div>
    </main>
  );
}