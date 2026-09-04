'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { getIdentity, getRuntimeDir, startEndpoint, sendToPane } = require('../lib/pi-remote.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomId = () => crypto.randomBytes(16).toString('hex');
const identity = (pane = '%7', pid = 1234, socket = '/tmp/tmux-test/default') =>
  getIdentity({ TMUX: `${socket},${pid},0`, TMUX_PANE: pane });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function until(callback, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await callback();
    if (result) return result;
    await sleep(10);
  }
  throw new Error('Test condition timed out');
}

async function fixture(t, transport = 'socket', extra = {}) {
  const runtimeDir = await fs.mkdtemp('/tmp/tpr-');
  const config = { identity: identity(), runtimeDir, transport, sessionId: 'session-a', onPrompt: async () => {}, ...extra };
  const endpoints = [];
  t.after(async () => {
    await Promise.all(endpoints.map(endpoint => endpoint.close()));
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });
  return {
    config,
    async start(overrides = {}) {
      const endpoint = await startEndpoint({ ...config, ...overrides });
      endpoints.push(endpoint);
      return endpoint;
    },
    registryPath(id = config.identity) { return path.join(runtimeDir, 'panes', id.serverKey, `${id.paneId}.json`); },
    async registration() { return JSON.parse(await fs.readFile(this.registryPath(), 'utf8')); },
    async endpointPath() {
      const registration = await this.registration();
      return path.join(runtimeDir, `${registration.transport === 'socket' ? 's' : 'f'}-${registration.instanceId}${registration.transport === 'socket' ? '.sock' : ''}`);
    },
    send(overrides = {}) { return sendToPane({ ...config, text: 'hello', ...overrides }); },
  };
}

function socketPeer(socketPath) {
  const socket = net.createConnection(socketPath);
  const queue = [];
  let buffer = '';
  let terminal;
  socket.on('error', error => {
    terminal = error;
    for (const pending of queue.splice(0)) { clearTimeout(pending.timer); pending.reject(error); }
  });
  socket.on('data', chunk => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const frame = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const pending = queue.shift();
      if (pending) {
        clearTimeout(pending.timer);
        try { pending.resolve(JSON.parse(frame)); } catch (error) { pending.reject(error); }
      }
    }
  });
  socket.on('close', () => {
    for (const pending of queue.splice(0)) { clearTimeout(pending.timer); pending.reject(new Error('Peer closed')); }
  });
  return {
    socket,
    request(request) { return this.frame(`${JSON.stringify(request)}\n`); },
    frame(frame, end = false) {
      if (terminal) return Promise.reject(terminal);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('Raw socket test timeout')); }, 3000);
        queue.push({ resolve, reject, timer });
        if (end) socket.end(frame);
        else socket.write(frame);
      });
    },
    close() { socket.destroy(); },
  };
}

async function rawFile(endpointPath, request, rawFrame) {
  const wireId = randomId();
  const requestPath = path.join(endpointPath, 'requests', `${wireId}.json`);
  const replyDir = path.join(endpointPath, 'replies', wireId);
  const replyPath = path.join(replyDir, 'reply.json');
  await fs.mkdir(replyDir, { mode: 0o700 });
  await fs.writeFile(replyPath, '', { mode: 0o600, flag: 'wx' });
  try {
    const temporary = `${requestPath}.tmp`;
    await fs.writeFile(temporary, rawFrame ?? `${JSON.stringify(request)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, requestPath);
    return await until(async () => {
      const text = await fs.readFile(replyPath, 'utf8');
      return text && JSON.parse(text);
    });
  } finally {
    await fs.unlink(requestPath).catch(() => {});
    await fs.rm(replyDir, { recursive: true, force: true });
  }
}

async function rawPeer(t, f) {
  const endpointPath = await f.endpointPath();
  if (f.config.transport === 'files') return { request: request => rawFile(endpointPath, request) };
  const peer = socketPeer(endpointPath);
  t.after(() => peer.close());
  return peer;
}

const hello = instanceId => ({ type: 'hello', requestId: randomId(), instanceId });
const prompt = (instanceId, extra = {}) => ({
  type: 'prompt', requestId: randomId(), instanceId, sessionId: 'session-a', text: 'hello', deliverAs: 'steer', ...extra,
});

test('identity parses TMUX from the right and namespaces by socket + PID, not session or pane', () => {
  const result = getIdentity({ TMUX: '/tmp/tmux,with,commas/default,1234,9', TMUX_PANE: '%12' });
  assert.equal(result.socketPath, '/tmp/tmux,with,commas/default');
  assert.equal(result.serverPid, 1234);
  assert.equal(result.paneId, '%12');
  assert.match(result.serverKey, /^[a-f0-9]{24}$/);
  assert.equal(result.serverKey, getIdentity({ TMUX: '/tmp/tmux,with,commas/default,1234,10', TMUX_PANE: '%99' }).serverKey);
  assert.notEqual(identity().serverKey, identity('%7', 1235).serverKey);
  assert.notEqual(identity().serverKey, identity('%7', 1234, '/tmp/another').serverKey);
});

test('explicit identity overrides TMUX, and invalid identity/configuration fails closed', () => {
  assert.deepEqual(getIdentity({
    TMUX: 'invalid', TMUX_PANE: '%7',
    TMUX_REMOTE_CONTROL_TMUX_SOCKET: '/tmp/tmux-test/default', TMUX_REMOTE_CONTROL_TMUX_SERVER_PID: '1234',
  }), identity());
  for (const env of [
    {}, { TMUX: '/tmp/x,123,0' }, { TMUX: 'relative,123,0', TMUX_PANE: '%0' },
    { TMUX: '/tmp/x,0,0', TMUX_PANE: '%0' }, { TMUX: '/tmp/x,9007199254740992,0', TMUX_PANE: '%0' },
    { TMUX: '/tmp/x,123,no', TMUX_PANE: '%0' }, { TMUX: '/tmp/x,123,0', TMUX_PANE: '../../bad' },
    { TMUX: '/tmp/x\n,123,0', TMUX_PANE: '%0' },
    { TMUX_REMOTE_CONTROL_TMUX_SOCKET: '/tmp/x', TMUX_PANE: '%0' },
    { TMUX_REMOTE_CONTROL_TMUX_SERVER_PID: '123', TMUX_PANE: '%0' },
  ]) assert.throws(() => getIdentity(env), { code: 'INVALID_CONFIG' });
  assert.equal(getRuntimeDir({}), `/tmp/tmux-pi-${process.getuid()}`);
  assert.equal(getRuntimeDir({ TMUX_REMOTE_CONTROL_RPC_DIR: '/tmp/shared/' }), '/tmp/shared');
  for (const value of ['', 'relative', '/tmp/a\nb']) {
    assert.throws(() => getRuntimeDir({ TMUX_REMOTE_CONTROL_RPC_DIR: value }), { code: 'INVALID_CONFIG' });
  }
});

for (const transport of ['socket', 'files']) {
  test(`${transport}: ACK awaits callback, carries session, and preserves Unicode/newlines and delivery mode`, async t => {
    const entered = deferred();
    const release = deferred();
    const calls = [];
    const f = await fixture(t, transport, { onPrompt: async value => { calls.push(value); entered.resolve(); await release.promise; } });
    const endpoint = await f.start();
    let settled = false;
    const sending = f.send({ text: 'hello\n世界 🐈', deliverAs: 'followUp' }).finally(() => { settled = true; });
    await entered.promise;
    await sleep(30);
    assert.equal(settled, false);
    assert.deepEqual(calls, [{ text: 'hello\n世界 🐈', deliverAs: 'followUp', sessionId: 'session-a' }]);
    release.resolve();
    const ack = await sending;
    assert.equal(ack.ok, true);
    assert.equal(ack.type, 'ack');
    assert.equal(ack.instanceId, endpoint.instanceId);
    assert.equal(ack.sessionId, 'session-a');
    assert.match(ack.requestId, /^[a-f0-9]{32}$/);
    await f.send();
    assert.equal(calls[1].deliverAs, 'steer');
  });

  test(`${transport}: rejects stale instance/session and expired requests; getter tracks live session`, async t => {
    let session = 'session-a';
    let calls = 0;
    const f = await fixture(t, transport, { sessionId: () => session, onPrompt: async () => { calls++; } });
    const endpoint = await f.start();
    const peer = await rawPeer(t, f);
    assert.equal((await peer.request(hello(endpoint.instanceId))).sessionId, 'session-a');
    assert.equal((await peer.request(prompt(randomId()))).code, 'STALE_INSTANCE');
    session = 'session-b';
    assert.equal((await peer.request(prompt(endpoint.instanceId))).code, 'STALE_SESSION');
    assert.equal((await peer.request(prompt(endpoint.instanceId, { sessionId: session, expiresAt: Date.now() - 1 }))).code, 'EXPIRED');
    assert.equal(calls, 0);
    assert.equal((await peer.request(hello(endpoint.instanceId))).sessionId, 'session-b');
    assert.equal((await f.send()).sessionId, 'session-b');
    assert.equal(calls, 1);
  });

  test(`${transport}: concurrent/replayed request IDs invoke callback once; changed payload is rejected`, async t => {
    let calls = 0;
    const entered = deferred();
    const release = deferred();
    const f = await fixture(t, transport, { onPrompt: async () => { calls++; entered.resolve(); await release.promise; } });
    const endpoint = await f.start();
    const firstPeer = await rawPeer(t, f);
    const secondPeer = await rawPeer(t, f);
    const request = prompt(endpoint.instanceId);
    const first = firstPeer.request(request);
    await entered.promise;
    const second = secondPeer.request(request);
    await sleep(150);
    assert.equal(calls, 1);
    release.resolve();
    const replies = await Promise.all([first, second]);
    assert.deepEqual(replies[0], replies[1]);
    assert.equal(replies[0].type, 'ack');
    assert.deepEqual(await firstPeer.request(request), replies[0]);
    assert.equal((await firstPeer.request({ ...request, text: 'different' })).code, 'DUPLICATE_ID');
    assert.equal(calls, 1);
  });

  test(`${transport}: callback errors are acknowledged as failures and also deduplicated`, async t => {
    let calls = 0;
    const f = await fixture(t, transport, { onPrompt: async () => { calls++; throw new Error('not accepted'); } });
    const endpoint = await f.start();
    await assert.rejects(f.send(), { code: 'PROMPT_FAILED', message: 'not accepted' });
    const peer = await rawPeer(t, f);
    const request = prompt(endpoint.instanceId);
    const first = await peer.request(request);
    assert.equal(first.ok, false);
    assert.equal(first.message, 'not accepted');
    assert.deepEqual(await peer.request(request), first);
    assert.equal(calls, 2);
  });

  test(`${transport}: concurrent startup is exclusive, failure cleans its own resources, close is idempotent`, async t => {
    const f = await fixture(t, transport);
    const results = await Promise.allSettled([f.start(), f.start()]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'ENDPOINT_EXISTS');
    const endpoint = results.find(result => result.status === 'fulfilled').value;
    assert.equal((await f.registration()).instanceId, endpoint.instanceId);
    assert.equal((await fs.readdir(f.config.runtimeDir)).filter(name => /^[sf]-/.test(name)).length, 1);
    await f.send();
    const endpointPath = await f.endpointPath();
    await Promise.all([endpoint.close(), endpoint.close()]);
    await assert.rejects(fs.stat(f.registryPath()), { code: 'ENOENT' });
    await assert.rejects(fs.stat(endpointPath), { code: 'ENOENT' });
    await assert.rejects(f.send(), { code: 'NO_ENDPOINT' });
    const replacement = await f.start();
    assert.notEqual(replacement.instanceId, endpoint.instanceId);
    const peer = await rawPeer(t, f);
    assert.equal((await peer.request(prompt(endpoint.instanceId))).code, 'STALE_INSTANCE');
  });

  test(`${transport}: registry separates both panes and tmux servers`, async t => {
    const f = await fixture(t, transport);
    const received = [];
    const identities = [identity(), identity('%8'), identity('%7', 2222), identity('%7', 1234, '/tmp/other-socket')];
    for (let index = 0; index < identities.length; index++) {
      await f.start({ identity: identities[index], onPrompt: async () => { received.push(index); } });
    }
    for (const target of identities) await f.send({ identity: target });
    assert.deepEqual(received, [0, 1, 2, 3]);
  });

  test(`${transport}: all registry/transport paths are private; unsafe directories/files are rejected`, async t => {
    const entered = deferred();
    const release = deferred();
    const f = await fixture(t, transport, { onPrompt: async () => { entered.resolve(); await release.promise; } });
    await f.start();
    const sending = f.send();
    await entered.promise;
    async function checkTree(directory) {
      assert.equal((await fs.stat(directory)).mode & 0o777, 0o700, directory);
      for (const name of await fs.readdir(directory)) {
        const item = path.join(directory, name);
        const stat = await fs.lstat(item);
        assert.equal(stat.uid, process.getuid());
        if (stat.isDirectory()) await checkTree(item);
        else assert.equal(stat.mode & 0o777, 0o600, item);
      }
    }
    await checkTree(f.config.runtimeDir);
    release.resolve();
    await sending;
    await fs.chmod(f.registryPath(), 0o644);
    await assert.rejects(f.send(), { code: 'UNSAFE_PATH' });
    await fs.chmod(f.registryPath(), 0o600);
    await fs.chmod(f.config.runtimeDir, 0o755);
    await assert.rejects(f.send(), { code: 'UNSAFE_PATH' });
    await assert.rejects(f.start({ identity: identity('%99') }), { code: 'UNSAFE_PATH' });
    await fs.chmod(f.config.runtimeDir, 0o700);
  });

  test(`${transport}: close never deletes another instance's registration`, async t => {
    const f = await fixture(t, transport);
    const endpoint = await f.start();
    const replacement = { ...await f.registration(), instanceId: randomId() };
    await fs.writeFile(`${f.registryPath()}.replacement`, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
    await fs.rename(`${f.registryPath()}.replacement`, f.registryPath());
    await endpoint.close();
    assert.deepEqual(await f.registration(), replacement);
    await assert.rejects(f.send(), { code: 'STALE_ENDPOINT' });
    await assert.rejects(f.start(), { code: 'ENDPOINT_EXISTS' });
  });

  test(`${transport}: timeout never retries ambiguous delivery and close does not await a hung callback`, async t => {
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    const f = await fixture(t, transport, { onPrompt: async () => { calls++; entered.resolve(); await release.promise; } });
    const endpoint = await f.start();
    const rejected = assert.rejects(f.send({ timeoutMs: transport === 'files' ? 650 : 150 }), error => error.code === 'TIMEOUT' && /delivery may have occurred.*not retried/.test(error.message));
    await entered.promise;
    await rejected;
    assert.equal(calls, 1);
    if (transport === 'files') {
      const endpointPath = await f.endpointPath();
      assert.deepEqual(await fs.readdir(path.join(endpointPath, 'requests')), []);
      assert.deepEqual(await fs.readdir(path.join(endpointPath, 'replies')), []);
    }
    await Promise.race([endpoint.close(), sleep(1000).then(() => { throw new Error('close waited for callback'); })]);
    release.resolve();
    await sleep(30);
    assert.equal(calls, 1);
  });

  test(`${transport}: rejects oversized payload and invalid delivery/timeout without invoking callback`, async t => {
    let calls = 0;
    const f = await fixture(t, transport, { onPrompt: async () => { calls++; } });
    await f.start();
    await assert.rejects(f.send({ text: 'x'.repeat(1024 * 1024) }), { code: 'TOO_LARGE' });
    await assert.rejects(f.send({ deliverAs: 'paste' }), { code: 'BAD_REQUEST' });
    await assert.rejects(f.send({ text: 123 }), { code: 'BAD_REQUEST' });
    for (const timeoutMs of [0, -1, 1.5, 60_001, Infinity]) {
      await assert.rejects(f.send({ timeoutMs }), { code: 'INVALID_CONFIG' });
    }
    assert.equal(calls, 0);
  });
}

test('socket is the default; missing endpoint is a clear error', async t => {
  const f = await fixture(t);
  await assert.rejects(f.send(), { code: 'NO_ENDPOINT' });
  await f.start({ transport: undefined });
  assert.equal((await f.registration()).transport, 'socket');
  await f.send();
});

test('files requires explicit shared directory and accepts an environment override on both peers', async t => {
  const old = process.env.TMUX_REMOTE_CONTROL_RPC_DIR;
  delete process.env.TMUX_REMOTE_CONTROL_RPC_DIR;
  t.after(() => { if (old === undefined) delete process.env.TMUX_REMOTE_CONTROL_RPC_DIR; else process.env.TMUX_REMOTE_CONTROL_RPC_DIR = old; });
  await assert.rejects(startEndpoint({ identity: identity(), transport: 'files', sessionId: 's', onPrompt: async () => {} }), { code: 'INVALID_CONFIG' });
  const f = await fixture(t, 'files');
  process.env.TMUX_REMOTE_CONTROL_RPC_DIR = f.config.runtimeDir;
  await f.start({ runtimeDir: undefined });
  await f.send({ runtimeDir: undefined });
});

test('unsafe symlinked runtime and registration are rejected', async t => {
  const f = await fixture(t);
  await f.start();
  const link = `${f.config.runtimeDir}-link`;
  await fs.symlink(f.config.runtimeDir, link);
  t.after(() => fs.unlink(link));
  await assert.rejects(f.send({ runtimeDir: link }), { code: 'UNSAFE_PATH' });
  const original = `${f.registryPath()}.original`;
  await fs.rename(f.registryPath(), original);
  await fs.symlink(original, f.registryPath());
  await assert.rejects(f.send(), error => ['ELOOP', 'UNSAFE_PATH'].includes(error.code));
  await fs.unlink(f.registryPath());
  await fs.rename(original, f.registryPath());
});

test('non-regular registration is rejected without blocking on a FIFO', async t => {
  const f = await fixture(t);
  await f.start();
  const original = `${f.registryPath()}.original`;
  await fs.rename(f.registryPath(), original);
  try {
    execFileSync('mkfifo', ['-m', '600', f.registryPath()]);
    await assert.rejects(f.send({ timeoutMs: 100 }), { code: 'UNSAFE_PATH' });
  } finally {
    await fs.unlink(f.registryPath()).catch(() => {});
    await fs.rename(original, f.registryPath());
  }
});

test('socket rejects malformed, incomplete, oversized, and invalid UTF-8 frames without delivery', async t => {
  let calls = 0;
  const f = await fixture(t, 'socket', { onPrompt: async () => { calls++; } });
  await f.start();
  for (const [frame, end, code] of [
    ['not-json\n', false, 'BAD_FRAME'], ['[]\n', false, 'BAD_FRAME'],
    ['{}', true, 'BAD_FRAME'], ['x'.repeat(1024 * 1024), false, 'TOO_LARGE'],
    [Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125, 10]), false, 'BAD_FRAME'],
  ]) {
    const peer = socketPeer(await f.endpointPath());
    t.after(() => peer.close());
    assert.equal((await peer.frame(frame, end)).code, code);
    peer.close();
  }
  assert.equal(calls, 0);
  await f.send();
});

test('socket accepts fragmented JSONL and multiple frames on one connection', async t => {
  const f = await fixture(t);
  const endpoint = await f.start();
  const peer = await rawPeer(t, f);
  const frame = JSON.stringify(hello(endpoint.instanceId));
  const reply = peer.frame(frame.slice(0, 10));
  await sleep(10);
  peer.socket.write(`${frame.slice(10)}\n`);
  assert.equal((await reply).type, 'hello');
  const replies = await Promise.all([peer.request(hello(endpoint.instanceId)), peer.request(hello(endpoint.instanceId))]);
  assert.equal(replies.length, 2);
  assert.ok(replies.every(value => value.ok));
});

test('files rejects malformed/incomplete/oversized frames and ignores unpublished temporary files', async t => {
  let calls = 0;
  const f = await fixture(t, 'files', { onPrompt: async () => { calls++; } });
  const endpoint = await f.start();
  const endpointPath = await f.endpointPath();
  for (const [frame, code] of [['{bad}\n', 'BAD_FRAME'], ['{}', 'BAD_FRAME'], ['{}\n{}\n', 'BAD_FRAME'], ['x'.repeat(1024 * 1024 + 1), 'TOO_LARGE']]) {
    assert.equal((await rawFile(endpointPath, null, frame)).code, code);
  }
  const temporary = path.join(endpointPath, 'requests', `${randomId()}.json.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(prompt(endpoint.instanceId))}\n`, { mode: 0o600 });
  await sleep(220);
  assert.equal(calls, 0);
  await f.send();
  assert.equal(calls, 1);
  await endpoint.close();
  await assert.rejects(fs.stat(temporary), { code: 'ENOENT' });
});

test('files late ACK cannot leave orphan replies after client timeout', async t => {
  const release = deferred();
  const f = await fixture(t, 'files', { onPrompt: async () => release.promise });
  await f.start();
  await assert.rejects(f.send({ timeoutMs: 650 }), { code: 'TIMEOUT' });
  release.resolve();
  await sleep(220);
  const endpointPath = await f.endpointPath();
  assert.deepEqual(await fs.readdir(path.join(endpointPath, 'requests')), []);
  assert.deepEqual(await fs.readdir(path.join(endpointPath, 'replies')), []);
});

test('socket client times out a stale/nonresponsive endpoint without retrying', async t => {
  const f = await fixture(t);
  const endpoint = await f.start();
  const registration = await f.registration();
  const endpointPath = await f.endpointPath();
  await endpoint.close();
  let connections = 0;
  const sockets = new Set();
  const server = net.createServer(socket => { connections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(endpointPath, resolve));
  await fs.chmod(endpointPath, 0o600);
  await fs.writeFile(f.registryPath(), `${JSON.stringify(registration)}\n`, { mode: 0o600 });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  await assert.rejects(f.send({ timeoutMs: 100 }), error => error.code === 'TIMEOUT' && /stale or unresponsive/.test(error.message));
  assert.equal(connections, 1);
});

for (const transport of ['socket', 'files']) {
  test(`${transport}: trusted ancestor symlinks work, but managed directory symlinks are rejected`, async t => {
    const f = await fixture(t, transport);
    const ancestor = path.join(f.config.runtimeDir, 'real');
    const alias = path.join(f.config.runtimeDir, 'alias');
    await fs.mkdir(ancestor, { mode: 0o700 });
    await fs.symlink(ancestor, alias);
    const runtimeDir = path.join(alias, 'rpc');
    const endpoint = await f.start({ runtimeDir });
    assert.equal((await f.send({ runtimeDir })).instanceId, endpoint.instanceId);
    // Both spellings refer to the same namespace, without expanding a short
    // socket path such as macOS /tmp to /private/tmp before binding it.
    assert.equal((await f.send({ runtimeDir: path.join(ancestor, 'rpc') })).instanceId, endpoint.instanceId);
    const panes = path.join(runtimeDir, 'panes');
    const realPanes = path.join(runtimeDir, 'real-panes');
    await fs.rename(panes, realPanes);
    await fs.symlink(realPanes, panes);
    await assert.rejects(f.send({ runtimeDir }), { code: 'UNSAFE_PATH' });
    await assert.rejects(f.start({ runtimeDir, identity: identity('%99') }), { code: 'UNSAFE_PATH' });
    await fs.unlink(panes);
    await fs.rename(realPanes, panes);
    await endpoint.close();
  });

  test(`${transport}: deadline is rechecked after the session getter, immediately before callback`, async t => {
    let sessionReads = 0;
    let expiresAt;
    let calls = 0;
    const f = await fixture(t, transport, {
      sessionId: () => {
        sessionReads++;
        if (sessionReads === 2) {
          queueMicrotask(() => {
            // Delay the delivery microtask past its deadline, without relying
            // on the order of network timers or filesystem polling.
            while (Date.now() <= expiresAt) { /* deliberate short busy wait */ }
          });
        }
        return 'session-a';
      },
      onPrompt: async () => { calls++; },
    });
    const endpoint = await f.start();
    const peer = await rawPeer(t, f);
    expiresAt = Date.now() + 250;
    const reply = await peer.request(prompt(endpoint.instanceId, { expiresAt }));
    assert.equal(sessionReads, 3);
    assert.equal(reply.code, 'EXPIRED');
    assert.equal(calls, 0);
  });

  test(`${transport}: disabling between validation and delivery prevents callback`, async t => {
    let endpoint;
    let closing;
    let reads = 0;
    let calls = 0;
    const f = await fixture(t, transport, {
      sessionId: () => {
        reads++;
        if (reads === 2) queueMicrotask(() => { closing = endpoint.close(); });
        return 'session-a';
      },
      onPrompt: async () => { calls++; },
    });
    endpoint = await f.start();
    const peer = await rawPeer(t, f);
    // Close in the microtask between prompt validation and callback execution.
    await assert.rejects(peer.request(prompt(endpoint.instanceId)));
    await closing;
    assert.equal(calls, 0);
  });
}

test('files stale/unresponsive registry times out its handshake and cleans request/reply files', async t => {
  const f = await fixture(t, 'files');
  const endpoint = await f.start();
  const registration = await f.registration();
  const endpointPath = await f.endpointPath();
  await endpoint.close();
  await fs.mkdir(path.join(endpointPath, 'requests'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(endpointPath, 'replies'), { mode: 0o700 });
  await fs.writeFile(f.registryPath(), `${JSON.stringify(registration)}\n`, { mode: 0o600 });
  await assert.rejects(f.send({ timeoutMs: 150 }), error => error.code === 'TIMEOUT' && /stale or unresponsive/.test(error.message));
  assert.deepEqual(await fs.readdir(path.join(endpointPath, 'requests')), []);
  assert.deepEqual(await fs.readdir(path.join(endpointPath, 'replies')), []);
});

test('socket client rejects malformed replies and bounds unterminated reply waits', async t => {
  const f = await fixture(t);
  const endpoint = await f.start();
  const registration = await f.registration();
  const endpointPath = await f.endpointPath();
  await endpoint.close();
  let frame = 'not JSON\n';
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', () => socket.write(frame));
  });
  await new Promise(resolve => server.listen(endpointPath, resolve));
  await fs.chmod(endpointPath, 0o600);
  await fs.writeFile(f.registryPath(), `${JSON.stringify(registration)}\n`, { mode: 0o600 });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  await assert.rejects(f.send(), { code: 'BAD_FRAME' });
  frame = '{}';
  await assert.rejects(f.send({ timeoutMs: 100 }), { code: 'TIMEOUT' });
});

test('invalid startup options and overlong Unix socket paths leave no registration', async t => {
  const f = await fixture(t);
  await assert.rejects(f.start({ identity: { ...identity(), serverKey: '../bad' } }), { code: 'INVALID_CONFIG' });
  await assert.rejects(f.start({ transport: 'automatic' }), { code: 'INVALID_CONFIG' });
  await assert.rejects(f.start({ sessionId: async () => 's' }), { code: 'INVALID_SESSION' });
  await assert.rejects(f.start({ onPrompt: null }), { code: 'INVALID_CONFIG' });
  await assert.rejects(f.start({ runtimeDir: path.join(f.config.runtimeDir, 'x'.repeat(100)) }), { code: 'INVALID_CONFIG' });
  assert.deepEqual(await fs.readdir(f.config.runtimeDir), []);
});
