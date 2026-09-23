/** Presentation only: displays engine numbers without recalculating them. */
export function renderResult(container, result = null, explanation = null) {
  container.replaceChildren();
  const add = (tag, text) => {
    const element = document.createElement(tag);
    element.textContent = text;
    container.append(element);
  };
  add('h2', 'Результат для города');
  if (!result) {
    add('p', 'После анализа здесь появятся Score, его изменение, визуализация показателей и объяснение AI.');
    return;
  }
  add('p', `Score: ${result.score.value} · Изменение: ${result.score.delta}`);
  add('h3', 'Изменения по районам');
  for (const district of result.districts) {
    add('p', district.districtId);
    for (const indicator of district.indicators) {
      add('p', `${indicator.id}: ${indicator.baseline} → ${indicator.value} (${indicator.delta})`);
    }
  }
  add('h3', 'AI-анализ');
  if (!explanation) {
    add('p', 'Объяснение пока недоступно.');
    return;
  }
  for (const [key, label] of Object.entries({ strengths: 'Сильные стороны', risks: 'Риски', tradeoffs: 'Компромиссы', recommendations: 'Рекомендации' })) {
    add('h4', label);
    for (const item of explanation[key]) add('p', item);
  }
}
