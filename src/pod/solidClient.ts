// src/pod/solidClient.ts

import * as fs from 'fs';
import * as path from 'path';
import { Session } from '@inrupt/solid-client-authn-node';
import { getContainedResourceUrlAll, getSolidDataset } from '@inrupt/solid-client';

export interface PodCredentials {
  oidcIssuer: string;
  clientId: string;
  clientSecret: string;
  webId?: string;
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
  remoteDisplayName: string;
  remotePeerId: string;
  startedAt: string;
  endedAt: string;
}

export interface StoredMessage {
  senderName: string;
  timestamp: number;
  text: string;
}

export class SolidClient {
  private readonly session = new Session({ keepAlive: false });
  private readonly podUrl: string;
  private readonly credentials: PodCredentials;
  private loggedIn = false;

  constructor(homeDir: string, podUrl: string) {
    const configPath = path.join(homeDir, 'pod-config.json');
    if (!fs.existsSync(configPath)) {
      throw new Error(
        `Konfigurasi Pod tidak ditemukan di ${configPath}. Jalankan dulu: npm run setup:pod`
      );
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<PodCredentials>;
    if (!config.clientId || !config.clientSecret || !config.oidcIssuer) {
      throw new Error('pod-config.json tidak lengkap (butuh clientId, clientSecret, oidcIssuer)');
    }

    this.podUrl = podUrl.endsWith('/') ? podUrl : `${podUrl}/`;
    this.credentials = {
      oidcIssuer: config.oidcIssuer,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      webId: config.webId,
    };
  }

  async login(): Promise<void> {
    if (this.loggedIn) return;

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

  async logout(): Promise<void> {
    if (!this.loggedIn) return;
    await this.session.logout();
    this.loggedIn = false;
  }

  async saveChatSession(chatId: string, meta: ChatSessionMeta, history: HistoryEntry[]): Promise<string> {
    await this.login();
    await this.ensureChatContainers(chatId);

    const sessionFile = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

    const sessionDoc = {
      '@context': 'https://schema.org/',
      '@type': 'Conversation',
      identifier: chatId,
      dateCreated: meta.startedAt,
      dateModified: meta.endedAt,
      participants: [
        { '@type': 'Person', name: meta.localDisplayName, identifier: meta.localPeerId },
        { '@type': 'Person', name: meta.remoteDisplayName, identifier: meta.remotePeerId },
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
      lastActivityAt: meta.endedAt,
    };

    await this.putJson(`${this.chatBase(chatId)}sessions/${sessionFile}`, sessionDoc);
    await this.putJson(`${this.chatBase(chatId)}metadata.json`, metadata);
    return sessionFile;
  }

  async loadChatSession(chatId: string): Promise<StoredMessage[]> {
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

    const messages: StoredMessage[] = [];
    for (const url of sessionUrls) {
      const response = await this.authFetch(url);
      if (!response.ok) {
        await response.text().catch(() => undefined);
        continue;
      }
      const doc = (await response.json()) as { messages?: unknown };
      if (!Array.isArray(doc.messages)) continue;
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
