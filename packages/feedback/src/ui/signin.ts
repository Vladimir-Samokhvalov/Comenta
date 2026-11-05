import type { FeedbackLabels } from '../types';
import { closeIcon, h } from './h';

export interface SignInProvider {
  id: string;
  label: string;
}

export interface SignInHandlers {
  onPick: (provider: SignInProvider) => void;
  onClose: () => void;
}

/** "Sign in to comment" card anchored to the bar (the `auth` option). */
export class SignIn {
  readonly el: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly error: HTMLParagraphElement;

  constructor(
    private readonly doc: Document,
    parent: HTMLElement,
    private readonly labels: FeedbackLabels,
    private readonly handlers: SignInHandlers,
  ) {
    const d = doc;
    const close = h(d, 'button', { type: 'button', class: 'ph-icon-btn ph-signin-close', 'aria-label': labels.close }, [closeIcon(d)]);
    close.addEventListener('click', () => handlers.onClose());
    this.body = h(d, 'div', { class: 'ph-signin-list' });
    this.error = h(d, 'p', { class: 'ph-signin-error', role: 'alert', hidden: true });
    this.el = h(d, 'div', { class: 'ph-signin', role: 'dialog', 'aria-label': labels.signInTitle, hidden: true }, [
      h(d, 'div', { class: 'ph-signin-head' }, [h(d, 'span', { class: 'ph-signin-title' }, [labels.signInTitle]), close]),
      h(d, 'p', { class: 'ph-signin-hint' }, [labels.signInHint]),
      this.body,
      this.error,
    ]);
    parent.append(this.el);
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open(providers: SignInProvider[], error?: string) {
    const d = this.doc;
    this.body.replaceChildren(
      ...providers.map((p) => {
        const b = h(d, 'button', { type: 'button', class: 'ph-btn ph-signin-btn', 'data-provider': p.id }, [this.labels.signInWith(p.label)]);
        b.addEventListener('click', () => this.handlers.onPick(p));
        return h(d, 'div', { class: 'ph-signin-row' }, [b]);
      }),
    );
    this.showError(error);
    this.el.hidden = false;
    this.body.querySelector('button')?.focus({ preventScroll: true });
  }

  showError(message?: string) {
    this.error.textContent = message ?? '';
    this.error.hidden = !message;
  }

  close() {
    this.el.hidden = true;
  }
}
