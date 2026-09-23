import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server.js';
import { calculate } from '../src/engine/index.js';
import { previewBudget } from '../src/engine/preview.js';
import { explain } from '../src/ai/backend.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const decisions = [
  { measureId: 'M7', districtId: 'Нура' }, { measureId: 'M8', districtId: 'Нура' },
  { measureId: 'M10', districtId: 'Нура' }, { measureId: 'M12' }, { measureId: 'M5', districtId: 'Сарыарка' }
];
const scenario = { mode: 'MATAN-only', decisions };
const ai = {
  summary: 'В Нуре улучшились социальные показатели.', strengths: ['Критических показателей не осталось.'],
  risks: ['Районы сохраняют различия.'], tradeoffs: ['Большая часть бюджета использована.'],
  recommendations: ['Обратить внимание на сохраняющиеся слабые показатели.']
};
let apiMode = 'success';
let engineCalls = 0;
let aiCalls = 0;
let origin;
let server;
const originalKey = process.env.OPENAI_API_KEY;

before(async () => {
  process.env.OPENAI_API_KEY = 'stage4-mock-only';
  server = createApplication({
    calculateInput(input) { engineCalls++; return calculate(input); },
    async explainResult(input, result) {
      aiCalls++;
      return explain(input, result, { fetchImpl: async () => {
        await wait(250);
        if (apiMode === 'failure') throw new Error('Mock API unavailable');
        return { ok: true, json: async () => ({ status: 'completed', output: [
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(ai) }] }
        ] }) };
      } });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

test('Budget preview comes from engine for unfinished and completed selections', () => {
  assert.deepEqual(previewBudget([]), { totalCost: 0, remainingBudget: 100 });
  assert.deepEqual(previewBudget(['M7']), { totalCost: 24, remainingBudget: 76 });
  assert.deepEqual(previewBudget(decisions.map(item => item.measureId)), { totalCost: 95, remainingBudget: 5 });
  assert.throws(() => previewBudget(['unknown']), TypeError);
});

test('Endpoint returns Validator reason and does not call Engine or AI on invalid input', async () => {
  const counts = [engineCalls, aiCalls];
  const response = await fetch(origin + '/api/scenario', {
    method: 'POST', body: JSON.stringify({ mode: 'MATAN-only', decisions: decisions.slice(0, 4) })
  });
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error.code, 'DECISION_COUNT');
  assert.match(body.error.message, /ровно 5/);
  assert.deepEqual([engineCalls, aiCalls], counts);
  for (const path of ['/src/ai/backend.js', '/.env']) assert.equal((await fetch(origin + path)).status, 404);
});

test('Endpoint preserves unrounded engine result and exact response contract on AI success/failure', async () => {
  for (const mode of ['success', 'failure']) {
    apiMode = mode;
    const response = await fetch(origin + '/api/scenario', { method: 'POST', body: JSON.stringify(scenario) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ['calculation', 'aiAnalysis', 'aiError']);
    assert.deepEqual(body.calculation, calculate(scenario));
    if (mode === 'success') { assert.deepEqual(body.aiAnalysis, ai); assert.equal(body.aiError, null); }
    else { assert.equal(body.aiAnalysis, null); assert.match(body.aiError, /временно недоступен/); }
  }
  apiMode = 'success';
});

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.next = 0;
    this.pending = new Map();
    this.errors = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails.text);
      if (!message.id) return;
      const task = this.pending.get(message.id);
      if (!task) return;
      this.pending.delete(message.id);
      clearTimeout(task.timer);
      if (message.error) task.reject(new Error(message.error.message));
      else task.resolve(message.result);
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async until(expression) {
    for (let i = 0; i < 100; i++) { if (await this.eval(expression)) return; await wait(50); }
    throw new Error('UI condition timed out: ' + expression);
  }
}

test('Real Edge E2E: selection, six states, full flow, AI failure and responsive layout', { timeout: 60000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'hackalem-ui-'));
  const browser = spawn(process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'
  ], { windowsHide: true, stdio: 'ignore' });
  let launchError;
  browser.on('error', error => { launchError = error; });
  let cdp;
  try {
    let debugPort;
    for (let i = 0; i < 100; i++) {
      if (launchError) throw launchError;
      try { debugPort = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await wait(100); }
    }
    assert.ok(debugPort, 'Edge remote debugging started');
    const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    cdp = new CDP(socket);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1536, height: 864, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: origin });
    await cdp.until(`document.querySelectorAll('.measure-card').length === 14`);
    assert.equal(await cdp.eval('document.body.dataset.state'), 'INITIAL');
    assert.equal(await cdp.eval(`document.querySelector('#baseline').textContent`), '52.56');
    assert.equal(await cdp.eval(`document.querySelector('#analyze').disabled`), true);
    assert.equal(await cdp.eval(`document.querySelectorAll('.city-card').length`), 5);

    async function layout() {
      const result = await cdp.eval(`(() => {
        const main = document.querySelector('main');
        const cards = [...document.querySelectorAll('.measure-card')];
        const panel = document.querySelector('.selection-panel').getBoundingClientRect();
        const catalog = document.querySelector('#catalog').getBoundingClientRect();
        const overlap = panel.left < catalog.right && panel.right > catalog.left && panel.top < catalog.bottom && panel.bottom > catalog.top;
        const clipped = [...document.querySelectorAll('h1,h2,h3,.measure-label,#status,.primary,.score-main,.ai-summary')]
          .filter(e => e.getClientRects().length).some(e => e.scrollWidth > e.clientWidth + 1);
        return { overflow: document.documentElement.scrollWidth > innerWidth, overlap, clipped, cards: cards.length, mainWidth: main.getBoundingClientRect().width };
      })()`);
      assert.equal(result.overflow, false, JSON.stringify(result));
      assert.equal(result.overlap, false, JSON.stringify(result));
      assert.equal(result.clipped, false, JSON.stringify(result));
    }
    async function select(items) {
      await cdp.eval(`document.querySelectorAll('.measure-card input:checked').forEach(input => input.click())`);
      for (const item of items) {
        await cdp.eval(`document.querySelector('#choose-${item.measureId}').click()`);
        if (item.districtId) await cdp.eval(`(() => { const select = document.querySelector('#district-${item.measureId}'); select.value = ${JSON.stringify(item.districtId)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      }
    }
    await layout();
    await select(decisions);
    await cdp.until(`document.querySelector('#used').textContent === '95'`);
    assert.equal(await cdp.eval('document.body.dataset.state'), 'READY');
    assert.equal(await cdp.eval(`document.querySelector('#remaining').textContent`), '5');
    assert.equal(await cdp.eval(`document.querySelector('#selected-label').textContent`), '5 / 5');
    assert.equal(await cdp.eval(`document.querySelector('#district-M7').value`), 'Нура');
    assert.equal(await cdp.eval(`document.querySelector('#district-M12') === null`), true);
    assert.equal(await cdp.eval(`document.querySelector('#choose-M1').disabled`), true);
    await cdp.eval(`document.querySelector('#choose-M1').click()`);
    assert.equal(await cdp.eval(`document.querySelectorAll('.measure-card input:checked').length`), 5);
    await cdp.eval(`document.querySelector('#analyze').click()`);
    await cdp.until(`document.body.dataset.state === 'PROCESSING'`);
    assert.equal(await cdp.eval(`document.querySelector('#analyze').disabled`), true);
    await cdp.until(`document.body.dataset.state === 'SUCCESS'`);
    assert.equal(await cdp.eval(`document.querySelector('#result-score').textContent`), '56.54');
    assert.equal(await cdp.eval(`document.querySelector('#result-cost').textContent`), '95');
    assert.equal(await cdp.eval(`document.querySelector('#result-remaining').textContent`), '5');
    assert.equal(await cdp.eval(`document.querySelector('#result-critical').textContent`), '0');
    assert.equal(await cdp.eval(`document.querySelector('.ai-summary').textContent`), ai.summary);
    assert.deepEqual(await cdp.eval(`[...document.querySelectorAll('[data-section]')].map(e => e.dataset.section)`), ['strengths', 'risks', 'tradeoffs', 'recommendations']);
    for (const [width, height] of [[1920,1080], [1536,864], [1280,720], [375,812]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await layout();
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1536, height: 864, deviceScaleFactor: 1, mobile: false });
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(join(profile, 'check.png'), Buffer.from(screenshot.data, 'base64'));

    apiMode = 'failure';
    await cdp.eval(`document.querySelector('#analyze').click()`);
    await cdp.until(`document.body.dataset.state === 'AI_ERROR'`);
    assert.equal(await cdp.eval(`document.querySelector('#result-score').textContent`), '56.54');
    assert.equal(await cdp.eval(`document.querySelector('#result').hidden`), false);
    assert.match(await cdp.eval(`document.querySelector('.ai-unavailable').textContent`), /временно недоступен/);
    apiMode = 'success';

    await select([{ measureId: 'M1', districtId: 'Есиль' }, { measureId: 'M3', districtId: 'Нура' }, { measureId: 'M9', districtId: 'Нура' }, { measureId: 'M10', districtId: 'Нура' }, { measureId: 'M12' }]);
    const counts = [engineCalls, aiCalls];
    await cdp.eval(`document.querySelector('#analyze').click()`);
    await cdp.until(`document.body.dataset.state === 'VALIDATION_ERROR'`);
    assert.match(await cdp.eval(`document.querySelector('#status').textContent`), /M1 и M3 несовместимы/);
    assert.deepEqual([engineCalls, aiCalls], counts);
    await select(decisions.map(item => item.measureId === 'M7' ? { measureId: 'M7' } : item));
    // Existing selection remembers its district; explicitly clear to test required district validation.
    await cdp.eval(`(() => { const select = document.querySelector('#district-M7'); select.value = ''; select.dispatchEvent(new Event('change')); })()`);
    await cdp.eval(`document.querySelector('#analyze').click()`);
    await cdp.until(`document.body.dataset.state === 'VALIDATION_ERROR'`);
    assert.match(await cdp.eval(`document.querySelector('#status').textContent`), /допустимый район/);
    assert.deepEqual(cdp.errors, []);
  } finally {
    if (cdp) { cdp.socket.send(JSON.stringify({ id: ++cdp.next, method: 'Browser.close' })); cdp.socket.close(); }
    browser.kill();
  }
});
