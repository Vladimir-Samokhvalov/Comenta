import type { FeedbackLabels, FeedbackPosition } from '../types';
import { STYLES } from './styles';
import { commentIcon, h } from './h';

export const HOST_TAG = 'pinhelp-feedback';

export interface ViewOptions {
  position: FeedbackPosition;
  zIndex: number;
  labels: FeedbackLabels;
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
  private readonly count: HTMLSpanElement;
  private readonly label: HTMLSpanElement;
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

    this.label = h(doc, 'span', {}, [opts.labels.toggle]);
    this.count = h(doc, 'span', { class: 'ph-count', hidden: true });
    this.toggle = h(
      doc,
      'button',
      { type: 'button', class: `ph-toggle ph-pos-${opts.position}`, 'aria-pressed': 'false', 'aria-label': opts.labels.toggle },
      [commentIcon(doc), this.label, this.count],
    );
    this.toggle.addEventListener('click', () => opts.onToggle());

    this.toast = h(doc, 'div', { class: 'ph-toast', role: 'status', 'aria-live': 'polite', hidden: true });

    this.root.append(this.hoverBox, this.selBox, this.pinLayer, this.toggle, this.toast);
    (doc.documentElement ?? doc.body).append(this.host);
  }

  setActive(active: boolean) {
    this.toggle.setAttribute('aria-pressed', String(active));
    this.toggle.setAttribute('aria-label', active ? this.opts.labels.toggleActive : this.opts.labels.toggle);
  }

  setCount(n: number) {
    this.count.textContent = String(n);
    this.count.hidden = n === 0;
    this.count.setAttribute('aria-label', this.opts.labels.count(n));
    this.toggle.title = n ? this.opts.labels.count(n) : '';
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
