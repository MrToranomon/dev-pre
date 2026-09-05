import assert from "node:assert/strict";

const debugPort = Number(process.argv[2]);
const pageUrlFragment = process.argv[3];
if (!debugPort || !pageUrlFragment) throw new Error("Usage: node scripts/ui-smoke.mjs <debug-port> <page-url-fragment>");

async function retry(action, attempts = 40) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try { return await action(); } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError;
}

const pages = await retry(async () => {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  if (!response.ok) throw new Error("DevTools is not ready.");
  return response.json();
});
const page = pages.find((item) => item.type === "page" && item.url.includes(pageUrlFragment));
if (!page) throw new Error(`Manager page not found. Open pages: ${pages.map((item) => item.url).join(", ")}`);

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let nextId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
});

function command(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

await command("Runtime.enable");
await retry(async () => {
  if (!(await evaluate("Boolean(document.querySelector('.category-item') && document.querySelector('#addExtensionButton:not(:disabled)'))"))) throw new Error("UI is not ready.");
});
await evaluate("window.__orbitSmokeErrors=[]; window.addEventListener('error', event => window.__orbitSmokeErrors.push(event.message));");

const extensionOpened = await evaluate("document.querySelector('#addExtensionButton').click(); document.querySelector('#textDialog').open");
const cancelClosed = await evaluate("document.querySelector('#dialogCancel').click(); !document.querySelector('#textDialog').open");
const patternOpened = await evaluate("document.querySelector('#addPatternButton').click(); document.querySelector('#textDialog').open");
const closeClosed = await evaluate("document.querySelector('#dialogClose').click(); !document.querySelector('#textDialog').open");
const escapeOpened = await evaluate("document.querySelector('#addExtensionButton').click(); document.querySelector('#textDialog').open");
const escapeClosed = await evaluate("document.querySelector('#textDialog').dispatchEvent(new Event('cancel',{cancelable:true})); !document.querySelector('#textDialog').open");
const destinationControl = await evaluate("Boolean(document.querySelector('#destinationButton:not(:disabled)'))");
const conflictMetricReady = await evaluate("document.querySelector('#conflictCount').textContent.endsWith('件')");
const conflictDialogOpened = await evaluate(`
  openConflictDialog([{reason:'「Office-Tool」のようなフォルダ名が両方に一致します',rules:[
    {category:'仕事',pattern:'Office-*',priority:1,preferred:true},
    {category:'ツール',pattern:'*Tool*',priority:2,preferred:false}
  ]}]);
  document.querySelector('#conflictDialog').open
    && document.querySelectorAll('#newConflictList .priority-rule').length === 2
    && document.querySelectorAll('#newConflictList [data-priority-rule]').length === 2
`);
const conflictDialogClosed = await evaluate("document.querySelector('#conflictDialogClose').click(); !document.querySelector('#conflictDialog').open");
const errors = await evaluate("window.__orbitSmokeErrors");

assert.equal(extensionOpened, true);
assert.equal(cancelClosed, true);
assert.equal(patternOpened, true);
assert.equal(closeClosed, true);
assert.equal(escapeOpened, true);
assert.equal(escapeClosed, true);
assert.equal(destinationControl, true);
assert.equal(conflictMetricReady, true);
assert.equal(conflictDialogOpened, true);
assert.equal(conflictDialogClosed, true);
assert.deepEqual(errors, []);
console.log(JSON.stringify({ extensionOpened, cancelClosed, patternOpened, closeClosed, escapeClosed, destinationControl, conflictMetricReady, conflictDialogOpened, conflictDialogClosed, errors }, null, 2));
socket.close();
