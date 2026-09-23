import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, calculateBaseline } from '../src/engine/index.js';
import { DISTRICTS } from '../src/engine/data.js';
import { validate, ValidationError } from '../src/validator/index.js';
import { computeEvent } from '../src/dynamic/engine.js';
import { EVENTS } from '../src/dynamic/catalog.js';
import { captureStrategy, compareStrategy } from '../src/adaptation/index.js';
import { explainAdaptation } from '../src/ai/backend.js';
import { createApplication } from '../server.js';

const scenario = decisions => ({ mode: 'MATAN-only', decisions });
const measure = (measureId, districtId) => ({ measureId, ...(districtId ? { districtId } : {}) });
const original = scenario([measure('M7', 'Нура'), measure('M8', 'Нура'), measure('M10', 'Нура'), measure('M12'), measure('M5', 'Сарыарка')]);
const alternate = scenario([measure('M1', 'Есиль'), measure('M4', 'Алматы'), measure('M9', 'Нура'), measure('M10', 'Сарыарка'), measure('M14')]);
const analysis = { summary: 'Сравниваются альтернативные планы при одинаковом событии и одном лимите бюджета.', strengths: ['Можно сопоставить устойчивость планов.'], risks: ['Сохраняются уязвимости районов.'], tradeoffs: ['Приоритеты расходов различаются.'], recommendations: ['Сравните районные показатели перед выбором плана.'] };
const mock = async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(analysis) }] }] }) });
const snapshot = (event = EVENTS[4], district = 'Нура') => {
  const base = calculate(original);
  return captureStrategy(original, base, computeEvent(base, event.id, district));
};

test('Identical-plan invariant, independent replay and state isolation for every event and district', () => {
  const initial = calculateBaseline();
  const source = JSON.stringify(DISTRICTS);
  for (const event of EVENTS) for (const district of Object.keys(DISTRICTS)) {
    const saved = snapshot(event, district);
    const before = JSON.stringify(saved);
    const result = compareStrategy(saved, original);
    assert.deepEqual(result.event, saved.event);
    assert.equal(result.comparison.deltaAdaptationScore, 0);
    assert.deepEqual(result.comparison.original, result.comparison.adapted);
    assert.deepEqual(result, compareStrategy(saved, scenario([...original.decisions].reverse())));
    assert.equal(JSON.stringify(saved), before);
    assert.ok(Object.isFrozen(saved.calculation.finalIndicators['Нура']));
    assert.ok(Object.isFrozen(saved.event.finalIndicators['Нура']));
    assert.ok(Object.isFrozen(result.adaptationState.finalIndicators['Нура']));
    assert.throws(() => { result.adaptationState.finalIndicators['Нура'].C1 = 0; }, TypeError);
  }
  assert.equal(JSON.stringify(DISTRICTS), source);
  assert.deepEqual(calculateBaseline(), initial);
});

test('Alternative starts from source data, applies only its plan once then the same event once', () => {
  const saved = snapshot();
  let calls = 0;
  const result = compareStrategy(saved, alternate, { calculateInput(input) { calls++; return calculate(input); } });
  assert.equal(calls, 1);
  assert.deepEqual(result.adaptationState, calculate(alternate));
  assert.deepEqual(result.event, computeEvent(calculate(alternate), saved.event.eventId, saved.event.district));
  // Original M7/M8 effects cannot leak into this branch. Only M9 changes these values.
  assert.equal(result.adaptationState.finalIndicators['Нура'].S1, 38 + 3 * 7 / 8);
  assert.equal(result.adaptationState.finalIndicators['Нура'].S2, 35 + 3 * 7 / 8);
  assert.equal(result.event.finalIndicators['Нура'].C1, 60 + 5 * 7 / 8 - 20);
  assert.equal(result.comparison.deltaAdaptationScore, result.event.Score_after - saved.event.Score_after);
  assert.equal(result.comparison.original.totalCost, 95);
  assert.equal(result.comparison.adapted.totalCost, 71);
  assert.equal(result.comparison.adapted.remainingBudget, 29);
  assert.equal(result.comparison.original.remainingBudget, 5);
  assert.deepEqual(result, compareStrategy(saved, alternate));
  assert.deepEqual(result, compareStrategy(saved, scenario([...alternate.decisions].reverse())));
  for (const [district, changes] of Object.entries(result.comparison.indicatorChanges)) for (const [id, delta] of Object.entries(changes)) {
    assert.equal(delta, result.event.finalIndicators[district][id] - saved.event.finalIndicators[district][id]);
  }
});

const invalidPlans = [
  scenario(original.decisions.slice(0, 4)),
  scenario([...original.decisions, measure('M9', 'Есиль')]),
  scenario([measure('M3', 'Нура'), measure('M5', 'Сарыарка'), measure('M7', 'Нура'), measure('M8', 'Нура'), measure('M13', 'Есиль')]),
  scenario([original.decisions[0], original.decisions[0], ...original.decisions.slice(2)]),
  scenario([measure('M7'), ...original.decisions.slice(1)]),
  scenario(original.decisions.map(item => item.measureId === 'M12' ? measure('M12', 'Нура') : item)),
  scenario([measure('M7', 'Нура'), measure('M8', 'Нура'), measure('M9', 'Нура'), measure('M10', 'Нура'), measure('M12')]),
  scenario([measure('M1', 'Есиль'), measure('M3', 'Нура'), measure('M9', 'Нура'), measure('M10', 'Нура'), measure('M12')]),
  scenario([measure('M4', 'Нура'), measure('M7', 'Нура'), measure('M9', 'Нура'), measure('M10', 'Нура'), measure('M12')]),
  scenario([measure('M5', 'Нура'), measure('M13', 'Нура'), measure('M9', 'Нура'), measure('M10', 'Нура'), measure('M12')])
];

test('Existing Validator remains authoritative: every invalid alternative is rejected before computation', () => {
  for (const input of invalidPlans) {
    const expected = validate(input);
    assert.equal(expected.valid, false);
    assert.throws(() => compareStrategy(snapshot(), input, { calculateInput() { assert.fail('Calculation called'); } }), error => error instanceof ValidationError && error.code === expected.code);
  }
});

test('Adaptation AI receives only calculated comparison facts and keeps existing output contract', async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'adaptation-mock-only';
  try {
    const { comparison } = compareStrategy(snapshot(), alternate);
    const before = JSON.stringify(comparison);
    const response = await explainAdaptation({ ...comparison, untrusted: 'DO_NOT_FORWARD' }, { fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const request = JSON.parse(options.body);
      const facts = JSON.parse(request.input[0].content);
      assert.equal(facts.untrusted, undefined);
      assert.deepEqual(facts.original, comparison.original);
      assert.deepEqual(facts.adapted, comparison.adapted);
      assert.deepEqual(facts.indicatorChanges, comparison.indicatorChanges);
      assert.equal(facts.deltaAdaptationScore, comparison.deltaAdaptationScore);
      assert.match(request.instructions, /контрфактическое сравнение/);
      assert.match(request.instructions, /расходы не суммируются/);
      assert.equal(request.text.format.strict, true);
      assert.equal(request.text.format.schema.additionalProperties, false);
      assert.ok(!options.body.includes(process.env.OPENAI_API_KEY));
      return mock();
    } });
    assert.deepEqual(response, analysis);
    assert.equal(JSON.stringify(comparison), before);
    for (const summary of ['deltaAdaptationScore 0', 'STATE_3 55.72', 'S1 40', '55.1234']) {
      await assert.rejects(explainAdaptation(comparison, { fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ ...analysis, summary }) }] }] }) }) }));
    }
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('API full adaptation path binds original snapshot, rejects invalid plans and preserves result on AI failure', async () => {
  let calculations = 0;
  let aiCalls = 0;
  let failAI = false;
  const server = createApplication({
    calculateInput(input) { calculations++; return calculate(input); },
    explainResult: async () => analysis, explainEventResult: async () => analysis,
    explainAdaptationResult: async facts => { aiCalls++; assert.equal(facts.eventType, EVENTS[4].id); if (failAI) throw new Error('Unavailable'); return analysis; }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const post = (path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/adaptation', { eventId: 'missing', scenario: alternate })).status, 409);
    const base = await post('/api/scenario', original);
    const scenarioId = base.headers.get('X-Scenario-Id');
    assert.equal((await base.json()).calculation.Score.toFixed(2), '56.54');
    const event = await post('/api/event', { scenarioId, eventType: EVENTS[4].id, district: 'Нура' });
    const eventId = event.headers.get('X-Event-Id');
    assert.equal((await event.json()).event.Score_after.toFixed(2), '55.72');
    // Later event selections cannot change the saved comparison target.
    await post('/api/event', { scenarioId, eventType: EVENTS[0].id, district: 'Есиль' });
    const counts = [calculations, aiCalls];
    for (const input of invalidPlans) {
      const invalid = await post('/api/adaptation', { eventId, scenario: input });
      assert.equal(invalid.status, 422);
      assert.equal((await invalid.json()).error.code, validate(input).code);
    }
    assert.deepEqual([calculations, aiCalls], counts);
    for (const input of [original, alternate]) {
      const response = await post('/api/adaptation', { eventId, scenario: input, eventType: EVENTS[0].id, district: 'Есиль', Score: 999 });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.comparison, compareStrategy(snapshot(), input).comparison);
      assert.deepEqual(body.aiAnalysis, analysis);
    }
    failAI = true;
    const failed = await (await post('/api/adaptation', { eventId, scenario: alternate })).json();
    assert.deepEqual(failed.comparison, compareStrategy(snapshot(), alternate).comparison);
    assert.equal(failed.aiAnalysis, null);
    assert.match(failed.aiError, /Результат сравнения сохранён/);
    assert.equal(calculations, counts[0] + 3);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
