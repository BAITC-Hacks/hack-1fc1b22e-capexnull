// Synthetic demonstration effects, not organizer dataset parameters. Order is fixed.
export const EVENTS = Object.freeze([
  { id: 'road-closure', name: 'Перекрытие крупной магистрали', label: 'Перекрытие крупной магистрали', direction: 'transport', effects: { T1: -20 }, description: 'Разгрузка дорог выбранного района −20' },
  { id: 'air-pollution', name: 'Эпизод сильного загрязнения воздуха', label: 'Сильное загрязнение воздуха', direction: 'ecology', effects: { E2: -20 }, description: 'Качество воздуха выбранного района −20' },
  { id: 'social-overload', name: 'Резкий рост нагрузки на социальную инфраструктуру', label: 'Рост нагрузки на социальную инфраструктуру', direction: 'social', effects: { S2: -10, S1: -10 }, description: 'Школы и детсады −10; поликлиники и первичная медпомощь −10' },
  { id: 'road-safety-decline', name: 'Ухудшение дорожной безопасности', label: 'Ухудшение дорожной безопасности', direction: 'safety', effects: { B2: -20 }, description: 'Безопасность дорожного движения −20' },
  { id: 'heating-network-failure', name: 'Авария теплосети в зимний период', label: 'Авария теплосети', direction: 'services', effects: { C1: -20 }, description: 'Надёжность ЖКХ −20' }
].map(event => Object.freeze({ ...event, effects: Object.freeze(event.effects) })));

export const INDICATOR_NAMES = Object.freeze({
  T1: 'Разгрузка дорог', T2: 'Доступность общественного транспорта', E1: 'Озеленение', E2: 'Качество воздуха',
  S1: 'Школы и детсады', S2: 'Поликлиники и первичная медпомощь', B1: 'Безопасность улиц',
  B2: 'Безопасность дорожного движения', C1: 'Надёжность ЖКХ', C2: 'Скорость решения обращений жителей'
});
