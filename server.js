import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { explain, explainEvent, AgenticAIError } from './src/ai/backend.js';
import { createDynamicBranch, EventValidationError } from './src/dynamic/engine.js';
import { validate } from './src/validator/index.js';
import { calculate, calculateBaseline } from './src/engine/index.js';
import { previewBudget } from './src/engine/preview.js';
import { MEASURES, DISTRICTS, RULES } from './src/engine/data.js';

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/src/ui/app.js', ['src/ui/app.js', 'text/javascript']],
  ['/src/ui/styles.css', ['src/ui/styles.css', 'text/css']],
  ['/src/scenario/index.js', ['src/scenario/index.js', 'text/javascript']],
  ['/src/validator/index.js', ['src/validator/index.js', 'text/javascript']],
  ['/src/engine/index.js', ['src/engine/index.js', 'text/javascript']],
  ['/src/engine/data.js', ['src/engine/data.js', 'text/javascript']],
  ['/src/ai/index.js', ['src/ai/index.js', 'text/javascript']],
  ['/src/result/index.js', ['src/result/index.js', 'text/javascript']],
  ['/src/dynamic/ui.js', ['src/dynamic/ui.js', 'text/javascript']],
  ['/src/dynamic/catalog.js', ['src/dynamic/catalog.js', 'text/javascript']]
]);

const port = Number(process.env.PORT || 3000);
const json = (response, status, data) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
};

/** One integration endpoint. Overrides are for local tests, never request parameters. */
export function createApplication({ validateInput = validate, calculateInput = calculate, explainResult = explain, explainEventResult = explainEvent } = {}) {
  const branches = new Map();
  let scenarioNumber = 0;
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/event' && request.method === 'POST') {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 16384) { json(response, 413, { error: { message: 'Слишком большой запрос события.' } }); return; }
          chunks.push(chunk);
        }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const branch = branches.get(input?.scenarioId);
        if (!branch) { json(response, 409, { error: { message: 'Сначала выполните успешный базовый расчёт.' } }); return; }
        // Explicit request is the only trigger; branch applies only a validated candidate.
        const event = branch.apply(input.eventType, input.district);
        let aiAnalysis = null;
        let aiError = null;
        try { aiAnalysis = await explainEventResult(event); }
        catch { aiError = 'AI-анализ события временно недоступен. Результат события сохранён.'; }
        json(response, 200, { event, aiAnalysis, aiError });
      } catch (error) {
        const invalid = error instanceof EventValidationError || error instanceof SyntaxError;
        json(response, invalid ? 422 : 500, { error: { message: error instanceof EventValidationError ? error.message : invalid ? 'Некорректный запрос события.' : 'Не удалось смоделировать событие.' } });
      }
      return;
    }
    if (url.pathname === '/api/scenario') {
      try {
        if (request.method === 'GET') {
          const ids = url.searchParams.getAll('measure');
          json(response, 200, {
            baseline: calculateBaseline(), measures: MEASURES, districts: Object.keys(DISTRICTS),
            budget: RULES.budget, ...previewBudget(ids)
          });
          return;
        }
        if (request.method !== 'POST') {
          json(response, 405, { error: { message: 'Используйте GET или POST.' } });
          return;
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 16384) {
            json(response, 413, { error: { message: 'Слишком большой сценарий.' } });
            return;
          }
          chunks.push(chunk);
        }
        const scenario = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const validation = validateInput(scenario);
        if (!validation.valid) {
          json(response, 422, { error: { code: validation.code, message: validation.errors[0] } });
          return;
        }
        const calculation = calculateInput(validation.input);
        const scenarioId = String(++scenarioNumber);
        branches.set(scenarioId, createDynamicBranch(calculation));
        response.setHeader('X-Scenario-Id', scenarioId);
        let aiAnalysis = null;
        let aiError = null;
        try {
          aiAnalysis = await explainResult(validation.input, calculation);
        } catch (error) {
          aiError = error instanceof AgenticAIError
            ? 'AI-анализ временно недоступен. Математический результат сохранён.'
            : 'Не удалось получить AI-анализ. Математический результат сохранён.';
        }
        json(response, 200, { calculation, aiAnalysis, aiError });
      } catch (error) {
        const badInput = error instanceof SyntaxError || error instanceof TypeError;
        json(response, badInput ? 400 : 500, { error: {
          message: badInput ? 'Не удалось прочитать сценарий. Проверьте выбранные мероприятия.' : 'Не удалось выполнить расчёт. Попробуйте ещё раз.'
        } });
      }
      return;
    }
    const asset = assets.get(url.pathname);
    if (!asset || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404).end('Not found');
      return;
    }
    try {
      const content = await readFile(new URL(asset[0], import.meta.url));
      response.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch {
      response.writeHead(500).end('Unable to load application');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApplication().listen(port, '127.0.0.1', () => {
    console.log(`Аким на 5 часов: http://127.0.0.1:${port}`);
  });
}

