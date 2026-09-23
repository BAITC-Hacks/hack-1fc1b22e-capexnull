import { MEASURES, RULES } from './data.js';

/** Budget-only preview for an unfinished selection. Never calculates scenario Score. */
export function previewBudget(measureIds = []) {
  if (!Array.isArray(measureIds) || measureIds.some(id => typeof id !== 'string' || !Object.hasOwn(MEASURES, id))) {
    throw new TypeError('Неизвестное мероприятие.');
  }
  const totalCost = measureIds.reduce((total, id) => total + MEASURES[id].cost, 0);
  return { totalCost, remainingBudget: RULES.budget - totalCost };
}
