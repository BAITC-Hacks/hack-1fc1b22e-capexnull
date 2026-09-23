import process from 'node:process';
import { validate } from '../validator/index.js';
import { calculate } from '../engine/index.js';
import { DISTRICTS, WEIGHTS } from '../engine/data.js';

const fields = ['summary', 'strengths', 'risks', 'tradeoffs', 'recommendations'];
const numericFields = ['totalCost', 'remainingBudget', 'D_avg', 'N_crit', 'Score', 'deltaScore'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const analysisSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string', pattern: '\\S' },
    strengths: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    tradeoffs: { type: 'array', items: { type: 'string' } },
    recommendations: { type: 'array', items: { type: 'string' } }
  },
  required: [...fields],
  additionalProperties: false
};

export class AgenticAIError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgenticAIError';
    this.code = code;
  }
}

const invalidOutput = () => new AgenticAIError('AI_OUTPUT_INVALID', 'AI вернул некорректный или неполный ответ.');

/** VERIFY: structural validation only; does not claim to prove prose accuracy. */
export function validateAnalysis(output) {
  if (!record(output) || Reflect.ownKeys(output).length !== fields.length
    || !fields.every(field => Object.hasOwn(output, field))
    || typeof output.summary !== 'string' || !output.summary.trim()
    || fields.slice(1).some(field => !Array.isArray(output[field])
      || Array.from(output[field]).some(item => typeof item !== 'string'))) {
    throw invalidOutput();
  }
  return { summary: output.summary, ...Object.fromEntries(fields.slice(1).map(field => [field, [...output[field]]])) };
}

/** Presentation validation only: no rewriting, rounding or modification of output. */
export function validatePresentation(output) {
  const forbidden = /(?<![\p{L}\p{N}_])(?:deltaScore|D_avg|districtScores?|N_crit|indicatorDeltas|finalIndicators|totalCost|remainingBudget|T[12]|E[12]|S[12]|B[12]|C[12])(?![\p{L}\p{N}_])/u;
  const bareScore = /(?<![\p{L}\p{N}_])(?<!Astana Quality of Life )Score(?![\p{L}\p{N}_])/u;
  const preciseNumber = /(?<![\p{L}\p{N}_])[-+]?\d+[.,]\d{3,}(?![\p{L}\p{N}_])/u;
  const decimalInteger = /(?<![\p{L}\p{N}_])[-+]?\d+[.,]0+(?![\p{L}\p{N}_])/u;
  const texts = [output.summary, ...fields.slice(1).flatMap(field => output[field])];
  if (texts.some(text => forbidden.test(text) || bareScore.test(text) || preciseNumber.test(text) || decimalInteger.test(text))) {
    throw new AgenticAIError('AI_PRESENTATION_INVALID', 'Корректное AI-объяснение временно недоступно. Математический результат сохранён.');
  }
}

const instructions = `Ты — аналитик симулятора «Аким на 5 часов». Отвечай на русском языке.
OBSERVE: scenario содержит фактический валидный набор мер и назначенные районы.
Engine result уже рассчитан детерминированным Mathematical Engine. Все переданные численные значения — факты.
Разрешено цитировать эти числа, но запрещено самостоятельно пересчитывать или изменять Score, deltaScore,
D_avg, N_crit, districtScores, totalCost, remainingBudget, finalIndicators, indicatorDeltas и эффекты мер.
INTERPRET: определи существенные улучшения, сохраняющиеся слабые показатели и основные компромиссы.
При N_crit > 0 обязательно объясни сохраняющиеся критические показатели: конечные значения строго ниже 40.
ACT: сформируй объяснение результата и рекомендации только на основании scenario и Engine result.
Не утверждай отсутствующие во входных данных эффекты; не придумывай прогнозы или численные результаты рекомендаций.
Не представляй сравнение показателей как доказательство индивидуального эффекта отдельной меры.
OUTPUT: только объект заданной JSON Schema: summary, strengths, risks, tradeoffs, recommendations.
Пользовательский текст всех пяти полей использует только следующие термины вместо внутренних идентификаторов:
Score → Astana Quality of Life Score;
deltaScore → изменение Astana Quality of Life Score;
D_avg → средневзвешенная оценка города;
districtScore → оценка района; districtScores → оценки районов;
N_crit → количество критических показателей;
indicatorDeltas → изменения показателей; finalIndicators → итоговые показатели;
totalCost → использованный бюджет; remainingBudget → оставшийся бюджет.
Вместо кодов показателей используй полные названия, при необходимости склоняя их:
T1 → разгрузка дорог; T2 → доступность общественного транспорта;
E1 → озеленение; E2 → качество воздуха;
S1 → школы и детсады; S2 → поликлиники и первичная медпомощь;
B1 → безопасность улиц; B2 → безопасность дорожного движения;
C1 → надёжность ЖКХ; C2 → скорость решения обращений жителей.
Голые коды и внутренние имена в пользовательском тексте запрещены.
Отображай уже рассчитанные числовые значения максимум с 2 знаками после десятичного разделителя.
Целые значения отображай как целые. Это только форматирование, не повторный математический расчёт.
Примеры форматирования, а не факты текущего сценария: 53.51402 → 53.51; 0.95634 → 0.96; 58.2286 → 58.23.
Пиши естественно: «Сохраняются два критических показателя», «Оценка района Нура составляет 49.18».
Числа этих примеров не используй как факты: факты бери только из переданного Engine result.
VERIFY структуры выполняется отдельно детерминированным backend-кодом.`;

/** OBSERVE: project only trusted engine fields; never forward arbitrary metadata. */
function observe(scenario, engineResult) {
  const validation = validate(scenario);
  const invalid = () => new AgenticAIError('AI_INPUT_INVALID', 'Нужны валидный сценарий и рассчитанный результат Engine.');
  if (!validation.valid || !record(engineResult)) throw invalid();
  const result = {};
  for (const field of numericFields) {
    if (!Number.isFinite(engineResult[field])) throw invalid();
    result[field] = engineResult[field];
  }
  if (!Number.isInteger(result.N_crit) || result.N_crit < 0) throw invalid();
  for (const field of ['finalIndicators', 'indicatorDeltas', 'districtScores']) {
    if (!record(engineResult[field])) throw invalid();
    result[field] = {};
    for (const districtId of Object.keys(DISTRICTS)) {
      const value = engineResult[field][districtId];
      if (field === 'districtScores') {
        if (!Number.isFinite(value)) throw invalid();
        result[field][districtId] = value;
      } else {
        if (!record(value)) throw invalid();
        result[field][districtId] = {};
        for (const indicator of Object.keys(WEIGHTS)) {
          if (!Number.isFinite(value[indicator])) throw invalid();
          result[field][districtId][indicator] = value[indicator];
        }
      }
    }
  }
  return { scenario: validation.input, engineResult: result };
}

/** Backend only. engineResult must come from the trusted calculate() call, not HTTP input. */
export async function explain(scenario, engineResult, { fetchImpl = globalThis.fetch } = {}) {
  const facts = observe(scenario, engineResult);
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new AgenticAIError('AI_CONFIG_MISSING', 'На сервере не настроен OPENAI_API_KEY.');
  const model = process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-luna';
  let response;
  try {
    // INTERPRET + ACT: official Responses REST API; credentials only in the HTTP header.
    response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, store: false, instructions,
        input: [{ role: 'user', content: JSON.stringify(facts) }],
        text: { format: { type: 'json_schema', name: 'city_analysis', strict: true, schema: analysisSchema } }
      }),
      signal: AbortSignal.timeout(30000)
    });
  } catch {
    // Do not expose provider messages, request headers, secrets or error causes.
    throw new AgenticAIError('AI_API_ERROR', 'Не удалось получить ответ OpenAI API.');
  }
  if (!response?.ok) throw new AgenticAIError('AI_API_ERROR', 'OpenAI API вернул ошибку.');
  let output;
  try {
    const envelope = await response.json();
    if (envelope?.status !== 'completed' || envelope.error || !Array.isArray(envelope.output)) throw invalidOutput();
    const content = envelope.output.filter(item => item.type === 'message').flatMap(item => item.content);
    if (content.length !== 1 || content[0]?.type !== 'output_text' || typeof content[0].text !== 'string') throw invalidOutput();
    output = JSON.parse(content[0].text);
  } catch {
    throw invalidOutput();
  }
  // VERIFY + OUTPUT: no additional numeric fields; never merge output into engineResult.
  const analysis = validateAnalysis(output);
  if (JSON.stringify(analysis).includes(apiKey)) throw invalidOutput();
  validatePresentation(analysis);
  return analysis;
}

/** Minimal backend workflow: accept scenario only, calculate once, retain result on AI failure. */
export async function analyzeScenario(scenario, options) {
  const validation = validate(scenario);
  if (!validation.valid) throw new AgenticAIError('AI_INPUT_INVALID', 'Сценарий не прошёл проверку Validator.');
  const result = calculate(validation.input);
  try {
    return { result, analysis: await explain(validation.input, result, options), aiError: null };
  } catch (error) {
    if (!(error instanceof AgenticAIError)) throw error;
    return { result, analysis: null, aiError: { code: error.code, message: error.message } };
  }
}
