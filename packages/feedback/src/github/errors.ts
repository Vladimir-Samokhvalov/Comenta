/** Errors of the GitHub integration: `TrackerError`s with GitHub's messages. */
import { TrackerError, waitMessage, type TrackerErrorCode, type TrackerErrorExtra } from '../tracker/errors';

export type GitHubErrorCode = TrackerErrorCode;

/** A `TrackerError` with `provider: 'github'`. */
export class GitHubError extends TrackerError {
  constructor(code: GitHubErrorCode, message: string, extra: TrackerErrorExtra = {}) {
    super('github', code, message, extra);
    this.name = 'GitHubError';
  }
}

export const MESSAGES = {
  unauthorized: 'Доступ к GitHub истёк или был отозван. Войдите через GitHub заново.',
  forbidden: 'У токена нет нужных прав в GitHub.',
  issuesDisabled: 'В этом репозитории выключены issues. Включите их в настройках репозитория.',
  notFound: 'Не найдено в GitHub (или нет доступа).',
  network: 'GitHub не отвечает. Попробуйте ещё раз чуть позже.',
  notConfigured: 'Интеграция с GitHub не настроена.',
  uninstalled: 'Приложение Comenta удалено из GitHub или у него больше нет доступа к репозиторию. Установите его снова в настройках.',
  validation: 'GitHub отклонил запрос.',
} as const;

export function rateLimitMessage(resetAt?: number, now = Date.now()): string {
  return waitMessage('GitHub', resetAt, now);
}
