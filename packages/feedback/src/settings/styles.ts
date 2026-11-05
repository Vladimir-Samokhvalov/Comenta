/** Styles of `<comenta-settings>` (inside its shadow root). Same palette as the widget. */
export const SETTINGS_STYLES = /* css */ `
:host { display: block; all: initial; display: block; }
.cs {
  --cs-accent: #c96442; --cs-accent-rgb: 201, 100, 66; --cs-accent-ink: #fff;
  --cs-bg: #ffffff; --cs-ink: #1f1e1d; --cs-muted: #73726c; --cs-line: #e6e4dd; --cs-soft: #faf9f6;
  --cs-hover: #f0eee8; --cs-danger: #c4392f; --cs-danger-rgb: 196, 57, 47; --cs-ok: #3f8f5b; --cs-ok-rgb: 63, 143, 91; --cs-warn: #9a6a00; --cs-warn-bg: #fdf6e3;
  --cs-shadow: 0 4px 16px rgba(20,20,19,.10), 0 1px 3px rgba(20,20,19,.06);
  font: 14px/20px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--cs-ink); -webkit-font-smoothing: antialiased;
  background: var(--cs-bg); border: 1px solid var(--cs-line); border-radius: 14px; box-shadow: var(--cs-shadow);
  max-width: 560px; overflow: hidden;
}
@media (prefers-color-scheme: dark) {
  .cs { --cs-bg: #262624; --cs-ink: #f2f0ea; --cs-muted: #a6a39b; --cs-line: #3a3936; --cs-soft: #2c2b29; --cs-hover: #33322f;
    --cs-accent: #d97757; --cs-accent-rgb: 217,119,87; --cs-ok: #6cbf88; --cs-ok-rgb: 108,191,136; --cs-warn: #e7b84a; --cs-warn-bg: #3a3222; }
}
.cs *, .cs *::before, .cs *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.cs-head { display: flex; gap: 12px; align-items: flex-start; padding: 18px 20px 14px; border-bottom: 1px solid var(--cs-line); }
.cs-logo { width: 28px; height: 28px; flex: none; color: var(--cs-ink); }
.cs-title { margin: 0; font-size: 16px; line-height: 22px; font-weight: 600; }
.cs-sub { margin: 2px 0 0; color: var(--cs-muted); font-size: 13px; line-height: 18px; }
.cs-body { padding: 16px 20px 20px; display: flex; flex-direction: column; gap: 16px; }
.cs-field { display: flex; flex-direction: column; gap: 6px; }
.cs-label { font-size: 13px; font-weight: 600; }
.cs-hint { font-size: 12px; line-height: 16px; color: var(--cs-muted); }
.cs-manage { display: block; margin-top: 4px; font-size: 12px; line-height: 16px; }
.cs-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  height: 36px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--cs-line);
  background: var(--cs-bg); color: var(--cs-ink); font: inherit; font-weight: 500; cursor: pointer; white-space: nowrap;
}
.cs-btn:hover:not(:disabled) { background: var(--cs-hover); }
.cs-btn:focus-visible, .cs-input:focus-visible, .cs-select:focus-visible, .cs-link:focus-visible { outline: 2px solid var(--cs-accent); outline-offset: 2px; }
.cs-btn:disabled { opacity: .5; cursor: default; }
.cs-btn-primary { background: var(--cs-accent); border-color: var(--cs-accent); color: var(--cs-accent-ink); }
.cs-btn-primary:hover:not(:disabled) { background: var(--cs-accent); filter: brightness(.95); }
.cs-btn-gh { background: #1f2328; border-color: #1f2328; color: #fff; height: 40px; padding: 0 18px; align-self: flex-start; }
.cs-btn-gh:hover:not(:disabled) { background: #32383f; }
.cs-btn-gh svg { width: 18px; height: 18px; }
.cs-btn-gl { background: #6b4fbb; border-color: #6b4fbb; }
.cs-btn-gl:hover:not(:disabled) { background: #5c43a6; }
.cs-chooser { display: flex; flex-direction: column; gap: 8px; padding: 14px 20px 0; }
.cs-choices { display: inline-flex; align-self: flex-start; padding: 3px; gap: 3px; border: 1px solid var(--cs-line); border-radius: 10px; background: var(--cs-soft); }
.cs-choice { display: inline-flex; align-items: center; gap: 7px; height: 32px; padding: 0 14px; border: 0; border-radius: 7px; background: none; color: var(--cs-muted); font: inherit; font-weight: 500; cursor: pointer; }
.cs-choice svg { width: 16px; height: 16px; }
.cs-choice[aria-checked="true"] { background: var(--cs-bg); color: var(--cs-ink); box-shadow: 0 1px 2px rgba(20,20,19,.12); }
.cs-choice[data-provider="gitlab"][aria-checked="true"] svg { color: #e24329; }
.cs-choice:hover:not(:disabled):not([aria-checked="true"]) { color: var(--cs-ink); }
.cs-choice:disabled { opacity: .45; cursor: not-allowed; }
.cs-choice:focus-visible { outline: 2px solid var(--cs-accent); outline-offset: 1px; }
.cs[data-provider="gitlab"] .cs-logo { color: #e24329; }
.cs-btn-danger { color: var(--cs-danger); border-color: rgba(var(--cs-danger-rgb), .35); }
.cs-btn-danger:hover:not(:disabled) { background: rgba(var(--cs-danger-rgb), .08); }
.cs-btn-sm { height: 30px; padding: 0 10px; font-size: 13px; }
.cs-link { color: var(--cs-accent); background: none; border: 0; padding: 0; font: inherit; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.cs-input, .cs-select {
  width: 100%; height: 38px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--cs-line);
  background: var(--cs-bg); color: var(--cs-ink); font: inherit; appearance: none; -webkit-appearance: none;
}
.cs-select { padding-right: 32px; background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 17px) 17px, calc(100% - 12px) 17px; background-size: 5px 5px; background-repeat: no-repeat; }
.cs-select:disabled, .cs-input:disabled { opacity: .55; }
.cs-account { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--cs-line); border-radius: 10px; background: var(--cs-soft); }
.cs-avatar { width: 36px; height: 36px; border-radius: 50%; flex: none; background: var(--cs-hover); object-fit: cover; }
.cs-who { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.cs-who b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cs-who a { color: var(--cs-muted); font-size: 12px; text-decoration: none; }
.cs-who a:hover { text-decoration: underline; }
.cs-combo { position: relative; }
.cs-combo .cs-input { padding-left: 34px; }
.cs-combo-icon { position: absolute; left: 11px; top: 11px; width: 16px; height: 16px; color: var(--cs-muted); pointer-events: none; }
.cs-list {
  position: absolute; z-index: 2; left: 0; right: 0; top: calc(100% + 4px); margin: 0; padding: 4px; list-style: none;
  max-height: 264px; overflow-y: auto; background: var(--cs-bg); border: 1px solid var(--cs-line); border-radius: 10px; box-shadow: var(--cs-shadow);
}
.cs-opt { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 6px; cursor: pointer; }
.cs-opt[aria-selected="true"] { font-weight: 600; }
.cs-opt.cs-active { background: var(--cs-hover); }
.cs-opt-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cs-opt-name span { color: var(--cs-muted); font-weight: 400; }
.cs-opt-tag { font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 8px; border: 1px solid var(--cs-line); color: var(--cs-muted); }
.cs-empty-opt { padding: 10px; color: var(--cs-muted); font-size: 13px; }
.cs-note { padding: 10px 12px; border-radius: 10px; font-size: 13px; line-height: 18px; display: flex; gap: 10px; align-items: flex-start; }
.cs-note > span { flex: 1; }
.cs-note-error { background: rgba(var(--cs-danger-rgb), .08); color: var(--cs-danger); }
.cs-note-warn { background: var(--cs-warn-bg); color: var(--cs-warn); }
.cs-note-ok { background: rgba(var(--cs-ok-rgb), .10); color: var(--cs-ok); }
.cs-note-info { background: var(--cs-soft); color: var(--cs-muted); border: 1px solid var(--cs-line); }
.cs-site { gap: 10px; }
.cs-site-login { text-decoration: none; }
.cs-site-logout { align-self: flex-start; }
.cs-note .cs-btn { height: 28px; font-size: 12px; padding: 0 10px; flex: none; }
.cs-footer { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding-top: 4px; }
.cs-saved { font-size: 13px; color: var(--cs-muted); margin: 10px 0 0; padding-top: 12px; border-top: 1px solid var(--cs-line); }
.cs-ok { font-size: 13px; color: var(--cs-ok); font-weight: 500; }
.cs-footer-wrap { display: flex; flex-direction: column; gap: 10px; }
.cs-saved b { color: var(--cs-ink); font-weight: 600; }
.cs-row { display: flex; gap: 8px; }
.cs-row .cs-input { flex: 1; }
.cs-details summary { cursor: pointer; color: var(--cs-muted); font-size: 13px; }
.cs-details[open] summary { margin-bottom: 8px; }
.cs-loading { padding: 28px 20px; color: var(--cs-muted); display: flex; align-items: center; gap: 10px; }
.cs-spin { width: 16px; height: 16px; border: 2px solid var(--cs-line); border-top-color: var(--cs-accent); border-radius: 50%; animation: cs-spin .8s linear infinite; flex: none; }
@keyframes cs-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .cs-spin { animation-duration: 2.4s; } }
code { font: 12px/16px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--cs-hover); padding: 1px 4px; border-radius: 4px; }
`;
