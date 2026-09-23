import { format } from '../result/index.js';
import { INDICATOR_NAMES } from '../dynamic/catalog.js';

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

export function renderComparison(container, { comparison, aiAnalysis, aiError }) {
  container.replaceChildren();
  container.hidden = false;
  container.append(node('h2', '', 'Сравнение альтернативных стратегий'),
    node('p', 'event-conclusion', comparison.eventName + ' · ' + comparison.district),
    node('p', 'event-conclusion', 'Два альтернативных распределения одного бюджета 100. Это сравнение планов при одинаковом событии, а не последовательная реализация мероприятий.'));
  const cards = node('div', 'event-comparison');
  for (const [key, title] of [['original', 'Первоначальная стратегия после события'], ['adapted', 'Адаптированная стратегия при том же событии']]) {
    const side = comparison[key];
    const card = node('section', 'event-state');
    card.append(node('h3', '', title));
    for (const [label, field, digits] of [
      ['Astana Quality of Life Score', 'Score', 2], ['Количество критических показателей', 'N_crit', 0],
      ['Использованный бюджет', 'totalCost', 0], ['Оставшийся бюджет', 'remainingBudget', 0]
    ]) {
      const row = node('div', 'event-metric');
      const value = node('strong', '', format(side[field], digits));
      value.id = `adaptation-${key}-${field}`;
      row.append(node('span', '', label), value);
      card.append(row);
    }
    card.append(node('p', 'event-conclusion', side.scenario.decisions.map(item =>
      item.measureId + ' — ' + (item.districtId || 'Весь город')).join('; ')));
    cards.append(card);
  }
  const delta = node('p', 'event-delta', 'Изменение Astana Quality of Life Score: ' +
    (comparison.deltaAdaptationScore > 0 ? '+' : '') + format(comparison.deltaAdaptationScore));
  delta.id = 'adaptation-delta';
  container.append(cards, delta, node('h3', '', 'Сравнение районов после события'));
  for (const [district, changes] of Object.entries(comparison.indicatorChanges)) {
    const row = node('section', 'event-state');
    row.append(node('h3', '', district), node('p', 'event-conclusion', 'Оценка района: ' +
      format(comparison.original.districtScores[district]) + ' → ' + format(comparison.adapted.districtScores[district])));
    const list = node('ul', '');
    list.style.fontSize = '22px';
    list.style.lineHeight = '1.6';
    for (const [id, change] of Object.entries(changes)) {
      if (change !== 0) list.append(node('li', '', INDICATOR_NAMES[id] + ': ' +
        format(comparison.original.finalIndicators[district][id]) + ' → ' +
        format(comparison.adapted.finalIndicators[district][id]) + ' (' + (change > 0 ? '+' : '') + format(change) + ')'));
    }
    if (!list.children.length) list.append(node('li', '', 'Показатели совпадают.'));
    row.append(list);
    container.append(row);
  }
  const ai = node('section', 'ai-panel');
  ai.id = 'adaptation-analysis';
  ai.append(node('h2', '', 'AI-анализ сравнения'));
  if (!aiAnalysis) ai.append(node('p', 'ai-unavailable', aiError));
  else {
    ai.append(node('p', 'ai-summary', aiAnalysis.summary));
    const sections = node('div', 'ai-sections');
    for (const [key, label] of Object.entries({ strengths: 'Сильные стороны', risks: 'Риски', tradeoffs: 'Компромиссы', recommendations: 'Рекомендации' })) {
      const section = node('section', '');
      const list = node('ul', '');
      for (const text of aiAnalysis[key]) list.append(node('li', '', text));
      if (!list.children.length) list.append(node('li', '', 'Не отмечены в анализе.'));
      section.append(node('h3', '', label), list);
      sections.append(section);
    }
    ai.append(sections);
  }
  container.append(ai);
}
