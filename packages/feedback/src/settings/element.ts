import { h } from '../ui/h';
import { SETTINGS_STYLES } from './styles';

/**
 * `<comenta-settings endpoint="/api/github">` — the site owner's page for the GitHub integration:
 * sign in with GitHub, pick a repository (searchable) and, optionally, a Project v2, save, sign out.
 *
 * It talks only to your backend (see README, "GitHub"); the token never reaches the browser:
 *
 *   GET  {endpoint}/status              → SettingsStatus
 *   GET  {endpoint}/auth/login?return=  → redirect to GitHub (page navigation)
 *   GET  {endpoint}/auth/install?return= → redirect to the GitHub App's install page (status.app only)
 *   POST {endpoint}/auth/token          { token } — personal access token (local development)
 *   POST {endpoint}/auth/logout
 *   GET  {endpoint}/repos               → { items: SettingsRepo[] }
 *   GET  {endpoint}/projects?owner=     → { items: SettingsProject[] }
 *   PUT  {endpoint}/config              { repo: "owner/name", projectId: string | null } → { config }
 *
 * Errors come as `{ error: { code, message } }`; `code: "unauthorized"` means "sign in again".
 * Events: `comenta-settings-save` (detail: config), `comenta-settings-logout`.
 */

export interface SettingsAccount {
  login: string;
  name: string | null;
  avatarUrl: string;
  htmlUrl: string;
  scopes?: string[];
}
export interface SettingsRepo {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  hasIssues?: boolean;
  ownerType?: 'User' | 'Organization';
  htmlUrl?: string;
}
export interface SettingsProject {
  id: string;
  number: number;
  title: string;
  url: string;
  closed?: boolean;
}
export interface SettingsConfig {
  repo: { owner: string; name: string; fullName: string; htmlUrl?: string };
  project?: SettingsProject | null;
}
export interface SettingsStatus {
  /** A GitHub App is configured on the server, so "Sign in with GitHub" works. */
  oauth: boolean;
  /** The server accepts a personal access token. */
  pat: boolean;
  connected: boolean;
  /** Why the owner is signed out: the token expired or was revoked. */
  reason?: 'expired';
  account?: SettingsAccount;
  config?: SettingsConfig | null;
  /** Connected through the GitHub App: repository access is managed on GitHub. */
  app?: boolean;
  /** Issues are created by the app's bot (installation token), not under the owner's account. */
  bot?: boolean;
  /** Signed out, but the bot still turns comments into issues. */
  syncing?: boolean;
  /** Scopes the integration needs that the token lacks. */
  missingScopes?: string[];
  /** The integration is connected by someone else (shown to other visitors). */
  owner?: string;
  /** Comments waiting to be sent to GitHub, and the last error. */
  sync?: { pending: number; lastError?: { code: string; message: string; at: string } };
}

interface ApiError {
  code: string;
  message: string;
}

type HeadersInput = Record<string, string> | (() => Record<string, string>);

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(doc: Document, cls: string, viewBox: string, d: string, filled = false): SVGSVGElement {
  const s = doc.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  if (filled) s.setAttribute('fill', 'currentColor');
  else for (const [k, v] of Object.entries({ fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' })) s.setAttribute(k, v);
  const p = doc.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  s.append(p);
  return s;
}
const GH_PATH =
  'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z';
const ghLogo = (doc: Document, cls: string) => svg(doc, cls, '0 0 16 16', GH_PATH, true);
const searchIcon = (doc: Document) => svg(doc, 'cs-combo-icon', '0 0 16 16', 'M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM11 11l3.5 3.5');

export const SETTINGS_TAG = 'comenta-settings';

/** Messages the browser side produces itself. */
const M = {
  title: 'Интеграция с GitHub',
  sub: 'Комментарии с сайта будут превращаться в issues в выбранном репозитории и, если хотите, попадать в проект GitHub.',
  loading: 'Загружаем настройки…',
  login: 'Войти через GitHub',
  loginHint: 'GitHub предложит установить приложение и выбрать репозитории. Токен хранится на вашем сервере, браузер его не видит.',
  expired: 'Доступ к GitHub истёк или был отозван. Войдите заново, чтобы комментарии снова попадали в issues.',
  sessionExpired: 'Сессия входа в GitHub истекла. Комментарии по-прежнему создают issues, войдите заново, чтобы менять настройки.',
  noOauth: 'Вход через GitHub не настроен на сервере: нет GitHub App. Для локальной разработки можно вставить токен.',
  patSummary: 'Вставить токен вместо входа (для локальной разработки)',
  patLabel: 'Personal access token',
  patHint: 'Classic-токен с правами repo и project или fine-grained с доступом Issues, Contents и Projects: read & write.',
  patConnect: 'Подключить',
  nothing: 'Сервер не поддерживает ни вход через GitHub, ни токен. Проверьте настройки сервера.',
  logout: 'Выйти',
  logoutConfirm: 'Отключить GitHub?',
  logoutYes: 'Отключить',
  logoutNo: 'Отмена',
  logoutHint: 'Токен будет удалён с сервера. Новые комментарии перестанут создавать issues.',
  repo: 'Репозиторий',
  repoPlaceholder: 'Найти репозиторий…',
  repoHint: 'Показаны репозитории, где у вас есть права на запись.',
  reposLoading: 'Загружаем репозитории…',
  reposEmpty: 'Нет репозиториев, где у вас есть права на запись. Создайте репозиторий на GitHub или попросите доступ.',
  reposEmptyApp: 'Приложению пока не открыт ни один репозиторий, где у вас есть права на запись. Откройте доступ на GitHub и обновите страницу.',
  manageRepos: 'Изменить доступ к репозиториям на GitHub',
  reposNotFound: 'Ничего не найдено',
  private: 'private',
  noIssues: 'issues выкл.',
  project: 'Проект',
  projectOptional: 'необязательно',
  noProject: 'Без проекта',
  projectsLoading: 'Загружаем проекты…',
  projectsEmpty: (owner: string) => `У ${owner} нет проектов GitHub. Issues будут создаваться без проекта.`,
  projectsPickRepo: 'Сначала выберите репозиторий.',
  projectsHint: (owner: string) => `Проекты (Projects v2) владельца ${owner}.`,
  closed: 'закрыт',
  save: 'Сохранить',
  saving: 'Сохраняем…',
  saved: 'Сохранено.',
  current: 'Сейчас комментарии создают issues в',
  currentProject: 'и добавляются в проект',
  notConfigured: 'Репозиторий ещё не выбран: комментарии пока не попадают в GitHub.',
  retry: 'Повторить',
  relogin: 'Войти заново',
  offline: 'Нет связи с сервером. Проверьте подключение и попробуйте ещё раз.',
  scopes: (s: string[]) => `Токену не хватает прав: ${s.join(', ')}. Выйдите и войдите снова, чтобы выдать их.`,
  ownedBy: (login: string) => `GitHub уже подключил @${login}. Войдите этим аккаунтом, чтобы изменить настройки.`,
  syncProblem: (msg: string | undefined, pending: number) =>
    [msg ? `Последняя ошибка отправки в GitHub: ${msg}` : '', pending ? `Ждут отправки: ${pending} ${plural(pending, 'комментарий', 'комментария', 'комментариев')}. Мы повторим автоматически.` : '']
      .filter(Boolean)
      .join(' '),
};

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

interface State {
  phase: 'loading' | 'error' | 'signedOut' | 'connected';
  status: SettingsStatus | null;
  error: ApiError | null;
  repos: { loading: boolean; items: SettingsRepo[]; error: ApiError | null };
  projects: { owner: string | null; loading: boolean; items: SettingsProject[]; error: ApiError | null };
  repo: string | null;
  projectId: string | null;
  saving: boolean;
  notice: { kind: 'ok' | 'error'; text: string; relogin?: boolean } | null;
  confirmLogout: boolean;
  busy: boolean;
}

/** Defines `<comenta-settings>` (once). Call it in the browser before using the tag. */
export function defineSettingsElement(tag = SETTINGS_TAG): void {
  if (typeof customElements === 'undefined' || customElements.get(tag)) return;
  customElements.define(tag, createSettingsElementClass());
}

export function createSettingsElementClass(): CustomElementConstructor {
  return class ComentaSettingsElement extends HTMLElement {
    /** Extra request headers (e.g. CSRF token), or a function returning them. */
    headers: HeadersInput | undefined;
    /** Custom fetch (tests). */
    fetchImpl: typeof fetch | undefined;

    private root: ShadowRoot;
    private card!: HTMLDivElement;
    private st: State = {
      phase: 'loading',
      status: null,
      error: null,
      repos: { loading: false, items: [], error: null },
      projects: { owner: null, loading: false, items: [], error: null },
      repo: null,
      projectId: null,
      saving: false,
      notice: null,
      confirmLogout: false,
      busy: false,
    };
    private query = '';
    private listOpen = false;
    private active = -1;
    private projectsReq = 0;
    private refs: {
      input?: HTMLInputElement;
      list?: HTMLUListElement;
      reposBox?: HTMLElement;
      projectsBox?: HTMLElement;
      footer?: HTMLElement;
      account?: HTMLElement;
    } = {};

    static get observedAttributes() {
      return ['endpoint'];
    }

    constructor() {
      super();
      this.root = this.attachShadow({ mode: 'open' });
    }

    get endpoint(): string {
      return (this.getAttribute('endpoint') || '/api/github').replace(/\/$/, '');
    }
    set endpoint(v: string) {
      this.setAttribute('endpoint', v);
    }

    connectedCallback() {
      if (!this.card) {
        const style = document.createElement('style');
        style.textContent = SETTINGS_STYLES;
        this.card = h(document, 'div', { class: 'cs', part: 'card' });
        this.root.append(style, this.card);
      }
      void this.reload();
    }

    attributeChangedCallback(_name: string, old: string | null, value: string | null) {
      if (this.card && old !== value) void this.reload();
    }

    /** Re-read the status from the server. */
    async reload(): Promise<void> {
      this.st.phase = 'loading';
      this.render();
      // an error from the OAuth callback (?comenta_error=...) is shown once
      const url = new URL(window.location.href);
      const cbError = url.searchParams.get('comenta_error');
      if (cbError) {
        url.searchParams.delete('comenta_error');
        history.replaceState(history.state, '', url.pathname + (url.search || '') + url.hash);
      }
      try {
        const status = await this.api<SettingsStatus>('GET', '/status');
        this.applyStatus(status);
        if (cbError) this.st.notice = { kind: 'error', text: cbError };
      } catch (err) {
        this.st.phase = 'error';
        this.st.error = asError(err);
      }
      this.render();
      if ((this.st.phase as State['phase']) === 'connected') void this.loadRepos();
    }

    private applyStatus(status: SettingsStatus) {
      this.st.status = status;
      this.st.error = null;
      this.st.confirmLogout = false;
      this.st.phase = status.connected ? 'connected' : 'signedOut';
      this.st.repo = status.config?.repo.fullName ?? null;
      this.st.projectId = status.config?.project?.id ?? null;
      this.query = '';
    }

    // ------------------------------------------------------------ server

    private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
      const doFetch = this.fetchImpl ?? window.fetch.bind(window);
      const extra = typeof this.headers === 'function' ? this.headers() : this.headers;
      let res: Response;
      try {
        res = await doFetch(this.endpoint + path, {
          method,
          credentials: 'same-origin',
          headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch {
        throw { code: 'offline', message: M.offline } satisfies ApiError;
      }
      const data = (await res.json().catch(() => null)) as (T & { error?: ApiError }) | null;
      if (!res.ok || data?.error) {
        throw (data?.error ?? { code: 'http', message: `Сервер ответил ${res.status}` }) satisfies ApiError;
      }
      return data as T;
    }

    /** Token expired mid-session: back to the sign-in view with the "expired" banner. */
    private handleAuthError(err: ApiError): boolean {
      if (err.code !== 'unauthorized') return false;
      const status: SettingsStatus = { ...(this.st.status ?? { oauth: true, pat: true }), connected: false, reason: 'expired', syncing: !!this.st.status?.bot };
      this.applyStatus(status);
      this.render();
      return true;
    }

    private async loadRepos() {
      this.st.repos = { loading: true, items: this.st.repos.items, error: null };
      this.renderRepos();
      try {
        const { items } = await this.api<{ items: SettingsRepo[] }>('GET', '/repos');
        this.st.repos = { loading: false, items, error: null };
      } catch (err) {
        const e = asError(err);
        if (this.handleAuthError(e)) return;
        this.st.repos = { loading: false, items: [], error: e };
      }
      this.renderRepos();
      const owner = this.selectedOwner();
      if (owner) void this.loadProjects(owner);
      else this.renderProjects();
    }

    private async loadProjects(owner: string) {
      const req = ++this.projectsReq;
      this.st.projects = { owner, loading: true, items: [], error: null };
      this.renderProjects();
      try {
        const { items } = await this.api<{ items: SettingsProject[] }>('GET', `/projects?owner=${encodeURIComponent(owner)}`);
        if (req !== this.projectsReq) return;
        this.st.projects = { owner, loading: false, items, error: null };
        if (this.st.projectId && !items.some((p) => p.id === this.st.projectId)) this.st.projectId = null;
      } catch (err) {
        if (req !== this.projectsReq) return;
        const e = asError(err);
        if (this.handleAuthError(e)) return;
        this.st.projects = { owner, loading: false, items: [], error: e };
      }
      this.renderProjects();
      this.renderFooter();
    }

    private selectedOwner(): string | null {
      return this.st.repo ? this.st.repo.split('/')[0] : null;
    }

    private login() {
      const back = window.location.pathname + window.location.search;
      window.location.assign(`${this.endpoint}/auth/login?return=${encodeURIComponent(back)}`);
    }

    private async connectToken(token: string) {
      this.st.busy = true;
      this.st.notice = null;
      this.render();
      try {
        const status = await this.api<SettingsStatus>('POST', '/auth/token', { token });
        this.applyStatus(status);
        this.st.busy = false;
        this.render();
        void this.loadRepos();
      } catch (err) {
        this.st.busy = false;
        this.st.notice = { kind: 'error', text: asError(err).message };
        this.render();
      }
    }

    private async logout() {
      this.st.busy = true;
      this.renderAccount();
      try {
        const status = await this.api<SettingsStatus>('POST', '/auth/logout', {});
        this.applyStatus(status);
        this.st.notice = null;
        this.dispatchEvent(new CustomEvent('comenta-settings-logout', { bubbles: true, composed: true }));
      } catch (err) {
        this.st.notice = { kind: 'error', text: asError(err).message };
      }
      this.st.busy = false;
      this.render();
    }

    private async save() {
      if (!this.st.repo) return;
      this.st.saving = true;
      this.st.notice = null;
      this.renderFooter();
      try {
        const { config } = await this.api<{ config: SettingsConfig }>('PUT', '/config', { repo: this.st.repo, projectId: this.st.projectId });
        if (this.st.status) this.st.status = { ...this.st.status, config };
        this.st.notice = { kind: 'ok', text: M.saved };
        this.dispatchEvent(new CustomEvent('comenta-settings-save', { detail: config, bubbles: true, composed: true }));
      } catch (err) {
        const e = asError(err);
        this.st.saving = false;
        if (this.handleAuthError(e)) return;
        this.st.notice = { kind: 'error', text: e.message };
      }
      this.st.saving = false;
      this.renderFooter();
    }

    // ------------------------------------------------------------ render

    private render() {
      const d = document;
      const head = h(d, 'div', { class: 'cs-head' }, [
        ghLogo(d, 'cs-logo'),
        h(d, 'div', {}, [h(d, 'h2', { class: 'cs-title' }, [M.title]), h(d, 'p', { class: 'cs-sub' }, [M.sub])]),
      ]);
      this.refs = {};
      let body: HTMLElement;
      switch (this.st.phase) {
        case 'loading':
          body = h(d, 'div', { class: 'cs-loading', role: 'status' }, [h(d, 'span', { class: 'cs-spin' }), M.loading]);
          break;
        case 'error':
          body = h(d, 'div', { class: 'cs-body' }, [this.note('error', this.st.error?.message ?? M.offline, M.retry, () => void this.reload())]);
          break;
        case 'signedOut':
          body = this.signedOutView();
          break;
        default:
          body = this.connectedView();
      }
      this.card.replaceChildren(head, body);
      this.card.setAttribute('data-phase', this.st.phase);
    }

    private note(kind: 'error' | 'warn' | 'ok' | 'info', text: string, action?: string, onAction?: () => void): HTMLElement {
      const d = document;
      const kids: Node[] = [h(d, 'span', {}, [text])];
      if (action && onAction) {
        const b = h(d, 'button', { type: 'button', class: 'cs-btn' }, [action]);
        b.addEventListener('click', onAction);
        kids.push(b);
      }
      return h(d, 'div', { class: `cs-note cs-note-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, kids);
    }

    private signedOutView(): HTMLElement {
      const d = document;
      const s = this.st.status!;
      const kids: Node[] = [];
      if (s.reason === 'expired') kids.push(s.syncing ? this.note('info', M.sessionExpired) : this.note('warn', M.expired));
      if (s.owner) kids.push(this.note('info', M.ownedBy(s.owner)));
      if (this.st.notice?.kind === 'error') kids.push(this.note('error', this.st.notice.text));
      if (s.oauth) {
        const btn = h(d, 'button', { type: 'button', class: 'cs-btn cs-btn-gh cs-login' }, [ghLogo(d, ''), s.reason === 'expired' ? M.relogin : M.login]);
        btn.addEventListener('click', () => this.login());
        kids.push(h(d, 'div', { class: 'cs-field' }, [btn, h(d, 'span', { class: 'cs-hint' }, [M.loginHint])]));
      } else if (s.pat) {
        kids.push(this.note('info', M.noOauth));
      }
      if (s.pat) {
        const input = h(d, 'input', { class: 'cs-input cs-token', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'ghp_… / github_pat_…', 'aria-label': M.patLabel });
        const go = h(d, 'button', { type: 'submit', class: 'cs-btn cs-btn-primary' }, [M.patConnect]);
        const form = h(d, 'form', { class: 'cs-field' }, [
          h(d, 'label', { class: 'cs-label' }, [M.patLabel]),
          h(d, 'div', { class: 'cs-row' }, [input, go]),
          h(d, 'span', { class: 'cs-hint' }, [M.patHint]),
        ]);
        const sync = () => (go.disabled = this.st.busy || !input.value.trim());
        input.addEventListener('input', sync);
        sync();
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          if (input.value.trim()) void this.connectToken(input.value.trim());
        });
        if (s.oauth) {
          const det = h(d, 'details', { class: 'cs-details' }, [h(d, 'summary', {}, [M.patSummary]), form]);
          kids.push(det);
        } else kids.push(form);
      }
      if (!s.oauth && !s.pat) kids.push(this.note('error', M.nothing));
      return h(d, 'div', { class: 'cs-body' }, kids);
    }

    private connectedView(): HTMLElement {
      const d = document;
      const s = this.st.status!;
      const kids: Node[] = [];
      const account = h(d, 'div', { class: 'cs-account-wrap' });
      this.refs.account = account;
      kids.push(account);
      if (s.missingScopes?.length) kids.push(this.note('warn', M.scopes(s.missingScopes)));
      if (s.sync?.lastError || s.sync?.pending) kids.push(this.note('warn', M.syncProblem(s.sync.lastError?.message, s.sync.pending)));

      const reposBox = h(d, 'div', { class: 'cs-field' });
      const projectsBox = h(d, 'div', { class: 'cs-field' });
      const footer = h(d, 'div', { class: 'cs-footer-wrap' });
      Object.assign(this.refs, { reposBox, projectsBox, footer });
      kids.push(reposBox, projectsBox, footer);
      const body = h(d, 'div', { class: 'cs-body' }, kids);
      this.renderAccount();
      this.buildRepoField();
      this.renderProjects();
      this.renderFooter();
      return body;
    }

    private renderAccount() {
      const box = this.refs.account;
      const a = this.st.status?.account;
      if (!box || !a) return;
      const d = document;
      if (this.st.confirmLogout) {
        const yes = h(d, 'button', { type: 'button', class: 'cs-btn cs-btn-sm cs-btn-danger cs-logout-yes' }, [M.logoutYes]);
        const no = h(d, 'button', { type: 'button', class: 'cs-btn cs-btn-sm' }, [M.logoutNo]);
        yes.disabled = this.st.busy;
        yes.addEventListener('click', () => void this.logout());
        no.addEventListener('click', () => {
          this.st.confirmLogout = false;
          this.renderAccount();
        });
        box.replaceChildren(
          h(d, 'div', { class: 'cs-note cs-note-warn', role: 'alert' }, [
            h(d, 'span', {}, [h(d, 'b', {}, [M.logoutConfirm]), ' ', M.logoutHint]),
            h(d, 'div', { class: 'cs-row' }, [no, yes]),
          ]),
        );
        no.focus();
        return;
      }
      const out = h(d, 'button', { type: 'button', class: 'cs-btn cs-btn-sm cs-logout' }, [M.logout]);
      out.addEventListener('click', () => {
        this.st.confirmLogout = true;
        this.renderAccount();
      });
      box.replaceChildren(
        h(d, 'div', { class: 'cs-account' }, [
          h(d, 'img', { class: 'cs-avatar', src: a.avatarUrl, alt: '', width: 36, height: 36 }),
          h(d, 'div', { class: 'cs-who' }, [
            h(d, 'b', { class: 'cs-name' }, [a.name || a.login]),
            h(d, 'a', { href: a.htmlUrl, target: '_blank', rel: 'noopener noreferrer' }, [`@${a.login}`]),
          ]),
          out,
        ]),
      );
    }

    // ---- repository combobox

    private buildRepoField() {
      const box = this.refs.reposBox!;
      const d = document;
      const id = 'cs-repos';
      const input = h(d, 'input', {
        class: 'cs-input cs-repo-input',
        type: 'text',
        role: 'combobox',
        'aria-autocomplete': 'list',
        'aria-expanded': 'false',
        'aria-controls': id,
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: M.repoPlaceholder,
        'aria-label': M.repo,
      });
      input.value = this.st.repo ?? '';
      const list = h(d, 'ul', { class: 'cs-list', id, role: 'listbox', 'aria-label': M.repo, hidden: true });
      this.refs.input = input;
      this.refs.list = list;
      input.addEventListener('focus', () => {
        input.select();
        this.query = '';
        this.openList();
      });
      input.addEventListener('click', () => this.openList());
      input.addEventListener('input', () => {
        this.query = input.value;
        this.active = 0;
        this.openList();
      });
      input.addEventListener('keydown', (e) => this.onComboKey(e));
      input.addEventListener('blur', () => {
        // a click on an option fires mousedown first (prevented), so blur here means "left the field"
        setTimeout(() => {
          if (this.root.activeElement === input) return;
          this.closeList();
          input.value = this.st.repo ?? '';
        }, 0);
      });
      list.addEventListener('mousedown', (e) => e.preventDefault());
      box.replaceChildren(
        h(d, 'label', { class: 'cs-label', for: 'cs-repo-input' }, [M.repo]),
        h(d, 'div', { class: 'cs-combo' }, [searchIcon(d), input, list]),
        h(d, 'div', { class: 'cs-repos-state' }),
      );
      input.id = 'cs-repo-input';
      this.renderRepos();
    }

    private filtered(): SettingsRepo[] {
      const q = this.query.trim().toLowerCase();
      const items = this.st.repos.items;
      return q ? items.filter((r) => r.fullName.toLowerCase().includes(q)) : items;
    }

    private renderRepos() {
      const box = this.refs.reposBox;
      if (!box) return;
      const d = document;
      const state = box.querySelector('.cs-repos-state')!;
      const r = this.st.repos;
      const input = this.refs.input!;
      input.disabled = !r.items.length;
      input.placeholder = r.loading && !r.items.length ? M.reposLoading : M.repoPlaceholder;
      if (r.error) state.replaceChildren(this.note('error', r.error.message, M.retry, () => void this.loadRepos()));
      else if (!r.loading && !r.items.length) state.replaceChildren(this.note('info', this.st.status?.app ? M.reposEmptyApp : M.reposEmpty), ...this.manageLink());
      else if (r.loading) state.replaceChildren(h(d, 'span', { class: 'cs-hint', role: 'status' }, [M.reposLoading]));
      else state.replaceChildren(h(d, 'span', { class: 'cs-hint' }, [M.repoHint]), ...this.manageLink());
      if (this.listOpen) this.renderList();
    }

    /** Repository access of a GitHub App is managed on GitHub; a new tab keeps the unsaved choice here. */
    private manageLink(): HTMLElement[] {
      if (!this.st.status?.app) return [];
      const back = window.location.pathname + window.location.search;
      return [h(document, 'a', { class: 'cs-manage', href: `${this.endpoint}/auth/install?return=${encodeURIComponent(back)}`, target: '_blank', rel: 'noopener noreferrer' }, [M.manageRepos])];
    }

    private openList() {
      if (!this.st.repos.items.length) return;
      this.listOpen = true;
      if (this.active < 0) this.active = Math.max(0, this.filtered().findIndex((r) => r.fullName === this.st.repo));
      this.renderList();
    }

    private closeList() {
      this.listOpen = false;
      this.active = -1;
      const { list, input } = this.refs;
      if (list) list.hidden = true;
      input?.setAttribute('aria-expanded', 'false');
      input?.removeAttribute('aria-activedescendant');
    }

    private renderList() {
      const { list, input } = this.refs;
      if (!list || !input) return;
      const d = document;
      const items = this.filtered();
      if (this.active >= items.length) this.active = items.length - 1;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (!items.length) {
        list.replaceChildren(h(d, 'li', { class: 'cs-empty-opt', role: 'presentation' }, [M.reposNotFound]));
        input.removeAttribute('aria-activedescendant');
        return;
      }
      list.replaceChildren(
        ...items.map((r, i) => {
          const tags: Node[] = [];
          if (r.private) tags.push(h(d, 'span', { class: 'cs-opt-tag' }, [M.private]));
          if (r.hasIssues === false) tags.push(h(d, 'span', { class: 'cs-opt-tag' }, [M.noIssues]));
          const li = h(
            d,
            'li',
            { class: `cs-opt${i === this.active ? ' cs-active' : ''}`, role: 'option', id: `cs-opt-${i}`, 'aria-selected': r.fullName === this.st.repo ? 'true' : 'false', 'data-repo': r.fullName },
            [h(d, 'span', { class: 'cs-opt-name' }, [h(d, 'span', {}, [`${r.owner}/`]), r.name]), ...tags],
          );
          li.addEventListener('click', () => this.pickRepo(r));
          li.addEventListener('mousemove', () => {
            if (this.active === i) return;
            this.active = i;
            this.renderList();
          });
          return li;
        }),
      );
      if (this.active >= 0) {
        input.setAttribute('aria-activedescendant', `cs-opt-${this.active}`);
        const el = list.children[this.active] as HTMLElement | undefined;
        el?.scrollIntoView?.({ block: 'nearest' });
      }
    }

    private onComboKey(e: KeyboardEvent) {
      const items = this.filtered();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!this.listOpen) return this.openList();
        if (!items.length) return;
        this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        this.renderList();
      } else if (e.key === 'Enter') {
        if (this.listOpen && items[this.active]) {
          e.preventDefault();
          this.pickRepo(items[this.active]);
        }
      } else if (e.key === 'Escape') {
        if (this.listOpen) {
          e.preventDefault();
          e.stopPropagation();
          this.closeList();
          this.refs.input!.value = this.st.repo ?? '';
        }
      }
    }

    private pickRepo(r: SettingsRepo) {
      const ownerChanged = this.selectedOwner() !== r.owner;
      this.st.repo = r.fullName;
      this.st.notice = null;
      this.query = '';
      this.closeList();
      this.refs.input!.value = r.fullName;
      if (ownerChanged) {
        this.st.projectId = null;
        void this.loadProjects(r.owner);
      } else this.renderProjects();
      this.renderFooter();
    }

    // ---- projects

    private renderProjects() {
      const box = this.refs.projectsBox;
      if (!box) return;
      const d = document;
      const p = this.st.projects;
      const owner = this.selectedOwner();
      const select = h(d, 'select', { class: 'cs-select cs-project', id: 'cs-project' });
      select.append(h(d, 'option', { value: '' }, [M.noProject]));
      for (const item of owner && p.owner === owner ? p.items : []) {
        select.append(h(d, 'option', { value: item.id, selected: item.id === this.st.projectId }, [`${item.title}${item.closed ? ` (${M.closed})` : ''}`]));
      }
      select.value = this.st.projectId ?? '';
      select.disabled = !owner || p.loading;
      select.addEventListener('change', () => {
        this.st.projectId = select.value || null;
        this.st.notice = null;
        this.renderFooter();
      });
      let state: Node;
      if (!owner) state = h(d, 'span', { class: 'cs-hint' }, [M.projectsPickRepo]);
      else if (p.loading) state = h(d, 'span', { class: 'cs-hint', role: 'status' }, [M.projectsLoading]);
      else if (p.error) state = this.note(p.error.code === 'forbidden' ? 'warn' : 'error', p.error.message, M.retry, () => void this.loadProjects(owner));
      else if (!p.items.length) state = h(d, 'span', { class: 'cs-hint cs-projects-empty' }, [M.projectsEmpty(owner)]);
      else state = h(d, 'span', { class: 'cs-hint' }, [M.projectsHint(owner)]);
      box.replaceChildren(
        h(d, 'label', { class: 'cs-label', for: 'cs-project' }, [M.project, ' ', h(d, 'span', { class: 'cs-hint' }, [`(${M.projectOptional})`])]),
        select,
        state,
      );
    }

    // ---- save

    private renderFooter() {
      const box = this.refs.footer;
      if (!box) return;
      const d = document;
      const cfg = this.st.status?.config;
      const dirty = (cfg?.repo.fullName ?? null) !== this.st.repo || (cfg?.project?.id ?? null) !== this.st.projectId;
      const save = h(d, 'button', { type: 'button', class: 'cs-btn cs-btn-primary cs-save' }, [this.st.saving ? M.saving : M.save]);
      save.disabled = this.st.saving || !this.st.repo || !dirty || this.st.projects.loading;
      save.addEventListener('click', () => void this.save());
      const kids: Node[] = [];
      if (this.st.notice?.kind === 'error') kids.push(this.note('error', this.st.notice.text));
      const row: Node[] = [save];
      if (this.st.notice?.kind === 'ok') row.push(h(d, 'span', { class: 'cs-ok', role: 'status' }, [`✓ ${this.st.notice.text}`]));
      kids.push(h(d, 'div', { class: 'cs-footer' }, row));
      let summary: Node;
      if (cfg) {
        const parts: Array<Node | string> = [`${M.current} `, h(d, 'b', {}, [cfg.repo.fullName])];
        if (cfg.project) parts.push(` ${M.currentProject} `, h(d, 'b', {}, [cfg.project.title]));
        parts.push('.');
        summary = h(d, 'p', { class: 'cs-saved' }, parts);
      } else summary = h(d, 'p', { class: 'cs-saved' }, [M.notConfigured]);
      kids.push(summary);
      box.replaceChildren(...kids);
    }
  };
}

function asError(err: unknown): ApiError {
  if (err && typeof err === 'object' && 'message' in err) {
    const e = err as { code?: string; message: string };
    return { code: e.code ?? 'error', message: e.message };
  }
  return { code: 'error', message: String(err) };
}
