// src/net/messageFramer.ts

import { AnyMessage } from '../types/messages';
import { EventEmitter } from 'events';

export class MessageFramer extends EventEmitter {
  private buffer: Buffer = Buffer.alloc(0);

  // Encode AnyMessage -> Buffer dengan format [4-byte length][JSON payload]
  encode(msg: AnyMessage): Buffer {
    const json = JSON.stringify(msg);
    const payload = Buffer.from(json, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    return Buffer.concat([header, payload]);
  }

  // Feed chunk data dari socket, emit 'message' saat satu JSON utuh terbaca
  feed(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + length) {
        // belum cukup data
        return;
      }

      const payload = this.buffer.slice(4, 4 + length);
      this.buffer = this.buffer.slice(4 + length);

      try {
        const jsonStr = payload.toString('utf8');
        const msg = JSON.parse(jsonStr) as AnyMessage;
        this.emit('message', msg);
      } catch (err) {
        this.emit('error', err);
      }
    }
  }
}
