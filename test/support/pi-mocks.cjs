const state = {};
function reset() {
  Object.assign(state, { events: new Map(), commands: new Map(), shortcuts: new Map(), messages: [], notices: [], execs: [], closed: 0, endpointOptions: undefined, startError: undefined, execResult: { code: 0, stdout: 'tmux-remote-control attach host --session %12 --pi', stderr: '' } });
}
reset();
class CustomEditor {
  constructor() { this.actionHandlers = new Map(); this.text = ''; this.focused = true; }
  setText(text) { this.text = text; }
  getText() { return this.text; }
  handleInput(data) { state.baseInput = data; this.text += data; }
}
const keyMap = {
  'app.interrupt': '\x1b', 'app.tools.expand': '\x0f', 'app.thinking.toggle': '\x14',
  'app.message.copy': '\x18', 'app.model.select': '\x0c', 'app.model.cycleForward': '\x10',
  'app.model.cycleBackward': '\x1b[112;6u', 'app.thinking.cycle': '\x1b[Z',
  'app.suspend': '\x1a', 'app.session.tree': '\x1b[116;6u', 'app.session.resume': '\x1b[114;6u',
};
const keybindings = { matches: (data, action) => keyMap[action] === data };
module.exports = {
  state, reset, CustomEditor, keybindings,
  matchesKey: (data, key) => key === 'ctrl+shift+r' && data === '\x1b[114;6u',
  truncateToWidth: (text, width) => text.slice(0, width),
  getIdentity: () => ({ paneId: '%12', serverKey: 'test' }),
  getRuntimeDir: () => '/tmp/mock-rpc',
  async startEndpoint(options) {
    if (state.startError) throw state.startError;
    state.endpointOptions = options;
    return { instanceId: 'instance', close: async () => { state.closed++; } };
  },
};
