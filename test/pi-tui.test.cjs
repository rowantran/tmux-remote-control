// Optional integration test against an installed Pi CLI and a private tmux
// server. All prompts are intercepted before the model; no API key is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { getIdentity } = require('../lib/pi-remote.cjs');
const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const transport of ['socket', 'files']) {
test(`installed Pi (${transport}): direct messages, locked typing, dialogs, disable, and reload`, {
  skip: process.env.PI_TUI_TEST !== '1', timeout: 60000,
}, async t => {
  const root = await fs.mkdtemp('/tmp/tpi-');
  const project = path.resolve(__dirname, '..');
  const socket = path.join(root, 'tmux.sock');
  const runtimeDir = path.join(root, 'rpc');
  const home = path.join(root, 'home');
  const agentDir = path.join(home, '.pi/agent');
  const eventsPath = path.join(root, 'events.jsonl');
  const ready = path.join(root, 'ready');
  const tmux = (...args) => exec('tmux', ['-S', socket, ...args], { timeout: 8000 });
  t.after(async () => {
    await tmux('kill-server').catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  await exec(path.join(project, 'install-pi-extension.sh'), [], { env: { ...process.env, HOME: home } });
  const guardPath = path.join(root, 'guard.ts');
  await fs.writeFile(guardPath, `
import fs from 'node:fs';
export default function(pi) {
  const record = value => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(value) + '\\n');
  pi.on('session_start', () => fs.writeFileSync(${JSON.stringify(ready)}, 'ready'));
  pi.on('input', (event, ctx) => {
    record({ text: event.text, source: event.source, draft: ctx.ui.getEditorText() });
    return { action: 'handled' };
  });
  pi.registerCommand('test-dialog', { handler: async (_args, ctx) => {
    record({ dialog: 'open' });
    const answer = await ctx.ui.input('Integration test dialog');
    record({ dialog: 'closed', answer });
  }});
}
`);
  await tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'test', '-x', '140', '-y', '40',
    'env', '-u', 'TMUX_REMOTE_CONTROL_TMUX_SOCKET', '-u', 'TMUX_REMOTE_CONTROL_TMUX_SERVER_PID',
    `PATH=${path.join(project, 'bin')}:${process.env.PATH}`,
    `PI_CODING_AGENT_DIR=${agentDir}`, `TMUX_REMOTE_CONTROL_RPC_DIR=${runtimeDir}`,
    `TMUX_REMOTE_CONTROL_RPC_TRANSPORT=${transport}`, 'TMUX_REMOTE_CONTROL_HOST=test-host',
    process.env.PI_TEST_CLI || 'pi', '--offline', '--no-approve', '--no-session',
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-tools',
    '-e', path.join(agentDir, 'extensions/tmux-remote-control/index.ts'), '-e', guardPath);
  async function waitFor(check) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await sleep(80);
    }
    const screen = await tmux('capture-pane', '-p', '-t', 'test', '-S', '-150').catch(() => ({ stdout: '(pane closed)' }));
    throw new Error(`Timed out waiting for Pi. Screen:\n${screen.stdout}`);
  }
  const exists = file => fs.access(file).then(() => true, () => false);
  await waitFor(() => exists(ready));
  await sleep(200);
  const { stdout } = await tmux('display-message', '-p', '-t', 'test', '#{socket_path}|#{pid}|#{pane_id}|#{session_id}');
  const [socketPath, pid, paneId, tmuxSession] = stdout.trim().split('|');
  const identity = getIdentity({ TMUX: `${socketPath},${pid},0`, TMUX_PANE: paneId });
  const registry = path.join(runtimeDir, 'panes', identity.serverKey, `${paneId}.json`);
  const type = text => tmux('send-keys', '-l', '-t', paneId, text);
  const toggle = () => type('\x1b[114;6u');
  const events = async () => (await fs.readFile(eventsPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  async function send(text) {
    const child = require('node:child_process').spawn(path.join(project, 'bin/tmux-remote-control'), [
      'pi-send', '--tmux-socket', socketPath, '--tmux-server-pid', pid, '--session', tmuxSession, '--rpc-dir', runtimeDir,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    const result = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
    });
    child.stdin.end(text);
    await result;
  }
  await type('preserved draft');
  await toggle();
  await waitFor(() => exists(registry));
  // Focus a non-Pi pane. Pi mode must fail instead of feeding its terminal.
  const second = (await tmux('split-window', '-d', '-P', '-F', '#{pane_id}', '-t', paneId, 'sleep', '60')).stdout.trim();
  await tmux('select-pane', '-t', second);
  await assert.rejects(send('not for this terminal'), /No remote endpoint/);
  await tmux('select-pane', '-t', paneId);
  await type('accidental typing');
  await tmux('send-keys', '-t', paneId, 'Enter');
  await type('\x1b[200~pasted text\nmore text\x1b[201~');
  await send('remote sentinel\n世界');
  await waitFor(async () => (await events()).some(event => event.text === 'remote sentinel\n世界'));
  const received = (await events()).find(event => event.text === 'remote sentinel\n世界');
  assert.equal(received.source, 'extension');
  assert.equal(received.draft, 'preserved draft');
  assert.equal((await events()).filter(event => event.text).length, 1);
  await assert.rejects(send('/tree'), /visible editor/);
  await send('/test-dialog');
  await waitFor(async () => (await events()).some(event => event.dialog === 'open'));
  await sleep(100);
  await assert.rejects(send('must not answer dialog'), /dialog open/);
  await type('visible answer');
  await tmux('send-keys', '-t', paneId, 'Enter');
  await waitFor(async () => (await events()).some(event => event.answer === 'visible answer'));
  await toggle();
  await waitFor(async () => !await exists(registry));
  await assert.rejects(send('disabled'), /No remote endpoint/);
  await tmux('send-keys', '-t', paneId, 'Enter');
  await waitFor(async () => (await events()).some(event => event.text === 'preserved draft'));
  assert.equal((await events()).find(event => event.text === 'preserved draft').source, 'interactive');
  // Reload from the visible editor, then enable the fresh extension instance.
  await type('/reload');
  await tmux('send-keys', '-t', paneId, 'Enter');
  await sleep(600);
  await toggle();
  await waitFor(() => exists(registry));
  await send('after reload');
  await waitFor(async () => (await events()).some(event => event.text === 'after reload'));
});
}
