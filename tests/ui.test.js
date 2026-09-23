import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server.js';
import { calculate } from '../src/engine/index.js';
import { previewBudget } from '../src/engine/preview.js';
import { explain, explainEvent, validatePresentation } from '../src/ai/backend.js';
import { validate } from '../src/validator/index.js';
import { EVENTS, INDICATOR_NAMES } from '../src/dynamic/catalog.js';
import { computeEvent } from '../src/dynamic/engine.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const decisions = [
  { measureId: 'M7', districtId: 'Нура' }, { measureId: 'M8', districtId: 'Нура' },
  { measureId: 'M10', districtId: 'Нура' }, { measureId: 'M12' }, { measureId: 'M5', districtId: 'Сарыарка' }
];
const scenario = { mode: 'MATAN-only', decisions };
const ai = {
  summary: 'Astana Quality of Life Score составляет 56.54. В Нуре улучшились школы и детсады, поликлиники и первичная медпомощь.', strengths: ['Критических показателей не осталось.'],
  risks: ['Районы сохраняют различия.'], tradeoffs: ['Большая часть бюджета использована.'],
  recommendations: ['Обратить внимание на сохраняющиеся слабые показатели.']
};
let apiMode = 'success';
let engineCalls = 0;
let aiCalls = 0;
let validatorCalls = 0;
let eventCalls = 0;
let eventMode = 'success';
const eventAI = {
  summary: 'Демонстрационная авария теплосети в Нуре снизила надёжность ЖКХ с 60 до 40.',
  strengths: ['Критических показателей не появилось.'],
  risks: ['Astana Quality of Life Score снизился с 56.54 до 55.72.'],
  tradeoffs: ['Выбранная стратегия сохраняет уязвимость коммунальной инфраструктуры.'],
  recommendations: ['Пересмотреть приоритеты распределения бюджета.']
};
let origin;
let server;
const originalKey = process.env.OPENAI_API_KEY;

before(async () => {
  process.env.OPENAI_API_KEY = 'stage4-mock-only';
  server = createApplication({
    async explainEventResult(event) {
      eventCalls++;
      return explainEvent(event, { fetchImpl: async () => {
        await wait(150);
        if (eventMode === 'failure') throw new Error('Mock event AI unavailable');
        return { ok: true, json: async () => ({ status: 'completed', output: [
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(event.eventId === 'heating-network-failure' ? eventAI : { ...eventAI, summary: event.eventName + '. Затронут район ' + event.district + '.', strengths: [], risks: ['Изменились показатели выбранного района.'] }) }] }
        ] }) };
      } });
    },
    validateInput(input) { validatorCalls++; return validate(input); },
    calculateInput(input) { engineCalls++; return calculate(input); },
    async explainResult(input, result) {
      aiCalls++;
      return explain(input, result, { fetchImpl: async () => {
        await wait(250);
        if (apiMode === 'failure') throw new Error('Mock API unavailable');
        return { ok: true, json: async () => ({ status: 'completed', output: [
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(apiMode === 'bad-presentation' ? { ...ai, summary: 'deltaScore 3.98539, S1 48' } : ai) }] }
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
    assert.equal(await cdp.eval(`document.querySelector('#dynamic-scenario') === null`), true);
    assert.equal(await cdp.eval(`document.querySelector('#baseline').textContent`), '52.56');
    assert.equal(await cdp.eval(`document.querySelector('#analyze').disabled`), true);
    assert.equal(await cdp.eval(`document.querySelectorAll('.city-card').length`), 5);
    assert.equal(await cdp.eval(`document.querySelector('#selection-title').textContent`), 'Выбранные мероприятия');
    assert.equal(await cdp.eval(`document.querySelector('#city-title').textContent`), 'Исходные показатели районов');
    assert.equal(await cdp.eval(`document.querySelectorAll('#methodology-open').length`), 1);
    assert.equal(await cdp.eval(`document.querySelector('#methodology-open').textContent`), 'Методология оценки');
    assert.equal(await cdp.eval(`document.querySelectorAll('dialog').length`), 1);
    assert.deepEqual(await cdp.eval(`[...document.querySelectorAll('.budget-lines>div>span')].map(e => e.textContent)`), ['Общий бюджет', 'Использовано', 'Осталось']);
    assert.equal(await cdp.eval(`/Budget used|Budget remaining|Selected|Пять районов. Разные потребности.|Исходная районная оценка · из 100/.test(document.body.innerText)`), false);
    assert.equal(await cdp.eval(`document.querySelectorAll('#selected-count').length`), 1);
    assert.equal(await cdp.eval(`document.querySelector('#selected-label')`), null);
    const definitions = [
      ['T1', 'Разгрузка дорог'], ['T2', 'Доступность общественного транспорта'],
      ['E1', 'Озеленение'], ['E2', 'Качество воздуха'], ['S1', 'Школы и детсады'],
      ['S2', 'Поликлиники и первичная медпомощь'], ['B1', 'Безопасность улиц'],
      ['B2', 'Безопасность дорожного движения'], ['C1', 'Надёжность ЖКХ'],
      ['C2', 'Скорость решения обращений жителей']
    ];
    for (const [width, height] of [[1536,864], [375,812]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await cdp.eval(`document.querySelector('#methodology-open').click()`);
      assert.equal(await cdp.eval(`document.querySelector('#methodology').open`), true);
      assert.equal(await cdp.eval(`document.querySelector('#methodology-title').textContent`), 'Методология оценки районов');
      assert.deepEqual(await cdp.eval(`[...document.querySelectorAll('.methodology-list>div')].map(e => [e.querySelector('dt').textContent,e.querySelector('dd').textContent])`), definitions);
      assert.match(await cdp.eval(`document.querySelector('#methodology').textContent`), /шкале 0–100/);
      assert.match(await cdp.eval(`document.querySelector('#methodology').textContent`), /Значение ниже 40 считается критическим/);
      assert.equal(await cdp.eval(`(() => { const d = document.querySelector('#methodology'); const r = d.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && d.scrollWidth <= d.clientWidth; })()`), true);
      await cdp.eval(`document.querySelector('#methodology-close').click()`);
      assert.equal(await cdp.eval(`document.querySelector('#methodology').open`), false);
      await cdp.until(`document.activeElement.id === 'methodology-open'`);
      assert.equal(await cdp.eval(`document.activeElement.id`), 'methodology-open');
    }
    await cdp.eval(`document.querySelector('#methodology-open').click()`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.until(`!document.querySelector('#methodology').open`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1536, height: 864, deviceScaleFactor: 1, mobile: false });
    assert.deepEqual(await cdp.eval(`[...document.querySelectorAll('.measure-card')].map(e => e.dataset.id)`), Array.from({ length: 14 }, (_, i) => 'M' + (i + 1)));
    await cdp.eval(`document.querySelector('[data-id="M14"]').scrollIntoView()`);
    assert.equal(await cdp.eval(`document.querySelector('[data-id="M14"]').getBoundingClientRect().top < innerHeight`), true);

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
    assert.equal(await cdp.eval(`document.querySelector('#selected-count').textContent`), 'Выбрано: 5/5');
    assert.equal(await cdp.eval(`document.querySelector('#district-M7').value`), 'Нура');
    assert.equal(await cdp.eval(`document.querySelector('#district-M7').closest('.district-field').hidden`), false);
    assert.equal(await cdp.eval(`document.querySelector('#district-M7').closest('.district-field').querySelector('span').textContent`), 'Район');
    assert.deepEqual(await cdp.eval(`[...document.querySelector('#district-M7').options].filter(o => o.value).map(o => o.value)`), ['Есиль', 'Алматы', 'Сарыарка', 'Байконур', 'Нура']);
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
    const renderedAnalysis = await cdp.eval(`({ summary: document.querySelector('.ai-summary').textContent, ...Object.fromEntries([...document.querySelectorAll('[data-section]')].map(e => [e.dataset.section, [...e.querySelectorAll('li')].map(li => li.textContent)])) })`);
    assert.doesNotThrow(() => validatePresentation(renderedAnalysis));
    const typography = await cdp.eval(`['.ai-summary', ...['strengths','risks','tradeoffs','recommendations'].map(s => '[data-section="' + s + '"] li')].map(selector => { const s = getComputedStyle(document.querySelector(selector)); return [parseFloat(s.fontSize), parseFloat(s.lineHeight)]; })`);
    for (let i = 0; i < typography.length; i++) {
      const expectedSize = 22;
      assert.equal(typography[i][0], expectedSize);
      assert.ok(Math.abs(typography[i][1] - expectedSize * 1.7) < 0.1);
    }
    assert.deepEqual(await cdp.eval(`[...document.querySelectorAll('[data-section]')].map(e => e.dataset.section)`), ['strengths', 'risks', 'tradeoffs', 'recommendations']);
    assert.equal(await cdp.eval(`document.querySelector('#dynamic-scenario').dataset.state`), 'initial');
    assert.equal(await cdp.eval(`document.querySelector('#event-trigger').disabled`), true);
    assert.deepEqual(await cdp.eval(`[...document.querySelector('#event-type').options].map(o => o.textContent)`), ['Перекрытие крупной магистрали', 'Сильное загрязнение воздуха', 'Рост нагрузки на социальную инфраструктуру', 'Ухудшение дорожной безопасности', 'Авария теплосети']);
    await cdp.eval(`(() => { const s = document.querySelector('#event-type'); s.value = 'heating-network-failure'; s.dispatchEvent(new Event('change')); })()`);
    assert.match(await cdp.eval(`document.querySelector('#dynamic-scenario').textContent`), /Демонстрационное событие/);
    assert.match(await cdp.eval(`document.querySelector('.event-effect').textContent`), /Надёжность ЖКХ −20/);
    assert.match(await cdp.eval(`document.querySelector('#dynamic-scenario').textContent`), /Эффекты заданы для демонстрации/);
    assert.equal(await cdp.eval(`document.querySelector('#dynamic-scenario h2').textContent`), 'Неожиданное городское событие');
    assert.equal(await cdp.eval(`/MATAN-only|Динамический сценарий|Детерминированный расчёт|Базовый Score|Синтетический параметр/.test(document.body.innerText)`), false);
    const baseCalls = engineCalls;
    assert.equal(eventCalls, 0);
    await cdp.eval(`(() => { const s = document.querySelector('#event-district'); s.value = 'Нура'; s.dispatchEvent(new Event('change')); })()`);
    assert.equal(eventCalls, 0);
    await cdp.eval(`document.querySelector('#event-trigger').click()`);
    await cdp.until(`document.querySelector('#dynamic-scenario').dataset.state === 'processing'`);
    assert.equal(await cdp.eval(`document.querySelector('#event-trigger').disabled`), true);
    await cdp.until(`document.querySelector('#dynamic-scenario').dataset.state === 'success'`);
    assert.equal(await cdp.eval(`document.querySelector('#event-score-before').textContent`), '56.54');
    assert.equal(await cdp.eval(`document.querySelector('#event-score-after').textContent`), '55.72');
    assert.equal(await cdp.eval(`document.querySelector('#event-c1-before').textContent`), '60.00');
    assert.equal(await cdp.eval(`document.querySelector('#event-c1-after').textContent`), '40.00');
    assert.equal(await cdp.eval(`document.querySelector('#event-critical-after').textContent`), '0');
    assert.match(await cdp.eval(`document.querySelector('#event-delta').textContent`), /-0.82/);
    assert.equal(await cdp.eval(`document.querySelector('#result-score').textContent`), '56.54');
    assert.equal(await cdp.eval(`document.querySelector('#event-analysis .ai-summary').textContent`), eventAI.summary);
    assert.equal(engineCalls, baseCalls);
    const firstEvent = await cdp.eval(`document.querySelector('#event-result').textContent`);
    await cdp.eval(`document.querySelector('#event-trigger').click()`);
    await cdp.until(`document.querySelector('#dynamic-scenario').dataset.state === 'success'`);
    assert.equal(await cdp.eval(`document.querySelector('#event-result').textContent`), firstEvent);
    assert.equal(engineCalls, baseCalls);
    for (const event of EVENTS) {
      await cdp.eval(`(() => { const s = document.querySelector('#event-type'); s.value = ${JSON.stringify(event.id)}; s.dispatchEvent(new Event('change')); })()`);
      assert.equal(await cdp.eval(`document.querySelector('.event-effect').textContent`), event.description);
      assert.equal(await cdp.eval(`document.querySelector('.event-title').textContent`), event.name);
      await cdp.eval(`document.querySelector('#event-trigger').click()`);
      await cdp.until(`document.querySelector('#dynamic-scenario').dataset.state === 'success'`);
      const expected = computeEvent(calculate(scenario), event.id, 'Нура');
      assert.equal(await cdp.eval(`document.querySelector('#event-score-after').textContent`), expected.Score_after.toFixed(2));
      for (const id of expected.affectedIndicators) {
        assert.equal(await cdp.eval(`document.querySelector('#event-${id.toLowerCase()}-before').textContent`), expected.indicatorsBefore[id].toFixed(2));
        assert.equal(await cdp.eval(`document.querySelector('#event-${id.toLowerCase()}-after').textContent`), expected.indicatorsAfter[id].toFixed(2));
        assert.ok((await cdp.eval(`document.querySelector('#event-result').innerText`)).includes(INDICATOR_NAMES[id]));
      }
      assert.equal(await cdp.eval(`document.querySelector('#result-score').textContent`), '56.54');
      assert.ok((await cdp.eval(`document.querySelector('#event-analysis .ai-summary').textContent`)).length > 0);
      const snapshot = await cdp.eval(`document.querySelector('#event-result').textContent`);
      await cdp.eval(`document.querySelector('#event-trigger').click()`);
      await cdp.until(`document.querySelector('#dynamic-scenario').dataset.state === 'success'`);
      assert.equal(await cdp.eval(`document.querySelector('#event-result').textContent`), snapshot);
      assert.equal(engineCalls, baseCalls);
    }
    eventMode = 'failure';
    await cdp.eval(`document.querySelector('#event-trigger').click()`);
    await cdp.until(`document.querySelector('#dynamic-scenario').dataset.state === 'ai-error'`);
    assert.equal(await cdp.eval(`document.querySelector('#event-score-after').textContent`), '55.72');
    assert.equal(await cdp.eval(`document.querySelector('#result-score').textContent`), '56.54');
    assert.match(await cdp.eval(`document.querySelector('#event-analysis .ai-unavailable').textContent`), /Результат события сохранён/);
    eventMode = 'success';
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
    apiMode = 'bad-presentation';
    await cdp.eval(`document.querySelector('#analyze').click()`);
    await cdp.until(`document.body.dataset.state === 'AI_ERROR' && !document.querySelector('#analyze').disabled`);
    assert.equal(await cdp.eval(`document.querySelector('#result-score').textContent`), '56.54');
    assert.equal(await cdp.eval(`document.querySelector('#result-cost').textContent`), '95');
    assert.equal(await cdp.eval(`document.querySelector('#result-remaining').textContent`), '5');
    assert.equal(await cdp.eval(`document.querySelector('#result').hidden`), false);
    assert.equal(await cdp.eval(`document.querySelector('.ai-panel').innerText.includes('deltaScore')`), false);
    assert.match(await cdp.eval(`document.querySelector('.ai-unavailable').textContent`), /Математический результат сохранён/);
    apiMode = 'success';

    await select([{ measureId: 'M1', districtId: 'Есиль' }, { measureId: 'M3', districtId: 'Нура' }, { measureId: 'M9', districtId: 'Нура' }, { measureId: 'M10', districtId: 'Нура' }, { measureId: 'M12' }]);
    const counts = [engineCalls, aiCalls];
    await cdp.eval(`document.querySelector('#analyze').click()`);
    await cdp.until(`document.body.dataset.state === 'VALIDATION_ERROR'`);
    assert.match(await cdp.eval(`document.querySelector('#status').textContent`), /M1 и M3 несовместимы/);
    assert.deepEqual([engineCalls, aiCalls], counts);
    await select(decisions.map(item => item.measureId === 'M7' ? { measureId: 'M7' } : item));
    // Structural incompleteness blocks sending, without duplicating business rules.
    await cdp.eval(`(() => { const select = document.querySelector('#district-M7'); select.value = ''; select.dispatchEvent(new Event('change')); })()`);
    assert.equal(await cdp.eval(`document.querySelector('#analyze').disabled`), true);
    assert.equal(await cdp.eval(`document.body.dataset.state`), 'INITIAL');
    const incompleteCounts = [validatorCalls, engineCalls, aiCalls];
    await cdp.eval(`document.querySelector('#analyze').click()`);
    assert.deepEqual([validatorCalls, engineCalls, aiCalls], incompleteCounts);
    await cdp.eval(`(() => { const select = document.querySelector('#district-M7'); select.value = 'Нура'; select.dispatchEvent(new Event('change')); })()`);
    assert.equal(await cdp.eval(`document.querySelector('#analyze').disabled`), false);
    assert.equal(await cdp.eval(`document.body.dataset.state`), 'READY');

    // Complete but over-budget selection must reach backend Validator unchanged.
    await select([
      { measureId: 'M3', districtId: 'Нура' }, { measureId: 'M5', districtId: 'Сарыарка' },
      { measureId: 'M7', districtId: 'Нура' }, { measureId: 'M8', districtId: 'Нура' },
      { measureId: 'M13', districtId: 'Есиль' }
    ]);
    await cdp.until(`document.querySelector('#used').textContent === '127'`);
    assert.equal(await cdp.eval(`document.querySelector('#remaining').textContent`), '-27');
    assert.equal(await cdp.eval(`document.querySelector('#analyze').disabled`), false);
    const budgetCounts = [validatorCalls, engineCalls, aiCalls];
    await cdp.eval(`document.querySelector('#analyze').click()`);
    await cdp.until(`document.body.dataset.state === 'VALIDATION_ERROR'`);
    assert.match(await cdp.eval(`document.querySelector('#status').textContent`), /Стоимость 127 превышает бюджет 100/);
    assert.equal(validatorCalls, budgetCounts[0] + 1);
    assert.deepEqual([engineCalls, aiCalls], budgetCounts.slice(1));
    assert.equal(await cdp.eval(`document.querySelector('#result').hidden`), true);
    assert.deepEqual(cdp.errors, []);
  } finally {
    if (cdp) { cdp.socket.send(JSON.stringify({ id: ++cdp.next, method: 'Browser.close' })); cdp.socket.close(); }
    browser.kill();
  }
});
