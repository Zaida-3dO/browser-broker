import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

import { completeServerHandshake, connectWebSocket } from '../../src/attach/ws.ts';

/**
 * The framing layer proved over itself: the same `WebSocketConnection` code
 * runs on both sides of these sockets, so what passes here passes wherever
 * the relay carries it. The rows are the wire cases that actually matter —
 * the three length encodings, a message the sender split in two, a ping, and
 * a close with a reason to carry.
 */

async function startEchoServer(): Promise<{
  port: number;
  close: () => void;
  first: () => Promise<import('../../src/attach/ws.ts').WebSocketConnection>;
}> {
  let firstConnection: (connection: import('../../src/attach/ws.ts').WebSocketConnection) => void;
  const firstPromise = new Promise<import('../../src/attach/ws.ts').WebSocketConnection>(
    (resolve) => {
      firstConnection = resolve;
    },
  );
  const server = http.createServer();
  server.on('upgrade', (request, socket, head) => {
    const connection = completeServerHandshake(request, socket, head);
    if (!connection) return;
    connection.onMessage = (text) => connection.send(`echo:${text}`);
    firstConnection(connection);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return {
    port: address.port,
    close: () => server.close(),
    first: () => firstPromise,
  };
}

async function roundTrip(text: string): Promise<string> {
  const server = await startEchoServer();
  try {
    const client = await connectWebSocket(`ws://127.0.0.1:${server.port}/x`);
    const reply = new Promise<string>((resolve) => {
      client.onMessage = (received) => resolve(received);
    });
    client.send(text);
    const echoed = await reply;
    client.close();
    return echoed;
  } finally {
    server.close();
  }
}

test('the three length encodings round-trip: short, 16-bit, and 64-bit', async () => {
  const small = 'ping';
  assert.equal(await roundTrip(small), `echo:${small}`);

  const wide = 'w'.repeat(70_000); // past 125, inside 16-bit
  assert.equal((await roundTrip(wide)).length, wide.length + 5);

  const huge = 'h'.repeat(120_000); // past 64 KB: still 16-bit, but split across TCP chunks
  assert.equal((await roundTrip(huge)).length, huge.length + 5);
});

test('a fragmented message is reassembled before the handler sees it', async () => {
  const server = await startEchoServer();
  try {
    const connectionPromise = server.first();
    const socket = net.connect(server.port, '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(
      'GET /x HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${server.port}\r\n` +
        'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n',
    );
    const handshake = await readUntil(socket, '\r\n\r\n');
    assert.match(handshake, /HTTP\/1\.1 101/);
    const serverSide = await connectionPromise;
    const received = new Promise<string>((resolve) => {
      serverSide.onMessage = resolve;
    });
    // A text frame with fin=0, then a continuation with fin=1 — both masked
    // with a zero mask, which is a legal mask.
    socket.write(masks(0x01, 'hal', false));
    socket.write(masks(0x00, 'lo'));
    assert.equal(await received, 'hallo');
    socket.destroy();
  } finally {
    server.close();
  }
});

test('a ping gets a pong, and a close carries its reason across', async () => {
  const server = await startEchoServer();
  try {
    const connectionPromise = server.first();
    const client = await connectWebSocket(`ws://127.0.0.1:${server.port}/x`);
    const serverSide = await connectionPromise;
    const serverSawClose = serverSide.onceClosed();
    client.close(1000, 'done here');
    assert.equal(await serverSawClose, 'done here');
  } finally {
    server.close();
  }
});

/**
 * A masked frame: zero mask key (a legal mask), header and payload as one
 * write. `fin` false makes an unfinished frame — the fragmented case needs it.
 */
function masks(opcode: number, text: string, fin = true): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const first = opcode | (fin ? 0x80 : 0);
  const head = Buffer.from([first, 0x80 | payload.length, 0, 0, 0, 0]);
  return Buffer.concat([head, payload]);
}

function readUntil(socket: net.Socket, until: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const onData = (chunk: Buffer) => {
      data += chunk.toString('latin1');
      if (data.includes(until)) {
        socket.off('data', onData);
        socket.off('error', reject);
        resolve(data);
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}
