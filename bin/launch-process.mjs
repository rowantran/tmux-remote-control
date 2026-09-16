import { spawn } from "node:child_process";

// Launch helpers never read terminal input themselves. SSH keeps access to
// /dev/tty for authentication, and the interactive attachment inherits the TTY.
export function runProcess(command, args, { interactive = false, quiet = false, signal, timeoutMs = 0, env } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("launch cancelled"));
    const child = spawn(command, args, { env, stdio: interactive ? "inherit" : ["ignore", "pipe", quiet ? "ignore" : "inherit"] });
    let output = "";
    let failure;
    let timer;
    const stop = (message) => {
      if (failure) return;
      failure = new Error(message);
      child.kill("SIGTERM");
      clearTimeout(timer);
      timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    };
    const abort = () => stop("launch cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    if (timeoutMs && !failure) timer = setTimeout(() => stop(`${command} timed out`), timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (data) => {
      if (failure) return;
      output += data;
      if (output.length > 64 * 1024) stop(`${command} returned too much output`);
    });
    child.on("error", (error) => { failure = error; });
    child.on("close", (code, childSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve({ code: code ?? (childSignal === "SIGINT" ? 130 : 1), stdout: output });
    });
  });
}
