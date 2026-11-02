/**
 * All widget styles live inside the shadow root. `.ph-root` resets inherited
 * properties so page styles (fonts, colors, `* { all: unset }` on the host) can't leak in.
 * Only px units: page `html { font-size }` must not scale the widget.
 */
export const STYLES = /* css */ `
:host { all: initial; }
.ph-root {
  all: initial;
  --ph-accent: #2f6bff;
  --ph-accent-ink: #ffffff;
  --ph-bg: #ffffff;
  --ph-ink: #1d1f24;
  --ph-muted: #6b7080;
  --ph-line: #e2e4ea;
  --ph-danger: #d93a3a;
  --ph-shadow: 0 8px 28px rgba(16, 24, 40, .18), 0 2px 6px rgba(16, 24, 40, .08);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 14px;
  line-height: 20px;
  color: var(--ph-ink);
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  .ph-root {
    --ph-bg: #1f2128;
    --ph-ink: #eceef3;
    --ph-muted: #a0a5b4;
    --ph-line: #343744;
    --ph-accent: #5b8cff;
  }
}
.ph-root *, .ph-root *::before, .ph-root *::after { box-sizing: border-box; }
[hidden] { display: none !important; }

/* Toggle button */
.ph-toggle {
  position: fixed;
  display: inline-flex; align-items: center; gap: 8px;
  height: 40px; padding: 0 14px 0 12px; margin: 0;
  border: 1px solid var(--ph-line); border-radius: 20px;
  background: var(--ph-bg); color: var(--ph-ink);
  font-family: inherit; font-weight: 500; font-size: 14px; line-height: 20px;
  box-shadow: var(--ph-shadow);
  cursor: pointer; user-select: none;
  pointer-events: auto;
  appearance: none; -webkit-appearance: none;
  transition: background .15s, color .15s, border-color .15s;
}
.ph-toggle:hover { border-color: var(--ph-accent); }
.ph-toggle:focus-visible { outline: 2px solid var(--ph-accent); outline-offset: 2px; }
.ph-toggle[aria-pressed="true"] { background: var(--ph-accent); color: var(--ph-accent-ink); border-color: var(--ph-accent); }
.ph-toggle svg { width: 18px; height: 18px; flex: none; display: block; }
.ph-pos-bottom-right { right: 20px; bottom: 20px; }
.ph-pos-bottom-left { left: 20px; bottom: 20px; }
.ph-pos-top-right { right: 20px; top: 20px; }
.ph-pos-top-left { left: 20px; top: 20px; }
.ph-count {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px;
  background: var(--ph-accent); color: var(--ph-accent-ink);
  font-size: 12px; line-height: 20px; font-weight: 600;
}
.ph-toggle[aria-pressed="true"] .ph-count { background: var(--ph-accent-ink); color: var(--ph-accent); }

/* Highlight boxes */
.ph-box {
  position: fixed; top: 0; left: 0; width: 0; height: 0;
  pointer-events: none;
  border-radius: 3px;
  outline: 2px solid var(--ph-accent);
  outline-offset: 0;
  background: rgba(47, 107, 255, .06);
}
.ph-box.ph-selected { outline-width: 2px; background: rgba(47, 107, 255, .10); }
.ph-tag {
  position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px;
  max-width: 280px; padding: 2px 6px; border-radius: 4px;
  background: var(--ph-accent); color: #fff;
  font: 500 11px/16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ph-tag.ph-inside { bottom: auto; top: 2px; left: 2px; margin: 0; }

/* Pins */
.ph-pin {
  position: fixed; top: 0; left: 0;
  width: 24px; height: 24px; padding: 0; margin: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 2px solid #fff; border-radius: 12px 12px 12px 2px;
  background: var(--ph-accent); color: #fff;
  font-family: inherit; font-weight: 600; font-size: 12px; line-height: 1;
  box-shadow: 0 2px 6px rgba(16,24,40,.3);
  cursor: pointer; pointer-events: auto;
  appearance: none; -webkit-appearance: none;
}
.ph-pin:focus-visible { outline: 2px solid var(--ph-accent); outline-offset: 2px; }
.ph-pin[data-kind="bug"] { background: var(--ph-danger); }
.ph-pin[data-kind="question"] { background: #8a4dff; }

/* Popover */
.ph-popover {
  position: fixed; top: 0; left: 0;
  width: 320px; max-width: calc(100vw - 16px);
  padding: 12px; border-radius: 12px;
  background: var(--ph-bg); color: var(--ph-ink);
  border: 1px solid var(--ph-line);
  box-shadow: var(--ph-shadow);
  pointer-events: auto;
  display: flex; flex-direction: column; gap: 10px;
}
.ph-kinds { display: flex; gap: 4px; padding: 3px; border-radius: 8px; background: rgba(127,127,127,.12); border: 0; margin: 0; min-width: 0; }
.ph-kind { flex: 1; position: relative; display: block; cursor: pointer; }
.ph-kind input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; pointer-events: none; }
.ph-kind span {
  display: block; text-align: center; padding: 4px 6px; border-radius: 6px;
  font-size: 13px; line-height: 18px; color: var(--ph-muted);
}
.ph-kind input:checked + span { background: var(--ph-bg); color: var(--ph-ink); box-shadow: 0 1px 2px rgba(0,0,0,.12); font-weight: 500; }
.ph-kind input:focus-visible + span { outline: 2px solid var(--ph-accent); outline-offset: 1px; }
.ph-textarea {
  display: block; width: 100%; min-height: 72px; max-height: 240px; margin: 0;
  padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--ph-line); background: transparent; color: inherit;
  font-family: inherit; font-size: 14px; line-height: 20px;
  resize: none; overflow-y: auto; white-space: pre-wrap;
}
.ph-textarea:focus { outline: none; border-color: var(--ph-accent); box-shadow: 0 0 0 3px rgba(47,107,255,.18); }
.ph-textarea::placeholder { color: var(--ph-muted); }
.ph-error { color: var(--ph-danger); font-size: 13px; line-height: 18px; }
.ph-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.ph-hint { margin-right: auto; color: var(--ph-muted); font-size: 12px; }
.ph-btn {
  display: inline-flex; align-items: center; justify-content: center;
  height: 32px; padding: 0 12px; margin: 0; border-radius: 8px;
  border: 1px solid var(--ph-line); background: transparent; color: inherit;
  font-family: inherit; font-weight: 500; font-size: 13px; line-height: 18px; cursor: pointer;
  appearance: none; -webkit-appearance: none;
}
.ph-btn:focus-visible { outline: 2px solid var(--ph-accent); outline-offset: 2px; }
.ph-btn-primary { background: var(--ph-accent); border-color: var(--ph-accent); color: var(--ph-accent-ink); }
.ph-btn:disabled { opacity: .45; cursor: default; }
.ph-view-head { display: flex; align-items: center; gap: 8px; }
.ph-badge { font-size: 12px; line-height: 16px; padding: 2px 8px; border-radius: 10px; background: rgba(127,127,127,.14); color: var(--ph-ink); }
.ph-meta { color: var(--ph-muted); font-size: 12px; margin-left: auto; }
.ph-view-text { white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; }

/* Toast */
.ph-toast {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
  padding: 8px 14px; border-radius: 8px;
  background: #1d1f24; color: #fff; font-size: 14px; line-height: 20px;
  box-shadow: var(--ph-shadow); pointer-events: none;
}
@media (prefers-reduced-motion: no-preference) {
  .ph-popover, .ph-toast { animation: ph-in .12s ease-out; }
  @keyframes ph-in { from { opacity: 0; transform: translateY(4px); } }
  .ph-toast { animation: none; }
}
`;
