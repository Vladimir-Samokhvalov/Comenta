import { describe, expect, it } from 'vitest';
import { createElement, createRef, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { FeedbackWidget } from '../../src/react';
import type { FeedbackInstance } from '../../src';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('<FeedbackWidget />', () => {
  it('mounts once (StrictMode), exposes the instance via ref, cleans up on unmount', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const ref = createRef<FeedbackInstance | null>();
    const adapter = { submit: async () => {} };
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(FeedbackWidget, { adapter, position: 'top-left', ref })));
    });
    expect(document.querySelectorAll('comenta-feedback').length).toBe(1);
    const host = document.querySelector('comenta-feedback')!;
    expect(host.shadowRoot!.querySelector('.ph-bar')!.classList.contains('ph-pos-top-left')).toBe(true);
    expect(container.childNodes.length).toBe(0);

    ref.current!.open();
    expect(ref.current!.isOpen()).toBe(true);

    await act(async () => {
      root.render(createElement(FeedbackWidget, { adapter, position: 'bottom-left', ref }));
    });
    const toggle = document.querySelector('comenta-feedback')!.shadowRoot!.querySelector('.ph-bar')!;
    expect(toggle.classList.contains('ph-pos-bottom-left')).toBe(true);

    await act(async () => root.unmount());
    expect(document.querySelectorAll('comenta-feedback').length).toBe(0);
  });
});
