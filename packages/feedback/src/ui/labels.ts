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
  kindEmoji: { question: '🤔', suggestion: '🚀', bug: '😢' },
  kindGroup: 'Категория (необязательно)',
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
  panelTitle: 'Комментарии',
  tabPage: 'Эта страница',
  tabAll: 'Все страницы',
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
  statusOpen: 'Открыт',
  statusResolved: 'Закрыт',
  resolve: 'Закрыть',
  reopen: 'Открыть снова',
  reply: 'Ответить',
  replyPlaceholder: 'Ответить…',
  replyAndResolve: 'Ответить и закрыть',
  replyTextarea: 'Текст ответа',
  thread: 'Тред комментария',
  edited: 'изменено',
  edit: 'Изменить',
  save: 'Сохранить',
  deleteReply: 'Удалить',
  deleteConfirm: 'Удалить ответ?',
  replyError: 'Не удалось сохранить',
  resolvedBy: (name) => `${name} закрыл(а)`,
  resolvedByYou: 'Вы закрыли',
  guest: 'Гость',
  yourName: 'Ваше имя',
  filterOpen: 'Открытые',
  filterResolved: 'Закрытые',
  filterAll: 'Все',
  showResolved: 'Показать закрытые',
  hideResolved: 'Скрыть закрытые',
  unread: (n) => `${n} ${plural(n, 'тред', 'треда', 'тредов')} с новыми ответами`,
  replies: (n) => `${n} ${plural(n, 'ответ', 'ответа', 'ответов')}`,
  issueLink: (i) => `${DEFAULT_LABELS.providerName(i.provider)} #${i.number}`,
  issueState: (i) => (i.state === 'closed' ? 'закрыт' : 'открыт'),
  issueStateLong: (i) => {
    if (i.state !== 'closed') return 'открыт';
    const why: Record<string, string> = { completed: 'выполнен', not_planned: 'не будет сделан', duplicate: 'дубликат' };
    const r = i.stateReason ? why[i.stateReason] : undefined;
    return r ? `закрыт · ${r}` : 'закрыт';
  },
  issueUnavailable: 'Issue недоступен',
  providerName: (p) => (p === 'github' ? 'GitHub' : p === 'gitlab' ? 'GitLab' : p),
  closedOnTracker: (provider, name, reason) => {
    const why: Record<string, string> = { not_planned: 'не будет сделан', duplicate: 'дубликат' };
    const r = reason && why[reason] ? ` · ${why[reason]}` : '';
    return `${name ? `${name} закрыл(а)` : 'Закрыт'} на ${DEFAULT_LABELS.providerName(provider)}${r}`;
  },
  fromTracker: (provider) => `из ${DEFAULT_LABELS.providerName(provider)}`,
  signInTitle: 'Войдите, чтобы комментировать',
  signInHint: 'Комментарии видны команде сайта под вашим именем.',
  signInWith: (provider) => `Войти через ${provider}`,
  signInFailed: 'Не удалось войти. Попробуйте ещё раз.',
  signInPopupBlocked: 'Браузер заблокировал окно входа. Разрешите всплывающие окна или нажмите ещё раз.',
  signOut: 'Выйти',
};
