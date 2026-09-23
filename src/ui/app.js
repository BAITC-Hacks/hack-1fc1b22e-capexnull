import { createInput } from '../scenario/index.js';
import { renderResult, format } from '../result/index.js';

export const states = Object.freeze(['INITIAL', 'READY', 'PROCESSING', 'VALIDATION_ERROR', 'SUCCESS', 'AI_ERROR']);
const labels = {
  M1: 'Районная мобильность', M2: 'Городской транспорт', M3: 'Транспортная инфраструктура',
  M4: 'Экология района', M5: 'Экологическая инфраструктура', M6: 'Городская экология',
  M7: 'Социальная инфраструктура', M8: 'Социальная доступность', M9: 'Поддержка сообщества',
  M10: 'Безопасность района', M11: 'Безопасная мобильность', M12: 'Цифровые услуги',
  M13: 'Районные сервисы', M14: 'Городские сервисы'
};
const directions = { transport: 'Транспорт', ecology: 'Экология', social: 'Социальная сфера', safety: 'Безопасность', services: 'Сервисы' };
const selected = new Map();
let config;
let busy = false;
let previewVersion = 0;
let state = 'INITIAL';
const $ = selector => document.querySelector(selector);
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function setState(next, message) {
  state = next;
  document.body.dataset.state = next;
  $('#status').textContent = message;
  $('#status').className = next === 'VALIDATION_ERROR' ? 'error-message' : '';
  $('#analyze').disabled = busy || selected.size !== 5 || !config;
  $('#analyze').textContent = busy ? 'Рассчитываем и анализируем…' : 'Рассчитать сценарий ↗';
  document.querySelector('main').setAttribute('aria-busy', String(busy));
}

function renderSelection() {
  $('#selected-count').textContent = `${selected.size} / 5`;
  $('#selected-label').textContent = `${selected.size} / 5`;
  const list = $('#selection-list');
  list.replaceChildren();
  if (!selected.size) list.append(element('p', 'empty-note', 'Добавьте мероприятия из каталога. Для районных мер укажите район.'));
  for (const [id, district] of selected) {
    const row = element('div', 'selection-row');
    row.append(element('span', 'measure-id', id), element('span', '', district || (config.measures[id].scope === 'city' ? 'Весь город' : 'Район не выбран')));
    list.append(row);
  }
  for (const card of document.querySelectorAll('.measure-card')) {
    const id = card.dataset.id;
    const active = selected.has(id);
    card.classList.toggle('selected', active);
    const checkbox = card.querySelector('input');
    checkbox.checked = active;
    checkbox.disabled = busy || (!active && selected.size === 5);
    const select = card.querySelector('select');
    if (select) { select.hidden = !active; select.disabled = busy; }
  }
}

async function refreshBudget() {
  const version = ++previewVersion;
  $('#used').textContent = '…';
  $('#remaining').textContent = '…';
  const query = new URLSearchParams();
  for (const id of selected.keys()) query.append('measure', id);
  try {
    const response = await fetch('/api/scenario?' + query);
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (version !== previewVersion) return;
    $('#used').textContent = format(data.totalCost, 0);
    $('#remaining').textContent = format(data.remainingBudget, 0);
    $('#remaining').classList.toggle('negative', data.remainingBudget < 0);
  } catch {
    if (version !== previewVersion) return;
    $('#used').textContent = '—';
    $('#remaining').textContent = '—';
    setState('VALIDATION_ERROR', 'Не удалось обновить бюджет. Проверьте соединение с сервером.');
  }
}

function changed(updateBudget = true) {
  $('#result').hidden = true;
  renderSelection();
  setState(selected.size === 5 ? 'READY' : 'INITIAL', selected.size === 5
    ? 'Набор готов к проверке. Убедитесь, что районы выбраны.'
    : 'Выберите ровно пять мероприятий для расчёта.');
  if (updateBudget) void refreshBudget();
}

function renderCatalog() {
  for (const [id, measure] of Object.entries(config.measures)) {
    const card = element('article', 'measure-card');
    card.dataset.id = id;
    card.dataset.direction = measure.direction;
    const top = element('div', 'measure-top');
    top.append(element('span', 'direction', directions[measure.direction]), element('span', 'cost', `${measure.cost} ед.`));
    const label = element('label', 'measure-label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'choose-' + id;
    checkbox.setAttribute('aria-label', `Выбрать ${id}: ${labels[id]}`);
    const title = element('span', '');
    title.append(element('span', 'measure-id', id), document.createTextNode(' ' + labels[id]));
    label.append(checkbox, title);
    const details = element('p', 'measure-details', `${measure.scope === 'city' ? 'Город' : 'Район'} · Лаг ${measure.lag} кв.`);
    const effects = element('p', 'effects');
    for (const [indicator, value] of Object.entries(measure.effects)) {
      effects.append(element('span', value < 0 ? 'effect negative' : 'effect', `${indicator} ${value > 0 ? '+' : ''}${value}`));
    }
    card.append(top, label, details, effects);
    if (measure.scope === 'district') {
      const select = document.createElement('select');
      select.id = 'district-' + id;
      select.setAttribute('aria-label', 'Район для ' + id);
      select.required = true;
      select.hidden = true;
      select.append(new Option('Выберите район *', ''));
      for (const district of config.districts) select.append(new Option(district, district));
      select.addEventListener('change', () => { selected.set(id, select.value); changed(false); });
      card.append(select);
    }
    checkbox.addEventListener('change', () => {
      if (busy) return;
      if (checkbox.checked && selected.size < 5) selected.set(id, card.querySelector('select')?.value || '');
      else selected.delete(id);
      changed();
    });
    $('#catalog').append(card);
  }
}

function renderCity() {
  for (const district of config.districts) {
    const card = element('article', 'city-card');
    card.append(element('h3', '', district), element('strong', '', format(config.baseline.districtScores[district])));
    const meter = document.createElement('meter');
    meter.min = 0; meter.max = 100; meter.value = config.baseline.districtScores[district];
    meter.setAttribute('aria-label', 'Исходная оценка: ' + district);
    card.append(meter);
    const indicators = config.baseline.finalIndicators[district];
    card.append(element('p', '', Object.entries(indicators).map(([key, value]) => `${key} ${value}`).join(' · ')));
    $('#city-overview').append(card);
  }
}

$('#analyze').addEventListener('click', async () => {
  if (busy || selected.size !== 5) return;
  const decisions = [...selected].map(([measureId, districtId]) => ({
    measureId, ...(config.measures[measureId].scope === 'district' ? { districtId } : {})
  }));
  busy = true;
  renderSelection();
  setState('PROCESSING', 'Сначала рассчитываем показатели, затем получаем объяснение AI.');
  try {
    const response = await fetch('/api/scenario', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(createInput(decisions))
    });
    const payload = await response.json();
    if (!response.ok) {
      setState('VALIDATION_ERROR', payload.error?.message || 'Не удалось проверить сценарий.');
      return;
    }
    $('#used').textContent = format(payload.calculation.totalCost, 0);
    $('#remaining').textContent = format(payload.calculation.remainingBudget, 0);
    renderResult($('#result'), payload.calculation, payload.aiAnalysis, config.baseline, payload.aiError);
    setState(payload.aiError ? 'AI_ERROR' : 'SUCCESS', payload.aiError
      ? 'Расчёт готов. AI-анализ временно недоступен.'
      : 'Сценарий рассчитан. Результат и рекомендации доступны ниже.');
    $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch {
    setState('VALIDATION_ERROR', 'Сервер недоступен. Проверьте соединение и повторите расчёт.');
  } finally {
    busy = false;
    renderSelection();
    setState(state, $('#status').textContent);
  }
});

try {
  const response = await fetch('/api/scenario');
  if (!response.ok) throw new Error();
  config = await response.json();
  $('#baseline').textContent = format(config.baseline.Score);
  $('#budget').textContent = format(config.budget, 0);
  $('#used').textContent = format(config.totalCost, 0);
  $('#remaining').textContent = format(config.remainingBudget, 0);
  renderCity();
  renderCatalog();
  changed(false);
} catch {
  setState('VALIDATION_ERROR', 'Не удалось загрузить данные города. Обновите страницу после запуска сервера.');
}

