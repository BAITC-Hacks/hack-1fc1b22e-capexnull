import { DISTRICTS, MEASURES, RULES } from '../engine/data.js';

const fail = (code, message) => ({ valid: false, code, errors: [message] });
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Structural/ID preflight, then rules 1–9 in specification order.
 * Returns a canonical copy; never mutates input or computes Score.
 * @param {import('../scenario/index.js').ScenarioInput} input
 * @returns {{valid: false, code: string, errors: string[]} | {valid: true, input: import('../scenario/index.js').ScenarioInput}}
 */
export function validate(input) {
  if (!isRecord(input) || input.mode !== 'MATAN-only' || !Array.isArray(input.decisions)
    || Array.from(input.decisions).some(decision => !isRecord(decision) || typeof decision.measureId !== 'string')) {
    return fail('INPUT_STRUCTURE', 'Ожидается режим MATAN-only и массив решений с текстовым measureId.');
  }
  const unknown = input.decisions.map(decision => decision.measureId)
    .filter(id => !Object.hasOwn(MEASURES, id)).sort();
  if (unknown.length) return fail('UNKNOWN_MEASURE', `Неизвестное мероприятие: ${unknown[0]}.`);
  const decisions = input.decisions.map(decision => ({
    measureId: decision.measureId,
    ...(Object.hasOwn(decision, 'districtId') ? { districtId: decision.districtId } : {})
  })).sort((a, b) => Number(a.measureId.slice(1)) - Number(b.measureId.slice(1)));

  if (decisions.length !== RULES.decisionCount) return fail('DECISION_COUNT', 'Нужно выбрать ровно 5 решений.');
  const selected = new Map();
  for (const decision of decisions) {
    if (selected.has(decision.measureId)) {
      return fail('DUPLICATE_MEASURE', `Мероприятие ${decision.measureId} выбрано больше одного раза.`);
    }
    selected.set(decision.measureId, decision);
  }
  const totalCost = decisions.reduce((total, decision) => total + MEASURES[decision.measureId].cost, 0);
  if (totalCost > RULES.budget) return fail('BUDGET_EXCEEDED', `Стоимость ${totalCost} превышает бюджет 100.`);
  for (const decision of decisions) {
    if (MEASURES[decision.measureId].scope === 'district'
      && (typeof decision.districtId !== 'string' || !Object.hasOwn(DISTRICTS, decision.districtId))) {
      return fail('INVALID_DISTRICT', `Для ${decision.measureId} укажите ровно один допустимый район.`);
    }
  }
  for (const decision of decisions) {
    if (MEASURES[decision.measureId].scope === 'city' && Object.hasOwn(decision, 'districtId')) {
      return fail('CITY_DISTRICT', `Для городского мероприятия ${decision.measureId} район должен отсутствовать.`);
    }
  }
  const directions = new Map();
  for (const decision of decisions) {
    const direction = MEASURES[decision.measureId].direction;
    directions.set(direction, (directions.get(direction) || 0) + 1);
    if (directions.get(direction) > RULES.maxPerDirection) {
      return fail('DIRECTION_LIMIT', `В направлении ${direction} допускается максимум 2 мероприятия.`);
    }
  }
  if (selected.has('M1') && selected.has('M3')) {
    return fail('M1_M3_CONFLICT', 'M1 и M3 несовместимы независимо от района.');
  }
  for (const [first, second] of [['M4', 'M7'], ['M5', 'M13']]) {
    if (selected.has(first) && selected.has(second)
      && selected.get(first).districtId === selected.get(second).districtId) {
      return fail(`${first}_${second}_CONFLICT`, `${first} и ${second} несовместимы в одном районе.`);
    }
  }
  return { valid: true, input: { mode: 'MATAN-only', decisions } };
}

export class ValidationError extends Error {
  constructor(validation) {
    super(validation.errors[0]);
    this.name = 'ValidationError';
    this.code = validation.code;
    this.errors = [...validation.errors];
  }
}
