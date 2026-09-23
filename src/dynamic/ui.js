import { format } from '../result/index.js';
import { EVENTS, INDICATOR_NAMES } from './catalog.js';

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

/** A separate branch shown only after a successful backend base calculation. */
export function mountDynamic(container, scenarioId, districts, onReview) {
  if (!scenarioId) return;
  const section = node('section', 'dynamic-panel');
  section.id = 'dynamic-scenario';
  section.dataset.state = 'initial';
  section.append(node('p', 'eyebrow', '04 / УСТОЙЧИВОСТЬ СТРАТЕГИИ'), node('h2', '', 'Неожиданное городское событие'));
  section.append(node('p', '', 'Проверьте устойчивость выбранной стратегии к неожиданному городскому событию.'));
  section.append(node('span', 'pill', 'Демонстрационное событие'));
  const eventTitle = node('h3', 'event-title', EVENTS[0].name);
  section.append(eventTitle);
  const effect = node('p', 'event-effect', EVENTS[0].description);
  section.append(effect);
  section.append(node('p', 'muted', 'Эффекты заданы для демонстрации и не входят в исходные данные организаторов. Каждый запуск показывает последствия для выбранных пяти мероприятий.'));
  const controls = node('div', 'event-controls');
  const eventLabel = node('label', '', 'Событие');
  const eventSelect = document.createElement('select');
  eventSelect.id = 'event-type';
  for (const event of EVENTS) eventSelect.append(new Option(event.label, event.id));
  eventLabel.append(eventSelect);
  controls.append(eventLabel);
  eventSelect.addEventListener('change', () => {
    const event = EVENTS.find(event => event.id === eventSelect.value);
    effect.textContent = event.description;
    eventTitle.textContent = event.name;
  });
  const label = node('label', '', 'Район');
  const select = document.createElement('select');
  select.id = 'event-district';
  select.append(new Option('Выберите район', ''));
  for (const district of districts) select.append(new Option(district, district));
  label.append(select);
  const button = node('button', 'primary', 'Смоделировать событие');
  button.id = 'event-trigger';
  button.disabled = true;
  controls.append(label, button);
  section.append(controls);
  const status = node('p', 'event-status', 'Сначала выберите район. Событие запускается только по нажатию кнопки.');
  status.id = 'event-status';
  status.setAttribute('role', 'status');
  const result = node('div', '');
  result.id = 'event-result';
  result.setAttribute('aria-live', 'polite');
  section.append(status, result);
  container.append(section);
  let busy = false;
  select.addEventListener('change', () => { button.disabled = busy || !select.value; });
  button.addEventListener('click', async () => {
    if (busy || !select.value) return;
    busy = true;
    button.disabled = true;
    select.disabled = true;
    eventSelect.disabled = true;
    section.dataset.state = 'processing';
    status.textContent = 'Моделируем событие и анализируем последствия…';
    try {
      const response = await fetch('/api/event', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarioId, eventType: eventSelect.value, district: select.value })
      });
      const payload = await response.json();
      if (!response.ok) {
        section.dataset.state = 'validation-error';
        status.textContent = payload.error?.message || 'Событие не применено.';
        return;
      }
      renderEvent(result, payload);
      if (onReview && response.headers.get('X-Event-Id')) {
        const review = node('button', 'primary', 'Пересмотреть стратегию');
        review.id = 'review-strategy';
        const context = { eventId: response.headers.get('X-Event-Id'), eventName: payload.event.eventName, district: payload.event.district };
        review.addEventListener('click', () => onReview(context));
        result.append(review);
      }
      section.dataset.state = payload.aiError ? 'ai-error' : 'success';
      status.textContent = 'Последствия события рассчитаны. Сравните их с результатом ваших решений до события.';
    } catch {
      section.dataset.state = 'validation-error';
      status.textContent = 'Не удалось получить результат события. Проверьте соединение.';
    } finally {
      busy = false;
      select.disabled = false;
      eventSelect.disabled = false;
      button.disabled = !select.value;
    }
  });
}

function renderEvent(container, { event, aiAnalysis, aiError }) {
  container.replaceChildren();
  container.append(node('p', 'event-sequence', 'Результат пяти мероприятий → ' + event.eventName + ' → состояние после события'));
  container.append(node('h3', '', 'Затронутый район: ' + event.district));
  const comparison = node('div', 'event-comparison');
  for (const [side, title] of [['before', 'До события'], ['after', 'После события']]) {
    const card = node('section', 'event-state');
    card.append(node('h3', '', title));
    for (const [label, metric, id, digits] of [
      ['Astana Quality of Life Score', event['Score_' + side], 'event-score-' + side, 2],
      ...event.affectedIndicators.map(indicator => [INDICATOR_NAMES[indicator], event[side === 'before' ? 'indicatorsBefore' : 'indicatorsAfter'][indicator], 'event-' + indicator.toLowerCase() + '-' + side, 2]),
      ['Количество критических показателей', event['N_crit_' + side], 'event-critical-' + side, 0]
    ]) {
      const row = node('div', 'event-metric');
      const value = node('strong', '', format(metric, digits));
      value.id = id;
      row.append(node('span', '', label), value);
      card.append(row);
    }
    comparison.append(card);
  }
  container.append(comparison, node('h3', '', 'Влияние события'));
  const delta = node('p', 'event-delta', 'Изменение Astana Quality of Life Score: ' + (event.deltaScore_event > 0 ? '+' : '') + format(event.deltaScore_event));
  delta.id = 'event-delta';
  container.append(delta);
  const ai = node('section', 'ai-panel');
  ai.id = 'event-analysis';
  ai.append(node('h2', '', 'AI-анализ события'));
  if (!aiAnalysis) ai.append(node('p', 'ai-unavailable', aiError));
  else {
    ai.append(node('p', 'ai-summary', aiAnalysis.summary));
    const sections = node('div', 'ai-sections');
    for (const [key, label] of Object.entries({ strengths: 'Сильные стороны', risks: 'Риски', tradeoffs: 'Компромиссы', recommendations: 'Рекомендации' })) {
      const item = node('section', '');
      item.append(node('h3', '', label));
      const list = node('ul', '');
      for (const text of aiAnalysis[key]) list.append(node('li', '', text));
      if (!aiAnalysis[key].length) list.append(node('li', 'muted', 'Не отмечены в анализе.'));
      item.append(list);
      sections.append(item);
    }
    ai.append(sections);
  }
  container.append(ai, node('p', 'event-conclusion', 'Событие изменило состояние города. Для повышения устойчивости стратегии можно пересмотреть распределение бюджета и набор мероприятий.'));
}
