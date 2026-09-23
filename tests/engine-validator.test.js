import test from 'node:test';
import assert from 'node:assert/strict';
import { createInput } from '../src/scenario/index.js';
import { validate, ValidationError } from '../src/validator/index.js';
import { calculate, calculateBaseline, clip } from '../src/engine/index.js';
import { DISTRICTS, MEASURES, WEIGHTS } from '../src/engine/data.js';

const decision = (measureId, districtId) => ({ measureId, ...(districtId === undefined ? {} : { districtId }) });
const control = [decision('M7', 'Нура'), decision('M8', 'Нура'), decision('M10', 'Нура'), decision('M12'), decision('M5', 'Сарыарка')];
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-9, `${actual} != ${expected}`);
const run = decisions => calculate(createInput(decisions));

// Every invalid fixture also proves engine rejection and permutation-invariant errors.
function rejected(decisions, code) {
  const input = createInput(decisions);
  const result = validate(input);
  assert.equal(result.valid, false);
  assert.equal(result.code, code);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].length > 0);
  assert.equal(Object.hasOwn(result, 'Score'), false);
  for (const permutation of [decisions, [...decisions].reverse(), [...decisions.slice(1), decisions[0]]]) {
    assert.deepEqual(validate(createInput(permutation)), result);
    assert.throws(() => run(permutation), error => error instanceof ValidationError
      && error.code === code && !Object.hasOwn(error, 'Score'));
  }
}

test('A: baseline uses initial indicators directly, strict <40 threshold and exact Score', () => {
  const baseline = calculateBaseline();
  near(baseline.D_avg, 56.8624);
  assert.equal(baseline.N_crit, 2);
  near(baseline.Score, 52.55768);
  assert.equal(baseline.Score.toFixed(2), '52.56');
  const critical = Object.entries(baseline.finalIndicators).flatMap(([district, indicators]) =>
    Object.entries(indicators).filter(([, value]) => value < 40).map(([id, value]) => [district, id, value]));
  assert.deepEqual(critical, [['Нура', 'S1', 38], ['Нура', 'S2', 35]]);
  assert.equal(validate(createInput()).code, 'DECISION_COUNT');
});

test('B: control scenario, full indicator matrix, cost, Score and unrounded delta', () => {
  const result = run(control);
  assert.equal(result.totalCost, 95);
  assert.equal(result.remainingBudget, 5);
  assert.equal(result.N_crit, 0);
  near(result.Score, 56.54307);
  near(result.deltaScore, 3.98539);
  assert.equal(result.Score.toFixed(2), '56.54');
  assert.deepEqual(result.finalIndicators, {
    'Есиль': { T1: 45, T2: 62, E1: 68, E2: 72, S1: 48, S2: 55, B1: 78, B2: 60, C1: 75, C2: 74.375 },
    'Алматы': { T1: 40, T2: 75, E1: 50, E2: 55, S1: 60, S2: 65, B1: 62, B2: 52, C1: 50, C2: 64.375 },
    'Сарыарка': { T1: 50, T2: 70, E1: 42, E2: 48.75, S1: 62, S2: 68, B1: 58, B2: 55, C1: 47.5, C2: 59.375 },
    'Байконур': { T1: 52, T2: 68, E1: 55, E2: 50, S1: 58, S2: 60, B1: 52, B2: 58, C1: 55, C2: 62.375 },
    'Нура': { T1: 55, T2: 40, E1: 45, E2: 65, S1: 48, S2: 43.75, B1: 67.5, B2: 51.75, C1: 60, C2: 54.375 }
  });
  near(result.D_avg, 58.0776);
  for (const [districtId, indicators] of Object.entries(result.finalIndicators)) {
    for (const [id, value] of Object.entries(indicators)) {
      near(result.indicatorDeltas[districtId][id], value - DISTRICTS[districtId].indicators[id]);
    }
  }
  assert.equal(result.score.value, result.Score);
  assert.equal(result.score.delta, result.deltaScore);
  assert.equal(result.budget.remaining, result.remainingBudget);
});

test('C: cost over 100', () => rejected([
  decision('M3', 'Есиль'), decision('M5', 'Нура'), decision('M7', 'Алматы'), decision('M8', 'Нура'), decision('M13', 'Сарыарка')
], 'BUDGET_EXCEEDED'));
test('D: four decisions', () => rejected(control.slice(0, 4), 'DECISION_COUNT'));
test('E: six decisions', () => rejected([...control, decision('M9', 'Есиль')], 'DECISION_COUNT'));
test('F: repeated measure even in different districts', () => rejected([
  decision('M7', 'Нура'), decision('M7', 'Алматы'), ...control.slice(2)
], 'DUPLICATE_MEASURE'));
test('G: more than two in the same direction', () => rejected([
  decision('M7', 'Нура'), decision('M8', 'Нура'), decision('M9', 'Есиль'), decision('M10', 'Нура'), decision('M12')
], 'DIRECTION_LIMIT'));
test('H: M1 and M3 conflict across districts', () => rejected([
  decision('M1', 'Есиль'), decision('M3', 'Нура'), decision('M9', 'Есиль'), decision('M10', 'Нура'), decision('M12')
], 'M1_M3_CONFLICT'));
test('I: M4 and M7 conflict in one district', () => rejected([
  decision('M4', 'Нура'), decision('M7', 'Нура'), decision('M9', 'Есиль'), decision('M10', 'Нура'), decision('M12')
], 'M4_M7_CONFLICT'));
test('J: M4 and M7 are allowed in different districts', () => {
  assert.equal(validate(createInput([
    decision('M4', 'Есиль'), decision('M7', 'Нура'), decision('M9', 'Есиль'), decision('M10', 'Нура'), decision('M12')
  ])).valid, true);
});
test('K: M5 and M13 conflict in one district', () => rejected([
  decision('M5', 'Нура'), decision('M13', 'Нура'), decision('M9', 'Есиль'), decision('M10', 'Нура'), decision('M12')
], 'M5_M13_CONFLICT'));
test('L: district measure requires a district', () => rejected([
  decision('M7'), ...control.slice(1)
], 'INVALID_DISTRICT'));
test('M: city measure cannot have a district', () => rejected(
  control.map(item => item.measureId === 'M12' ? decision('M12', 'Нура') : item), 'CITY_DISTRICT'
));
test('N: unknown measure ID', () => rejected([decision('M99'), ...control.slice(1)], 'UNKNOWN_MEASURE'));
test('O: unknown district', () => rejected([decision('M7', 'Неизвестный'), ...control.slice(1)], 'INVALID_DISTRICT'));

function* permutations(items) {
  if (!items.length) { yield []; return; }
  for (let i = 0; i < items.length; i++) {
    for (const tail of permutations(items.filter((_, index) => index !== i))) yield [items[i], ...tail];
  }
}

test('P: all 120 orders yield identical validation and complete numerical results', () => {
  const expectedValidation = validate(createInput(control));
  assert.deepEqual(expectedValidation.input.decisions.map(item => item.measureId), ['M5', 'M7', 'M8', 'M10', 'M12']);
  const expected = run(control);
  let count = 0;
  for (const order of permutations(control)) {
    assert.deepEqual(validate(createInput(order)), expectedValidation);
    assert.deepEqual(run(order), expected); // Exact equality is stronger than the 1e-9 tolerance.
    count++;
  }
  assert.equal(count, 120);
});

test('Q1: M1 + M2 gives unscaled +2 only in M1 district', () => {
  const result = run([decision('M1', 'Нура'), decision('M2'), decision('M9', 'Есиль'), decision('M11', 'Алматы'), decision('M14')]);
  near(result.indicatorDeltas['Нура'].T1, 9.5);
  near(result.indicatorDeltas['Нура'].T2, 6.75);
  near(result.indicatorDeltas['Есиль'].T1, 3);
  near(result.indicatorDeltas['Алматы'].T1, 1.25);
  for (const id of Object.keys(DISTRICTS)) near(result.indicatorDeltas[id].C1, 4.375);
});
test('Q2: M10 + M12 gives unscaled +2 only in M10 district', () => {
  const result = run(control);
  near(result.indicatorDeltas['Нура'].B1, 12.5);
  near(result.indicatorDeltas['Есиль'].B1, 0);
  for (const id of Object.keys(DISTRICTS)) near(result.indicatorDeltas[id].C2, 4.375);
});
test('Q3: M5 + M6 gives unscaled +2 only in M5 district', () => {
  const result = run([decision('M5', 'Нура'), decision('M6'), decision('M9', 'Есиль'), decision('M11', 'Алматы'), decision('M14')]);
  near(result.indicatorDeltas['Нура'].E2, 12.25);
  near(result.indicatorDeltas['Есиль'].E2, 1.5);
  for (const id of Object.keys(DISTRICTS)) near(result.indicatorDeltas[id].E1, 2.5);
});

test('R: clipping below, at and above both bounds without rounding', () => {
  for (const [value, expected] of [[-20, 0], [0, 0], [0.125, 0.125], [99.875, 99.875], [100, 100], [120, 100]]) {
    assert.equal(clip(value, 0, 100), expected);
  }
});

test('All ordinary effects including negative effects, lag 4 and city scope', () => {
  const result = run([decision('M3', 'Нура'), decision('M4', 'Есиль'), decision('M9', 'Алматы'), decision('M11', 'Сарыарка'), decision('M14')]);
  const expectedChanges = {
    'Нура': { T1: 8, T2: 10, E2: 2 },
    'Есиль': { E1: 9, E2: 2.25, B1: 1.5 },
    'Алматы': { S1: 2.625, S2: 2.625, B1: 2.625 },
    'Сарыарка': { B2: 10.5, T1: -1.75 },
    'Байконур': {}
  };
  for (const [district, changes] of Object.entries(expectedChanges)) {
    for (const indicator of Object.keys(WEIGHTS)) {
      const expected = indicator === 'C1' ? 4.375 : indicator === 'C2' ? 1.75 : (changes[indicator] || 0);
      near(result.indicatorDeltas[district][indicator], expected);
    }
  }
  const m13 = run([decision('M13', 'Байконур'), decision('M4', 'Есиль'), decision('M8', 'Нура'), decision('M11', 'Сарыарка'), decision('M2')]);
  near(m13.indicatorDeltas['Байконур'].C1, 9);
  near(m13.indicatorDeltas['Байконур'].E2, 1);
});

test('Exactly 100 budget is allowed', () => {
  const result = run([decision('M3', 'Нура'), decision('M7', 'Нура'), decision('M6'), decision('M10', 'Нура'), decision('M12')]);
  assert.equal(result.totalCost, 100);
  assert.equal(result.remainingBudget, 0);
});

test('M5 and M13 are allowed in different districts', () => {
  assert.equal(validate(createInput([decision('M5', 'Нура'), decision('M13', 'Есиль'), decision('M9', 'Нура'), decision('M10', 'Нура'), decision('M12')])).valid, true);
});

test('Multiple violations return the earliest numbered rule', () => {
  rejected([decision('M3'), decision('M3'), decision('M5'), decision('M7')], 'DECISION_COUNT');
  rejected([decision('M3'), decision('M3'), decision('M5'), decision('M7'), decision('M13')], 'DUPLICATE_MEASURE');
  rejected([decision('M3'), decision('M5'), decision('M7'), decision('M8'), decision('M13')], 'BUDGET_EXCEEDED');
  rejected([decision('M7'), decision('M8', 'Нура'), decision('M9', 'Нура'), decision('M10', 'Нура'), decision('M12', 'Нура')], 'INVALID_DISTRICT');
  rejected([decision('M7', 'Нура'), decision('M8', 'Нура'), decision('M9', 'Нура'), decision('M10', 'Нура'), decision('M12', 'Нура')], 'CITY_DISTRICT');
  rejected([decision('M1', 'Нура'), decision('M2'), decision('M3', 'Нура'), decision('M9', 'Нура'), decision('M11', 'Нура')], 'DIRECTION_LIMIT');
  rejected([decision('M1', 'Нура'), decision('M3', 'Нура'), decision('M4', 'Нура'), decision('M7', 'Нура'), decision('M11', 'Нура')], 'M1_M3_CONFLICT');
});

test('Canonical first error uses numeric measure order', () => {
  const decisions = [decision('M10'), decision('M2', 'Нура'), decision('M1'), decision('M9', 'Нура'), decision('M14')];
  rejected(decisions, 'INVALID_DISTRICT');
  assert.match(validate(createInput(decisions)).errors[0], /M1 /);
});

test('Malformed inputs and invalid district shapes are rejected without calculation', () => {
  for (const input of [null, {}, [], { mode: 'other', decisions: control }, { mode: 'MATAN-only', decisions: [null] }, { mode: 'MATAN-only', decisions: new Array(5) }]) {
    assert.equal(validate(input).code, 'INPUT_STRUCTURE');
    assert.throws(() => calculate(input), ValidationError);
  }
  for (const districtId of [null, ['Нура'], ['Нура', 'Есиль'], 1, {}, 'toString']) {
    rejected([{ measureId: 'M7', districtId }, ...control.slice(1)], 'INVALID_DISTRICT');
  }
  for (const districtId of [undefined, null, '']) {
    rejected(control.map(item => item.measureId === 'M12' ? { ...item, districtId } : item), 'CITY_DISTRICT');
  }
  rejected([decision('toString'), ...control.slice(1)], 'UNKNOWN_MEASURE');
});

test('Calculation and validation are pure; returned objects cannot mutate model data', () => {
  const input = createInput(control);
  const snapshot = structuredClone(input);
  const dataSnapshot = structuredClone({ DISTRICTS, MEASURES, WEIGHTS });
  const baseline = calculateBaseline();
  const expectedBaseline = structuredClone(baseline);
  const expected = calculate(input);
  validate(input);
  assert.deepEqual(input, snapshot);
  baseline.finalIndicators['Нура'].S1 = 99;
  const changedResult = calculate(input);
  changedResult.finalIndicators['Нура'].S1 = 99;
  assert.deepEqual(calculateBaseline(), expectedBaseline);
  assert.deepEqual(calculate(input), expected);
  assert.deepEqual({ DISTRICTS, MEASURES, WEIGHTS }, dataSnapshot);
});
