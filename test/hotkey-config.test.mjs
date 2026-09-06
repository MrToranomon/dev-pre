import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureHotkeyConfiguration,
  hotkeyStatus,
  normalizeHotkey,
  updateHotkeyConfiguration,
} from "../src/hotkey-config.mjs";

test("normalizes configurable global shortcuts and rejects unsafe bare keys", () => {
  assert.equal(normalizeHotkey("win+ins"), "Win+Insert");
  assert.equal(normalizeHotkey("Ctrl + Alt + p"), "Ctrl+Alt+P");
  assert.equal(normalizeHotkey("shift+win+F12"), "Win+Shift+F12");
  assert.throws(() => normalizeHotkey("P"), /Win、Ctrl、Alt/);
  assert.throws(() => normalizeHotkey("Win+NoSuchKey"), /利用できない/);
});

test("stores OS-local hotkey configuration separately from workspace data", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "perfectwork-hotkey-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const launcher = path.join(directory, "launch-perfectwork.vbs");
  await fs.writeFile(launcher, "' test launcher");
  const initial = await ensureHotkeyConfiguration(directory, launcher);
  assert.equal(initial.shortcut, "Win+Insert");
  const updated = await updateHotkeyConfiguration(directory, launcher, {
    shortcut: "ctrl+alt+p",
    enabled: false,
  });
  assert.equal(updated.shortcut, "Ctrl+Alt+P");
  assert.equal(updated.enabled, false);
  const status = await hotkeyStatus(directory, launcher);
  assert.equal(status.running, false);
  assert.equal(status.shortcut, "Ctrl+Alt+P");
});
