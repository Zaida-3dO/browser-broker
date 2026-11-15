// A minimal RFC 6455 WebSocket over a plain TCP socket.
//
// The relay needs a WebSocket *server* (the extension and Playwright both
// connect to one), and the tests need a client that can present an arbitrary
// `Origin` header — which the platform `WebSocket` does not allow. The package
// deliberately keeps `ws` out of its dependency set, so the framing lives here:
// text frames, fragmentation, ping/pong and close, and nothing else. Both
// directions run through this one implementation — the server end expects
// masked client frames, the client end masks its own — so a framing bug cannot
// hide on one side of a test.

import crypto from 'node:crypto';
import net from 'node:net';
import type { IncomingMessage } from 'node:http';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Above this, a message is treated as hostile rather than large (close 1009). */
const DEFAULT_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export interface WebSocketConnectionOptions {
  /** Frames arriving on this socket must carry a mask (true on the server end). */
  maskIncoming: boolean;
  /** Frames leaving this socket are masked (true on the client end). */
  maskOutgoing?: boolean;
  /** Bytes already read from the socket after the handshake. */
  head?: Buffer;
  maxMessageBytes?: number;
}

/**
 * One WebSocket connection over a connected TCP socket, already handshaked.
 * Callbacks are set, not subscribed: `onMessage`, `onClose` fire at most once
 * each for the life of the connection.
 */
export class WebSocketConnection {
  onMessage: ((text: string) => void) | undefined;
  onClose: ((reason: string) => void) | undefined;

  readonly _socket: net.Socket;
  private readonly _maskIncoming: boolean;
  private readonly _maskOutgoing: boolean;
  private readonly _maxMessageBytes: number;
  private _buffer: Buffer;
  /** Payloads of a fragmented message, awaiting its final frame. */
  private _fragments: Buffer[] | null = null;
  private _closing = false;
  private _closed = false;
  private _closedReason = '';
  private _closeWaiters: ((reason: string) => void)[] = [];

  constructor(socket: net.Socket, options: WebSocketConnectionOptions) {
    this._socket = socket;
    this._maskIncoming = options.maskIncoming;
    this._maskOutgoing = options.maskOutgoing ?? false;
    this._maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this._buffer = options.head && options.head.length > 0 ? options.head : Buffer.alloc(0);

    this._socket.on('data', (chunk: Buffer) => {
      this._buffer = Buffer.concat([this._buffer, chunk]);
      this._drain();
    });
    this._socket.on('close', () => this._fireClose(''));
    this._socket.on('error', () => this._fireClose(''));
    if (this._buffer.length > 0) this._drain();
  }

  get readyState(): 'open' | 'closing' | 'closed' {
    if (this._closed) return 'closed';
    return this._closing ? 'closing' : 'open';
  }

  send(text: string): void {
    if (this.readyState !== 'open') return;
    const payload = Buffer.from(text, 'utf8');
    this._socket.write(this._frame(0x1, payload, true));
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState !== 'open') return;
    this._closing = true;
    const body = Buffer.alloc(2 + Buffer.from(reason, 'utf8').length);
    body.writeUInt16BE(code, 0);
    body.write(reason, 2, 'utf8');
    // A control frame is always FIN, and _frame is the one place that sets it.
    this._socket.write(this._frame(0x8, body, true));
    this._socket.end();
    this._fireClose(reason);
  }

  /** Send a close frame with the given status and drop the socket. */
  private _fail(code: number, reason: string): void {
    if (!this._closing) {
      this._closing = true;
      const body = Buffer.alloc(2 + Buffer.from(reason, 'utf8').length);
      body.writeUInt16BE(code, 0);
      body.write(reason, 2, 'utf8');
      try {
        this._socket.write(this._frame(0x8, body, true));
      } catch {
        // The socket is already failing; the close we are reporting is the failure.
      }
      this._socket.destroy();
    }
    this._fireClose(reason);
  }

  private _fireClose(reason: string): void {
    if (this._closed) return;
    this._closed = true;
    this._closedReason = reason;
    const waiters = this._closeWaiters;
    this._closeWaiters = [];
    this.onClose?.(reason);
    for (const resolve of waiters) resolve(reason);
  }

  /**
   * Resolves with the close reason — whenever the close happened, including
   * before this was called. `onClose` only fires once, at the moment, so a
   * test that attaches its assertion a tick late still sees the fact.
   */
  onceClosed(): Promise<string> {
    if (this._closed) return Promise.resolve(this._closedReason);
    return new Promise((resolve) => {
      this._closeWaiters.push(resolve);
    });
  }

  private _frame(opcode: number, payload: Buffer, fin: boolean): Buffer {
    const head = this._frameHead(opcode | (fin ? 0x80 : 0), payload.length);
    return Buffer.concat([head, this._masked(payload)]);
  }

  private _masked(payload: Buffer): Buffer {
    if (!this._maskOutgoing) return payload;
    const mask = crypto.randomBytes(4);
    const out = Buffer.alloc(4 + payload.length);
    mask.copy(out, 0);
    payload.copy(out, 4);
    for (let i = 0; i < payload.length; i++) {
      out[4 + i] = (out[4 + i] as number) ^ (mask[i % 4] as number);
    }
    return out;
  }

  private _frameHead(opcodeWithFin: number, length: number): Buffer {
    // On the wire, the mask bit is in the second byte; masked frames set it in
    // _masked's prefix instead, so the head carries length encoding only.
    const maskBit = this._maskOutgoing ? 0x80 : 0;
    if (length < 126) return Buffer.from([opcodeWithFin, maskBit | length]);
    if (length <= 0xffff) {
      const b = Buffer.alloc(4);
      b[0] = opcodeWithFin;
      b[1] = maskBit | 126;
      b.writeUInt16BE(length, 2);
      return b;
    }
    const b = Buffer.alloc(10);
    b[0] = opcodeWithFin;
    b[1] = maskBit | 127;
    b.writeBigUInt64BE(BigInt(length), 2);
    return b;
  }

  private _drain(): void {
    for (;;) {
      const b = this._buffer;
      if (b.length < 2) return;
      const fin = ((b[0] as number) & 0x80) !== 0;
      const opcode = (b[0] as number) & 0x0f;
      const masked = ((b[1] as number) & 0x80) !== 0;
      let length = (b[1] as number) & 0x7f;
      let header = 2;
      if (length === 126) {
        if (b.length < 4) return;
        length = b.readUInt16BE(2);
        header = 4;
      } else if (length === 127) {
        if (b.length < 10) return;
        if ((b[2] as number) & 0x80) return this._fail(1002, 'frame length must fit');
        length = Number(b.readBigUInt64BE(2));
        header = 10;
      }
      if (length > this._maxMessageBytes) return this._fail(1009, 'message too large');
      if (opcode >= 0x8) {
        if (!fin || length > 125) return this._fail(1002, 'bad control frame');
      }
      if (this._maskIncoming && !masked) return this._fail(1002, 'client frames must be masked');
      let maskKey: Buffer | null = null;
      if (masked) {
        if (b.length < header + 4) return;
        maskKey = b.subarray(header, header + 4);
        header += 4;
      }
      if (b.length < header + length) return;
      const payload = b.subarray(header, header + length);
      const unmasked = Buffer.from(payload);
      if (maskKey) {
        for (let i = 0; i < unmasked.length; i++) {
          unmasked[i] = (unmasked[i] as number) ^ (maskKey[i % 4] as number);
        }
      }
      this._buffer = b.subarray(header + length);
      if (!this._handleFrame(fin, opcode, unmasked)) return;
    }
  }

  /** Returns false when the connection was failed and draining must stop. */
  private _handleFrame(fin: boolean, opcode: number, payload: Buffer): boolean {
    switch (opcode) {
      case 0x0: {
        // Continuation.
        if (!this._fragments) {
          this._fail(1002, 'unexpected continuation frame');
          return false;
        }
        this._fragments.push(payload);
        if (fin) this._dispatchFragmented();
        return true;
      }
      case 0x1: {
        if (fin) {
          this.onMessage?.(payload.toString('utf8'));
          return true;
        }
        this._fragments = [payload];
        return true;
      }
      case 0x2:
        this._fail(1003, 'binary frames are not used here');
        return false;
      case 0x8: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (!this._closing) {
          this._closing = true;
          // Echo the close, then let the socket fall shut.
          const body = Buffer.alloc(2);
          body.writeUInt16BE(code === 1005 || code === 1006 ? 1000 : code, 0);
          try {
            this._socket.write(this._frame(0x8, body, true));
          } catch {
            // Failing shut is still shutting.
          }
        }
        this._socket.destroy();
        this._fireClose(reason);
        return false;
      }
      case 0x9:
        if (this.readyState === 'open') this._socket.write(this._frame(0xa, payload, true));
        return true;
      case 0xa:
        return true; // pong: the socket is alive, which the read proves.
      default:
        this._fail(1002, 'unknown opcode');
        return false;
    }
  }

  private _dispatchFragmented(): void {
    const parts = this._fragments as Buffer[];
    this._fragments = null;
    this.onMessage?.(Buffer.concat(parts).toString('utf8'));
  }
}

/** The `Sec-WebSocket-Accept` value for a key, per RFC 6455 §1.3. */
export function acceptKey(key: string): string {
  return crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

/**
 * Complete a server-side handshake already validated by the caller (path,
 * Host, Origin all checked before this is reached) and wrap the socket.
 * Returns null — after replying — when the request is not a usable upgrade.
 */
export function completeServerHandshake(
  request: IncomingMessage,
  socket: import('node:stream').Duplex,
  head: Buffer,
): WebSocketConnection | null {
  const key = request.headers['sec-websocket-key'];
  const version = request.headers['sec-websocket-version'];
  if (typeof key !== 'string' || version !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return null;
  }
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  return new WebSocketConnection(socket as net.Socket, { maskIncoming: true, head });
}

export function rejectUpgrade(socket: import('node:stream').Duplex, status: number): void {
  const reason = status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Bad Request';
  socket.write(`HTTP/1.1 ${status} ${reason}\r\n\r\n`);
  socket.destroy();
}

/**
 * A client-side handshake that can carry headers the platform `WebSocket`
 * will not (an arbitrary `Origin`, a missing upgrade header, a bogus key) —
 * which is exactly what the refusal tests need. On anything other than a
 * 101 it throws, carrying the status code on the error.
 */
export function connectWebSocket(
  url: string,
  headers: Record<string, string> = {},
): Promise<WebSocketConnection> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const port = Number(target.port);
    const socket = net.connect(port, target.hostname);
    let settled = false;
    let buffer = Buffer.alloc(0);
    const key = crypto.randomBytes(16).toString('base64');
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.on('error', (error) => fail(error));
    socket.once('connect', () => {
      const overridesHost = Object.keys(headers).some((name) => name.toLowerCase() === 'host');
      const lines = [
        `GET ${target.pathname}${target.search} HTTP/1.1`,
        ...(overridesHost ? [] : [`Host: ${target.hostname}:${port}`]),
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
      ];
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = buffer.subarray(0, end).toString('latin1');
      const rest = buffer.subarray(end + 4);
      const statusLine = head.split('\r\n')[0] ?? '';
      const status = Number(statusLine.split(' ')[1]);
      if (status !== 101) {
        const error = new Error(`handshake refused: ${status}`) as Error & {
          statusCode?: number;
        };
        error.statusCode = status;
        fail(error);
        return;
      }
      // A 101 that did not prove knowledge of our key is not a handshake.
      const acceptLine = head
        .split('\r\n')
        .find((line) => line.toLowerCase().startsWith('sec-websocket-accept:'));
      if (!acceptLine || acceptLine.slice(acceptLine.indexOf(':') + 1).trim() !== acceptKey(key)) {
        fail(new Error('handshake answered with a wrong Sec-WebSocket-Accept'));
        return;
      }
      settled = true;
      socket.removeAllListeners('data');
      resolve(
        new WebSocketConnection(socket, {
          maskIncoming: false,
          maskOutgoing: true,
          head: rest,
        }),
      );
    });
  });
}
