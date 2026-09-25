import { decodeKittyPrintable, parseKey } from "@earendil-works/pi-tui";

const shiftedSymbols = {
  "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
  "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|", ";": ":", "'": '"', ",": "<", ".": ">", "/": "?", "`": "~",
};

const specialKeys = {
  backspace: "BSpace",
  delete: "DC",
  insert: "IC",
  enter: "Enter",
  escape: "Escape",
  tab: "Tab",
  BTab: "BTab",
  space: "Space",
  home: "Home",
  end: "End",
  pageUp: "PageUp",
  pageDown: "PageDown",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
};

/** Convert one normalized terminal keypress into a tmux send-keys key name. */
export function remoteKey(data) {
  let name = parseKey(data);
  if (!name) return undefined; // A paste or unknown sequence is not one key.
  const modifiers = [];
  for (const modifier of ["shift", "ctrl", "alt", "super"]) {
    if (name.startsWith(`${modifier}+`)) {
      modifiers.push(modifier);
      name = name.slice(modifier.length + 1);
    }
  }
  if (modifiers.includes("super")) return undefined; // tmux has no Super key.

  if (modifiers.includes("shift") && /^[a-z]$/.test(name)) {
    name = name.toUpperCase();
    modifiers.splice(modifiers.indexOf("shift"), 1);
  } else if (modifiers.includes("shift") && name === "tab") {
    name = "BTab";
    modifiers.splice(modifiers.indexOf("shift"), 1);
  } else if (modifiers.includes("shift") && shiftedSymbols[name]) {
    // Kitty can report the actual shifted character; legacy/CSI-u without
    // that field uses the usual symbol mapping rather than an invalid S-;.
    const printable = decodeKittyPrintable(data);
    name = printable && printable !== name ? printable : shiftedSymbols[name];
    modifiers.splice(modifiers.indexOf("shift"), 1);
  }

  const key = specialKeys[name] ?? (/^[\x21-\x7e]$/.test(name) ? name : /^f(?:[1-9]|1[0-2])$/.test(name) ? name.toUpperCase() : undefined);
  if (!key) return undefined;
  const prefix = modifiers.map((modifier) => ({ shift: "S", ctrl: "C", alt: "M" })[modifier]);
  return [...prefix, key].join("-");
}
