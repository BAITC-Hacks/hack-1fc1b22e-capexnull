import { DISTRICTS, MEASURES, RULES, SYNERGIES, WEIGHTS } from './data.js';
import { validate, ValidationError } from '../validator/index.js';

/** Clamp only after all ordinary effects and synergies have been summed. */
export const clip = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));

const initialIndicators = () => Object.fromEntries(
  Object.entries(DISTRICTS).map(([id, district]) => [id, { ...district.indicators }])
);

/** Pure scoring of final indicators, using fixed district and indicator order. */
function scoreIndicators(finalIndicators) {
  const districtScores = {};
  let D_avg = 0;
  let N_crit = 0;
  for (const [id, district] of Object.entries(DISTRICTS)) {
    let districtScore = 0;
    for (const [indicator, weight] of Object.entries(WEIGHTS)) {
      const value = finalIndicators[id][indicator];
      districtScore += weight * value;
      if (value < 40) N_crit += 1;
    }
    districtScores[id] = districtScore;
    D_avg += district.population_share * districtScore;
  }
  const Score = 0.7 * D_avg + 0.3 * Math.min(...Object.values(districtScores)) - N_crit;
  return { districtScores, D_avg, N_crit, Score };
}

/** Baseline is not a user scenario and bypasses the five-decision rule. */
export function calculateBaseline() {
  const finalIndicators = initialIndicators();
  return { finalIndicators, ...scoreIndicators(finalIndicators) };
}

/**
 * @typedef {Object} CalculatedResult
 * @property {'MATAN-only'} mode
 * @property {number} totalCost
 * @property {number} remainingBudget
 * @property {Object<string, Object<string, number>>} finalIndicators
 * @property {Object<string, Object<string, number>>} indicatorDeltas
 * @property {Object<string, number>} districtScores
 * @property {number} D_avg
 * @property {number} N_crit
 * @property {number} Score
 * @property {number} deltaScore
 * @property {{baseline: number, value: number, delta: number}} score
 * @property {{total: number, spent: number, remaining: number}} budget
 * @property {Array<{districtId: string, indicators: Array<{id: string, baseline: number, value: number, delta: number}>}>} districts
 */

/**
 * Revalidate at the public boundary so callers cannot bypass admissibility.
 * Only a successful canonical set reaches mathematical calculation.
 * No rounding, randomness, AI, UI dependencies or mutations of source data.
 * @param {import('../scenario/index.js').ScenarioInput} input
 * @returns {CalculatedResult}
 * @throws {ValidationError} Before any scenario indicators or Score are calculated.
 */
export function calculate(input) {
  const validation = validate(input);
  if (!validation.valid) throw new ValidationError(validation);
  const { decisions } = validation.input;
  const finalIndicators = initialIndicators();
  let totalCost = 0;

  for (const decision of decisions) {
    const measure = MEASURES[decision.measureId];
    totalCost += measure.cost;
    const realizedFraction = (RULES.horizon - measure.lag) / RULES.horizon;
    const targets = measure.scope === 'city' ? Object.keys(DISTRICTS) : [decision.districtId];
    for (const districtId of targets) {
      for (const [indicator, effect] of Object.entries(measure.effects)) {
        finalIndicators[districtId][indicator] += effect * realizedFraction;
      }
    }
  }
  const selected = new Map(decisions.map(decision => [decision.measureId, decision]));
  for (const synergy of SYNERGIES) {
    if (synergy.pair.every(id => selected.has(id))) {
      const districtId = selected.get(synergy.districtFrom).districtId;
      finalIndicators[districtId][synergy.indicator] += synergy.delta;
    }
  }

  const indicatorDeltas = {};
  for (const [districtId, district] of Object.entries(DISTRICTS)) {
    indicatorDeltas[districtId] = {};
    for (const indicator of Object.keys(WEIGHTS)) {
      const value = clip(finalIndicators[districtId][indicator]);
      finalIndicators[districtId][indicator] = value;
      indicatorDeltas[districtId][indicator] = value - district.indicators[indicator];
    }
  }
  const scores = scoreIndicators(finalIndicators);
  const baseline = calculateBaseline();
  const deltaScore = scores.Score - baseline.Score;
  const remainingBudget = RULES.budget - totalCost;
  return {
    mode: 'MATAN-only', totalCost, remainingBudget, finalIndicators, indicatorDeltas,
    ...scores, deltaScore,
    // Preserve stage-one presentation fields with the same calculated values.
    score: { baseline: baseline.Score, value: scores.Score, delta: deltaScore },
    budget: { total: RULES.budget, spent: totalCost, remaining: remainingBudget },
    districts: Object.entries(DISTRICTS).map(([districtId, district]) => ({
      districtId,
      indicators: Object.keys(WEIGHTS).map(id => ({
        id, baseline: district.indicators[id], value: finalIndicators[districtId][id],
        delta: indicatorDeltas[districtId][id]
      }))
    }))
  };
}
