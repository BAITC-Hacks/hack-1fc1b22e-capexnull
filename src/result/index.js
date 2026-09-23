/** Rendering only: all numerical values come from the backend engine. */
export const format = (value, digits = 2) => Number(value).toFixed(digits);
const signed = value => (value > 0 ? '+' : '') + format(value);
const node = (tag, className, text) => {
  const item = document.createElement(tag);
  item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
};

export function renderResult(container, calculation, analysis, baseline, aiError) {
  container.replaceChildren();
  container.hidden = false;
  const heading = node('div', 'section-heading');
  const titles = node('div', '');
  titles.append(node('p', 'eyebrow', '03 / ПОСЛЕДСТВИЯ РЕШЕНИЙ'), node('h2', '', 'Ваш сценарий для Астаны'));
  heading.append(titles, node('span', 'pill', 'Горизонт: 8 кварталов'));
  container.append(heading);

  const scorePanel = node('section', 'score-panel');
  const mainScore = node('div', 'score-main');
  mainScore.append(node('p', '', 'Astana Quality of Life Score'));
  const number = node('strong', 'score-value', format(calculation.Score));
  number.id = 'result-score';
  mainScore.append(number, node('span', 'score-delta', signed(calculation.deltaScore) + ' к исходному'));
  mainScore.append(node('p', 'score-baseline', 'До ваших решений: ' + format(baseline.Score)));
  const stats = node('div', 'result-stats');
  for (const [label, value, id] of [
    ['Использовано', calculation.totalCost, 'result-cost'],
    ['Осталось', calculation.remainingBudget, 'result-remaining'],
    ['Критических показателей', calculation.N_crit, 'result-critical']
  ]) {
    const item = node('div', '');
    const strong = node('strong', '', format(value, 0));
    strong.id = id;
    item.append(strong, node('span', '', label));
    stats.append(item);
  }
  scorePanel.append(mainScore, stats);
  container.append(scorePanel);

  const visual = node('section', 'visual-panel');
  visual.append(node('h3', '', 'Как меняются районы'), node('p', 'muted', 'Оценка до ваших решений → оценка после их реализации.'));
  const bars = node('div', 'district-bars');
  for (const [district, value] of Object.entries(calculation.districtScores)) {
    const row = node('div', 'district-row');
    const label = node('div', 'district-label');
    label.append(node('strong', '', district), node('span', '', format(baseline.districtScores[district]) + ' → ' + format(value)));
    const track = node('div', 'bar-track');
    const before = node('span', 'bar-before');
    before.style.width = baseline.districtScores[district] + '%';
    const after = node('span', 'bar-after');
    after.style.width = value + '%';
    track.append(before, after);
    row.append(label, track);
    bars.append(row);
  }
  visual.append(bars, node('p', 'bar-legend', 'Светлая полоса — исходное состояние · Зелёная — ваш сценарий'));
  visual.append(node('h3', '', 'Изменения показателей'));
  const changes = node('div', 'indicator-changes');
  for (const [district, indicators] of Object.entries(calculation.indicatorDeltas)) {
    const group = node('div', 'indicator-group');
    group.append(node('h4', '', district));
    for (const [id, delta] of Object.entries(indicators)) {
      if (delta === 0) continue;
      group.append(node('span', delta < 0 ? 'change negative' : 'change', id + ' ' + signed(delta)));
    }
    if (group.children.length === 1) group.append(node('span', 'muted', 'Без изменений'));
    changes.append(group);
  }
  visual.append(changes);
  container.append(visual);

  const ai = node('section', 'ai-panel');
  ai.append(node('p', 'eyebrow', 'ВЗГЛЯД НА ПОСЛЕДСТВИЯ'), node('h2', '', 'AI-анализ'));
  ai.append(node('p', 'muted', 'Что означают результаты, какие риски сохраняются и на что обратить внимание.'));
  if (!analysis) {
    ai.append(node('p', 'ai-unavailable', aiError || 'AI-анализ временно недоступен. Математический результат сохранён.'));
  } else {
    ai.append(node('p', 'ai-summary', analysis.summary));
    const sections = node('div', 'ai-sections');
    for (const [key, title] of Object.entries({ strengths: 'Сильные стороны', risks: 'Риски', tradeoffs: 'Компромиссы', recommendations: 'Рекомендации' })) {
      const section = node('section', '');
      section.dataset.section = key;
      section.append(node('h3', '', title));
      const list = node('ul', '');
      for (const text of analysis[key]) list.append(node('li', '', text));
      if (!analysis[key].length) list.append(node('li', 'muted', 'Не отмечены в анализе.'));
      section.append(list);
      sections.append(section);
    }
    ai.append(sections);
  }
  container.append(ai);
}

