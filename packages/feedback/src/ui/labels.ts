import type { FeedbackLabels } from '../types';

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export const DEFAULT_LABELS: FeedbackLabels = {
  toggle: 'Комментировать',
  toggleActive: 'Выйти из режима комментариев',
  count: (n) => `${n} ${plural(n, 'комментарий', 'комментария', 'комментариев')} на странице`,
  kinds: { question: 'Вопрос', suggestion: 'Предложение', bug: 'Ошибка' },
  kindGroup: 'Тип комментария',
  textarea: 'Текст комментария',
  placeholder: 'Опишите вопрос, предложение или ошибку…',
  submit: 'Отправить',
  submitting: 'Отправка…',
  cancel: 'Отмена',
  close: 'Закрыть',
  sent: 'Отправлено',
  errorPrefix: 'Не удалось отправить',
  dialog: 'Комментарий к элементу',
  pin: (n) => `Комментарий ${n}`,
  locale: 'ru',
  menu: 'Меню комментариев',
  showAll: 'Показать все комментарии',
  hidePins: 'Скрыть пины',
  showPins: 'Показать пины',
  panelTitle: 'Мои комментарии',
  tabPage: 'Эта страница',
  tabAll: 'Все',
  empty: 'Комментариев пока нет',
  notFound: 'элемент не найден',
  recVoice: 'Голосовое сообщение',
  recScreen: 'Запись экрана с голосом',
  recHint: 'удерживайте, чтобы записать; нажмите, чтобы переключить',
  recStop: 'Остановить запись',
  recCancel: 'Отменить запись',
  recRedo: 'Перезаписать',
  recDelete: 'Удалить запись',
  recVoiceLabel: 'Голос',
  recScreenLabel: 'Экран',
  recNoMic: 'Нет доступа к микрофону — экран записывается без звука',
  recDenied: 'Нет доступа: разрешите микрофон или запись экрана в браузере',
  recFailed: 'Не удалось начать запись',
  recMissing: 'Запись не сохранилась',
  recLimit: 'Запись остановлена: достигнут лимит длительности',
};
