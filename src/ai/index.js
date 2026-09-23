/**
 * Only calculated output crosses this boundary. No raw scenario, catalog,
 * independent numerical computation or provider integration at this stage.
 * @param {import('../engine/index.js').CalculatedResult} calculatedResult
 * @returns {Promise<{strengths: string[], risks: string[], tradeoffs: string[], recommendations: string[]}>}
 */
export async function explain(calculatedResult) {
  throw new Error('AI-анализ ещё не подключён.');
}
