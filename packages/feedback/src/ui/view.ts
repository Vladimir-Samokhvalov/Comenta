import type { FeedbackLabels, FeedbackPosition } from '../types';
import { STYLES } from './styles';
import { chevronIcon, commentIcon, h } from './h';

export const HOST_TAG = 'comenta-feedback';

export interface ViewOptions {
  position: FeedbackPosition;
  zIndex: number;
  labels: FeedbackLabels;
  hotkey: string | false;
  onToggle: () => void;
}

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Shadow-root shell: host, toggle button, highlight boxes, pin layer, toast. */
export class View {
  readonly doc: Document;
  readonly host: HTMLElement;
  readonly shadow: ShadowRoot;
  readonly root: HTMLDivElement;
  readonly toggle: HTMLButtonElement;
  readonly pinLayer: HTMLDivElement;
  readonly more: HTMLButtonElement;
  /** Container of the toggle, chevron, menu and panel. */
  readonly bar: HTMLDivElement;
  private readonly tip: HTMLDivElement;
  private readonly hoverBox: HTMLDivElement;
  private readonly hoverTag: HTMLDivElement;
  private readonly selBox: HTMLDivElement;
  private readonly toast: HTMLDivElement;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(doc: Document, private readonly opts: ViewOptions) {
    this.doc = doc;
    this.host = doc.createElement(HOST_TAG);
    this.host.setAttribute('data-feedback-widget', '');
    // Inline !important beats any page stylesheet, including `* { all: unset }`.
    const hs = this.host.style;
    for (const [k, v] of Object.entries({
      all: 'initial',
      position: 'fixed',
      top: '0',
      left: '0',
      width: '0',
      height: '0',
      overflow: 'visible',
      display: 'block',
      'z-index': String(opts.zIndex),
      'pointer-events': 'none',
      contain: 'none',
      transform: 'none',
      filter: 'none',
    })) {
      hs.setProperty(k, v, 'important');
    }
    this.shadow = this.host.attachShadow({ mode: 'open' });
    const style = h(doc, 'style', {}, [STYLES]);
    this.root = h(doc, 'div', { class: 'ph-root' });
    this.shadow.append(style, this.root);

    this.hoverTag = h(doc, 'div', { class: 'ph-tag' });
    this.hoverBox = h(doc, 'div', { class: 'ph-box', hidden: true, 'aria-hidden': 'true' }, [this.hoverTag]);
    this.selBox = h(doc, 'div', { class: 'ph-box ph-selected', hidden: true, 'aria-hidden': 'true' });
    this.pinLayer = h(doc, 'div', { class: 'ph-pins' });

    this.toggle = h(
      doc,
      'button',
      { type: 'button', class: 'ph-toggle', 'aria-pressed': 'false', 'aria-label': opts.labels.toggle },
      [commentIcon(doc)],
    );
    this.more = h(
      doc,
      'button',
      { type: 'button', class: 'ph-more', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': opts.labels.menu },
      [chevronIcon(doc)],
    );
    this.tip = h(doc, 'div', { class: 'ph-tip', role: 'tooltip', 'aria-hidden': 'true' });
    this.setTip(false);
    this.bar = h(doc, 'div', { class: `ph-bar ph-pos-${opts.position}` }, [this.toggle, this.more, this.tip]);
    this.toggle.addEventListener('click', () => opts.onToggle());

    this.toast = h(doc, 'div', { class: 'ph-toast', role: 'status', 'aria-live': 'polite', hidden: true });

    this.root.append(this.hoverBox, this.selBox, this.pinLayer, this.bar, this.toast);
    (doc.documentElement ?? doc.body).append(this.host);
  }

  setActive(active: boolean) {
    this.toggle.setAttribute('aria-pressed', String(active));
    this.toggle.setAttribute('aria-label', active ? this.opts.labels.toggleActive : this.opts.labels.toggle);
    this.setTip(active);
  }

  private setTip(active: boolean) {
    const d = this.doc;
    const key = this.opts.hotkey ? h(d, 'kbd', {}, [this.opts.hotkey.toUpperCase()]) : null;
    this.tip.replaceChildren(active ? this.opts.labels.toggleActive : this.opts.labels.toggle, ...(key ? [key] : []));
  }

  /** Hide the tooltip while a menu or panel is open. */
  setPopupOpen(open: boolean) {
    this.bar.toggleAttribute('data-popup', open);
  }

  showHover(rect: Rect | null, tag = '') {
    this.placeBox(this.hoverBox, rect);
    if (rect) {
      this.hoverTag.textContent = tag;
      this.hoverTag.classList.toggle('ph-inside', rect.top < 22);
    }
  }

  showSelection(rect: Rect | null) {
    this.placeBox(this.selBox, rect);
  }

  showToast(text: string, ms = 2500) {
    this.toast.textContent = text;
    this.toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast.hidden = true;
    }, ms);
  }

  /** True if the event originated inside the widget. */
  owns(e: Event): boolean {
    return e.composedPath().includes(this.host);
  }

  destroy() {
    clearTimeout(this.toastTimer);
    this.host.remove();
  }

  private placeBox(box: HTMLDivElement, rect: Rect | null) {
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const s = box.style;
    s.transform = `translate(${Math.round(rect.left)}px, ${Math.round(rect.top)}px)`;
    s.width = `${Math.round(rect.width)}px`;
    s.height = `${Math.round(rect.height)}px`;
  }
}
