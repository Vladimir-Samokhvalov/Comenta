import type { FeedbackLabels, FeedbackPayload } from '../types';
import { checkIcon, closeIcon, eyeIcon, eyeOffIcon, h, listIcon } from './h';
import { displayName } from './thread';
import { formatDuration } from '../core/recorder';

export interface MenuHandlers {
  onShowAll: () => void;
  onTogglePins: () => void;
  onToggleResolved: () => void;
}

/** Dropdown opened by the chevron next to the toggle. */
export class Menu {
  readonly el: HTMLDivElement;

  constructor(
    private readonly doc: Document,
    parent: HTMLElement,
    private readonly labels: FeedbackLabels,
    private readonly handlers: MenuHandlers,
  ) {
    this.el = h(doc, 'div', { class: 'ph-menu', role: 'menu', 'aria-label': labels.menu, hidden: true });
    this.el.addEventListener('keydown', this.onKeyDown);
    parent.append(this.el);
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open(count: number, pinsHidden: boolean, showResolved: boolean, resolvedCount: number) {
    const d = this.doc;
    const item = (icon: SVGSVGElement, text: string, onClick: () => void, extra?: string, cls = '') => {
      const b = h(d, 'button', { type: 'button', role: 'menuitem', class: `ph-mi ${cls}`, tabindex: -1 }, [
        icon,
        h(d, 'span', { class: 'ph-mi-text' }, [text]),
        extra !== undefined ? h(d, 'span', { class: 'ph-mi-extra' }, [extra]) : null,
      ]);
      b.addEventListener('click', onClick);
      return b;
    };
    this.el.replaceChildren(
      item(listIcon(d), this.labels.showAll, this.handlers.onShowAll, String(count), 'ph-mi-all'),
      item(pinsHidden ? eyeIcon(d) : eyeOffIcon(d), pinsHidden ? this.labels.showPins : this.labels.hidePins, this.handlers.onTogglePins, undefined, 'ph-mi-pins'),
      item(checkIcon(d), showResolved ? this.labels.hideResolved : this.labels.showResolved, this.handlers.onToggleResolved, String(resolvedCount), 'ph-mi-resolved'),
    );
    this.el.hidden = false;
    this.items()[0]?.focus({ preventScroll: true });
  }

  close() {
    this.el.hidden = true;
    this.el.replaceChildren();
  }

  private items() {
    return Array.from(this.el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const items = this.items();
    const active = (this.el.getRootNode() as ShadowRoot).activeElement as HTMLButtonElement | null;
    const i = active ? items.indexOf(active) : -1;
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'Tab') e.preventDefault();
    if (next >= 0) {
      e.preventDefault();
      items[next].focus();
    }
  };
}

export interface PanelItem {
  payload: FeedbackPayload;
  /** Pin number on the current page; null for other pages. */
  n: number | null;
  /** On the current page but the element is not in the DOM right now. */
  missing: boolean;
  /** Someone else wrote in the thread since the user last opened it. */
  unread: boolean;
}

export type PanelFilter = 'open' | 'resolved' | 'all';

export interface PanelHandlers {
  onTab: (tab: 'page' | 'all') => void;
  onFilter: (filter: PanelFilter) => void;
  onPick: (item: PanelItem) => void;
  onClose: () => void;
}

/** "My comments" list. */
export class Panel {
  readonly el: HTMLDivElement;
  tab: 'page' | 'all' = 'page';
  filter: PanelFilter = 'open';
  private readonly list: HTMLDivElement;
  private readonly tabs: Record<'page' | 'all', HTMLButtonElement>;
  private readonly filters: Record<PanelFilter, HTMLButtonElement>;

  constructor(
    private readonly doc: Document,
    parent: HTMLElement,
    private readonly labels: FeedbackLabels,
    private readonly handlers: PanelHandlers,
  ) {
    const d = doc;
    const tab = (key: 'page' | 'all', text: string) => {
      const b = h(d, 'button', { type: 'button', role: 'tab', class: 'ph-tab', 'data-tab': key }, [text]);
      b.addEventListener('click', () => {
        this.tab = key;
        this.syncTabs();
        handlers.onTab(key);
      });
      return b;
    };
    this.tabs = { page: tab('page', labels.tabPage), all: tab('all', labels.tabAll) };
    const filter = (key: PanelFilter, text: string) => {
      const b = h(d, 'button', { type: 'button', class: 'ph-filter', 'data-filter': key, 'aria-pressed': 'false' }, [text]);
      b.addEventListener('click', () => {
        this.filter = key;
        this.syncTabs();
        handlers.onFilter(key);
      });
      return b;
    };
    this.filters = { open: filter('open', labels.filterOpen), resolved: filter('resolved', labels.filterResolved), all: filter('all', labels.filterAll) };
    const close = h(d, 'button', { type: 'button', class: 'ph-icon-btn ph-panel-close', 'aria-label': labels.close }, [closeIcon(d)]);
    close.addEventListener('click', () => handlers.onClose());
    this.list = h(d, 'div', { class: 'ph-list', role: 'list' });
    this.el = h(d, 'div', { class: 'ph-panel', role: 'dialog', 'aria-label': labels.panelTitle, hidden: true }, [
      h(d, 'div', { class: 'ph-panel-head' }, [
        h(d, 'span', { class: 'ph-panel-title' }, [labels.panelTitle]),
        h(d, 'div', { class: 'ph-seg', role: 'tablist' }, [this.tabs.page, this.tabs.all]),
        close,
      ]),
      h(d, 'div', { class: 'ph-panel-filters', role: 'group', 'aria-label': labels.panelTitle }, [this.filters.open, this.filters.resolved, this.filters.all]),
      this.list,
    ]);
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    parent.append(this.el);
    this.syncTabs();
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open() {
    this.el.hidden = false;
    this.tabs[this.tab].focus({ preventScroll: true });
  }

  close() {
    this.el.hidden = true;
  }

  render(items: PanelItem[]) {
    const d = this.doc;
    if (!items.length) {
      this.list.replaceChildren(h(d, 'div', { class: 'ph-empty' }, [this.labels.empty]));
      return;
    }
    const rows = items.map((it) => {
      const p = it.payload;
      const meta: Array<Node | string> = [...(p.kind ? [`${this.labels.kindEmoji[p.kind]} ${this.labels.kinds[p.kind] ?? p.kind}`, ' · '] : []), relativeTime(p.createdAt, this.labels.locale), ' · '];
      for (const a of p.attachments ?? []) {
        meta.push(h(d, 'span', { class: 'ph-att', 'data-kind': a.kind }, [`${a.kind === 'audio' ? this.labels.recVoiceLabel : this.labels.recScreenLabel} ${formatDuration(a.durationMs)}`]), ' · ');
      }
      if (p.issue && (p.issue.state || p.issue.unavailable)) {
        const st = p.issue.unavailable ? 'unavailable' : p.issue.state;
        const title = `${this.labels.issueLink(p.issue)}: ${st === 'unavailable' ? this.labels.issueUnavailable : this.labels.issueStateLong(p.issue)}`;
        meta.push(h(d, 'span', { class: 'ph-issue-mark', 'data-state': st, title }, [st === 'unavailable' ? this.labels.issueUnavailable : `GitHub: ${this.labels.issueState(p.issue)}`]), ' · ');
      }
      const replies = p.replies ?? [];
      if (replies.length) {
        const last = replies[replies.length - 1];
        meta.push(h(d, 'span', { class: 'ph-replies', title: this.labels.replies(replies.length) }, [`💬 ${replies.length} · ${displayName(last.author, this.labels)}`]), ' · ');
      }
      if (p.status === 'resolved') meta.push(h(d, 'span', { class: 'ph-resolved-mark' }, [this.labels.statusResolved]), ' · ');
      if (it.n === null) meta.push(h(d, 'span', { class: 'ph-path' }, [pathOf(p.page.url)]));
      else if (it.missing) meta.push(h(d, 'span', { class: 'ph-missing' }, [this.labels.notFound]));
      else meta.push(h(d, 'code', {}, [shortSelector(p.target.selector)]));
      const resolved = p.status === 'resolved';
      const cls = `ph-item${it.missing ? ' ph-item-missing' : ''}${resolved ? ' ph-item-resolved' : ''}${it.unread ? ' ph-item-unread' : ''}`;
      const row = h(d, 'button', { type: 'button', role: 'listitem', class: cls, 'data-id': p.id, 'aria-description': it.unread ? this.labels.unread(1) : null }, [
        h(d, 'span', { class: 'ph-num', 'data-kind': p.kind ?? null, 'data-resolved': resolved ? '' : null }, [resolved ? '✓' : it.n === null ? '' : String(it.n)]),
        h(d, 'span', { class: 'ph-item-body' }, [h(d, 'span', { class: 'ph-item-text' }, [p.text || (p.attachments?.[0]?.kind === 'screen' ? this.labels.recScreen : this.labels.recVoice)]), h(d, 'span', { class: 'ph-item-meta' }, meta)]),
        it.unread ? h(d, 'span', { class: 'ph-unread-dot', 'aria-hidden': 'true' }) : null,
      ]);
      row.addEventListener('click', () => this.handlers.onPick(it));
      return row;
    });
    this.list.replaceChildren(...rows);
  }

  private syncTabs() {
    for (const [key, b] of Object.entries(this.tabs)) b.setAttribute('aria-selected', String(key === this.tab));
    for (const [key, b] of Object.entries(this.filters)) b.setAttribute('aria-pressed', String(key === this.filter));
  }
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || '/';
  } catch {
    return url;
  }
}

function shortSelector(sel: string): string {
  return sel.length > 28 ? `…${sel.slice(-27)}` : sel;
}

function relativeTime(iso: string, locale: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const sec = Math.round((t - Date.now()) / 1000);
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const abs = Math.abs(sec);
    if (abs < 60) return rtf.format(sec, 'second');
    if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
    return rtf.format(Math.round(sec / 86400), 'day');
  } catch {
    return new Date(t).toLocaleString();
  }
}
