// src/net/tcpConnection.ts

import * as net from 'net';
import { EventEmitter } from 'events';
import { AnyMessage } from '../types/messages';
import { MessageFramer } from './messageFramer';

export class ManagedConnection extends EventEmitter {
  private socket: net.Socket;
  private framer: MessageFramer;

  constructor(socket: net.Socket) {
    super();
    this.socket = socket;
    this.framer = new MessageFramer();

    this.socket.on('data', (chunk) => this.framer.feed(chunk));
    this.socket.on('close', () => this.emit('close'));
    this.socket.on('error', (err) => this.emit('error', err));

    this.framer.on('message', (msg: AnyMessage) => this.emit('message', msg));
    this.framer.on('error', (err) => this.emit('error', err));
  }

  send(msg: AnyMessage) {
    const buf = this.framer.encode(msg);
    this.socket.write(buf);
  }

  close() {
    this.socket.end();
    this.socket.destroy();
  }
}

export class TcpConnectionManager {
  private server: net.Server | null = null;

  /** Mulai mendengarkan; resolve dengan port aktual yang di-bind. */
  listen(port: number, onConnection: (conn: ManagedConnection) => void): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        const conn = new ManagedConnection(socket);
        onConnection(conn);
      });

      this.server.once('error', reject);
      this.server.listen(port, () => {
        const address = this.server?.address();
        resolve(typeof address === 'object' && address ? address.port : port);
      });
    });
  }

  closeServer() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  connect(host: string, port: number): Promise<ManagedConnection> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(port, host, () => {
        const conn = new ManagedConnection(socket);
        resolve(conn);
      });

      socket.on('error', (err) => {
        reject(err);
      });
    });
  }
}
