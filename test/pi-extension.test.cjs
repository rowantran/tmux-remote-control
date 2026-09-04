const assert = require('node:assert/strict');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');
const { createJiti } = require('jiti');
const mockPath = path.join(__dirname, 'support/pi-mocks.cjs');
const jiti = createJiti(__filename, { fsCache: false, alias: {
  '@earendil-works/pi-coding-agent': mockPath,
  '@earendil-works/pi-tui': mockPath,
  './lib/pi-remote.cjs': mockPath,
  [path.resolve(__dirname, '../lib/pi-remote.cjs')]: mockPath,
} });
const mocks = jiti(mockPath);
const { state, keybindings } = mocks;
const extension = jiti('../pi-extension.ts');
let ctx, pi, oldEditor, sessionId, env, stdoutWrite;
beforeEach(() => {
  mocks.reset();
  delete state.baseInput;
  env = { ...process.env };
  stdoutWrite = process.stdout.write;
  state.clipboard = [];
  process.stdout.write = function(chunk, ...args) {
    if (typeof chunk === 'string' && chunk.startsWith('\x1b]52;')) {
      state.clipboard.push(chunk);
      return true;
    }
    return stdoutWrite.call(this, chunk, ...args);
  };
  delete process.env.TMUX_REMOTE_CONTROL_RPC_TRANSPORT;
  delete process.env.TMUX_REMOTE_CONTROL_RPC_DIR;
  sessionId = 'session-1';
  oldEditor = () => new mocks.CustomEditor();
  ctx = {
    mode: 'tui', sessionManager: { getSessionId: () => sessionId },
    ui: {
      theme: { fg: (_color, text) => text },
      factory: oldEditor, editor: new mocks.CustomEditor(),
      getEditorComponent() { return this.factory; },
      setEditorComponent(factory) {
        const text = this.editor?.getText() || '';
        this.factory = factory;
        this.editor = factory ? factory({}, {}, keybindings) : new mocks.CustomEditor();
        this.editor.setText(text);
      },
      notify: (...args) => state.notices.push(args),
    },
  };
  pi = {
    on: (name, handler) => state.events.set(name, handler),
    registerCommand: (name, spec) => state.commands.set(name, spec),
    registerShortcut: (name, spec) => state.shortcuts.set(name, spec),
    exec: async (...args) => { state.execs.push(args); return state.execResult; },
    getCommands: () => [{ name: 'goal' }, { name: 'skill:review' }, { name: 'remote-control' }],
    sendUserMessage: (...args) => state.messages.push(args),
  };
  extension.default(pi);
});
afterEach(() => { process.env = env; process.stdout.write = stdoutWrite; });
const toggle = () => state.shortcuts.get('ctrl+shift+r').handler(ctx);
const prompt = (text = 'hello', overrides = {}) => state.endpointOptions.onPrompt({ text, deliverAs: 'steer', sessionId, ...overrides });

test('enable registers current session, locks editor, and generates Pi command', async () => {
  ctx.ui.editor.setText('existing draft');
  await toggle();
  assert.equal(state.endpointOptions.transport, 'socket');
  assert.equal(state.endpointOptions.sessionId(), 'session-1');
  assert.deepEqual(state.execs[0][1], ['--print-controller-command', '--pi']);
  assert.equal(state.clipboard.length, 1);
  assert.ok(ctx.ui.editor instanceof extension.RemoteControlEditor);
  assert.match(ctx.ui.editor.render(100)[0], /typing locked/);
  assert.equal(ctx.ui.editor.getText(), 'existing draft');
  prompt('multiline\nhello\u2028世界');
  assert.deepEqual(state.messages, [['multiline\nhello\u2028世界', { deliverAs: 'steer', expandPromptTemplates: true }]]);
  await toggle();
  assert.equal(ctx.ui.factory, oldEditor);
  assert.equal(ctx.ui.editor.getText(), 'existing draft');
  assert.equal(state.closed, 1);
  assert.throws(() => prompt(), /disabled/);
});

test('locked editor ignores typing, paste, submit, history, clipboard, external editor, and queue bindings', async () => {
  await toggle();
  const editor = ctx.ui.editor;
  editor.setText('preserved draft');
  let submitted = 0, clipboard = 0;
  editor.onSubmit = () => submitted++;
  editor.onPasteImage = () => clipboard++;
  for (const input of ['hello', '世界', '\r', '\n', '\x1b[13;3u', '\x16', '\x07', '\x19', '\x1b[A', '\x1b[1;3A', '\x03', '\x04', '\x1b[97u']) {
    editor.handleInput(input);
  }
  editor.handleInput('\x1b[200~');
  editor.handleInput('\x1b');
  editor.handleInput('\x1b[114;6u');
  editor.handleInput('pasted\ntext\x1b[201~');
  assert.equal(editor.getText(), 'preserved draft');
  assert.equal(submitted, 0);
  assert.equal(clipboard, 0);
  assert.equal(state.baseInput, undefined);
  assert.equal(state.messages.length, 0);
});

test('locked editor preserves explicit controls without delegating text editing', async () => {
  await toggle();
  const editor = ctx.ui.editor;
  let interrupted = 0, expanded = 0, toggled = 0;
  editor.onEscape = () => interrupted++;
  editor.actionHandlers.set('app.tools.expand', () => expanded++);
  editor.onExtensionShortcut = () => { toggled++; return true; };
  editor.handleInput('\x1b');
  editor.handleInput('\x0f');
  editor.handleInput('\x1b[114;6u');
  assert.deepEqual([interrupted, expanded, toggled], [1, 1, 1]);
});

test('dialogs retain keyboard ownership and remote prompts fail without delivery', async () => {
  await toggle();
  state.events.get('ui_prompt_start')();
  assert.throws(() => prompt(), /dialog open/);
  state.events.get('ui_prompt_end')();
  ctx.ui.editor.focused = false;
  assert.throws(() => prompt(), /dialog open/);
  ctx.ui.editor.focused = true;
  prompt();
  assert.equal(state.messages.length, 1);
});

test('session mismatch and shutdown reject stale messages and restore editor', async () => {
  await toggle();
  sessionId = 'session-2';
  assert.throws(() => prompt('old', { sessionId: 'session-1' }), /session changed/);
  await state.events.get('session_shutdown')({ reason: 'reload' }, ctx);
  assert.equal(state.closed, 1);
  assert.equal(ctx.ui.factory, oldEditor);
  assert.throws(() => prompt(), /disabled/);
  await toggle();
  assert.equal(state.execs.length, 1);
});

test('registered slash commands expand; unsupported TUI and shell shortcuts fail clearly', async () => {
  await toggle();
  for (const text of ['/tree', '/settings', '!rm file']) assert.throws(() => prompt(text), /visible editor/);
  prompt('/goal finish tests');
  prompt('/skill:review');
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[0][1].expandPromptTemplates, true);
});

test('explicit files transport requires a shared directory', async () => {
  process.env.TMUX_REMOTE_CONTROL_RPC_TRANSPORT = 'files';
  await toggle();
  assert.equal(state.endpointOptions, undefined);
  assert.match(state.notices.at(-1)[0], /requires TMUX_REMOTE_CONTROL_RPC_DIR/);
  assert.equal(ctx.ui.factory, oldEditor);
  process.env.TMUX_REMOTE_CONTROL_RPC_DIR = '/shared/private';
  await toggle();
  assert.equal(state.endpointOptions.transport, 'files');
});

test('startup failure leaves normal editor usable and never copies controller command', async () => {
  state.startError = new Error('socket blocked');
  await toggle();
  assert.equal(ctx.ui.factory, oldEditor);
  assert.match(state.notices.at(-1)[0], /socket blocked/);
  assert.equal(state.notices.some(([text]) => text.startsWith('Copied')), false);
});

test('invalid launcher output and non-TUI mode never create endpoint', async () => {
  state.execResult.stdout = 'invalid\ncommand';
  await toggle();
  assert.equal(state.endpointOptions, undefined);
  assert.match(state.notices.at(-1)[0], /invalid controller command/);
  ctx.mode = 'rpc';
  await toggle();
  assert.match(state.notices.at(-1)[0], /interactive TUI/);
});

test('shutdown during async startup does not install a stale editor', async () => {
  let resolve;
  pi.exec = () => new Promise(r => { resolve = r; });
  const enabling = toggle();
  await state.events.get('session_shutdown')({ reason: 'quit' }, ctx);
  resolve(state.execResult);
  await enabling;
  assert.equal(state.endpointOptions, undefined);
  assert.equal(ctx.ui.factory, oldEditor);
});
