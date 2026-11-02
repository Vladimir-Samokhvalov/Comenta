export { initFeedback } from './core/controller';
export { httpAdapter, consoleAdapter, FeedbackHttpError } from './adapters';
export type { HttpAdapterOptions, ConsoleAdapterOptions } from './adapters';
export { buildSelector, resolveSelector } from './selector';
export { describeTarget, getTextSnippet, getSafeAttributes, isPrivateElement } from './selector/sanitize';
export { placePopover } from './core/position';
export { DEFAULT_LABELS } from './ui/labels';
export type * from './types';
