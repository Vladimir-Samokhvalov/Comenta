import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { initFeedback } from '../core/controller';
import type { FeedbackInstance, FeedbackOptions } from '../types';

export type FeedbackWidgetProps = FeedbackOptions;

/**
 * Thin React wrapper. Renders nothing itself: the widget mounts into its own
 * Shadow DOM host. Options that affect markup (position, zIndex, ignoreSelector,
 * enabled, labels) re-mount the widget; adapter/author/callbacks are updated in place.
 */
export const FeedbackWidget = forwardRef<FeedbackInstance | null, FeedbackWidgetProps>(function FeedbackWidget(props, ref) {
  const instance = useRef<FeedbackInstance | null>(null);
  const latest = useRef(props);
  latest.current = props;

  // Stable handle that always delegates to the live instance (it is re-created on re-mount).
  useImperativeHandle(
    ref,
    (): FeedbackInstance => ({
      open: () => instance.current?.open(),
      close: () => instance.current?.close(),
      toggle: () => instance.current?.toggle(),
      isOpen: () => instance.current?.isOpen() ?? false,
      update: (o) => instance.current?.update(o),
      getComments: () => instance.current?.getComments() ?? [],
      destroy: () => instance.current?.destroy(),
    }),
    [],
  );

  const { position, zIndex, ignoreSelector, enabled, labels } = props;
  const labelsKey = labels ? JSON.stringify(labels, (_k, v) => (typeof v === 'function' ? String(v) : v)) : '';

  useEffect(() => {
    const fb = initFeedback({ ...latest.current });
    instance.current = fb;
    return () => {
      fb.destroy();
      if (instance.current === fb) instance.current = null;
    };
  }, [position, zIndex, ignoreSelector, enabled, labelsKey]);

  useEffect(() => {
    instance.current?.update({
      adapter: props.adapter,
      author: props.author,
      onSubmit: props.onSubmit,
      onError: props.onError,
    });
  }, [props.adapter, props.author, props.onSubmit, props.onError]);

  return null;
});

export { initFeedback };
export type { FeedbackInstance, FeedbackOptions } from '../types';
