/**
 * <script> build. Exposes `window.PinHelpFeedback` and auto-initialises from
 * data-* attributes on the script tag:
 *
 *   <script src="feedback.iife.js"
 *           data-endpoint="/api/feedback"      (omit → console + localStorage adapter)
 *           data-position="bottom-right"
 *           data-author-id="42" data-author-name="Anna"
 *           data-ignore-selector="[data-feedback-ignore]"
 *           data-z-index="2147483000"
 *           data-auto-init="false"             (opt out; call PinHelpFeedback.initFeedback yourself)
 *   ></script>
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
(window as unknown as { PinHelpFeedback: Global }).PinHelpFeedback = api;

const script = document.currentScript as HTMLScriptElement | null;

export function optionsFromDataset(ds: DOMStringMap): FeedbackOptions {
  const opts: FeedbackOptions = {
    adapter: ds.endpoint ? httpAdapter({ endpoint: ds.endpoint }) : consoleAdapter(),
  };
  if (ds.position) opts.position = ds.position as FeedbackPosition;
  if (ds.ignoreSelector) opts.ignoreSelector = ds.ignoreSelector;
  if (ds.zIndex && !Number.isNaN(Number(ds.zIndex))) opts.zIndex = Number(ds.zIndex);
  if (ds.authorId || ds.authorName) opts.author = { id: ds.authorId, name: ds.authorName };
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
