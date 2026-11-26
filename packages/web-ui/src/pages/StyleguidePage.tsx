import React, { useState } from 'react';
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

export interface StyleguidePageProps {
  onNavigateConsole: () => void;
}

interface SwatchDef {
  token: string;
  hex: string;
  role: string;
  bgVar: string;
  fgVar: string;
}

const SWATCHES: SwatchDef[] = [
  { token: '--surface-canvas', hex: '#080B16', role: 'Root CRT backdrop', bgVar: 'var(--surface-canvas)', fgVar: 'var(--ink-primary)' }, // audit-ignore
  { token: '--surface-card', hex: '#0E1426', role: 'Window panel surface', bgVar: 'var(--surface-card)', fgVar: 'var(--ink-primary)' }, // audit-ignore
  { token: '--surface-elevated', hex: '#161F38', role: 'Modal & composer surface', bgVar: 'var(--surface-elevated)', fgVar: 'var(--ink-primary)' }, // audit-ignore
  { token: '--accent-primary', hex: '#FF3D9A', role: 'Primary CTA & active frame', bgVar: 'var(--accent-primary)', fgVar: 'var(--accent-on-primary)' }, // audit-ignore
  { token: '--accent-secondary', hex: '#00E5FF', role: 'Syntax tag & focus ring', bgVar: 'var(--accent-secondary)', fgVar: 'var(--accent-on-primary)' }, // audit-ignore
  { token: '--border-default', hex: '#526391', role: '2px structural border (3.32:1)', bgVar: 'var(--border-default)', fgVar: 'var(--ink-primary)' }, // audit-ignore
  { token: '--status-success', hex: '#22E566', role: 'E2EE verified & Pod synced', bgVar: 'var(--status-success)', fgVar: 'var(--accent-on-primary)' }, // audit-ignore
  { token: '--status-warning', hex: '#FFD12A', role: 'Handshake & pending sync', bgVar: 'var(--status-warning)', fgVar: 'var(--accent-on-primary)' }, // audit-ignore
  { token: '--status-danger', hex: '#FF4D5E', role: 'Error & disconnect action', bgVar: 'var(--status-danger)', fgVar: 'var(--accent-on-primary)' }, // audit-ignore
];

const SPECIMEN_PEERS = [
  { peerId: 'specimen-peer-1', fingerprint: '361ed7740741c710', displayName: 'node-alpha [SPECIMEN]' },
  { peerId: 'specimen-peer-2', fingerprint: '19f6bd61fa8d593c', displayName: 'node-beta [SPECIMEN]' },
];

const SPECIMEN_MESSAGES = [
  {
    senderName: 'local-node',
    direction: 'sent' as const,
    timestamp: 1732532400000,
    seq: 1,
    text: '[SPECIMEN] Handshake Ed25519 + ECDH selesai, sesi terenkripsi aktif.',
  },
  {
    senderName: 'remote-node',
    direction: 'received' as const,
    timestamp: 1732532405000,
    seq: 1,
    text: '[SPECIMEN] Riwayat disimpan otomatis ke LocalStorage JSON-LD.',
  },
];

export function StyleguidePage({ onNavigateConsole }: StyleguidePageProps): React.ReactElement {
  const [activeTab, setActiveTab] = useState<'controls' | 'states' | 'stream'>('controls');
  const [demoInput, setDemoInput] = useState('http://127.0.0.1:4000');
  const [demoInvalid, setDemoInvalid] = useState('invalid-peer-id');
  const [demoMode, setDemoMode] = useState('oidc');
  const [modalOpen, setModalOpen] = useState(false);
  const [meterValue, setMeterValue] = useState(7);

  return (
    <main className="sg-container">
      {/* BLOCK 1: Theme Header & Atmosphere Banner */}
      <CrtWindowFrame
        title="01 // P2POD DESIGN SYSTEM & STYLEGUIDE"
        variant="magenta"
        headerRight={
          <Button variant="secondary" size="sm" onClick={onNavigateConsole}>
            [KEMBALI KE CONSOLE]
          </Button>
        }
        statusBarLeft="ARCHETYPE: 8-BIT RETRO-CYBER CRT TERMINAL & PIXEL HUD"
        statusBarRight="DIALS: ENERGY 3 / RHYTHM 2 / MOTION 1"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
          <SyntaxTagBadge label="VISUAL DNA" meta="DESIGN.md + design-tokens.css" tone="cyan" />
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'clamp(1.5rem, 3vw, 2.35rem)',
              lineHeight: 1.15,
              margin: 0,
              textTransform: 'uppercase',
            }}
          >
            // P2POD CRT TERMINAL KIT !
          </h1>
          <p style={{ margin: 0, maxWidth: '65ch', color: 'var(--ink-secondary)' }}>
            Sistem antarmuka berbasis referensi visual CRT gelap, blok tag sintaks kontras tinggi,
            tipografi piksel 8-bit untuk hierarki judul, dan monospace teknis untuk pesan terenkripsi
            serta identitas kriptografis Ed25519.
          </p>
        </div>
      </CrtWindowFrame>

      {/* BLOCK 2: Semantic Color Swatches & Contrast Proof */}
      <CrtWindowFrame
        title="02 // SEMANTIC COLOR TOKENS & WCAG CONTRAST PROOF"
        statusBarLeft="SELURUH PASANGAN TEKS >= 4.5:1 · BORDER STRUKTURAL >= 3.0:1"
      >
        <div className="sg-swatch-grid">
          {SWATCHES.map((sw) => (
            <div key={sw.token} className="sg-swatch">
              <div
                className="sg-swatch__preview"
                style={{ backgroundColor: sw.bgVar, color: sw.fgVar }}
              >
                <span style={{ fontWeight: 700, fontSize: '0.8125rem' }}>Primary Ink Sample</span>
                <span style={{ fontSize: '0.75rem', opacity: 0.9 }}>{sw.hex}</span>
              </div>
              <div className="sg-swatch__meta">
                <div style={{ fontWeight: 700, color: 'var(--ink-primary)' }}>{sw.token}</div>
                <div style={{ color: 'var(--ink-secondary)' }}>{sw.role}</div>
              </div>
            </div>
          ))}
        </div>
      </CrtWindowFrame>

      {/* BLOCK 3: Typography Scale & Pairing Specimen */}
      <CrtWindowFrame
        title="03 // TYPOGRAPHY SCALE & PAIRING SPECIMEN"
        statusBarLeft="DISPLAY: SILKSCREEN / PRESS START 2P"
        statusBarRight="BODY & MONO: IBM PLEX MONO"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
          <div>
            <SyntaxTagBadge label="HERO DISPLAY" meta="clamp(1.6rem, 3.2vw, 2.5rem)" tone="magenta" />
            <div
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(1.6rem, 3.2vw, 2.5rem)',
                lineHeight: 1.15,
                marginTop: 'var(--space-2xs)',
              }}
            >
              SOVEREIGN P2P CHAT
            </div>
          </div>

          <div className="sg-grid-2">
            <div>
              <SyntaxTagBadge label="H1 / MODAL TITLE" meta="clamp(1.2rem, 2vw, 1.5rem)" tone="cyan" />
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'clamp(1.2rem, 2vw, 1.5rem)',
                  marginTop: 'var(--space-2xs)',
                }}
              >
                SOLID POD VAULT SYNC
              </div>
            </div>
            <div>
              <SyntaxTagBadge label="H2 / WINDOW HEADER" meta="1rem · 700" tone="cyan" />
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: '1rem',
                  fontWeight: 700,
                  marginTop: 'var(--space-2xs)',
                }}
              >
                ACTIVE E2EE SESSION
              </div>
            </div>
          </div>

          <div>
            <SyntaxTagBadge label="BODY PARAGRAPH" meta="1rem (16px) · max 65ch · line-height 1.55" tone="muted" />
            <p style={{ maxWidth: '62ch', margin: 'var(--space-xs) 0 0', color: 'var(--ink-primary)' }}>
              Setiap sesi P2Pod membentuk kunci sementara ECDH, memverifikasi tanda tangan Ed25519
              peer lawan, mengenkripsi pesan menggunakan AES-256-GCM, lalu menulis riwayat secara
              atomik ke penyimpanan lokal sebelum disinkronkan ke Solid Pod pengguna.
            </p>
          </div>

          <div>
            <SyntaxTagBadge label="MICRO / KICKER" meta="0.75rem (12px) · tracking 0.05em" tone="success" />
            <div style={{ fontSize: '0.75rem', color: 'var(--ink-secondary)', marginTop: '6px' }}>
              FINGERPRINT: 6575059B3F97218D · CIPHER: AES-256-GCM · PROTOCOL: JSON-LD
            </div>
          </div>
        </div>
      </CrtWindowFrame>

      {/* BLOCK 4: Surface, Border, Shadow & Asset Mechanics */}
      <CrtWindowFrame title="04 // SURFACE, ELEVATION & CODE-NATIVE SIGNATURE ASSETS">
        <div className="sg-grid-2">
          <CrtWindowFrame
            title="DEFAULT WINDOW"
            statusBarLeft="--surface-card"
            statusBarRight="4px 4px 0 offset"
          >
            <p style={{ margin: 0, color: 'var(--ink-secondary)' }}>
              Kontainer standar dengan border struktural 2px dan bayangan piksel keras tanpa blur.
            </p>
            <div className="sg-row">
              <PixelIdenticon seed="6575059b3f97218d" size={40} />
              <PixelIdenticon seed="361ed7740741c710" size={40} />
              <PixelIdenticon seed="19f6bd61fa8d593c" size={40} />
              <span style={{ fontSize: '0.75rem', color: 'var(--ink-secondary)' }}>
                Deterministic 5x5 Ed25519 Pixel Identicons
              </span>
            </div>
          </CrtWindowFrame>

          <CrtWindowFrame
            title="ACTIVE / ELEVATED FRAME"
            variant="elevated"
            active
            statusBarLeft="--border-strong"
            statusBarRight="LIVE SVG TOPOLOGY"
          >
            <PeerTopologyGraph
              localName="local-node"
              localFingerprint="6575059b"
              discoveryOnline
              podEnabled
              podReachable
              activePeerId="specimen-peer-1"
              peers={SPECIMEN_PEERS}
            />
          </CrtWindowFrame>
        </div>
      </CrtWindowFrame>

      {/* BLOCK 5: Interactive Component Kit Matrix */}
      <CrtWindowFrame title="05 // INTERACTIVE COMPONENT KIT MATRIX">
        <Tabs
          ariaLabel="Kategori komponen styleguide"
          activeTab={activeTab}
          onSelect={setActiveTab}
          tabs={[
            { id: 'controls', label: 'Buttons & Forms' },
            { id: 'states', label: 'Meters & States' },
            { id: 'stream', label: 'Terminal Stream' },
          ]}
        />

        {activeTab === 'controls' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)', marginTop: 'var(--space-xs)' }}>
            <div>
              <div className="ui-field__label" style={{ marginBottom: 'var(--space-xs)' }}>
                BUTTON VARIANTS (MIN 44X44PX TAP TARGET)
              </div>
              <div className="sg-row">
                <Button variant="primary">Hubungkan Peer</Button>
                <Button variant="cyan">Sinkronkan Pod</Button>
                <Button variant="secondary">Segarkan Daftar</Button>
                <Button variant="ghost">[ GANTI PROFIL ]</Button>
                <Button variant="danger">Putuskan Sesi</Button>
                <Button variant="primary" disabled>
                  Nonaktif
                </Button>
              </div>
            </div>

            <div className="sg-grid-2">
              <InputField
                label="Discovery Platform URL (Valid)"
                value={demoInput}
                onChange={(e) => setDemoInput(e.target.value)}
                helperText="Endpoint HTTP tempat peer mendaftarkan alamat LAN."
              />
              <InputField
                label="Target Peer ID (Validation Error)"
                value={demoInvalid}
                onChange={(e) => setDemoInvalid(e.target.value)}
                errorText="Peer ID harus diawali MCowBQYDK2Vw dan panjang kunci Ed25519 valid."
              />
            </div>

            <div className="sg-grid-2">
              <SelectField
                label="Metode Autentikasi Solid Pod"
                value={demoMode}
                onChange={(e) => setDemoMode(e.target.value)}
                options={[
                  { value: 'oidc', label: 'Browser Solid-OIDC (PKCE)' },
                  { value: 'account', label: 'Direct CSS Email & Password' },
                ]}
              />
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-xs)' }}>
                <Button variant="primary" onClick={() => setModalOpen(true)}>
                  Buka Dialog Modal (&lt;dialog&gt;)
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {activeTab === 'states' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)', marginTop: 'var(--space-xs)' }}>
            <div className="sg-row">
              <SyntaxTagBadge label="E2EE" meta="AES-256-GCM" tone="success" />
              <SyntaxTagBadge label="WEBID" meta="LINKED" tone="cyan" />
              <SyntaxTagBadge label="UNSYNCED" meta="2 SESSIONS" tone="warning" />
              <SyntaxTagBadge label="OFFLINE" meta="LOCAL-FIRST" tone="danger" />
            </div>

            <PixelHudMeter
              label="SOLID POD SYNC METER"
              valueText={`${meterValue}/10 SEGMENTS`}
              filledSegments={meterValue}
              tone="success"
            />
            <div className="sg-row">
              <Button size="sm" onClick={() => setMeterValue((v) => Math.max(0, v - 2))}>
                [-2 SEGMENTS]
              </Button>
              <Button size="sm" variant="cyan" onClick={() => setMeterValue((v) => Math.min(10, v + 2))}>
                [+2 SEGMENTS]
              </Button>
            </div>

            <div className="sg-grid-2">
              <StatusBanner
                title="Empty State: Belum Ada Peer"
                description="Discovery Platform belum melaporkan peer aktif lain di jaringan ini. Bagikan URL Discovery ke rekan satu LAN."
                actionLabel="Cek Ulang Peer"
                onAction={() => undefined}
              />
              <StatusBanner
                tone="error"
                title="Error State: Solid Pod Offline"
                description="Server Pod tidak merespons. Seluruh pesan tetap disimpan utuh di disk lokal dan akan diunggah saat Pod kembali online."
                actionLabel="Coba Sync Ulang"
                onAction={() => undefined}
              />
            </div>
          </div>
        ) : null}

        {activeTab === 'stream' ? (
          <div style={{ marginTop: 'var(--space-xs)' }}>
            <NumberedTerminalStream messages={SPECIMEN_MESSAGES} localDisplayName="local-node" />
          </div>
        ) : null}
      </CrtWindowFrame>

      {/* BLOCK 6: Mini-Section Composition Test */}
      <CrtWindowFrame
        title="06 // MINI-SECTION COMPOSITION TEST"
        active
        statusBarLeft="VALIDASI PROPORSI KOMPONEN SEBELUM PERAKITAN HALAMAN PENUH"
      >
        <div className="sg-grid-2" style={{ alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
            <SyntaxTagBadge label="LOCAL-FIRST + POD VAULT" meta="SCHEMA.ORG JSON-LD" tone="magenta" />
            <h3
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(1.15rem, 2.2vw, 1.6rem)',
                margin: 0,
              }}
            >
              KOMUNIKASI LANGSUNG ANTAR PEER TANPA SERVER PENYIMPAN PESAN
            </h3>
            <p style={{ margin: 0, color: 'var(--ink-secondary)' }}>
              Discovery Platform hanya mempertemukan IP dan port. Enkripsi terjadi ujung-ke-ujung di
              perangkat Anda, sementara arsip percakapan berada di bawah kendali disk lokal dan Solid Pod
              milik Anda sendiri.
            </p>
            <div className="sg-row">
              <Button variant="primary" onClick={onNavigateConsole}>
                Masuk ke Console P2Pod
              </Button>
              <Button variant="secondary" onClick={() => setModalOpen(true)}>
                Inspeksi Dialog
              </Button>
            </div>
          </div>
          <PeerTopologyGraph
            localName="p2pod"
            localFingerprint="6575059b"
            discoveryOnline
            podEnabled
            podReachable
            activePeerId="specimen-peer-1"
            peers={SPECIMEN_PEERS}
          />
        </div>
      </CrtWindowFrame>

      <ModalDialog
        open={modalOpen}
        title="SPECIMEN // ACCESSIBLE DIALOG"
        onClose={() => setModalOpen(false)}
      >
        <p style={{ margin: 0, color: 'var(--ink-secondary)' }}>
          Dialog ini menggunakan elemen HTML asli &lt;dialog&gt;, memindahkan fokus saat dibuka,
          menangkap tombol Escape, dan mengembalikan fokus ke tombol pemicu saat ditutup.
        </p>
        <div className="sg-row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="primary" onClick={() => setModalOpen(false)}>
            Tutup Specimen
          </Button>
        </div>
      </ModalDialog>
    </main>
  );
}
