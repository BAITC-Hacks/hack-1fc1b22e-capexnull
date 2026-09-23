import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { createInput } from '../src/scenario/index.js';
import { calculate, calculateBaseline } from '../src/engine/index.js';
import { analysisSchema, validateAnalysis, validatePresentation, explain, analyzeScenario, AgenticAIError } from '../src/ai/backend.js';

const fakeKey = 'unit-test-only-not-a-real-key';
const originalKey = process.env.OPENAI_API_KEY;
const originalModel = process.env.OPENAI_MODEL;
beforeEach(context => {
  process.env.OPENAI_API_KEY = fakeKey;
  delete process.env.OPENAI_MODEL;
  // Any accidentally unstubbed request fails locally; no real API calls in CHECK.
  context.mock.method(globalThis, 'fetch', async () => { throw new Error('Unstubbed API request'); });
});
afterEach(() => {
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
  if (originalModel === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = originalModel;
});

const scenario = () => createInput([
  { measureId: 'M7', districtId: 'Нура' },
  { measureId: 'M8', districtId: 'Нура' },
  { measureId: 'M10', districtId: 'Нура' },
  { measureId: 'M12' },
  { measureId: 'M5', districtId: 'Сарыарка' }
]);
const output = () => ({
  summary: 'Качество жизни улучшилось: Astana Quality of Life Score 56.54.',
  strengths: ['В Нуре улучшились социальные показатели.'],
  risks: ['В Нуре сохраняются сравнительно слабые показатели.'],
  tradeoffs: ['Основная часть бюджета использована.'],
  recommendations: ['Сопоставить сохраняющиеся слабые показатели районов.']
});
const envelope = value => ({ status: 'completed', output: [
  { type: 'reasoning', summary: [] },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }
] });
const api = value => async () => ({ ok: true, json: async () => envelope(value) });
const hasCode = code => error => error instanceof AgenticAIError && error.code === code;
const keys = ['summary', 'strengths', 'risks', 'tradeoffs', 'recommendations'];

test('A: valid scenario and actual Engine result reach Responses without changes', async () => {
  const input = scenario();
  const result = calculate(input);
  const snapshot = structuredClone({ input, result });
  let calls = 0;
  const analysis = await explain(input, result, { fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.method, 'POST');
    const request = JSON.parse(options.body);
    assert.equal(request.text.format.type, 'json_schema');
    assert.equal(request.text.format.strict, true);
    assert.deepEqual(request.text.format.schema, analysisSchema);
    const facts = JSON.parse(request.input[0].content);
    assert.deepEqual(facts.scenario.decisions.map(item => item.measureId), ['M5', 'M7', 'M8', 'M10', 'M12']);
    assert.equal(facts.scenario.decisions[0].districtId, 'Сарыарка');
    assert.deepEqual(Object.keys(facts.engineResult).sort(), [
      'totalCost', 'remainingBudget', 'finalIndicators', 'indicatorDeltas', 'districtScores', 'D_avg', 'N_crit', 'Score', 'deltaScore'
    ].sort());
    for (const [field, value] of Object.entries(facts.engineResult)) assert.deepEqual(value, result[field]);
    for (const term of ['OBSERVE', 'INTERPRET', 'ACT', 'VERIFY', 'OUTPUT', 'N_crit > 0', 'запрещено самостоятельно пересчитывать', 'Не утверждай отсутствующие']) {
      assert.ok(request.instructions.includes(term), term);
    }
    return { ok: true, json: async () => envelope(output()) };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(analysis, output());
  assert.deepEqual({ input, result }, snapshot);
});

test('B: correct structured output passes local deterministic verification', () => {
  const valid = output();
  assert.deepEqual(validateAnalysis(valid), valid);
  assert.deepEqual(validateAnalysis({ summary: 'Результат', strengths: [], risks: [], tradeoffs: [], recommendations: [] }).risks, []);
});

test('Presentation validates tokens in all fields without rewriting', () => {
  const tokens = ['deltaScore', 'D_avg', 'districtScore', 'districtScores', 'N_crit', 'indicatorDeltas', 'finalIndicators', 'totalCost', 'remainingBudget', 'T1', 'T2', 'E1', 'E2', 'S1', 'S2', 'B1', 'B2', 'C1', 'C2', 'Score'];
  for (const field of keys) for (const token of tokens) {
    const value = output();
    value[field] = field === 'summary' ? `Значение (${token}) — 38.` : [`Значение (${token}) — 38.`];
    const snapshot = structuredClone(value);
    assert.throws(() => validatePresentation(value), hasCode('AI_PRESENTATION_INVALID'));
    assert.deepEqual(value, snapshot);
  }
  const valid = { ...output(), strengths: ['префиксT1 T10 T1suffix my_deltaScore districtScoresExtra'], risks: ['Школы и детсады: 38; качество воздуха: 58.23; изменение: 0,96.'] };
  const snapshot = structuredClone(valid);
  assert.doesNotThrow(() => validatePresentation(valid));
  assert.deepEqual(valid, snapshot);
});

test('Presentation checks precision without rounding and integers without decimal parts', () => {
  for (const number of ['53.51402', '0.95634', '58,2286', '-0.001', '+12.000', '38.00']) {
    assert.throws(() => validatePresentation({ ...output(), summary: `Оценка: ${number}.` }), hasCode('AI_PRESENTATION_INVALID'));
  }
  for (const number of ['53.51', '0.96', '58,23', '38', '-0.01', '0.05']) {
    assert.doesNotThrow(() => validatePresentation({ ...output(), summary: `Оценка: ${number}.` }));
  }
});

test('Presentation failure retains Engine result and original structured AI output', async () => {
  const invalid = { ...output(), recommendations: ['Проверить S1 и deltaScore 0.95634.'] };
  const snapshot = structuredClone(invalid);
  const result = calculate(scenario());
  const workflow = await analyzeScenario(scenario(), { fetchImpl: api(invalid) });
  assert.deepEqual(workflow.result, result);
  assert.equal(workflow.analysis, null);
  assert.equal(workflow.aiError.code, 'AI_PRESENTATION_INVALID');
  assert.deepEqual(invalid, snapshot);
});

test('C: schema and verifier require exactly the five mandatory fields', () => {
  assert.deepEqual(analysisSchema.required, keys);
  assert.deepEqual(Object.keys(analysisSchema.properties), keys);
  assert.equal(analysisSchema.additionalProperties, false);
  for (const field of keys) {
    const invalid = output();
    delete invalid[field];
    assert.throws(() => validateAnalysis(invalid), hasCode('AI_OUTPUT_INVALID'));
  }
  for (const invalid of [null, [], 'text', 42, { ...output(), Score: 99 }]) {
    assert.throws(() => validateAnalysis(invalid), hasCode('AI_OUTPUT_INVALID'));
  }
});

test('D: summary must be a nonempty string, including whitespace rejection', () => {
  for (const summary of ['', ' \n\t ', null, 0, [], {}]) {
    assert.throws(() => validateAnalysis({ ...output(), summary }), hasCode('AI_OUTPUT_INVALID'));
  }
  assert.equal(new RegExp(analysisSchema.properties.summary.pattern).test('   '), false);
});

test('E: each list contains strings only', () => {
  for (const field of keys.slice(1)) {
    for (const value of ['text', null, {}, [1], ['ok', null], new Array(1)]) {
      assert.throws(() => validateAnalysis({ ...output(), [field]: value }), hasCode('AI_OUTPUT_INVALID'));
    }
  }
});

test('F: malformed, incomplete, refused and invalid outputs produce controlled errors', async () => {
  const broken = [
    null, {}, { status: 'incomplete', output: [] }, { status: 'failed', output: [] },
    { status: 'completed', output: [] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{bad' }] }] },
    envelope({ summary: 'Incomplete' }), envelope({ ...output(), Score: 999 })
  ];
  for (const response of broken) {
    await assert.rejects(explain(scenario(), calculate(scenario()), {
      fetchImpl: async () => ({ ok: true, json: async () => response })
    }), hasCode('AI_OUTPUT_INVALID'));
  }
  await assert.rejects(explain(scenario(), calculate(scenario()), {
    fetchImpl: async () => ({ ok: true, json: async () => { throw new Error(fakeKey); } })
  }), hasCode('AI_OUTPUT_INVALID'));
});

test('G: HTTP, network and timeout errors stay inside the AI layer without secret details', async () => {
  const failures = [
    async () => ({ ok: false, status: 401 }),
    async () => ({ ok: false, status: 429 }),
    async () => { throw new Error(`Network error: ${fakeKey}`); },
    async () => { throw new DOMException('Timeout', 'TimeoutError'); }
  ];
  for (const fetchImpl of failures) {
    await assert.rejects(explain(scenario(), calculate(scenario()), { fetchImpl }), error => {
      assert.equal(error instanceof AgenticAIError, true);
      assert.equal(error.code, 'AI_API_ERROR');
      assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(fakeKey), false);
      return true;
    });
  }
});

test('H: AI/API failures preserve the full Engine result and Score', async () => {
  const input = scenario();
  const result = calculate(input);
  const snapshot = structuredClone(result);
  for (const fetchImpl of [async () => { throw new Error('offline'); }, api({ summary: '' })]) {
    await assert.rejects(explain(input, result, { fetchImpl }), AgenticAIError);
    assert.deepEqual(result, snapshot);
    const workflow = await analyzeScenario(input, { fetchImpl });
    assert.deepEqual(workflow.result, snapshot);
    assert.equal(workflow.analysis, null);
    assert.ok(workflow.aiError.code.startsWith('AI_'));
  }
  assert.ok(Math.abs(result.Score - 56.54307) <= 1e-9);
  assert.ok(Math.abs(calculateBaseline().Score - 52.55768) <= 1e-9);
});

test('I: missing API key produces a configuration error without API access', async () => {
  for (const key of [undefined, '', '   ']) {
    if (key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = key;
    let calls = 0;
    await assert.rejects(explain(scenario(), calculate(scenario()), {
      fetchImpl: async () => { calls++; throw new Error('Must not call'); }
    }), hasCode('AI_CONFIG_MISSING'));
    assert.equal(calls, 0);
  }
});

test('J: default model is gpt-5.6-luna; explicit OPENAI_MODEL is honored', async () => {
  for (const [model, expected] of [[undefined, 'gpt-5.6-luna'], ['', 'gpt-5.6-luna'], ['configured-model', 'configured-model']]) {
    if (model === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = model;
    await explain(scenario(), calculate(scenario()), { fetchImpl: async (_, options) => {
      assert.equal(JSON.parse(options.body).model, expected);
      return { ok: true, json: async () => envelope(output()) };
    } });
  }
});

test('K: key is backend environment only, not prompt, output, logs or served source', async context => {
  const log = context.mock.method(console, 'log', () => {});
  const warn = context.mock.method(console, 'warn', () => {});
  const error = context.mock.method(console, 'error', () => {});
  const input = { ...scenario(), secretMetadata: fakeKey };
  const result = { ...calculate(input), secretMetadata: fakeKey };
  const analysis = await explain(input, result, { fetchImpl: async (_, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${fakeKey}`);
    assert.equal(options.body.includes(fakeKey), false);
    const request = JSON.parse(options.body);
    for (const term of ['Astana Quality of Life Score', 'средневзвешенная оценка города', 'оценка района', 'оценки районов', 'количество критических показателей', 'изменения показателей', 'итоговые показатели', 'использованный бюджет', 'оставшийся бюджет', 'разгрузка дорог', 'доступность общественного транспорта', 'озеленение', 'качество воздуха', 'школы и детсады', 'поликлиники и первичная медпомощь', 'безопасность улиц', 'безопасность дорожного движения', 'надёжность ЖКХ', 'скорость решения обращений жителей', 'максимум с 2 знаками', 'Целые значения отображай как целые']) assert.ok(request.instructions.includes(term), term);
    return { ok: true, json: async () => envelope(output()) };
  } });
  assert.equal(JSON.stringify(analysis).includes(fakeKey), false);
  await assert.rejects(explain(input, result, { fetchImpl: api({ ...output(), summary: fakeKey }) }), hasCode('AI_OUTPUT_INVALID'));
  assert.equal(log.mock.callCount() + warn.mock.callCount() + error.mock.callCount(), 0);
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const assetList = server.slice(server.indexOf('const assets'), server.indexOf('const port'));
  assert.equal(assetList.includes('backend.js'), false);
  assert.equal(assetList.includes('.env'), false);
  const servedPaths = [...assetList.matchAll(/\[\s*'([^']+)',\s*'(?:text\/[^']+)'\s*\]/g)].map(match => match[1]);
  assert.ok(servedPaths.length >= 8);
  for (const path of servedPaths) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.equal(/OPENAI_API_KEY|process\.env|api\.openai\.com|ai\/backend/.test(source), false, path);
  }
  const ignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.ok(ignore.split(/\r?\n/).includes('.env'));
  assert.ok(ignore.split(/\r?\n/).includes('.env.*'));
});

test('Integration: backend calculates actual scenario and returns strictly validated analysis', async () => {
  const input = scenario();
  const snapshot = structuredClone(input);
  const response = await analyzeScenario(input, { fetchImpl: api(output()) });
  assert.deepEqual(response.result, calculate(input));
  assert.deepEqual(Object.keys(response.analysis), keys);
  assert.deepEqual(response.analysis, output());
  assert.equal(response.aiError, null);
  assert.deepEqual(input, snapshot);
});

test('Invalid scenario or missing/nonfinite engine data cannot reach OpenAI', async () => {
  let calls = 0;
  const options = { fetchImpl: async () => { calls++; throw new Error('Must not call'); } };
  await assert.rejects(analyzeScenario(createInput(), options), hasCode('AI_INPUT_INVALID'));
  await assert.rejects(explain(createInput(), calculate(scenario()), options), hasCode('AI_INPUT_INVALID'));
  for (const result of [null, {}, { ...calculate(scenario()), Score: NaN }, { ...calculate(scenario()), finalIndicators: {} }]) {
    await assert.rejects(explain(scenario(), result, options), hasCode('AI_INPUT_INVALID'));
  }
  assert.equal(calls, 0);
});
