#!/usr/bin/env python3
"""Exercise real terminal input and controller restarts without a remote host."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import tempfile
import termios
import time
import unittest
import uuid

PROJECT = Path(__file__).resolve().parent.parent
SCRIPT = PROJECT / "bin/tmux-remote-control"
FZF = shutil.which("fzf")
NODE = shutil.which("node")
ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")


class Controller:
    def __init__(self, env, *options, wait_for_prompt=True):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.execve(str(SCRIPT), [str(SCRIPT), "attach", "example-host", "--session", "%7", *options], env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
        self.output = bytearray()
        self.status = None
        if wait_for_prompt:
            self.wait_prompt(1)

    def send(self, text):
        os.write(self.fd, text.encode() if isinstance(text, str) else text)

    def read(self):
        if select.select([self.fd], [], [], 0.05)[0]:
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                data = b""
            old_cpr = self.output.count(b"\x1b[6n")
            self.output.extend(data)
            # fzf may ask the terminal for its cursor position.
            if self.output.count(b"\x1b[6n") > old_cpr:
                self.send(b"\x1b[1;1R")
        if self.status is None:
            child, status = os.waitpid(self.pid, os.WNOHANG)
            if child:
                self.status = os.waitstatus_to_exitcode(status)

    def wait(self, condition, label):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            self.read()
            if condition():
                return
            if self.status is not None:
                break
        raise AssertionError(f"Timed out waiting for {label} (exit={self.status}):\n{self.plain()[-7000:]}")

    def plain(self, offset=0):
        return ANSI.sub(b"", bytes(self.output[offset:])).decode("utf8", "replace")

    def prompts(self):
        # Only the inline composer uses '› '. The built-in picker uses '> '.
        sections = re.split(rb"\x1b\[>[0-9;]*u", bytes(self.output))[1:]
        return sum("› ".encode() in section for section in sections)

    def wait_prompt(self, number):
        self.wait(lambda: self.prompts() >= number, f"inline prompt {number}")

    def open_history(self, key=b"\x1b"):
        start = len(self.output)
        self.send(key)
        self.wait(lambda: "Message history" in self.plain(start), "history picker")

    def exit(self, expected=0):
        self.send(b"\x04")
        self.wait(lambda: self.status is not None, "controller exit")
        assert self.status == expected, self.plain()[-5000:]

    def close(self):
        # pty.fork creates an isolated session/process group for the controller.
        try:
            os.killpg(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if self.status is None:
            try:
                os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                child, _ = os.waitpid(self.pid, os.WNOHANG)
                if child:
                    break
                time.sleep(0.02)
        os.close(self.fd)


class HistoryTerminalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="tmux-history-pty-")
        self.root = Path(self.directory.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        (self.bin / "node").symlink_to(NODE)
        self.history = self.root / "history"
        self.history.mkdir(mode=0o700)
        self.env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
            "TMUX_REMOTE_CONTROL_AEROSPACE_RESIZE": "0",  # Never resize real desktop windows.
            "TMUX_REMOTE_CONTROL_HISTORY_DIR": str(self.history),
            "TMUX_REMOTE_CONTROL_HISTORY_PICKER": "builtin",
            "TMUX_REMOTE_CONTROL_HISTORY": "1",
            "TMUX_REMOTE_CONTROL_EDITOR": str(self.bin / "editor"),
            "TMUX_REMOTE_CONTROL_TMPDIR": str(self.root),
            "HISTORY_TEST_ROOT": str(self.root),
        }
        for name in ["TMUX_REMOTE_CONTROL_HOST", "TMUX_REMOTE_CONTROL_SESSION", "TMUX_REMOTE_CONTROL_TARGET"]:
            self.env.pop(name, None)
        # Satisfy CLI discovery without ever calling the real window manager.
        # Resize tests intercept the helper itself in the node mock below.
        self.program("aerospace", "raise SystemExit('unexpected AeroSpace CLI invocation')\n")
        self.program("ssh", r'''
import json, os, sys
from pathlib import Path
root = Path(os.environ['HISTORY_TEST_ROOT'])
args = sys.argv[1:]
command = args[-1]
if '-O' in args:
    sys.exit(0)
if '#{session_id}|#{session_name}' in command:
    print('$3|work')
elif '#{pane_id}|#{session_name}' in command:
    print('%7|work:0.0|work')
elif command.startswith(('tmux select-pane ', 'tmux select-window ', 'tmux resize-pane ')):
    (root / 'focus').write_text('B')
    with (root / 'navigation').open('a') as log:
        log.write(command + '\n')
else:
    assert 'paste-buffer -p -r' in command
    assert 'focused_pane=' in command
    text = sys.stdin.buffer.read().decode()
    target = (root / 'focus').read_text() if (root / 'focus').exists() else 'A'
    with (root / 'submissions').open('a') as log:
        log.write(json.dumps({'text': text, 'target': target}) + '\n')
    if (root / 'fail-send').exists():
        sys.exit(255)
''')
        self.program("editor", r'''
import os, sys
from pathlib import Path
root = Path(os.environ['HISTORY_TEST_ROOT'])
file = Path(sys.argv[1])
(root / 'editor-initial').write_bytes(file.read_bytes())
(root / 'editor-rows').write_text(str(os.get_terminal_size(0).lines))
result = root / 'editor-result'
file.write_bytes(result.read_bytes() if result.exists() else b'edited first\nedited second\n')
''')
        self.controllers = []

    def tearDown(self):
        for controller in self.controllers:
            controller.close()
        self.directory.cleanup()

    def program(self, name, source):
        import sys
        file = self.bin / name
        file.write_text(f"#!{sys.executable}\n" + source)
        file.chmod(0o700)

    def start(self, *options):
        controller = Controller(self.env, *options)
        self.controllers.append(controller)
        return controller

    def sent(self):
        file = self.root / "submissions"
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

    def records(self):
        return [json.loads(file.read_text()) for file in self.history.glob("*.json")]

    def draft(self):
        files = list(self.root.glob("tmux-remote-control.??????"))
        self.assertEqual(len(files), 1)
        return files[0].read_bytes()

    def seed(self, text, host="example-host", session="work", timestamp="2026-06-01T12:00:00.000Z"):
        entry = dict(id=str(uuid.uuid4()), text=text, host=host, session=session, timestamp=timestamp, status="sent")
        (self.history / f"{entry['id']}.json").write_text(json.dumps(entry))

    def mock_aerospace(self):
        self.env.update(TERM_PROGRAM="ghostty", OSTYPE="darwin", TMUX_REMOTE_CONTROL_AEROSPACE_RESIZE="1",
                        HISTORY_TEST_NODE=NODE)
        for name in ["TMUX", "STY", "SSH_CONNECTION", "SSH_TTY"]:
            self.env.pop(name, None)
        (self.bin / "node").unlink()
        self.program("node", r'''
import fcntl, os, struct, sys, termios
from pathlib import Path
if Path(sys.argv[1]).name == 'aerospace-window.mjs':
    assert len(sys.argv) == 4
    assert Path(sys.argv[2]).name == 'aerospace.json'
    assert sys.argv[3] in ('compact', 'expanded')
    root = Path(os.environ['HISTORY_TEST_ROOT'])
    with (root / 'sizes').open('a') as log:
        log.write(sys.argv[3] + '\n')
    if (root / 'fail-resize').exists():
        sys.exit(2)
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 8 if sys.argv[3] == 'compact' else 40, 100, 0, 0))
else:
    os.execv(os.environ['HISTORY_TEST_NODE'], [os.environ['HISTORY_TEST_NODE'], *sys.argv[1:]])
''')

    def sizes(self):
        file = self.root / "sizes"
        return file.read_text().splitlines() if file.exists() else []

    def test_aerospace_prompt_editor_and_history_sizes(self):
        self.mock_aerospace()
        self.seed("old message")
        controller = self.start()
        self.assertEqual(os.get_terminal_size(controller.fd).lines, 8)
        controller.send("draft\x07")
        controller.wait_prompt(2)
        self.assertEqual((self.root / "editor-rows").read_text(), "40")
        self.assertEqual(os.get_terminal_size(controller.fd).lines, 8)
        self.assertEqual(self.sent(), [])
        self.assertEqual(len(self.records()), 1)  # Only the seeded message.
        controller.send("\x03")  # Saving in the editor leaves a nonempty draft.
        controller.open_history()
        self.assertEqual(os.get_terminal_size(controller.fd).lines, 40)
        controller.send("\x1b")
        controller.wait_prompt(3)
        self.assertEqual(os.get_terminal_size(controller.fd).lines, 8)
        controller.send("\x1b[107;5u")  # Navigation must not resize.
        controller.wait_prompt(4)
        controller.exit()
        self.assertEqual(self.sizes(), ["compact", "expanded", "compact", "expanded", "compact"])

    def test_aerospace_editor_first_compacts_and_waits_for_confirmation(self):
        self.mock_aerospace()
        controller = self.start("--editor", "--once")
        self.assertEqual((self.root / "editor-rows").read_text(), "40")
        self.assertEqual(os.get_terminal_size(controller.fd).lines, 8)
        self.assertEqual(self.sizes(), ["expanded", "compact"])
        self.assertEqual(self.sent(), [])
        self.assertEqual(self.records(), [])
        self.assertIsNone(controller.status)
        controller.send("\r")
        controller.wait(lambda: controller.status is not None, "confirmed editor draft exit")
        self.assertEqual(controller.status, 0)
        self.assertEqual(self.sent()[0]["text"], "edited first\nedited second")
        self.assertEqual(len(self.records()), 1)

    def test_aerospace_failed_editor_compacts_before_exit(self):
        self.mock_aerospace()
        self.program("editor", "raise SystemExit(42)\n")
        controller = self.start()
        controller.send("\x07")
        controller.wait(lambda: controller.status is not None, "failed editor exit")
        self.assertEqual(controller.status, 1)
        self.assertEqual(self.sizes(), ["compact", "expanded", "compact"])
        self.assertEqual(self.sent(), [])

    def test_aerospace_history_selection_compacts_without_sending(self):
        self.mock_aerospace()
        self.seed("restore only")
        controller = self.start()
        controller.open_history()
        controller.send("\r")
        controller.wait_prompt(2)
        self.assertEqual(self.sent(), [])
        self.assertEqual(self.sizes(), ["compact", "expanded", "compact"])
        controller.exit()

    def test_aerospace_cleanup_compacts_when_terminated_in_history(self):
        self.mock_aerospace()
        self.seed("restore only")
        controller = self.start()
        controller.open_history()
        self.assertEqual(os.get_terminal_size(controller.fd).lines, 40)
        os.killpg(controller.pid, signal.SIGTERM)
        controller.wait(lambda: controller.status is not None, "controller termination in history")
        self.assertIn(controller.status, [-signal.SIGTERM, 128 + signal.SIGTERM])
        self.assertEqual(self.sizes(), ["compact", "expanded", "compact"])
        self.assertEqual(os.get_terminal_size(controller.fd).lines, 8)
        self.assertEqual(controller.prompts(), 1)
        self.assertEqual(self.sent(), [])
        self.assertEqual(len(self.records()), 1)

    def test_aerospace_failure_is_not_retried_and_input_still_works(self):
        self.mock_aerospace()
        (self.root / "fail-resize").touch()
        controller = self.start()
        controller.send("still works\r")
        controller.wait_prompt(2)
        controller.send("\x07")
        controller.wait_prompt(3)
        controller.exit()
        self.assertEqual(self.sent()[0]["text"], "still works")
        self.assertEqual(self.sizes(), ["compact"])

    def test_aerospace_missing_cli_silently_skips_sizing(self):
        self.mock_aerospace()
        (self.bin / "aerospace").unlink()
        # Exclude every ambient PATH entry, including any installed AeroSpace.
        for name in ["bash", "dirname", "mktemp", "rm", "sed", "stty"]:
            (self.bin / name).symlink_to(shutil.which(name))
        self.env["PATH"] = str(self.bin)
        self.assertIsNone(shutil.which("aerospace", path=self.env["PATH"]))
        controller = self.start()
        self.assertEqual(os.get_terminal_size(controller.fd).lines, 24)
        controller.send("still works\r")
        controller.wait_prompt(2)
        controller.send("\x07")
        controller.wait_prompt(3)
        self.assertEqual((self.root / "editor-rows").read_text(), "24")
        controller.exit()
        self.assertEqual(self.sent(), [{"text": "still works", "target": "A"}])
        self.assertEqual(self.sizes(), [])
        self.assertNotIn("aerospace", controller.plain().lower())

    def test_aerospace_opt_out_and_nested_terminals(self):
        self.mock_aerospace()
        for key, value in [("TMUX_REMOTE_CONTROL_AEROSPACE_RESIZE", "0"), ("TMUX", "/tmp/fake,1,1"),
                           ("STY", "screen"), ("SSH_CONNECTION", "remote"), ("SSH_TTY", "/dev/pts/0"),
                           ("TERM_PROGRAM", "other-terminal"), ("OSTYPE", "linux-gnu")]:
            old = self.env.get(key)
            self.env[key] = value
            controller = self.start()
            controller.exit()
            self.assertEqual(self.sizes(), [])
            if old is None:
                self.env.pop(key)
            else:
                self.env[key] = old

    def test_linear_history_restores_unsent_draft(self):
        controller = self.start()
        controller.send("older\r")
        controller.wait_prompt(2)
        controller.send("latest\r")
        controller.wait_prompt(3)
        controller.send("unfinished\x1b[A\x1b[A\x1b[A\x1b[B\x1b[B\r")
        controller.wait_prompt(4)
        self.assertEqual([entry["text"] for entry in self.sent()], ["older", "latest", "unfinished"])
        controller.exit()

    def test_recall_then_switch_pane_only_sends_on_explicit_enter(self):
        controller = self.start()
        controller.send("recover this message\r")
        controller.wait_prompt(2)
        controller.send("\x1b[A\x1b[107;5u")  # Up, Ctrl-K selects a different pane
        controller.wait_prompt(3)
        self.assertEqual(self.sent(), [{"text": "recover this message", "target": "A"}])
        controller.send("\r")
        controller.wait_prompt(4)
        self.assertEqual(self.sent()[-1], {"text": "recover this message", "target": "B"})
        controller.exit()
        controller = self.start()
        controller.send("\x1b[A\r")
        controller.wait_prompt(2)
        self.assertEqual(self.sent()[-1]["text"], "recover this message")
        self.assertEqual(len(self.records()), 3)
        for record in self.records():
            self.assertEqual(set(record), {"id", "text", "timestamp", "host", "session", "status"})
            self.assertEqual(record["status"], "sent")
        controller.exit()

    def test_builtin_search_scope_and_restore_without_submission(self):
        self.seed("run lint")
        self.seed("fix authentication tests", host="other", session="other")
        controller = self.start()
        controller.open_history()
        controller.send("fix ath\t\r")
        controller.wait_prompt(2)
        self.assertEqual(self.sent(), [])
        controller.send("\r")
        controller.wait_prompt(3)
        self.assertEqual(self.sent()[0]["text"], "fix authentication tests")
        self.assertEqual(self.sent()[0]["target"], "A")
        controller.exit()

    def test_cancel_and_nonempty_escape_preserve_prompt(self):
        self.seed("old message")
        controller = self.start()
        controller.open_history()
        controller.send("\x03")
        controller.wait_prompt(2)
        controller.send("do not lose this\x1b[27u\x1b[107;5u")
        controller.wait_prompt(3)
        controller.send("\r")
        controller.wait_prompt(4)
        self.assertEqual([entry["text"] for entry in self.sent()], ["do not lose this"])
        controller.exit()

    def test_extended_escape_opens_history_and_whitespace_draft_is_preserved(self):
        self.seed("recalled message")
        controller = self.start()
        controller.open_history(b"\x1b[27u")
        controller.send("\x1b")
        controller.wait_prompt(2)
        controller.send(" \x1b[27u\x1b[107;5u")
        controller.wait_prompt(3)
        controller.send("\r")
        controller.wait_prompt(4)
        self.assertEqual([entry["text"] for entry in self.sent()], [" "])
        controller.exit()

    def test_multiline_recall_and_external_editor_record_exact_input(self):
        text = "  first\tline\r\nsecond\n\n"
        self.seed(text)
        controller = self.start()
        controller.send("\x1b[A\r")
        controller.wait_prompt(2)
        self.assertEqual(self.sent()[0]["text"], text)
        controller.send("\x1b[A\x07")
        controller.wait_prompt(3)
        self.assertEqual((self.root / "editor-initial").read_bytes(), text.encode())
        self.assertEqual([entry["text"] for entry in self.sent()], [text])
        self.assertFalse(any(record["text"] == "edited first\nedited second" for record in self.records()))
        controller.send("\r")
        controller.wait_prompt(4)
        self.assertEqual(self.sent()[-1]["text"], "edited first\nedited second")
        self.assertTrue(any(record["text"] == "edited first\nedited second" for record in self.records()))
        controller.exit()

    def test_editor_draft_shows_overflow_and_can_be_edited_after_switching_panes(self):
        self.mock_aerospace()
        text = "\n".join(f"edited line {index}" for index in range(1, 11))
        (self.root / "editor-result").write_text(text + "\n")
        controller = self.start()
        start = len(controller.output)
        controller.send("draft\x07")
        controller.wait_prompt(2)
        self.assertIn("↑ 5 more", controller.plain(start))
        self.assertIn("edited line 10", controller.plain(start))
        self.assertEqual(os.get_terminal_size(controller.fd).lines, 8)
        self.assertEqual((self.root / "editor-initial").read_text(), "draft")
        self.assertEqual(self.draft(), text.encode())
        self.assertEqual(self.sent(), [])
        self.assertEqual(self.records(), [])
        start = len(controller.output)
        controller.send("\x1b[A" * 9)
        controller.wait(lambda: "↓ 5 more" in controller.plain(start), "hidden rows below editor draft")
        controller.send("\x1b[107;5u")  # Ctrl-K: keep the editor draft, change the target.
        controller.wait_prompt(3)
        self.assertEqual(self.sent(), [])
        controller.send("!\x1b[13;2u\r")  # Append text and an intentional final newline.
        controller.wait_prompt(4)
        self.assertEqual(self.sent(), [{"text": text + "!\n", "target": "B"}])
        self.assertEqual(self.records()[0]["text"], text + "!\n")
        controller.exit()

    def test_editor_draft_can_be_reopened_and_cleared_before_submission(self):
        controller = self.start("--once")
        controller.send("draft\x07")
        controller.wait_prompt(2)
        controller.send("\x07")
        controller.wait_prompt(3)
        self.assertEqual((self.root / "editor-initial").read_text(), "edited first\nedited second")
        self.assertEqual(self.sent(), [])
        self.assertEqual(self.records(), [])
        controller.send("\x03\x07")
        controller.wait_prompt(4)
        self.assertEqual((self.root / "editor-initial").read_text(), "")
        controller.send("\x03replacement\r")
        controller.wait(lambda: controller.status is not None, "replacement submission")
        self.assertEqual(controller.status, 0)
        self.assertEqual(self.sent(), [{"text": "replacement", "target": "A"}])
        self.assertEqual(len(self.records()), 1)

    def test_editor_draft_can_be_discarded_without_sending(self):
        for options in [(), ("--editor", "--once")]:
            controller = self.start(*options)
            if not options:
                controller.send("\x07")
                controller.wait_prompt(2)
            controller.exit()
            self.assertEqual(self.sent(), [])
            self.assertEqual(self.records(), [])

    def test_empty_editor_result_returns_to_an_editable_prompt(self):
        (self.root / "editor-result").write_text("\n")
        controller = self.start("--editor", "--once")
        self.assertEqual(self.sent(), [])
        self.assertEqual(self.records(), [])
        self.assertEqual(self.draft(), b"")
        controller.send("\r")  # Empty Enter is not a submission, even with --once.
        controller.wait_prompt(2)
        self.assertEqual(self.sent(), [])
        self.assertEqual(self.records(), [])
        controller.send("typed after editor\r")
        controller.wait(lambda: controller.status is not None, "submission after empty editor")
        self.assertEqual(controller.status, 0)
        self.assertEqual(self.sent()[0]["text"], "typed after editor")

    def test_editor_first_reopens_only_after_an_explicit_submission(self):
        controller = self.start("--editor")
        self.assertEqual(self.sent(), [])
        controller.send("\r")
        controller.wait_prompt(2)
        self.assertEqual((self.root / "editor-initial").read_text(), "")
        self.assertEqual(len(self.sent()), 1)
        self.assertEqual(len(self.records()), 1)
        controller.exit()
        self.assertEqual(len(self.sent()), 1)

    def test_editor_draft_preserves_whitespace_until_inline_editing(self):
        text = "  first\tline\r\nsecond\r\n"
        (self.root / "editor-result").write_bytes((text + "\r\n").encode())
        controller = self.start("--editor")
        self.assertEqual(self.draft(), text.encode())  # CRLF already removed, exactly once.
        self.assertEqual(self.sent(), [])
        self.assertEqual(self.records(), [])
        controller.send("\x1b[D\x1b[C\x1b[107;5u")  # Cursor motion does not edit the payload.
        controller.wait_prompt(2)
        self.assertEqual(self.draft(), text.encode())
        controller.send("\r")
        controller.wait_prompt(3)
        self.assertEqual(self.sent(), [{"text": text, "target": "B"}])
        self.assertEqual(self.records()[0]["text"], text)
        controller.exit()

    def test_external_edits_to_recalled_messages_preserve_history_and_original_draft(self):
        self.seed("oldest", timestamp="2026-06-01T10:00:00.000Z")
        self.seed("newest")
        edited = b" edited\tnewest"
        (self.root / "editor-result").write_bytes(edited + b"\r\n")
        controller = self.start()
        controller.send("original draft\x1b[A\x07")
        controller.wait_prompt(2)
        self.assertEqual((self.root / "editor-initial").read_bytes(), b"newest")
        self.assertEqual(self.draft(), edited)
        controller.send("\x1b[A\x1b[107;5u")  # Browse position survives editor return.
        controller.wait_prompt(3)
        self.assertEqual(self.draft(), b"oldest")
        controller.send("\x1b[B\x1b[112;5u")
        controller.wait_prompt(4)
        self.assertEqual(self.draft(), edited)
        controller.send("\x1b[B\x1b[107;5u")
        controller.wait_prompt(5)
        self.assertEqual(self.draft(), b"original draft")
        self.assertEqual(self.sent(), [])
        self.assertEqual(sorted(record["text"] for record in self.records()), ["newest", "oldest"])
        controller.send("\x1b[A\r")
        controller.wait_prompt(6)
        self.assertEqual(self.sent()[0]["text"], edited.decode())
        controller.exit()

    def test_history_recall_after_editor_return_is_not_trimmed_at_send(self):
        text = "history\ttext\r\nlast\n\n"
        self.seed(text)
        controller = self.start()
        controller.send("\x07")
        controller.wait_prompt(2)
        self.assertEqual(self.sent(), [])
        controller.send("\x03\x1b[A\r")
        controller.wait_prompt(3)
        self.assertEqual(self.sent()[0]["text"], text)
        self.assertTrue(all(record["text"] == text for record in self.records()))
        controller.exit()

    def test_failed_send_is_saved_unconfirmed_and_not_retried(self):
        (self.root / "fail-send").touch()
        controller = self.start()
        controller.send("keep after failure\r")
        controller.wait(lambda: controller.status is not None, "failed submission")
        self.assertEqual(controller.status, 1)
        self.assertEqual(self.records()[0]["status"], "unconfirmed")
        (self.root / "fail-send").unlink()
        controller = self.start()
        controller.send("\x1b[A\x1b[107;5u")
        controller.wait_prompt(2)
        self.assertEqual(len(self.sent()), 1)
        controller.exit()

    def test_history_can_be_disabled(self):
        self.seed("must not recall")
        self.env["TMUX_REMOTE_CONTROL_HISTORY"] = "0"
        controller = self.start()
        controller.send("\x1b[Anew input\r")
        controller.wait_prompt(2)
        self.assertEqual([entry["text"] for entry in self.sent()], ["new input"])
        self.assertEqual(len(self.records()), 1)
        controller.exit()

    def test_auto_picker_falls_back_when_fzf_is_missing(self):
        self.seed("fallback message")
        self.env["PATH"] = f"{self.bin}:/usr/bin:/bin"
        self.env["TMUX_REMOTE_CONTROL_HISTORY_PICKER"] = "auto"
        controller = self.start()
        controller.open_history()
        controller.send("\r")
        controller.wait_prompt(2)
        self.assertEqual(self.sent(), [])
        controller.send("\r")
        controller.wait_prompt(3)
        self.assertEqual(self.sent()[0]["text"], "fallback message")
        controller.exit()

    @unittest.skipUnless(FZF, "fzf is optional and not installed")
    def test_real_fzf_search_preview_restore_and_cancel(self):
        self.seed("older text", timestamp="2026-06-01T10:00:00.000Z")
        text = "review authentication\n$(touch should-not-execute)\nsecond line"
        self.seed(text)
        self.seed("unrelated newest message", timestamp="2026-06-01T13:00:00.000Z")
        self.env["TMUX_REMOTE_CONTROL_HISTORY_PICKER"] = "fzf"
        self.env["FZF_DEFAULT_OPTS"] = "--select-1 --multi --bind=enter:abort"
        controller = self.start()
        controller.open_history()
        start = len(controller.output)
        controller.send("rvw auth")
        controller.wait(lambda: "1/3" in controller.plain(start), "fzf search to filter to one match")
        controller.send("\r")
        controller.wait_prompt(2)
        self.assertEqual(self.sent(), [])
        controller.send("\r")
        controller.wait_prompt(3)
        controller.wait(lambda: len(self.sent()) == 1, "fzf-restored submission")
        self.assertEqual(self.sent()[0]["text"], text)
        controller.open_history()
        controller.send("\x1b")
        controller.wait_prompt(4)
        self.assertEqual(len(self.sent()), 1)
        controller.exit()


if __name__ == "__main__":
    unittest.main(verbosity=2)
