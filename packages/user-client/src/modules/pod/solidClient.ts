// packages/user-client/src/modules/pod/solidClient.ts

import * as fs from 'fs';
import * as path from 'path';
import { Session } from '@inrupt/solid-client-authn-node';
import { getContainedResourceUrlAll, getSolidDataset } from '@inrupt/solid-client';
import { Identity, verifyWithPeerId } from '../../identity/identity';
import { OIDC_SESSION_ID, restoreOidcSession } from './solidAuth';

export interface PodCredentials {
  authMode?: 'clientCredentials' | 'oidc';
  oidcIssuer: string;
  podUrl?: string;
  webId?: string;
  clientId?: string;
  clientSecret?: string;
  sessionId?: string;
}

export interface HistoryEntry {
  direction: 'sent' | 'received';
  displayName: string;
  text: string;
  timestamp: number;
  seq: number;
}

export interface ChatSessionMeta {
  chatId: string;
  localDisplayName: string;
  localPeerId: string;
  localWebId?: string;
  remoteDisplayName: string;
  remotePeerId: string;
  remoteWebId?: string;
  startedAt: string;
  endedAt: string;
}

export interface StoredMessage {
  senderName: string;
  timestamp: number;
  text: string;
  direction?: 'sent' | 'received';
  seq?: number;
}

export interface IdentityLinkDoc {
  '@context': string;
  '@type': 'Person';
  '@id': string;
  name: string;
  identifier: string;
  publicKey: {
    '@type': 'CryptographicKey';
    id: string;
    owner: string;
    peerId: string;
    fingerprint: string;
    publicKeyPem: string;
  };
  proof: {
    type: 'Ed25519Signature2020';
    created: string;
    verificationMethod: string;
    claim: string;
    signature: string;
  };
}

const IDENTITY_LINK_LABEL = 'p2pod-webid-link-v1';

export function buildIdentityLinkClaim(webId: string, peerId: string): string {
  return `${IDENTITY_LINK_LABEL}|${webId}|${peerId}`;
}

export function verifyIdentityLinkDoc(doc: IdentityLinkDoc): boolean {
  if (!doc || !doc['@id'] || !doc.identifier || !doc.proof?.claim || !doc.proof?.signature) {
    return false;
  }
  const expectedClaim = buildIdentityLinkClaim(doc['@id'], doc.identifier);
  if (doc.proof.claim !== expectedClaim) return false;
  return verifyWithPeerId(
    doc.identifier,
    Buffer.from(doc.proof.claim, 'utf8'),
    Buffer.from(doc.proof.signature, 'base64')
  );
}

export class SolidClient {
  private session = new Session({ keepAlive: false });
  private readonly homeDir: string;
  private readonly podUrl: string;
  private readonly credentials: PodCredentials;
  private loggedIn = false;

  constructor(homeDir: string, podUrl?: string) {
    this.homeDir = homeDir;
    const configPath = path.join(homeDir, 'pod-config.json');
    if (!fs.existsSync(configPath)) {
      throw new Error(
        `Konfigurasi Pod tidak ditemukan di ${configPath}. Jalankan dulu: npm run pod:login atau npm run setup:pod`
      );
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<PodCredentials>;
    const authMode =
      config.authMode ?? (config.sessionId && !config.clientSecret ? 'oidc' : 'clientCredentials');

    if (!config.oidcIssuer) {
      throw new Error('pod-config.json tidak lengkap (butuh oidcIssuer)');
    }
    if (authMode === 'clientCredentials' && (!config.clientId || !config.clientSecret)) {
      throw new Error('pod-config.json tidak lengkap (mode clientCredentials butuh clientId & clientSecret)');
    }

    const resolvedPodUrl = podUrl ?? config.podUrl;
    if (!resolvedPodUrl) {
      throw new Error('URL Pod tidak ditemukan di parameter maupun pod-config.json');
    }

    this.podUrl = resolvedPodUrl.endsWith('/') ? resolvedPodUrl : `${resolvedPodUrl}/`;
    this.credentials = {
      authMode,
      oidcIssuer: config.oidcIssuer,
      podUrl: this.podUrl,
      webId: config.webId,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      sessionId: config.sessionId ?? OIDC_SESSION_ID,
    };
  }

  get webId(): string | undefined {
    return this.session.info.webId ?? this.credentials.webId;
  }

  get oidcIssuer(): string {
    return this.credentials.oidcIssuer;
  }

  get authMode(): 'clientCredentials' | 'oidc' {
    return this.credentials.authMode ?? 'clientCredentials';
  }

  get basePodUrl(): string {
    return this.podUrl;
  }

  async login(): Promise<void> {
    if (this.loggedIn) return;

    if (this.authMode === 'oidc') {
      this.session = await restoreOidcSession(this.homeDir, this.credentials.sessionId);
      this.loggedIn = true;
      return;
    }

    await this.session.login({
      clientId: this.credentials.clientId,
      clientSecret: this.credentials.clientSecret,
      oidcIssuer: this.credentials.oidcIssuer,
    });

    if (!this.session.info.isLoggedIn) {
      throw new Error('Login ke Solid Pod gagal (client credentials ditolak)');
    }
    this.loggedIn = true;
  }

  /** Cek cepat apakah server Pod merespons (status HTTP apa pun dianggap hidup). */
  async ping(): Promise<boolean> {
    try {
      const response = await fetch(this.podUrl, { signal: AbortSignal.timeout(4000) });
      await response.text().catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }

  async logout(): Promise<void> {
    if (!this.loggedIn) return;
    await this.session.logout();
    this.loggedIn = false;
  }

  /**
   * Tautkan (link) identitas kriptografis P2Pod (Ed25519 Peer ID) dengan WebID Solid Pod.
   * Menyimpan dokumen bukti tanda tangan JSON-LD ke <podUrl>/p2pod/identity-link.json.
   */
  async linkIdentity(identity: Identity): Promise<IdentityLinkDoc> {
    await this.login();
    await this.ensureContainer(`${this.podUrl}p2pod/`);

    const webId = this.webId ?? `${this.podUrl}profile/card#me`;
    const claim = buildIdentityLinkClaim(webId, identity.peerId);
    const signature = identity.sign(Buffer.from(claim, 'utf8')).toString('base64');
    const now = new Date().toISOString();

    const doc: IdentityLinkDoc = {
      '@context': 'https://schema.org/',
      '@type': 'Person',
      '@id': webId,
      name: identity.displayName,
      identifier: identity.peerId,
      publicKey: {
        '@type': 'CryptographicKey',
        id: `${webId}#p2pod-ed25519`,
        owner: webId,
        peerId: identity.peerId,
        fingerprint: identity.fingerprint,
        publicKeyPem: identity.publicKeyPem,
      },
      proof: {
        type: 'Ed25519Signature2020',
        created: now,
        verificationMethod: identity.peerId,
        claim,
        signature,
      },
    };

    await this.putJson(this.identityLinkUrl(), doc);
    return doc;
  }

  /**
   * Muat dan verifikasi dokumen tautan identitas (<podUrl>/p2pod/identity-link.json) dari Solid Pod.
   */
  async loadIdentityLink(): Promise<IdentityLinkDoc | null> {
    await this.login();
    const response = await this.authFetch(this.identityLinkUrl());
    if (response.status === 404) {
      await response.text().catch(() => undefined);
      return null;
    }
    if (!response.ok) {
      await response.text().catch(() => undefined);
      throw new Error(`Gagal membaca identity-link.json (HTTP ${response.status})`);
    }
    const doc = (await response.json()) as IdentityLinkDoc;
    if (!verifyIdentityLinkDoc(doc)) {
      throw new Error('Tanda tangan kriptografis pada identity-link.json di Solid Pod TIDAK VALID.');
    }
    return doc;
  }

  identityLinkUrl(): string {
    return `${this.podUrl}p2pod/identity-link.json`;
  }

  async saveRawSessionDocument(chatId: string, sessionFileName: string, sessionDoc: unknown): Promise<void> {
    await this.login();
    await this.ensureChatContainers(chatId);
    await this.putJson(`${this.chatBase(chatId)}sessions/${sessionFileName}`, sessionDoc);
  }

  async saveChatMetadata(chatId: string, metadata: unknown): Promise<void> {
    await this.login();
    await this.ensureChatContainers(chatId);
    await this.putJson(`${this.chatBase(chatId)}metadata.json`, metadata);
  }

  async listChatSessionFiles(chatId: string): Promise<{ url: string; fileName: string }[]> {
    await this.login();

    const sessionsUrl = `${this.chatBase(chatId)}sessions/`;
    const probe = await this.authFetch(sessionsUrl);
    await probe.text().catch(() => undefined);
    if (probe.status === 404) return [];
    if (!probe.ok) {
      throw new Error(`Gagal membaca container ${sessionsUrl} (HTTP ${probe.status})`);
    }

    const dataset = await getSolidDataset(sessionsUrl, { fetch: this.authFetch as any });
    const sessionUrls = getContainedResourceUrlAll(dataset)
      .filter((url) => url.endsWith('.json'))
      .sort();

    return sessionUrls.map((url) => {
      const fileName = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      return { url, fileName };
    });
  }

  async fetchRawJson(url: string): Promise<any | null> {
    await this.login();
    const response = await this.authFetch(url);
    if (!response.ok) {
      await response.text().catch(() => undefined);
      return null;
    }
    return response.json();
  }

  async saveChatSession(chatId: string, meta: ChatSessionMeta, history: HistoryEntry[]): Promise<string> {
    const sessionFile = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const localWebId = meta.localWebId ?? this.webId;

    const sessionDoc = {
      '@context': 'https://schema.org/',
      '@type': 'Conversation',
      identifier: chatId,
      dateCreated: meta.startedAt,
      dateModified: meta.endedAt,
      participants: [
        {
          '@type': 'Person',
          ...(localWebId ? { '@id': localWebId } : {}),
          name: meta.localDisplayName,
          identifier: meta.localPeerId,
        },
        {
          '@type': 'Person',
          ...(meta.remoteWebId ? { '@id': meta.remoteWebId } : {}),
          name: meta.remoteDisplayName,
          identifier: meta.remotePeerId,
        },
      ],
      messages: history.map((entry, index) => ({
        '@type': 'Message',
        identifier: `msg-${String(index + 1).padStart(3, '0')}`,
        sender: entry.displayName,
        direction: entry.direction,
        dateCreated: new Date(entry.timestamp).toISOString(),
        text: entry.text,
      })),
    };

    const metadata = {
      '@context': 'https://schema.org/',
      '@type': 'Conversation',
      identifier: chatId,
      with: meta.remoteDisplayName,
      withPeerId: meta.remotePeerId,
      ...(meta.remoteWebId ? { withWebId: meta.remoteWebId } : {}),
      ...(localWebId ? { ownerWebId: localWebId } : {}),
      lastActivityAt: meta.endedAt,
    };

    await this.saveRawSessionDocument(chatId, sessionFile, sessionDoc);
    await this.saveChatMetadata(chatId, metadata);
    return sessionFile;
  }

  async loadChatSession(chatId: string): Promise<StoredMessage[]> {
    const sessionFiles = await this.listChatSessionFiles(chatId);
    if (sessionFiles.length === 0) return [];

    const messages: StoredMessage[] = [];
    for (const { url } of sessionFiles) {
      const doc = await this.fetchRawJson(url);
      if (!doc || !Array.isArray(doc.messages)) continue;
      for (const raw of doc.messages as any[]) {
        messages.push({
          senderName: String(raw?.sender ?? 'unknown'),
          timestamp: Date.parse(String(raw?.dateCreated)) || Date.now(),
          text: String(raw?.text ?? ''),
        });
      }
    }

    messages.sort((a, b) => a.timestamp - b.timestamp);
    return messages;
  }

  private chatBase(chatId: string): string {
    return `${this.podUrl}p2pod/chats/${chatId}/`;
  }

  private get authFetch(): typeof fetch {
    return this.session.fetch.bind(this.session) as unknown as typeof fetch;
  }

  private async ensureChatContainers(chatId: string): Promise<void> {
    await this.ensureContainer(`${this.podUrl}p2pod/`);
    await this.ensureContainer(`${this.podUrl}p2pod/chats/`);
    await this.ensureContainer(this.chatBase(chatId));
    await this.ensureContainer(`${this.chatBase(chatId)}sessions/`);
  }

  private async ensureContainer(url: string): Promise<void> {
    const probe = await this.authFetch(url);
    await probe.text().catch(() => undefined);

    if (probe.ok) return; // container sudah ada
    if (probe.status !== 404) {
      throw new Error(`Gagal memeriksa container ${url} (HTTP ${probe.status})`);
    }

    const response = await this.authFetch(url, {
      method: 'PUT',
      headers: {
        'content-type': 'text/turtle',
        link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
      },
      body: '',
    });
    await response.text().catch(() => undefined);

    // 205/409 = container sudah dibuat pihak lain (race) — dianggap sukses
    if (!response.ok && response.status !== 205 && response.status !== 409) {
      throw new Error(`Gagal membuat container ${url} (HTTP ${response.status})`);
    }
  }

  private async putJson(url: string, data: unknown): Promise<void> {
    const response = await this.authFetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/ld+json' },
      body: JSON.stringify(data, null, 2),
    });
    await response.text().catch(() => undefined);

    if (!response.ok) {
      throw new Error(`Gagal menulis ${url} (HTTP ${response.status})`);
    }
  }
}
