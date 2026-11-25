import React from 'react';
import { OnlinePeerItem } from '../../types/bridge';

export interface PeerTopologyGraphProps {
  localName: string;
  localFingerprint: string;
  discoveryOnline: boolean;
  podEnabled: boolean;
  podReachable: boolean;
  activePeerId?: string | null;
  connectingPeerId?: string | null;
  peers: OnlinePeerItem[];
  onSelectPeer?: (peer: OnlinePeerItem) => void;
}

export function PeerTopologyGraph({
  localName,
  localFingerprint,
  discoveryOnline,
  podEnabled,
  podReachable,
  activePeerId,
  connectingPeerId,
  peers,
  onSelectPeer,
}: PeerTopologyGraphProps): React.ReactElement {
  const visiblePeers = peers.slice(0, 5);
  const centerX = 140;
  const centerY = 108;

  const peerAnchors = [
    { x: 242, y: 44 },
    { x: 252, y: 108 },
    { x: 238, y: 172 },
    { x: 158, y: 184 },
    { x: 64, y: 174 },
  ];

  const podX = 48;
  const podY = 50;
  const discX = 140;
  const discY = 30;

  return (
    <div
      style={{
        backgroundColor: 'var(--surface-canvas)',
        border: '1px solid var(--border-subtle)',
        padding: 'var(--space-xs)',
      }}
    >
      <svg
        viewBox="0 0 290 212"
        width="100%"
        role="img"
        aria-label={`Topologi jaringan untuk ${localName}: ${peers.length} peer terdeteksi`}
        style={{ display: 'block', height: 'auto' }}
      >
        {/* Garis ke Discovery */}
        <line
          x1={centerX}
          y1={centerY}
          x2={discX}
          y2={discY}
          stroke={discoveryOnline ? 'var(--accent-secondary)' : 'var(--border-subtle)'}
          strokeWidth={2}
          strokeDasharray={discoveryOnline ? undefined : '4 4'}
        />

        {/* Garis ke Solid Pod Vault */}
        <line
          x1={centerX}
          y1={centerY}
          x2={podX}
          y2={podY}
          stroke={
            !podEnabled
              ? 'var(--border-subtle)'
              : podReachable
                ? 'var(--status-success)'
                : 'var(--status-warning)'
          }
          strokeWidth={2}
          strokeDasharray={podEnabled && podReachable ? undefined : '3 3'}
        />

        {/* Garis ke masing-masing Peer */}
        {visiblePeers.map((peer, idx) => {
          const pos = peerAnchors[idx];
          const isActive = activePeerId === peer.peerId;
          const isConnecting = connectingPeerId === peer.peerId;
          const stroke = isActive
            ? 'var(--status-success)'
            : isConnecting
              ? 'var(--status-warning)'
              : 'var(--border-default)';
          return (
            <line
              key={`edge-${peer.peerId}`}
              x1={centerX}
              y1={centerY}
              x2={pos.x}
              y2={pos.y}
              stroke={stroke}
              strokeWidth={isActive ? 3 : 1.75}
              strokeDasharray={isConnecting ? '4 3' : undefined}
            />
          );
        })}

        {/* Node Discovery */}
        <g>
          <rect
            x={discX - 10}
            y={discY - 10}
            width={20}
            height={20}
            fill={discoveryOnline ? 'var(--accent-secondary)' : 'var(--surface-muted)'}
            stroke="var(--border-default)"
            strokeWidth={1.5}
          />
          <text
            x={discX}
            y={discY - 14}
            textAnchor="middle"
            fill="var(--ink-secondary)"
            fontSize="9"
            fontFamily="var(--font-mono)"
          >
            DISCOVERY
          </text>
        </g>

        {/* Node Solid Pod */}
        <g>
          <rect
            x={podX - 10}
            y={podY - 10}
            width={20}
            height={20}
            fill={
              !podEnabled
                ? 'var(--surface-muted)'
                : podReachable
                  ? 'var(--status-success)'
                  : 'var(--status-warning)'
            }
            stroke="var(--border-default)"
            strokeWidth={1.5}
          />
          <text
            x={podX}
            y={podY + 22}
            textAnchor="middle"
            fill="var(--ink-secondary)"
            fontSize="9"
            fontFamily="var(--font-mono)"
          >
            {podEnabled ? 'SOLID POD' : 'LOCAL ONLY'}
          </text>
        </g>

        {/* Node Peer Online */}
        {visiblePeers.map((peer, idx) => {
          const pos = peerAnchors[idx];
          const isActive = activePeerId === peer.peerId;
          const isConnecting = connectingPeerId === peer.peerId;
          const fill = isActive
            ? 'var(--status-success)'
            : isConnecting
              ? 'var(--status-warning)'
              : 'var(--accent-tertiary)';
          const label = (peer.displayName ?? peer.fingerprint.slice(0, 6)).slice(0, 10);

          return (
            <g
              key={`node-${peer.peerId}`}
              onClick={() => onSelectPeer?.(peer)}
              style={{ cursor: onSelectPeer ? 'pointer' : 'default' }}
            >
              <circle
                cx={pos.x}
                cy={pos.y}
                r={isActive ? 11 : 9}
                fill={fill}
                stroke="var(--ink-primary)"
                strokeWidth={isActive ? 2 : 1}
              />
              <text
                x={pos.x}
                y={pos.y + 21}
                textAnchor="middle"
                fill="var(--ink-primary)"
                fontSize="9.5"
                fontFamily="var(--font-mono)"
              >
                {label}
              </text>
            </g>
          );
        })}

        {/* Node Lokal (Pusat) */}
        <g>
          <circle
            cx={centerX}
            cy={centerY}
            r={14}
            fill="var(--accent-primary)"
            stroke="var(--ink-primary)"
            strokeWidth={2}
          />
          <text
            x={centerX}
            y={centerY + 26}
            textAnchor="middle"
            fill="var(--ink-primary)"
            fontSize="10"
            fontWeight="700"
            fontFamily="var(--font-mono)"
          >
            {`${localName.slice(0, 10)} [${localFingerprint.slice(0, 4)}]`}
          </text>
        </g>
      </svg>
    </div>
  );
}
