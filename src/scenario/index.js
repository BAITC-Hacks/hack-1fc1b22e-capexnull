/** Input only. Future event scenarios adapt inputs here, outside the engine. */
export const scenario = Object.freeze({
  mode: 'MATAN-only',
  budget: 100,
  requiredDecisions: 5,
  baselineScore: 52.56
});

/** @typedef {{measureId: string, districtId?: 'Есиль'|'Алматы'|'Сарыарка'|'Байконур'|'Нура'}} Decision */
/** @typedef {{mode: 'MATAN-only', decisions: Decision[]}} ScenarioInput */

/** One unordered set, confirmed once. No sequence of turns. */
export function createInput(decisions = []) {
  return { mode: scenario.mode, decisions: decisions.map(decision => ({ ...decision })) };
}
