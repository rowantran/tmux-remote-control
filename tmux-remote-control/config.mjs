import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function configPath(env = process.env) {
  const configHome = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(configHome, "tmux-remote-control", "config.json");
}

export function loadConfig(env = process.env) {
  const path = configPath(env);
  try {
    const config = JSON.parse(readFileSync(path, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(`${path} must contain a JSON object`);
    }
    return config;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    if (error instanceof SyntaxError) throw new Error(`could not parse ${path}: ${error.message}`, { cause: error });
    throw error;
  }
}

export function piAutoEnable(config) {
  return config?.pi?.autoEnable === true;
}
