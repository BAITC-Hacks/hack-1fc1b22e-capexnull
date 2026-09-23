/** Fixed MATAN-only model data; all numerical outcomes belong to the engine. */
function freeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') freeze(child);
  }
  return Object.freeze(value);
}

export const RULES = freeze({ budget: 100, decisionCount: 5, maxPerDirection: 2, horizon: 8 });
export const WEIGHTS = freeze({
  T1: 0.10, T2: 0.10, E1: 0.09, E2: 0.11, S1: 0.11,
  S2: 0.11, B1: 0.09, B2: 0.09, C1: 0.10, C2: 0.10
});

// District names are the canonical districtId values in ScenarioInput.
export const DISTRICTS = freeze({
  'Есиль': { population_share: 0.27, indicators: { T1: 45, T2: 62, E1: 68, E2: 72, S1: 48, S2: 55, B1: 78, B2: 60, C1: 75, C2: 70 } },
  'Алматы': { population_share: 0.24, indicators: { T1: 40, T2: 75, E1: 50, E2: 55, S1: 60, S2: 65, B1: 62, B2: 52, C1: 50, C2: 60 } },
  'Сарыарка': { population_share: 0.20, indicators: { T1: 50, T2: 70, E1: 42, E2: 40, S1: 62, S2: 68, B1: 58, B2: 55, C1: 45, C2: 55 } },
  'Байконур': { population_share: 0.13, indicators: { T1: 52, T2: 68, E1: 55, E2: 50, S1: 58, S2: 60, B1: 52, B2: 58, C1: 55, C2: 58 } },
  'Нура': { population_share: 0.16, indicators: { T1: 55, T2: 40, E1: 45, E2: 65, S1: 38, S2: 35, B1: 55, B2: 50, C1: 60, C2: 50 } }
});

export const MEASURES = freeze({
  M1: { direction: 'transport', scope: 'district', cost: 18, lag: 2, effects: { T1: 6, T2: 9 } },
  M2: { direction: 'transport', scope: 'city', cost: 22, lag: 2, effects: { T1: 4, B2: 3 } },
  M3: { direction: 'transport', scope: 'district', cost: 30, lag: 4, effects: { T1: 16, T2: 20, E2: 4 } },
  M4: { direction: 'ecology', scope: 'district', cost: 15, lag: 2, effects: { E1: 12, E2: 3, B1: 2 } },
  M5: { direction: 'ecology', scope: 'district', cost: 25, lag: 3, effects: { E2: 14, C1: 4 } },
  M6: { direction: 'ecology', scope: 'city', cost: 20, lag: 4, effects: { E1: 5, E2: 3 } },
  M7: { direction: 'social', scope: 'district', cost: 24, lag: 3, effects: { S1: 16 } },
  M8: { direction: 'social', scope: 'district', cost: 20, lag: 3, effects: { S2: 14 } },
  M9: { direction: 'social', scope: 'district', cost: 10, lag: 1, effects: { S1: 3, S2: 3, B1: 3 } },
  M10: { direction: 'safety', scope: 'district', cost: 12, lag: 1, effects: { B1: 12, B2: 2 } },
  M11: { direction: 'safety', scope: 'district', cost: 10, lag: 1, effects: { B2: 12, T1: -2 } },
  M12: { direction: 'services', scope: 'city', cost: 14, lag: 1, effects: { C2: 5 } },
  M13: { direction: 'services', scope: 'district', cost: 28, lag: 4, effects: { C1: 18, E2: 2 } },
  M14: { direction: 'services', scope: 'city', cost: 16, lag: 1, effects: { C1: 5, C2: 2 } }
});

// Numeric pair order; apply after all ordinary effects, without lag scaling.
export const SYNERGIES = freeze([
  { pair: ['M1', 'M2'], districtFrom: 'M1', indicator: 'T1', delta: 2 },
  { pair: ['M5', 'M6'], districtFrom: 'M5', indicator: 'E2', delta: 2 },
  { pair: ['M10', 'M12'], districtFrom: 'M10', indicator: 'B1', delta: 2 }
]);
