import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../src/engine/index.js';
import { DISTRICTS, WEIGHTS } from '../src/engine/data.js';
import { EVENT_TYPE, EVENT_C1_DELTA, computeEvent, calculateStateMetrics, createDynamicBranch, EventValidationError } from '../src/dynamic/engine.js';
import { explainEvent, AgenticAIError } from '../src/ai/backend.js';
import { createApplication } from '../server.js';
import { EVENTS } from '../src/dynamic/catalog.js';

const scenario = { mode: 'MATAN-only', decisions: [
  { measureId: 'M7', districtId: 'Нура' }, { measureId: 'M8', districtId: 'Нура' },
  { measureId: 'M10', districtId: 'Нура' }, { measureId: 'M12' }, { measureId: 'M5', districtId: 'Сарыарка' }
] };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-9, `${actual} != ${expected}`);
const explanation = {
  summary: 'В Нуре произошла демонстрационная авария теплосети. Надёжность ЖКХ снизилась с 60 до 40.',
  strengths: ['Количество критических показателей осталось равным 0.'],
  risks: ['Astana Quality of Life Score снизился с 56.54 до 55.72.'],
  tradeoffs: ['Событие показывает уязвимость выбранной стратегии.'],
  recommendations: ['Пересмотреть приоритеты распределения бюджета с учётом надёжности ЖКХ.']
};
const mockResponse = value => ({ ok: true, json: async () => ({ status: 'completed', output: [
  { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }
] }) });

test('All five events in all five districts: exact effects, canonical order, immutable STATE_1 and replay', () => {
  const expected = [{ T1: -20 }, { E2: -20 }, { S1: -10, S2: -10 }, { B2: -20 }, { C1: -20 }];
  assert.deepEqual(EVENTS.map(event => event.name), ['Перекрытие крупной магистрали', 'Эпизод сильного загрязнения воздуха', 'Резкий рост нагрузки на социальную инфраструктуру', 'Ухудшение дорожной безопасности', 'Авария теплосети в зимний период']);
  // Deliberately reversed storage order proves result canonicalization is independent.
  assert.deepEqual(Object.keys(EVENTS[2].effects), ['S2', 'S1']);
  const state1 = calculate(scenario);
  const snapshot = structuredClone(state1);
  const branch = createDynamicBranch(state1);
  for (const [index, event] of EVENTS.entries()) for (const district of Object.keys(DISTRICTS)) {
    const result = branch.apply(event.id, district);
    assert.equal(result.eventId, event.id);
    assert.equal(result.eventName, event.name);
    const affected = Object.keys(expected[index]);
    assert.deepEqual(result.affectedIndicators, affected);
    assert.deepEqual(Object.keys(result.indicatorsBefore), affected);
    assert.deepEqual(Object.keys(result.indicatorsAfter), affected);
    for (const area of Object.keys(DISTRICTS)) for (const id of Object.keys(WEIGHTS)) {
      const before = state1.finalIndicators[area][id];
      const after = area === district && Object.hasOwn(expected[index], id) ? Math.max(0, before + expected[index][id]) : before;
      assert.equal(result.finalIndicators[area][id], after);
      if (area === district && affected.includes(id)) {
        assert.equal(result.indicatorsBefore[id], before);
        assert.equal(result.indicatorsAfter[id], after);
      }
    }
    const metrics = calculateStateMetrics(result.finalIndicators);
    assert.equal(result.Score_after, metrics.Score);
    assert.equal(result.D_avg_after, metrics.D_avg);
    assert.equal(result.N_crit_after, metrics.N_crit);
    assert.deepEqual(result.districtScores_after, metrics.districtScores);
    assert.equal(result.deltaScore_event, result.Score_after - result.Score_before);
    assert.deepEqual(branch.apply(event.id, district), result);
    assert.deepEqual(state1, snapshot);
    assert.deepEqual(branch.state1, snapshot);
    const clipped = structuredClone(state1);
    for (const id of affected) clipped.finalIndicators[district][id] = 5;
    const low = computeEvent(clipped, event.id, district);
    for (const id of affected) assert.equal(low.indicatorsAfter[id], 0);
  }
});

test('STATE_1 → STATE_2 changes only selected C1 and never mutates baseline result', () => {
  const state1 = calculate(scenario);
  const snapshot = structuredClone(state1);
  assert.equal(EVENT_C1_DELTA, -20);
  for (const district of Object.keys(DISTRICTS)) {
    const result = computeEvent(state1, EVENT_TYPE, district);
    assert.equal(result.indicatorsBefore.C1, state1.finalIndicators[district].C1);
    assert.equal(result.indicatorsAfter.C1, Math.max(0, result.indicatorsBefore.C1 - 20));
    for (const id of Object.keys(DISTRICTS)) for (const indicator of Object.keys(WEIGHTS)) {
      assert.equal(result.finalIndicators[id][indicator], id === district && indicator === 'C1'
        ? result.indicatorsAfter.C1 : state1.finalIndicators[id][indicator]);
    }
    assert.notEqual(result.finalIndicators, state1.finalIndicators);
    assert.deepEqual(state1, snapshot);
    assert.equal(result.deltaScore_event, result.Score_after - result.Score_before);
  }
});

test('Event aggregates use ready indicators and unchanged official formula', () => {
  const state1 = calculate(scenario);
  const before = calculateStateMetrics(state1.finalIndicators);
  near(before.Score, 56.54307);
  assert.deepEqual(before.districtScores, state1.districtScores);
  assert.equal(before.D_avg, state1.D_avg);
  const result = computeEvent(state1, EVENT_TYPE, 'Нура');
  near(result.Score_after, 55.71907);
  near(result.deltaScore_event, -0.824);
  assert.equal(result.indicatorsAfter.C1, 40);
  assert.equal(result.N_crit_after, 0);
  // Social effects from the base scenario must not be applied for a second time.
  assert.equal(result.finalIndicators['Нура'].S1, 48);
  assert.equal(result.finalIndicators['Нура'].S2, 43.75);
  const other = computeEvent(state1, EVENT_TYPE, 'Сарыарка');
  assert.equal(other.N_crit_after, 1);
  near(other.Score_after, 55.26307);
});

test('Clip and strict critical threshold operate on event indicators', () => {
  const state = calculate(scenario);
  for (const [before, after] of [[10, 0], [20, 0], [60, 40], [100, 80]]) {
    state.finalIndicators['Нура'].C1 = before;
    assert.equal(computeEvent(state, EVENT_TYPE, 'Нура').indicatorsAfter.C1, after);
  }
  const indicators = Object.fromEntries(Object.keys(DISTRICTS).map(district => [district,
    Object.fromEntries(Object.keys(WEIGHTS).map(id => [id, 40]))
  ]));
  assert.equal(calculateStateMetrics(indicators).N_crit, 0);
  indicators['Есиль'].C1 = 39.999;
  assert.equal(calculateStateMetrics(indicators).N_crit, 1);
});

test('Deterministic replay applies the event exactly once per independent STATE_2', () => {
  const base = calculate(scenario);
  const branch = createDynamicBranch(base);
  assert.equal(branch.current, null);
  const first = branch.apply(EVENT_TYPE, 'Нура');
  for (let i = 0; i < 3; i++) assert.deepEqual(branch.apply(EVENT_TYPE, 'Нура'), first);
  assert.equal(branch.current.indicatorsAfter.C1, 40);
  assert.equal(branch.state1.finalIndicators['Нура'].C1, 60);
  assert.throws(() => { branch.state1.finalIndicators['Нура'].C1 = 0; }, TypeError);
  assert.throws(() => { branch.current.finalIndicators['Нура'].C1 = 0; }, TypeError);
  assert.deepEqual(base, calculate(scenario));
});

test('VALIDATE rejects unsupported events, districts and invalid states before APPLY', () => {
  const branch = createDynamicBranch(calculate(scenario));
  for (const [type, district] of [['unsupported', 'Нура'], [EVENT_TYPE, 'unknown'], [EVENT_TYPE, ['Нура']]]) {
    assert.throws(() => branch.apply(type, district), EventValidationError);
    assert.equal(branch.current, null);
  }
  const current = branch.apply(EVENT_TYPE, 'Нура');
  assert.throws(() => branch.apply('unsupported', 'Нура'), EventValidationError);
  assert.equal(branch.current, current);
  for (const badValue of [-1, 101, NaN, Infinity, null]) {
    const bad = calculate(scenario);
    bad.finalIndicators['Нура'].C1 = badValue;
    assert.throws(() => computeEvent(bad, EVENT_TYPE, 'Нура'), EventValidationError);
  }
  const missing = calculate(scenario);
  delete missing.finalIndicators['Есиль'].T1;
  assert.throws(() => createDynamicBranch(missing), EventValidationError);
  delete missing.finalIndicators['Нура'];
  assert.throws(() => createDynamicBranch(missing), EventValidationError);
});

test('AI receives only computed event fields, with existing structured/presentation contract', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'event-test-only';
  try {
    const event = computeEvent(calculate(scenario), EVENT_TYPE, 'Нура');
    const snapshot = structuredClone(event);
    const result = await explainEvent({ ...event, scenario, unrelated: 'must-not-be-sent' }, { fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(options.body);
      assert.deepEqual(JSON.parse(body.input[0].content), event);
      assert.equal(body.text.format.strict, true);
      assert.match(body.instructions, /синтетический параметр/);
      assert.match(body.instructions, /Не пересчитывай/);
      assert.match(body.instructions, /максимум с 2 знаками/);
      assert.equal(options.body.includes('event-test-only'), false);
      return mockResponse(explanation);
    } });
    assert.deepEqual(result, explanation);
    assert.deepEqual(event, snapshot);
    for (const definition of EVENTS) {
      const calculated = computeEvent(calculate(scenario), definition.id, 'Нура');
      await explainEvent(calculated, { fetchImpl: async (_, options) => {
        assert.deepEqual(JSON.parse(JSON.parse(options.body).input[0].content), calculated);
        return mockResponse(explanation);
      } });
    }
    for (const token of ['Score_after', 'C1_before', 'deltaScore_event', 'N_crit_after', 'districtScores_after', 'EVENT_C1_DELTA', 'STATE_2', 'eventId', 'eventName', 'affectedIndicators', 'indicatorsBefore', 'indicatorsAfter']) {
      await assert.rejects(explainEvent(event, { fetchImpl: async () => mockResponse({ ...explanation, summary: token }) }), error => error instanceof AgenticAIError && error.code === 'AI_PRESENTATION_INVALID');
    }
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('Endpoint requires successful base calculation and replays without reapplying measures', async () => {
  let engineCalls = 0;
  let eventCalls = 0;
  let failAI = false;
  const app = createApplication({
    calculateInput(input) { engineCalls++; return calculate(input); },
    explainResult: async () => explanation,
    explainEventResult: async () => { eventCalls++; if (failAI) throw new Error('offline'); return explanation; }
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.address().port}`;
  const post = (path, body) => fetch(origin + path, { method: 'POST', body: JSON.stringify(body) });
  try {
    const eventRequest = { scenarioId: 'missing', eventType: EVENT_TYPE, district: 'Нура' };
    assert.equal((await post('/api/event', eventRequest)).status, 409);
    assert.equal(engineCalls, 0);
    assert.equal(eventCalls, 0);
    const baseResponse = await post('/api/scenario', scenario);
    eventRequest.scenarioId = baseResponse.headers.get('X-Scenario-Id');
    assert.ok(eventRequest.scenarioId);
    const base = await baseResponse.json();
    assert.deepEqual(base.calculation, calculate(scenario));
    const first = await (await post('/api/event', eventRequest)).json();
    near(first.event.Score_after, 55.71907);
    assert.deepEqual(first.aiAnalysis, explanation);
    assert.equal(first.aiError, null);
    assert.equal((await post('/api/event', { ...eventRequest, district: 'unknown' })).status, 422);
    assert.equal((await post('/api/event', { ...eventRequest, eventType: 'unsupported' })).status, 422);
    assert.equal(eventCalls, 1);
    const replay = await (await post('/api/event', eventRequest)).json();
    assert.deepEqual(replay, first);
    failAI = true;
    const failedAI = await (await post('/api/event', eventRequest)).json();
    assert.deepEqual(failedAI.event, first.event);
    assert.equal(failedAI.aiAnalysis, null);
    assert.match(failedAI.aiError, /Результат события сохранён/);
    assert.equal(engineCalls, 1);
    assert.deepEqual(base.calculation, calculate(scenario));
  } finally {
    app.closeAllConnections();
    await new Promise(resolve => app.close(resolve));
  }
});
