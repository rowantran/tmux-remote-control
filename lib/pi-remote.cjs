'use strict';

// Private, same-user transport. Protocol v1 uses one JSON object plus LF per
// request/reply: hello -> {instanceId, sessionId}, prompt -> ACK after onPrompt.
// Registrations are published exclusively, never taken over on a timeout (a
// sandbox may have a different PID namespace). Remove crashed registrations
// only after establishing that their endpoint is no longer running.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const MAX_BYTES = 1024 * 1024;
const MAX_TIMEOUT = 60_000;
const POLL_MS = 100;
const MAX_REQUESTS = 4096;
const MAX_CONNECTIONS = 128;
const ID = /^[a-f0-9]{32}$/;
const REQUEST_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const uid = () => process.getuid();
const randomId = () => crypto.randomBytes(16).toString('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw failure('INVALID_CONFIG', `${label} must be an absolute path without control characters`);
  }
  return path.resolve(value);
}

function makeIdentity(socketPath, serverPid, paneId) {
  socketPath = absolutePath(socketPath, 'tmux socket path');
  if (!/^[1-9]\d*$/.test(String(serverPid)) || !Number.isSafeInteger(Number(serverPid))) {
    throw failure('INVALID_CONFIG', 'tmux server PID must be a positive integer');
  }
  if (typeof paneId !== 'string' || !/^%\d+$/.test(paneId) || paneId.length > 32) {
    throw failure('INVALID_CONFIG', 'TMUX_PANE must be a pane ID such as %0');
  }
  serverPid = Number(serverPid);
  const serverKey = crypto.createHash('sha256').update(`${socketPath}\0${serverPid}`).digest('hex').slice(0, 24);
  return { socketPath, serverPid, serverKey, paneId };
}

function getIdentity(env = process.env) {
  let socketPath = env.TMUX_REMOTE_CONTROL_TMUX_SOCKET;
  let serverPid = env.TMUX_REMOTE_CONTROL_TMUX_SERVER_PID;
  if (socketPath !== undefined || serverPid !== undefined) {
    if (socketPath === undefined || serverPid === undefined) {
      throw failure('INVALID_CONFIG', 'Set both TMUX_REMOTE_CONTROL_TMUX_SOCKET and TMUX_REMOTE_CONTROL_TMUX_SERVER_PID');
    }
  } else {
    // The socket path itself may contain commas. The final fields are PID and
    // tmux's session index, not part of the socket path.
    const match = typeof env.TMUX === 'string' && /^(.*),([0-9]+),([0-9]+)$/.exec(env.TMUX);
    if (!match) throw failure('INVALID_CONFIG', 'Missing or invalid TMUX; expected socket-path,server-pid,session');
    [, socketPath, serverPid] = match;
  }
  return makeIdentity(socketPath, serverPid, env.TMUX_PANE);
}

function getRuntimeDir(env = process.env) {
  return absolutePath(env.TMUX_REMOTE_CONTROL_RPC_DIR ?? `/tmp/tmux-pi-${uid()}`, 'RPC directory');
}

function optionsFor(options) {
  const identity = options.identity ?? getIdentity();
  const checked = makeIdentity(identity.socketPath, identity.serverPid, identity.paneId);
  if (identity.serverKey !== checked.serverKey) throw failure('INVALID_CONFIG', 'Invalid tmux serverKey');
  const runtimeDir = absolutePath(options.runtimeDir ?? getRuntimeDir(), 'RPC directory');
  return {
    identity: checked,
    runtimeDir,
    explicitDir: options.runtimeDir !== undefined || process.env.TMUX_REMOTE_CONTROL_RPC_DIR !== undefined,
    registryDir: path.join(runtimeDir, 'panes', checked.serverKey),
    registryPath: path.join(runtimeDir, 'panes', checked.serverKey, `${checked.paneId}.json`),
  };
}

function requireFilesConfig(config) {
  if (!config.explicitDir) {
    throw failure('INVALID_CONFIG', 'Files transport requires an explicitly shared runtimeDir or TMUX_REMOTE_CONTROL_RPC_DIR');
  }
}

function checkPrivate(stat, directory, label) {
  if (!(directory ? stat.isDirectory() : stat.isFile()) || stat.uid !== uid() || (stat.mode & 0o077)) {
    throw failure('UNSAFE_PATH', `${label} must be an owned, private ${directory ? 'directory (0700)' : 'file (0600)'}`);
  }
}

async function privateDir(directory, create = false) {
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // Check every managed directory with lstat, but allow trusted ancestors to
  // be symlinks (notably /tmp -> /private/tmp on macOS). Both peers keep the
  // configured spelling so Unix socket paths remain short and consistent.
  checkPrivate(await fs.lstat(directory), true, directory);
}

async function registryDirs(config, create = false) {
  await privateDir(config.runtimeDir, create);
  await privateDir(path.join(config.runtimeDir, 'panes'), create);
  await privateDir(config.registryDir, create);
}

function encode(value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > MAX_BYTES) throw failure('TOO_LARGE', 'RPC frame exceeds 1 MiB');
  return bytes;
}

function decode(bytes) {
  if (bytes.length > MAX_BYTES) throw failure('TOO_LARGE', 'RPC frame exceeds 1 MiB');
  if (!bytes.length || bytes[bytes.length - 1] !== 10 || bytes.subarray(0, -1).includes(10)) {
    throw failure('BAD_FRAME', 'Expected one LF-terminated JSON frame');
  }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw failure('BAD_FRAME', 'Invalid UTF-8 or JSON RPC frame');
  }
}

async function readPrivate(file, allowEmpty = false) {
  // O_NONBLOCK prevents a substituted FIFO from hanging before fstat can
  // reject it. It has no effect on the regular files used by this protocol.
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    checkPrivate(stat, false, file);
    if (stat.size > MAX_BYTES) throw failure('TOO_LARGE', 'RPC file exceeds 1 MiB');
    // Bound the read as well as the stat, in case a writer grows the file.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_BYTES) throw failure('TOO_LARGE', 'RPC file exceeds 1 MiB');
    if (!bytesRead && allowEmpty) return null;
    return decode(bytes.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function atomicWrite(file, value, exclusive = false) {
  const temporary = `${file}.${randomId()}.tmp`;
  try {
    await fs.writeFile(temporary, encode(value), { mode: 0o600, flag: 'wx' });
    if (exclusive) await fs.link(temporary, file);
    else await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

function address(config, registration) {
  return path.join(config.runtimeDir, `${registration.transport === 'socket' ? 's' : 'f'}-${registration.instanceId}${registration.transport === 'socket' ? '.sock' : ''}`);
}

async function registrationFor(config) {
  try {
    await registryDirs(config);
    const registration = await readPrivate(config.registryPath);
    if (registration.version !== 1 || typeof registration.instanceId !== 'string' || !ID.test(registration.instanceId) ||
        !['socket', 'files'].includes(registration.transport) ||
        Object.entries(config.identity).some(([key, value]) => registration[key] !== value)) {
      throw failure('STALE_ENDPOINT', 'Invalid or stale endpoint registration');
    }
    if (registration.transport === 'files') requireFilesConfig(config);
    return registration;
  } catch (error) {
    if (error.code === 'ENOENT') throw failure('NO_ENDPOINT', `No remote endpoint for pane ${config.identity.paneId} on server ${config.identity.serverKey}`);
    throw error;
  }
}

function errorReply(error, requestId, instanceId) {
  return {
    ok: false, type: 'error', requestId: typeof requestId === 'string' && REQUEST_ID.test(requestId) ? requestId : undefined, instanceId,
    code: typeof error?.code === 'string' ? error.code.slice(0, 128) : 'PROMPT_FAILED',
    message: String(error?.message ?? error).slice(0, 1024),
  };
}

function currentSession(sessionId) {
  const value = typeof sessionId === 'function' ? sessionId() : sessionId;
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 4096) {
    throw failure('INVALID_SESSION', 'Endpoint has no valid current session ID');
  }
  return value;
}

function checkDeadline(expiresAt) {
  if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + MAX_TIMEOUT + 1000)) {
    throw failure('EXPIRED', 'RPC request deadline expired or invalid');
  }
}

function validatePrompt(text, deliverAs) {
  if (typeof text !== 'string') throw failure('BAD_REQUEST', 'Prompt text must be a string');
  if (!['steer', 'followUp'].includes(deliverAs)) throw failure('BAD_REQUEST', 'deliverAs must be steer or followUp');
}

/** Start an endpoint. sessionId may be a string or synchronous getter.
 * close disables new work immediately, but cannot cancel an already invoked
 * onPrompt. Deduplication lasts for the live endpoint; after 4096 unique prompt
 * IDs it rejects new IDs instead of evicting IDs and risking double delivery.
 */
async function startEndpoint(options = {}) {
  const config = optionsFor(options);
  const transport = options.transport ?? 'socket';
  if (!['socket', 'files'].includes(transport)) throw failure('INVALID_CONFIG', 'Transport must be socket or files');
  if (transport === 'files') requireFilesConfig(config);
  if (typeof options.onPrompt !== 'function') throw failure('INVALID_CONFIG', 'onPrompt must be a function');
  currentSession(options.sessionId);
  const instanceId = randomId();
  const registration = { version: 1, ...config.identity, instanceId, transport };
  const endpointPath = address(config, registration);
  if (transport === 'socket' && Buffer.byteLength(endpointPath) > 103) {
    throw failure('INVALID_CONFIG', 'RPC socket path is too long; use a shorter RPC directory or explicit files transport');
  }
  let active = true;
  let published = false;
  let server;
  let pollTimer;
  let polling;
  let closing;
  let endpointCreated = false;
  const connections = new Set();
  const requests = new Map();
  let pendingPrompts = 0;

  async function dispatch(request) {
    try {
      if (!active) throw failure('DISABLED', 'Endpoint is disabled');
      if (typeof request.requestId !== 'string' || !REQUEST_ID.test(request.requestId)) throw failure('BAD_REQUEST', 'Invalid request ID');
      if (request.instanceId !== instanceId) throw failure('STALE_INSTANCE', 'Endpoint instance changed; prompt was not delivered');
      checkDeadline(request.expiresAt);
      const sessionId = currentSession(options.sessionId);
      if (request.type === 'hello') return { ok: true, type: 'hello', requestId: request.requestId, instanceId, sessionId };
      if (request.type !== 'prompt') throw failure('BAD_REQUEST', 'Unknown RPC request type');
      if (request.sessionId !== sessionId) throw failure('STALE_SESSION', 'Endpoint session changed; prompt was not delivered');
      validatePrompt(request.text, request.deliverAs);
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify([sessionId, request.text, request.deliverAs])).digest('hex');
      const previous = requests.get(request.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw failure('DUPLICATE_ID', 'Request ID was already used for a different prompt');
        return await previous.result;
      }
      if (requests.size >= MAX_REQUESTS) throw failure('CAPACITY', 'Endpoint deduplication capacity reached; disable and enable remote control again');
      if (pendingPrompts >= 128) throw failure('CAPACITY', 'Too many pending prompts');
      pendingPrompts++;
      // Reserve the ID before invoking user code, including synchronous throws.
      const result = Promise.resolve().then(async () => {
        try {
          if (currentSession(options.sessionId) !== sessionId) throw failure('STALE_SESSION', 'Endpoint session changed; prompt was not delivered');
          checkDeadline(request.expiresAt);
          if (!active) throw failure('DISABLED', 'Endpoint is disabled');
          await options.onPrompt({ text: request.text, deliverAs: request.deliverAs, sessionId });
          if (!active) throw failure('DISABLED', 'Endpoint closed while prompt was being delivered');
          return { ok: true, type: 'ack', requestId: request.requestId, instanceId, sessionId };
        } catch (error) {
          return errorReply(error, request.requestId, instanceId);
        } finally {
          pendingPrompts--;
        }
      });
      requests.set(request.requestId, { fingerprint, result });
      return await result;
    } catch (error) {
      return errorReply(error, request?.requestId, instanceId);
    }
  }

  function accept(socket) {
    if (!active || connections.size >= MAX_CONNECTIONS) return socket.destroy();
    connections.add(socket);
    socket.on('error', () => {});
    const lifetime = setTimeout(() => socket.destroy(), MAX_TIMEOUT);
    socket.on('close', () => { clearTimeout(lifetime); connections.delete(socket); });
    let buffer = Buffer.alloc(0);
    let pending = 0;
    let failed = false;
    function badFrame(error) {
      if (failed) return;
      failed = true;
      socket.end(encode(errorReply(error, undefined, instanceId)));
    }
    socket.on('data', chunk => {
      if (failed) return;
      buffer = Buffer.concat([buffer, chunk]);
      let newline;
      while ((newline = buffer.indexOf(10)) !== -1) {
        const frame = buffer.subarray(0, newline + 1);
        buffer = buffer.subarray(newline + 1);
        let request;
        try {
          request = decode(frame);
          if (++pending > 128) throw failure('CAPACITY', 'Too many pending RPC requests');
        } catch (error) {
          badFrame(error);
          return;
        }
        dispatch(request).then(reply => {
          pending--;
          if (active && !failed && !socket.destroyed && socket.writable) socket.write(encode(reply));
        }).catch(() => socket.destroy());
      }
      if (buffer.length >= MAX_BYTES) badFrame(failure('TOO_LARGE', 'RPC frame exceeds 1 MiB or lacks LF'));
    });
    socket.on('end', () => {
      if (buffer.length) badFrame(failure('BAD_FRAME', 'Incomplete RPC frame: missing LF'));
    });
  }

  const requestsDir = path.join(endpointPath, 'requests');
  const repliesDir = path.join(endpointPath, 'replies');
  async function handleFile(file, wireId) {
    let reply;
    try {
      const request = await readPrivate(file);
      // Remove the inbox entry before callback execution; duplicates with a
      // different wire ID still share the request-ID deduplication table.
      await fs.unlink(file);
      reply = await dispatch(request);
    } catch (error) {
      await fs.unlink(file).catch(() => {});
      reply = errorReply(error, undefined, instanceId);
    }
    if (!active) return;
    const replyDir = path.join(repliesDir, wireId);
    const replyPath = path.join(replyDir, 'reply.json');
    try {
      // Removing the per-request directory on timeout also prevents a late
      // atomic rename from recreating an orphan reply after client cleanup.
      await privateDir(replyDir);
      await readPrivate(replyPath, true);
      if (active) await atomicWrite(replyPath, reply);
    } catch { /* Client timed out/closed, or an unsafe reply path was rejected. */ }
  }

  async function poll() {
    // A poll only claims files; it does not wait for asynchronous prompts.
    // This keeps handshakes responsive while an onPrompt is still pending.
    const files = await fs.readdir(requestsDir);
    for (const name of files.filter(name => /^[a-f0-9]{32}\.json$/.test(name)).slice(0, 128)) {
      if (!active) break;
      const source = path.join(requestsDir, name);
      const claimed = `${source}.processing`;
      try {
        await fs.rename(source, claimed);
        void handleFile(claimed, name.slice(0, -5));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  async function close() {
    if (closing) return closing;
    active = false;
    clearInterval(pollTimer);
    closing = (async () => {
      for (const socket of connections) socket.destroy();
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      if (polling) await polling.catch(() => {});
      try {
        if (published) {
          // An externally replaced registry belongs to its new owner.
          const current = await readPrivate(config.registryPath).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (current?.instanceId === instanceId) await fs.unlink(config.registryPath);
        }
      } finally {
        if (endpointCreated) {
          if (transport === 'files') await fs.rm(endpointPath, { recursive: true, force: true });
          else await fs.unlink(endpointPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
        requests.clear();
      }
    })();
    return closing;
  }

  try {
    await registryDirs(config, true);
    if (transport === 'socket') {
      server = net.createServer(accept);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(endpointPath, () => { server.removeListener('error', reject); resolve(); });
      });
      endpointCreated = true;
      server.on('error', () => { void close().catch(() => {}); });
      await fs.chmod(endpointPath, 0o600);
    } else {
      await fs.mkdir(endpointPath, { mode: 0o700 });
      endpointCreated = true;
      await privateDir(requestsDir, true);
      await privateDir(repliesDir, true);
      pollTimer = setInterval(() => {
        if (polling || !active) return;
        polling = poll().catch(() => { void close().catch(() => {}); }).finally(() => { polling = undefined; });
      }, POLL_MS);
      pollTimer.unref();
    }
    try {
      await atomicWrite(config.registryPath, registration, true);
      published = true;
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw failure('ENDPOINT_EXISTS', `An endpoint is already registered at ${config.registryPath}; close it first, or remove the registration only if it is confirmed stale`);
      }
      throw error;
    }
    return { instanceId, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

function timeoutError(promptSent) {
  return failure('TIMEOUT', `Remote RPC timed out${promptSent ? '; delivery may have occurred (not retried)' : '; endpoint may be stale or unresponsive'}`);
}

function socketChannel(socketPath, deadline) {
  const socket = net.createConnection(socketPath);
  let buffer = Buffer.alloc(0);
  let waiter;
  let terminal;
  let promptSent = false;
  const fail = error => {
    if (terminal) return;
    terminal = error;
    if (waiter) { waiter.reject(error); waiter = undefined; }
    socket.destroy();
  };
  const timer = setTimeout(() => fail(timeoutError(promptSent)), Math.max(1, deadline - Date.now()));
  socket.on('error', error => {
    const stale = ['ENOENT', 'ECONNREFUSED'].includes(error.code);
    fail(failure(stale ? 'STALE_ENDPOINT' : 'CONNECTION_FAILED', `${stale ? 'Stale endpoint: socket is unavailable' : 'Remote RPC connection failed'}${promptSent ? '; delivery may have occurred (not retried)' : ''}: ${error.message}`));
  });
  socket.on('close', () => {
    clearTimeout(timer);
    fail(failure('CONNECTION_CLOSED', `Remote endpoint closed the connection${promptSent ? '; delivery may have occurred (not retried)' : ''}`));
  });
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    const newline = buffer.indexOf(10);
    if (buffer.length > MAX_BYTES) return fail(failure('TOO_LARGE', 'RPC reply exceeds 1 MiB'));
    if (newline === -1) return;
    try {
      if (!waiter || newline !== buffer.length - 1) throw failure('BAD_FRAME', 'Unexpected RPC reply framing');
      const reply = decode(buffer);
      buffer = Buffer.alloc(0);
      const pending = waiter;
      waiter = undefined;
      pending.resolve(reply);
    } catch (error) { fail(error); }
  });
  return {
    request(request) {
      if (terminal) return Promise.reject(terminal);
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
        try {
          const bytes = encode(request);
          if (request.type === 'prompt') promptSent = true;
          socket.write(bytes);
        } catch (error) { fail(error); }
      });
    },
    close() { clearTimeout(timer); socket.destroy(); },
  };
}

async function fileRequest(endpointPath, request, deadline) {
  const requestsDir = path.join(endpointPath, 'requests');
  const repliesDir = path.join(endpointPath, 'replies');
  const wireId = randomId();
  const requestPath = path.join(requestsDir, `${wireId}.json`);
  const replyDir = path.join(repliesDir, wireId);
  const replyPath = path.join(replyDir, 'reply.json');
  let sent = false;
  let replyCreated = false;
  try {
    await privateDir(endpointPath);
    await privateDir(requestsDir);
    await privateDir(repliesDir);
    await fs.mkdir(replyDir, { mode: 0o700 });
    replyCreated = true;
    await fs.writeFile(replyPath, '', { flag: 'wx', mode: 0o600 });
    if (Date.now() >= deadline) throw timeoutError(false);
    await atomicWrite(requestPath, request, true);
    sent = true;
    while (Date.now() < deadline) {
      const reply = await readPrivate(replyPath, true);
      if (reply) return reply;
      await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
    }
    throw timeoutError(request.type === 'prompt' && sent);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw failure('STALE_ENDPOINT', `Remote files endpoint is missing or closed${request.type === 'prompt' && sent ? '; delivery may have occurred (not retried)' : ''}`);
    }
    throw error;
  } finally {
    if (sent) await fs.unlink(requestPath).catch(() => {});
    if (replyCreated) await fs.rm(replyDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
}

/** Look up one pane, handshake, then send exactly once. No paste fallback and
 * no retry, even when a timeout makes delivery ambiguous. timeoutMs is the
 * overall handshake + prompt budget (1..60000 ms).
 */
async function sendToPane(options = {}) {
  const config = optionsFor(options);
  const { text, deliverAs = 'steer', timeoutMs = 5000 } = options;
  validatePrompt(text, deliverAs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT) {
    throw failure('INVALID_CONFIG', 'timeoutMs must be an integer between 1 and 60000');
  }
  const deadline = Date.now() + timeoutMs;
  const registration = await registrationFor(config);
  const endpointPath = address(config, registration);
  if (registration.transport === 'socket') {
    let stat;
    try { stat = await fs.lstat(endpointPath); } catch (error) {
      if (error.code === 'ENOENT') throw failure('STALE_ENDPOINT', 'Stale endpoint: socket is missing');
      throw error;
    }
    if (!stat.isSocket() || stat.uid !== uid() || (stat.mode & 0o077)) {
      throw failure('UNSAFE_PATH', 'RPC socket must be an owned, private socket (0600)');
    }
  }
  // Validate size before the handshake and before any prompt can be delivered.
  encode({ type: 'prompt', requestId: randomId(), instanceId: registration.instanceId, sessionId: '', text, deliverAs, expiresAt: deadline });
  if (Date.now() >= deadline) throw timeoutError(false);
  const channel = registration.transport === 'socket' ? socketChannel(endpointPath, deadline) : {
    request: request => fileRequest(endpointPath, request, deadline), close() {},
  };
  async function rpc(request, expectedType) {
    const reply = await channel.request(request);
    if (reply.requestId !== request.requestId || reply.instanceId !== registration.instanceId || typeof reply.ok !== 'boolean') {
      throw failure('BAD_REPLY', 'Invalid or stale RPC reply');
    }
    if (!reply.ok) throw failure(reply.code || 'REMOTE_ERROR', reply.message || 'Remote endpoint rejected the request');
    if (reply.type !== expectedType || typeof reply.sessionId !== 'string' || !reply.sessionId || Buffer.byteLength(reply.sessionId) > 4096) {
      throw failure('BAD_REPLY', 'Invalid RPC acknowledgement');
    }
    return reply;
  }
  try {
    const hello = await rpc({ type: 'hello', requestId: randomId(), instanceId: registration.instanceId, expiresAt: deadline }, 'hello');
    const ack = await rpc({ type: 'prompt', requestId: randomId(), instanceId: registration.instanceId, sessionId: hello.sessionId, text, deliverAs, expiresAt: deadline }, 'ack');
    if (ack.sessionId !== hello.sessionId) throw failure('BAD_REPLY', 'ACK session does not match the handshake');
    return ack;
  } finally {
    channel.close();
  }
}

module.exports = { getIdentity, getRuntimeDir, startEndpoint, sendToPane };
