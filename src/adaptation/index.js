import { validate, ValidationError } from '../validator/index.js';
import { calculate } from '../engine/index.js';
import { DISTRICTS, WEIGHTS } from '../engine/data.js';
import { computeEvent } from '../dynamic/engine.js';

function immutable(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') immutable(child);
  }
  return Object.freeze(value);
}

// Capture the particular observed event, not the branch's mutable current pointer.
export function captureStrategy(scenario, calculation, event) {
  const validation = validate(scenario);
  if (!validation.valid) throw new ValidationError(validation);
  return immutable(structuredClone({ scenario: validation.input, calculation, event }));
}

export function compareStrategy(original, input, { calculateInput = calculate } = {}) {
  const validation = validate(input);
  if (!validation.valid) throw new ValidationError(validation);
  // calculate always starts from the fixed source data, never from original.event.
  const adaptationState = immutable(calculateInput(validation.input));
  const event = immutable(computeEvent(adaptationState, original.event.eventId, original.event.district));
  const side = (scenario, calculation, result) => ({
    scenario, totalCost: calculation.totalCost, remainingBudget: calculation.remainingBudget,
    Score: result.Score_after, N_crit: result.N_crit_after,
    districtScores: result.districtScores_after, finalIndicators: result.finalIndicators
  });
  const comparison = {
    eventName: event.eventName, eventType: event.eventId, district: event.district,
    original: side(original.scenario, original.calculation, original.event),
    adapted: side(validation.input, adaptationState, event),
    deltaAdaptationScore: event.Score_after - original.event.Score_after,
    indicatorChanges: Object.fromEntries(Object.keys(DISTRICTS).map(district => [district,
      Object.fromEntries(Object.keys(WEIGHTS).map(id => [id,
        event.finalIndicators[district][id] - original.event.finalIndicators[district][id]
      ]))
    ]))
  };
  return immutable(structuredClone({ adaptationState, event, comparison }));
}
