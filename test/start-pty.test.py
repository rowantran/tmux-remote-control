#!/usr/bin/env python3
"""Exercise the installed-style start CLI in a TTY without SSH or GUI side effects."""
import json
import os
from pathlib import Path
import pty
import select
import signal
import sys
import tempfile
import time


if sys.platform != "darwin":
    print("start PTY tests skipped: start requires macOS")
    raise SystemExit(0)

launcher = Path(__file__).resolve().parent.parent / "bin" / "tmux-remote-control"


def run(root, mode="success", extra_env=None, interrupt=False):
    log = root / f"{mode}.jsonl"
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("TMUX_REMOTE_CONTROL_")
           and key not in ("TMUX", "TMUX_PANE", "STY", "SSH_CONNECTION", "SSH_TTY")}
    env.update(PATH=f"{root}:{env['PATH']}", TERM="xterm-256color", TERM_PROGRAM="ghostty",
               FIXTURE_LOG=str(log), FIXTURE_MODE=mode)
    env.update(extra_env or {})
    pid, fd = pty.fork()
    if pid == 0:
        os.execve("/bin/bash", ["/bin/bash", str(launcher), "start", "dev'box", "team's work",
                                "--", "pi", "argument with spaces"], env)
    output = bytearray()
    status = None
    interrupted = False
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if select.select([fd], [], [], 0.02)[0]:
                try:
                    output.extend(os.read(fd, 65536))
                except OSError:
                    pass
            if interrupt and not interrupted and log.exists():
                os.kill(pid, signal.SIGTERM)
                interrupted = True
            child, result = os.waitpid(pid, os.WNOHANG)
            if child:
                status = os.waitstatus_to_exitcode(result)
                break
        # Drain error text written just before process exit.
        while select.select([fd], [], [], 0)[0]:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            output.extend(data)
        assert status is not None, f"start timed out: {output!r}"
    finally:
        if status is None:
            os.killpg(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        os.close(fd)
    calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    return status, output.decode(errors="replace"), calls


with tempfile.TemporaryDirectory(prefix="tmux-rc-start-pty-") as directory:
    root = Path(directory)
    fixture = f"#!{sys.executable}\n" + r'''
import json
import os
from pathlib import Path
import sys
import time
name = Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["FIXTURE_LOG"], "a") as log:
    log.write(json.dumps([name, args]) + "\n")
mode = os.environ["FIXTURE_MODE"]
if name == "ssh":
    if "-O" in args:
        raise SystemExit(0)
    if "-T" in args:
        if mode == "cancel":
            time.sleep(30)
        if mode == "ssh-failure":
            print("fixture authentication failure", file=sys.stderr)
            raise SystemExit(255)
        print("Login banner\nTMUX_REMOTE_CONTROL_SESSION=$42")
    elif "-t" in args:
        print("fixture remote attached")
    else:
        raise SystemExit("unexpected SSH invocation")
elif name == "osascript":
    if mode == "window-failure":
        print("fixture Automation failure", file=sys.stderr)
        raise SystemExit(1)
    print("fixture-window-id")
else:
    raise SystemExit("unexpected desktop automation")
'''
    for name in ("ssh", "osascript", "aerospace"):
        file = root / name
        file.write_text(fixture)
        file.chmod(0o700)

    status, output, calls = run(root)
    assert status == 0, output
    assert [call[0] for call in calls] == ["ssh", "osascript", "ssh", "ssh"], calls
    assert calls[0][1][-2] == "dev'box"
    assert "new-session" in calls[0][1][-1]
    assert "argument with spaces" in calls[0][1][-1]
    assert "'$42'" in calls[1][1][3], calls[1]
    assert calls[2][1][-1] == "tmux attach-session -t '$42'"
    socket_arg = next(arg for arg in calls[0][1] if arg.startswith("ControlPath="))
    assert socket_arg in calls[2][1] and socket_arg in calls[3][1]
    assert not Path(socket_arg.removeprefix("ControlPath=")).parent.exists()

    status, output, calls = run(root, "window-failure")
    assert status == 1, output
    assert "Automation" in output and "left running" in output and "'$42'" in output, output
    assert [call[0] for call in calls] == ["ssh", "osascript", "ssh"], calls
    assert "-O" in calls[-1][1]

    status, output, calls = run(root, "ssh-failure")
    assert status == 1 and "could not create or find" in output, output
    assert [call[0] for call in calls] == ["ssh", "ssh"], calls
    assert "-O" in calls[-1][1]

    status, output, calls = run(root, "unsupported", {"SSH_CONNECTION": "remote context"})
    assert status == 1 and "local macOS Ghostty terminal" in output, output
    assert not calls, calls

    status, output, calls = run(root, "cancel", interrupt=True)
    assert status == 143, (status, output)
    assert [call[0] for call in calls] == ["ssh", "ssh"], calls
    assert "-O" in calls[-1][1]

print("start PTY tests passed")
