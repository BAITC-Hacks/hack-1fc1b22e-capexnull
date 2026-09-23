import { scenario, createInput } from '../scenario/index.js';
import { validate } from '../validator/index.js';
import { calculate } from '../engine/index.js';
import { explain } from '../ai/index.js';
import { renderResult } from '../result/index.js';

export const states = Object.freeze(['initial', 'processing', 'result', 'validation-error', 'disabled']);
const model = { state: 'initial', input: createInput(), result: null, explanation: null };
const button = document.querySelector('#analyze');
const resultContainer = document.querySelector('#result');

function setState(state, message = '') {
  model.state = state;
  document.body.dataset.state = state;
  button.disabled = state === 'disabled' || state === 'processing';
  document.querySelector('main').setAttribute('aria-busy', String(state === 'processing'));
  document.querySelector('#status').textContent = message;
}

/** Future confirmed-set workflow. Stubs block calculation until implemented. */
async function analyze() {
  setState('processing', 'Анализируем решения…');
  try {
    const validation = validate(model.input);
    if (!validation.valid) {
      setState('validation-error', validation.errors.join(' '));
      return;
    }
    model.result = calculate(validation.input);
    model.explanation = await explain(model.result);
    renderResult(resultContainer, model.result, model.explanation);
    setState('result', 'Анализ завершён.');
  } catch (error) {
    setState('disabled', error.message);
  }
}

document.querySelector('#budget').textContent = scenario.budget;
document.querySelector('#remaining').textContent = scenario.budget;
document.querySelector('#baseline').textContent = scenario.baselineScore;
renderResult(resultContainer);
button.addEventListener('click', analyze);
setState('disabled', 'Выбор мероприятий и анализ станут доступны на следующем этапе.');
