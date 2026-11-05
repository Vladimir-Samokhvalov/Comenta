/**
 * <script> build. Exposes `window.Comenta` and auto-initialises from
 * data-* attributes on the script tag:
 *
 *   <script src="feedback.iife.js"
 *           data-endpoint="/api/feedback"      (omit → console + localStorage adapter)
 *           data-auth="/api/auth"              (visitors sign in through your server: Google, Yandex, Keycloak…)
 *           data-position="bottom-right"
 *           data-author-id="42" data-author-name="Anna"
 *           data-ignore-selector="[data-feedback-ignore]"
 *           data-z-index="2147483000"
 *           data-auto-init="false"             (opt out; call Comenta.initFeedback yourself)
 *   ></script>
 *
 * The owner's GitHub settings page uses a separate bundle: settings.iife.js (`<comenta-settings>`).
 */
import { initFeedback, httpAdapter, consoleAdapter, buildSelector } from './index';
import type { FeedbackInstance, FeedbackOptions, FeedbackPosition } from './types';

interface Global {
  initFeedback: typeof initFeedback;
  httpAdapter: typeof httpAdapter;
  consoleAdapter: typeof consoleAdapter;
  buildSelector: typeof buildSelector;
  instance: FeedbackInstance | null;
}

const api: Global = { initFeedback, httpAdapter, consoleAdapter, buildSelector, instance: null };
(window as unknown as { Comenta: Global }).Comenta = api;

const script = document.currentScript as HTMLScriptElement | null;

export function optionsFromDataset(ds: DOMStringMap): FeedbackOptions {
  const opts: FeedbackOptions = {
    adapter: ds.endpoint ? httpAdapter({ endpoint: ds.endpoint }) : consoleAdapter(),
  };
  if (ds.position) opts.position = ds.position as FeedbackPosition;
  if (ds.ignoreSelector) opts.ignoreSelector = ds.ignoreSelector;
  if (ds.zIndex && !Number.isNaN(Number(ds.zIndex))) opts.zIndex = Number(ds.zIndex);
  if (ds.authorId || ds.authorName) opts.author = { id: ds.authorId, name: ds.authorName };
  if (opts.author && (ds.authorRole === 'owner' || ds.authorRole === 'member')) opts.author.role = ds.authorRole;
  if (ds.auth) opts.auth = { endpoint: ds.auth };
  if (ds.enabled === 'false') opts.enabled = false;
  return opts;
}

if (script && script.dataset.autoInit !== 'false') {
  const start = () => {
    api.instance = initFeedback(optionsFromDataset(script.dataset));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
