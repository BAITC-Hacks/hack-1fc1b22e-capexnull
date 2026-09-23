import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server.js';
import { explainAdaptation } from '../src/ai/backend.js';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
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

test('Real Edge adaptation E2E: same-plan invariant, edit catalog, validation, comparison and AI', { timeout: 60000 }, async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'adaptation-ui-mock';
  const ai = { summary: 'Две альтернативные стратегии сравниваются при одинаковом событии.', strengths: ['Сохранён общий лимит бюджета.'], risks: ['Уязвимости районов различаются.'], tradeoffs: ['Приоритеты расходов меняются.'], recommendations: ['Сопоставьте результаты двух планов.'] };
  let aiCalls = 0;
  let captured;
  let failAI = false;
  const server = createApplication({
    explainResult: async () => ai, explainEventResult: async () => ai,
    explainAdaptationResult: async comparison => {
      captured = comparison;
      aiCalls++;
      return explainAdaptation(comparison, { fetchImpl: async () => {
        if (failAI) throw new Error('Unavailable');
        return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(ai) }] }] }) };
      } });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = await mkdtemp(join(tmpdir(), 'hackalem-adaptation-'));
  const browser = spawn(process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'
  ], { windowsHide: true, stdio: 'ignore' });
  let launchError;
  browser.on('error', error => { launchError = error; });
  let cdp;
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      if (launchError) throw launchError;
      try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await wait(100); }
    }
    assert.ok(port);
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    cdp = new CDP(socket);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: origin });
    await cdp.until(`document.querySelectorAll('.measure-card').length === 14`);
    const select = async items => {
      await cdp.eval(`document.querySelectorAll('.measure-card input:checked').forEach(input => input.click())`);
      for (const [id, district] of items) {
        await cdp.eval(`document.querySelector('#choose-${id}').click()`);
        if (district) await cdp.eval(`(() => { const s = document.querySelector('#district-${id}'); s.value = ${JSON.stringify(district)}; s.dispatchEvent(new Event('change')); })()`);
      }
    };
    const original = [['M7','Нура'],['M8','Нура'],['M10','Нура'],['M12'],['M5','Сарыарка']];
    await select(original);
    await cdp.until(`document.querySelector('#used').textContent === '95'`);
    await cdp.eval(`document.querySelector('#analyze').click()`);
    await cdp.until(`document.body.dataset.state === 'SUCCESS'`);
    await cdp.eval(`(() => { const e = document.querySelector('#event-type'); e.value = 'heating-network-failure'; e.dispatchEvent(new Event('change')); const d = document.querySelector('#event-district'); d.value = 'Нура'; d.dispatchEvent(new Event('change')); document.querySelector('#event-trigger').click(); })()`);
    await cdp.until(`document.querySelector('#review-strategy') !== null`);
    const savedBase = await cdp.eval(`document.querySelector('#result-score').textContent`);
    const savedEvent = await cdp.eval(`document.querySelector('#event-score-after').textContent`);
    await cdp.eval(`document.querySelector('#review-strategy').click()`);
    assert.equal(await cdp.eval(`document.querySelector('#builder-title').textContent`), 'Адаптация после события');
    assert.equal(await cdp.eval(`document.querySelector('#analyze').textContent`), 'Рассчитать адаптированную стратегию');
    assert.equal(await cdp.eval(`document.querySelectorAll('.measure-card').length`), 14);
    await cdp.eval(`document.querySelector('#analyze').click()`);
    await cdp.until(`document.querySelector('#adaptation-analysis .ai-summary') !== null && document.body.dataset.state === 'SUCCESS'`);
    assert.equal(await cdp.eval(`document.querySelector('#adaptation-original-Score').textContent`), '55.72');
    assert.equal(await cdp.eval(`document.querySelector('#adaptation-adapted-Score').textContent`), '55.72');
    assert.equal(captured.deltaAdaptationScore, 0);
    assert.match(await cdp.eval(`document.querySelector('#adaptation-delta').textContent`), /0.00/);
    await select([['M3','Нура'],['M5','Сарыарка'],['M7','Нура'],['M8','Нура'],['M13','Есиль']]);
    await cdp.until(`document.querySelector('#used').textContent === '127'`);
    const beforeCalls = aiCalls;
    await cdp.eval(`document.querySelector('#analyze').click()`);
    await cdp.until(`document.body.dataset.state === 'VALIDATION_ERROR'`);
    assert.match(await cdp.eval(`document.querySelector('#status').textContent`), /Стоимость 127 превышает бюджет 100/);
    assert.equal(aiCalls, beforeCalls);
    await select([['M1','Есиль'],['M4','Алматы'],['M9','Нура'],['M10','Сарыарка'],['M14']]);
    await cdp.until(`document.querySelector('#used').textContent === '71'`);
    assert.equal(await cdp.eval(`document.querySelector('#remaining').textContent`), '29');
    await cdp.eval(`document.querySelector('#analyze').click()`);
    await cdp.until(`document.body.dataset.state === 'SUCCESS' && !document.querySelector('#adaptation-result').hidden`);
    assert.equal(await cdp.eval(`document.querySelector('#adaptation-adapted-Score').textContent`), captured.adapted.Score.toFixed(2));
    assert.equal(await cdp.eval(`document.querySelector('#adaptation-original-totalCost').textContent`), '95');
    assert.equal(await cdp.eval(`document.querySelector('#adaptation-adapted-totalCost').textContent`), '71');
    assert.equal(await cdp.eval(`document.querySelector('#adaptation-analysis .ai-summary').textContent`), ai.summary);
    assert.equal(await cdp.eval(`document.querySelector('#result-score').textContent`), savedBase);
    assert.equal(await cdp.eval(`document.querySelector('#event-score-after').textContent`), savedEvent);
    assert.match(await cdp.eval(`document.querySelector('#adaptation-result').innerText`), /Первоначальная стратегия после события/);
    assert.match(await cdp.eval(`document.querySelector('#adaptation-result').innerText`), /Адаптированная стратегия при том же событии/);
    for (const width of [1536, 375]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 864, deviceScaleFactor: 1, mobile: false });
      assert.equal(await cdp.eval(`document.documentElement.scrollWidth > innerWidth`), false);
    }
    failAI = true;
    await cdp.eval(`document.querySelector('#analyze').click()`);
    await cdp.until(`document.body.dataset.state === 'AI_ERROR'`);
    assert.match(await cdp.eval(`document.querySelector('#adaptation-analysis .ai-unavailable').textContent`), /Результат сравнения сохранён/);
    assert.equal(await cdp.eval(`document.querySelector('#adaptation-adapted-Score').textContent`), captured.adapted.Score.toFixed(2));
    await cdp.eval(`document.querySelector('#adaptation-notice button').click()`);
    assert.equal(await cdp.eval(`document.querySelector('#builder-title').textContent`), 'Выберите пять мероприятий');
    assert.equal(await cdp.eval(`document.querySelector('#adaptation-result')`), null);
    assert.deepEqual(await cdp.eval(`[...document.querySelectorAll('.measure-card input:checked')].map(e => e.id)`), ['choose-M5','choose-M7','choose-M8','choose-M10','choose-M12']);
    assert.deepEqual(cdp.errors, []);
  } finally {
    if (cdp) { cdp.socket.send(JSON.stringify({ id: ++cdp.next, method: 'Browser.close' })); cdp.socket.close(); }
    browser.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

