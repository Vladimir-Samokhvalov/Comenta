import type { FeedbackAttachment, FeedbackPayload } from '../types';

const KIND_EMOJI = { question: '🤔', suggestion: '🚀', bug: '😢' } as const;
const KIND_NAME = { question: 'Вопрос', suggestion: 'Предложение', bug: 'Ошибка' } as const;

/** Hidden marker in the issue body: how a retry finds the issue it already created. */
export const marker = (commentId: string) => `<!-- comenta:id=${commentId} -->`;

/** `0:42`, `1:00` */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Caption for a recording link: `🎙 Голос, 0:42` / `🎥 Экран, 0:58`. */
export function attachmentCaption(a: Pick<FeedbackAttachment, 'kind' | 'mimeType' | 'durationMs' | 'name'>): string {
  if (a.mimeType.startsWith('image/')) return `🖼 ${a.name}`;
  const d = a.durationMs ? `, ${formatDuration(a.durationMs)}` : '';
  return a.kind === 'audio' ? `🎙 Голос${d}` : `🎥 Экран${d}`;
}

/** Guests write the text: keep @mentions and #refs from pinging people, and markers from being forged. */
export function neutralize(text: string): string {
  return text
    .replace(/<!--/g, '&lt;!--')
    .replace(/(^|[^\w`])@(?=[\w-])/g, '$1@​')
    .replace(/(^|\s)#(?=\d)/g, '$1#​');
}

const cell = (s: string) => neutralize(s).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
const code = (s: string) => {
  const t = s.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');
  const fence = t.includes('`') ? '``' : '`';
  return `${fence}${fence.length > 1 ? ' ' : ''}${t}${fence.length > 1 ? ' ' : ''}${fence}`;
};

/** Title from the first words of the comment (≤ `max` chars, cut on a word), with the category emoji. */
export function issueTitle(p: FeedbackPayload, max = 72): string {
  const prefix = p.kind ? `${KIND_EMOJI[p.kind]} ` : '';
  const text = p.text.replace(/\s+/g, ' ').trim();
  if (!text) {
    const a = p.attachments?.[0];
    const what = a ? (a.kind === 'audio' ? 'Голосовой комментарий' : 'Запись экрана') : 'Комментарий';
    return `${prefix}${what}: ${p.page.title || p.target.tag}`.slice(0, max + prefix.length);
  }
  if (text.length <= max) return prefix + text;
  const cut = text.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return `${prefix}${(space > max * 0.5 ? cut.slice(0, space) : text.slice(0, max)).replace(/[\s.,;:!?—-]+$/, '')}…`;
}

export interface UploadedAttachment {
  attachment: FeedbackAttachment;
  /** Page on GitHub that plays / shows the file. */
  htmlUrl: string;
  /** Raw file URL (used for inline images). */
  rawUrl?: string;
}

/** Issue body: the comment, recordings, where on the page it was left, and the hidden id marker. */
export function issueBody(p: FeedbackPayload, uploads: UploadedAttachment[] = [], opts: { threadUrl?: string } = {}): string {
  const lines: string[] = [];
  const text = p.text.trim();
  if (text) lines.push(neutralize(text), '');

  const notUploaded = (p.attachments ?? []).filter((a) => !uploads.some((u) => u.attachment.id === a.id));
  if (uploads.length || notUploaded.length) {
    for (const u of uploads) {
      const a = u.attachment;
      if (a.mimeType.startsWith('image/')) lines.push(`![${cell(a.name)}](${u.rawUrl ?? `${u.htmlUrl}?raw=true`})`);
      else lines.push(`- [${attachmentCaption(a)}](${u.htmlUrl})`);
    }
    for (const a of notUploaded) lines.push(`- ${attachmentCaption(a)} (файл не загружен)`);
    lines.push('');
  }

  const rows: Array<[string, string]> = [];
  if (p.kind) rows.push(['Категория', `${KIND_EMOJI[p.kind]} ${KIND_NAME[p.kind]}`]);
  rows.push(['Страница', `[${cell(p.page.title || p.page.url)}](${p.page.url.replace(/[()\s]/g, encodeURIComponent)})`]);
  rows.push(['Элемент', code(p.target.selector)]);
  if (p.target.textSnippet) rows.push(['Текст элемента', cell(p.target.textSnippet)]);
  rows.push(['Автор', cell(p.author?.name || 'Гость')]);
  rows.push(['Экран', `${p.page.viewport.w}×${p.page.viewport.h}`]);
  if (p.page.userAgent) rows.push(['Браузер', code(p.page.userAgent)]);
  rows.push(['Создано', p.createdAt]);
  lines.push('| | |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`), '');

  const thread = opts.threadUrl ?? `${p.page.url.split('#')[0]}#comenta=${encodeURIComponent(p.id)}`;
  lines.push(`<sub>Оставлено через Comenta · [открыть комментарий на странице](${thread.replace(/[()\s]/g, encodeURIComponent)})</sub>`);
  lines.push(marker(p.id));
  return lines.join('\n');
}
