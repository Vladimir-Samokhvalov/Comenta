/** Errors of the GitLab integration: `TrackerError`s with GitLab's messages. */
import { TrackerError, waitMessage, type TrackerErrorCode, type TrackerErrorExtra } from '../tracker/errors';

export type GitLabErrorCode = TrackerErrorCode;

/** A `TrackerError` with `provider: 'gitlab'`. */
export class GitLabError extends TrackerError {
  constructor(code: GitLabErrorCode, message: string, extra: TrackerErrorExtra = {}) {
    super('gitlab', code, message, extra);
    this.name = 'GitLabError';
  }
}

export const GL_MESSAGES = {
  unauthorized: 'Доступ к GitLab истёк или был отозван. Войдите через GitLab заново.',
  forbidden: 'Не хватает прав в GitLab: нужна роль Reporter или выше в проекте.',
  scopes: (s: string[]) => `У доступа к GitLab нет прав: ${s.join(', ')}. Выйдите и войдите через GitLab снова, чтобы выдать их.`,
  issuesDisabled: 'В этом проекте выключены issues. Включите их в настройках проекта GitLab (Settings → General → Visibility).',
  notFound: 'Не найдено в GitLab (или нет доступа).',
  network: 'GitLab не отвечает. Попробуйте ещё раз чуть позже.',
  notConfigured: 'Интеграция с GitLab не настроена.',
  validation: 'GitLab отклонил запрос.',
  tls: 'Сертификат сервера GitLab не прошёл проверку (самоподписанный, просрочен или выдан на другое имя). Если сертификат свой, добавьте корневой сертификат в NODE_EXTRA_CA_CERTS на сервере Comenta.',
  dns: 'Сервер GitLab не найден по этому адресу. Проверьте адрес.',
  refused: 'Сервер GitLab не принимает подключения по этому адресу. Проверьте адрес и порт.',
} as const;

export function rateLimitMessage(resetAt?: number, now = Date.now()): string {
  return waitMessage('GitLab', resetAt, now);
}

const TLS_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
]);

/** A failed `fetch` (no answer at all) as a GitLabError: TLS problems, unknown host, refused, timeout. */
export function connectionError(err: unknown): GitLabError {
  let code: string | undefined;
  for (let e: unknown = err, i = 0; e && i < 5; i++) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string') {
      code = c;
      break;
    }
    e = (e as { cause?: unknown }).cause;
  }
  if (code && (TLS_CODES.has(code) || /CERT|TLS|SSL/.test(code))) return new GitLabError('tls', GL_MESSAGES.tls);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new GitLabError('network', GL_MESSAGES.dns);
  if (code === 'ECONNREFUSED') return new GitLabError('network', GL_MESSAGES.refused);
  return new GitLabError('network', GL_MESSAGES.network);
}
