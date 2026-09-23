import { DISTRICTS, WEIGHTS } from '../engine/data.js';
import { clip } from '../engine/index.js';
import { EVENTS } from './catalog.js';

// Project-defined synthetic demo parameter, not part of the organizer dataset.
export const EVENT_TYPE = 'heating-network-failure';
export const EVENT_C1_DELTA = -20;

export class EventValidationError extends Error {
  constructor(message) { super(message); this.name = 'EventValidationError'; }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateIndicators(indicators) {
  if (!record(indicators) || Object.keys(indicators).length !== Object.keys(DISTRICTS).length) {
    throw new EventValidationError('Состояние должно содержать все пять районов.');
  }
  for (const district of Object.keys(DISTRICTS)) {
    const values = indicators[district];
    if (!record(values) || Object.keys(values).length !== Object.keys(WEIGHTS).length
      || Object.keys(WEIGHTS).some(id => !Number.isFinite(values[id]) || values[id] < 0 || values[id] > 100)) {
      throw new EventValidationError('Все показатели районов должны находиться в диапазоне 0–100.');
    }
  }
}

/** Pure aggregate calculation from ready indicators; never applies measures. */
export function calculateStateMetrics(indicators) {
  validateIndicators(indicators);
  const districtScores = {};
  let D_avg = 0;
  let N_crit = 0;
  for (const [district, data] of Object.entries(DISTRICTS)) {
    let value = 0;
    for (const [id, weight] of Object.entries(WEIGHTS)) {
      value += weight * indicators[district][id];
      if (indicators[district][id] < 40) N_crit++;
    }
    districtScores[district] = value;
    D_avg += data.population_share * value;
  }
  return { districtScores, D_avg, N_crit, Score: 0.7 * D_avg + 0.3 * Math.min(...Object.values(districtScores)) - N_crit };
}

/** OBSERVE → INTERPRET → DISPATCH → COMPUTE → VALIDATE → MEASURE. */
export function computeEvent(state1, eventType, district) {
  const event = EVENTS.find(item => item.id === eventType);
  if (!event) throw new EventValidationError('Этот тип события не поддерживается.');
  if (Object.entries(event.effects).some(([id, delta]) => !Object.hasOwn(WEIGHTS, id) || !Number.isFinite(delta))) {
    throw new EventValidationError('Событие содержит недопустимые показатели.');
  }
  if (typeof district !== 'string' || !Object.hasOwn(DISTRICTS, district)) {
    throw new EventValidationError('Выберите один из существующих районов.');
  }
  if (!record(state1)) throw new EventValidationError('Сначала выполните базовый расчёт.');
  validateIndicators(state1.finalIndicators);
  const snapshot = JSON.stringify(state1);
  const before = calculateStateMetrics(state1.finalIndicators);
  const finalIndicators = Object.fromEntries(Object.keys(DISTRICTS).map(id => [id,
    Object.fromEntries(Object.keys(WEIGHTS).map(indicator => [indicator, state1.finalIndicators[id][indicator]]))
  ]));
  const affectedIndicators = Object.keys(WEIGHTS).filter(id => Object.hasOwn(event.effects, id));
  const indicatorsBefore = {};
  const indicatorsAfter = {};
  for (const id of affectedIndicators) {
    indicatorsBefore[id] = finalIndicators[district][id];
    finalIndicators[district][id] = clip(indicatorsBefore[id] + event.effects[id], 0, 100);
    indicatorsAfter[id] = finalIndicators[district][id];
  }
  validateIndicators(finalIndicators);
  if (snapshot !== JSON.stringify(state1)) throw new EventValidationError('Базовое состояние изменилось. Событие не применено.');
  const after = calculateStateMetrics(finalIndicators);
  return {
    eventId: event.id, eventName: event.name, district, affectedIndicators, indicatorsBefore, indicatorsAfter,
    Score_before: before.Score, Score_after: after.Score, deltaScore_event: after.Score - before.Score,
    N_crit_before: before.N_crit, N_crit_after: after.N_crit,
    districtScores_after: after.districtScores, D_avg_after: after.D_avg, finalIndicators
  };
}

function freeze(value) {
  for (const child of Object.values(value)) if (record(child) || Array.isArray(child)) freeze(child);
  return Object.freeze(value);
}

/** APPLY only after successful validation. Replay always starts from immutable STATE_1. */
export function createDynamicBranch(engineResult) {
  validateIndicators(engineResult?.finalIndicators);
  const state1 = freeze(structuredClone(engineResult));
  let current = null;
  return {
    get state1() { return state1; },
    get current() { return current; },
    apply(eventType, district) {
      const candidate = computeEvent(state1, eventType, district);
      current = freeze(candidate);
      return current;
    }
  };
}
