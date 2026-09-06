import fs from "node:fs/promises";
import path from "node:path";
import { atomicJson, exists } from "./safety.mjs";

export const DEFAULT_HOTKEY = "Win+Insert";

const keyNames = new Map(
  Object.entries({
    ins: "Insert",
    insert: "Insert",
    del: "Delete",
    delete: "Delete",
    home: "Home",
    end: "End",
    pgup: "PageUp",
    pageup: "PageUp",
    pgdn: "PageDown",
    pagedown: "PageDown",
    space: "Space",
    enter: "Enter",
    return: "Enter",
    esc: "Escape",
    escape: "Escape",
    tab: "Tab",
    backspace: "Backspace",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
    pause: "Pause",
    scrolllock: "ScrollLock",
    printscreen: "PrintScreen",
  }),
);

export function normalizeHotkey(value) {
  if (typeof value !== "string")
    throw new Error("起動ショートカットを入力してください。");
  const parts = value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const modifiers = new Set();
  let key = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (["win", "windows", "meta"].includes(lower)) modifiers.add("Win");
    else if (["ctrl", "control"].includes(lower)) modifiers.add("Ctrl");
    else if (["alt", "option"].includes(lower)) modifiers.add("Alt");
    else if (lower === "shift") modifiers.add("Shift");
    else {
      if (key) throw new Error("起動ショートカットのキーは1つにしてください。");
      if (/^[a-z0-9]$/i.test(part)) key = part.toUpperCase();
      else if (/^f(?:[1-9]|1\d|2[0-4])$/i.test(part))
        key = part.toUpperCase();
      else key = keyNames.get(lower) ?? null;
      if (!key)
        throw new Error(
          "利用できないキーです。英数字、F1〜F24、Insert、Deleteなどを指定してください。",
        );
    }
  }
  if (!key) throw new Error("起動ショートカットのキーがありません。");
  if (!["Win", "Ctrl", "Alt"].some((item) => modifiers.has(item)))
    throw new Error("Win、Ctrl、Altのいずれかを含めてください。");
  const ordered = ["Win", "Ctrl", "Alt", "Shift"].filter((item) =>
    modifiers.has(item),
  );
  return [...ordered, key].join("+");
}

function files(directory) {
  return {
    config: path.join(directory, "hotkey.json"),
    status: path.join(directory, "hotkey-status.json"),
  };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

export async function ensureHotkeyConfiguration(directory, launchScript) {
  await fs.mkdir(directory, { recursive: true });
  const locations = files(directory);
  let current = null;
  if (await exists(locations.config)) {
    try {
      current = await readJson(locations.config);
    } catch (error) {
      throw new Error(`ホットキー設定を読み取れません: ${error.message}`);
    }
  }
  const next = {
    version: 1,
    enabled: current?.enabled !== false,
    shortcut: normalizeHotkey(current?.shortcut ?? DEFAULT_HOTKEY),
    launchScript: path.resolve(launchScript),
    updatedAt: current?.updatedAt ?? new Date().toISOString(),
  };
  if (!current || JSON.stringify(current) !== JSON.stringify(next))
    await atomicJson(locations.config, next);
  return next;
}

export async function updateHotkeyConfiguration(
  directory,
  launchScript,
  input,
) {
  const current = await ensureHotkeyConfiguration(directory, launchScript);
  const next = {
    ...current,
    enabled:
      input.enabled === undefined ? current.enabled : Boolean(input.enabled),
    shortcut:
      input.shortcut === undefined
        ? current.shortcut
        : normalizeHotkey(input.shortcut),
    updatedAt: new Date().toISOString(),
  };
  await atomicJson(files(directory).config, next);
  return next;
}

export async function hotkeyStatus(directory, launchScript) {
  const config = await ensureHotkeyConfiguration(directory, launchScript);
  let agent = null;
  try {
    agent = await readJson(files(directory).status);
  } catch {}
  const heartbeat = Date.parse(agent?.updatedAt ?? "");
  const running =
    Boolean(agent?.active) &&
    Number.isFinite(heartbeat) &&
    Date.now() - heartbeat < 15_000;
  return {
    enabled: config.enabled,
    shortcut: config.shortcut,
    running,
    registered: running && agent?.shortcut === config.shortcut,
    error: agent?.error ?? null,
    lastTriggeredAt: agent?.lastTriggeredAt ?? null,
    updatedAt: config.updatedAt,
  };
}
