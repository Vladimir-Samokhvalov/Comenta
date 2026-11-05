import { h } from '../ui/h';
import { SETTINGS_STYLES } from './styles';

/**
 * `<comenta-settings endpoint="/api/github">` — the site owner's page for the tracker integration:
 * sign in, pick a repository / project (searchable) and, on GitHub, optionally a Project v2, save, sign out.
 *
 * `providers="github gitlab"` offers a choice of tracker (a site connects exactly one); `gitlab-endpoint`
 * (default `/api/gitlab`) is where the GitLab backend lives. GitLab sign-in asks for the GitLab address
 * (gitlab.com or self-hosted) and sends `url` along: `GET {gitlab-endpoint}/auth/login?return=&url=`,
 * `POST {gitlab-endpoint}/auth/token { token, url }`, `GET /repos?q=` (search when the list was cut),
 * `PUT /config { id, repo }`. Statuses carry `active` (this tracker is the site's) and `blockedBy`.
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
  /** GitLab project id. */
  id?: number;
  /** Human name (GitLab). */
  title?: string;
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
  repo: { owner: string; name: string; fullName: string; htmlUrl?: string; id?: number; title?: string };
  project?: SettingsProject | null;
}
export type SettingsProvider = 'github' | 'gitlab';

export interface SettingsStatus {
  provider?: SettingsProvider;
  /** A GitHub App / GitLab OAuth application is configured on the server, so "Sign in" works. */
  oauth: boolean;
  /** This tracker is the site's (connected, or configured and not signed out on purpose). */
  active?: boolean;
  /** The site uses the other tracker: `GitHub` / `GitLab`. */
  blockedBy?: string;
  /** GitLab: instances with an OAuth application, and the address to offer first. */
  instances?: string[];
  defaultUrl?: string;
  /** GitLab: the instance the owner is connected to. */
  instanceUrl?: string;
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
// GitLab's tanuki (Simple Icons, CC0)
const GL_PATH =
  'm23.6 9.593-.034-.086L20.3.98a.851.851 0 0 0-.336-.405.875.875 0 0 0-1 .054.875.875 0 0 0-.29.44l-2.205 6.748H7.538L5.332 1.07a.857.857 0 0 0-.29-.441.875.875 0 0 0-1-.054.859.859 0 0 0-.336.405L.433 9.502l-.032.086a6.066 6.066 0 0 0 2.012 7.01l.011.009.03.021 4.976 3.727 2.462 1.863 1.5 1.132a1.009 1.009 0 0 0 1.22 0l1.499-1.132 2.462-1.863 5.006-3.749.012-.01a6.068 6.068 0 0 0 2.01-7.003z';
const glLogo = (doc: Document, cls: string) => svg(doc, cls, '0 0 24 24', GL_PATH, true);
const logo = (p: SettingsProvider, doc: Document, cls: string) => (p === 'gitlab' ? glLogo(doc, cls) : ghLogo(doc, cls));
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

type Messages = typeof M;

/** GitLab wording; everything not listed is the same as for GitHub. */
const GL_M: Partial<Messages> & {
  instance: string;
  instanceHint: string;
  instanceAt: (host: string) => string;
  searchMore: string;
  searching: string;
} = {
  title: 'Интеграция с GitLab',
  sub: 'Комментарии с сайта будут превращаться в issues в выбранном проекте GitLab: на gitlab.com или на вашем сервере.',
  login: 'Войти через GitLab',
  loginHint: 'GitLab попросит разрешить доступ (права api и read_user). Токен хранится на вашем сервере, браузер его не видит.',
  expired: 'Доступ к GitLab истёк или был отозван. Войдите заново, чтобы комментарии снова попадали в issues.',
  sessionExpired: 'Сессия входа в GitLab истекла. Войдите заново, чтобы менять настройки.',
  noOauth: 'Вход через GitLab не настроен на сервере: нет OAuth-приложения. Для локальной разработки можно вставить токен.',
  patHint: 'Personal access token с правами api (GitLab → Preferences → Access tokens).',
  nothing: 'Сервер не поддерживает ни вход через GitLab, ни токен. Проверьте настройки сервера.',
  logoutConfirm: 'Отключить GitLab?',
  repo: 'Проект',
  repoPlaceholder: 'Найти проект…',
  repoHint: 'Показаны проекты, где у вас роль Reporter или выше, в том числе проекты групп.',
  reposLoading: 'Загружаем проекты…',
  reposEmpty: 'Нет проектов, где у вас роль Reporter или выше. Создайте проект в GitLab или попросите доступ.',
  noIssues: 'issues выкл.',
  notConfigured: 'Проект ещё не выбран: комментарии пока не попадают в GitLab.',
  scopes: (s: string[]) => `Токену не хватает прав: ${s.join(', ')}. Выйдите и войдите снова, чтобы выдать их.`,
  ownedBy: (login: string) => `GitLab уже подключил @${login}. Войдите этим аккаунтом, чтобы изменить настройки.`,
  syncProblem: (msg: string | undefined, pending: number) =>
    [msg ? `Последняя ошибка отправки в GitLab: ${msg}` : '', pending ? `Ждут отправки: ${pending} ${plural(pending, 'комментарий', 'комментария', 'комментариев')}. Мы повторим автоматически.` : '']
      .filter(Boolean)
      .join(' '),
  instance: 'Адрес GitLab',
  instanceHint: 'gitlab.com или адрес вашего сервера, например https://gitlab.example.com',
  instanceAt: (host: string) => `на ${host}`,
  searchMore: 'Показаны не все проекты: начните вводить название, чтобы искать по всем.',
  searching: 'Ищем в GitLab…',
};

const PROVIDER_NAMES: Record<SettingsProvider, string> = { github: 'GitHub', gitlab: 'GitLab' };
const CHOOSE = {
  label: 'Куда отправлять комментарии',
  blocked: (other: string) => `Сайт уже подключён к ${other}. Сайт работает с одним трекером: чтобы перейти, сначала отключите ${other}.`,
};

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

interface State {
  phase: 'loading' | 'error' | 'siteSignIn' | 'signedOut' | 'connected';
  /** Site sign-in (Google, Yandex, Keycloak) that the tracker settings need first. */
  site?: { code: 'signin_required' | 'not_owner'; message: string; providers: Array<{ id: string; label: string }> };
  /** The tracker shown. */
  provider: SettingsProvider;
  /** Statuses of every offered tracker (null: could not be read). */
  statuses: Partial<Record<SettingsProvider, SettingsStatus | null>>;
  status: SettingsStatus | null;
  error: ApiError | null;
  repos: { loading: boolean; items: SettingsRepo[]; error: ApiError | null; complete?: boolean; search?: { q: string; items: SettingsRepo[]; loading: boolean } | null };
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
      provider: 'github',
      statuses: {},
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

    private searchTimer: ReturnType<typeof setTimeout> | undefined;

    static get observedAttributes() {
      return ['endpoint', 'gitlab-endpoint', 'providers', 'auth-endpoint'];
    }

    constructor() {
      super();
      this.root = this.attachShadow({ mode: 'open' });
    }

    /** The GitHub backend. */
    get endpoint(): string {
      return (this.getAttribute('endpoint') || '/api/github').replace(/\/$/, '');
    }
    set endpoint(v: string) {
      this.setAttribute('endpoint', v);
    }

    /** Trackers offered, in order: `providers="github gitlab"`. Default: GitHub only. */
    get providers(): SettingsProvider[] {
      const list = (this.getAttribute('providers') || 'github').split(/[\s,]+/).filter((p): p is SettingsProvider => p === 'github' || p === 'gitlab');
      return list.length ? [...new Set(list)] : ['github'];
    }

    /** Sign-in of the site (`auth-endpoint`, default `/api/auth`): the settings are for the site owner. */
    private get authBase(): string {
      return (this.getAttribute('auth-endpoint') || '/api/auth').replace(/\/$/, '');
    }

    private base(p: SettingsProvider = this.st.provider): string {
      return p === 'gitlab' ? (this.getAttribute('gitlab-endpoint') || '/api/gitlab').replace(/\/$/, '') : this.endpoint;
    }

    /** Messages of the tracker shown. */
    private get M(): Messages & Partial<typeof GL_M> {
      return this.st.provider === 'gitlab' ? { ...M, ...GL_M } : M;
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
      const cbProvider = url.searchParams.get('comenta_provider');
      if (cbError || cbProvider) {
        url.searchParams.delete('comenta_error');
        url.searchParams.delete('comenta_provider');
        history.replaceState(history.state, '', url.pathname + (url.search || '') + url.hash);
      }
      const providers = this.providers;
      const results = await Promise.all(providers.map((p) => this.api<SettingsStatus>('GET', '/status', undefined, p).then((s) => ({ p, s, e: null as ApiError | null }), (e) => ({ p, s: null, e: asError(e) }))));
      this.st.statuses = Object.fromEntries(results.map((r) => [r.p, r.s]));
      // the site's tracker; else the one the sign-in came back from; else the one shown; else the first
      const active = results.find((r) => r.s?.active)?.p;
      const back = providers.find((p) => p === cbProvider);
      this.st.provider = active ?? back ?? (providers.includes(this.st.provider) ? this.st.provider : providers[0]);
      const mine = results.find((r) => r.p === this.st.provider)!;
      if (mine.s) {
        this.applyStatus(mine.s);
        if (cbError) this.st.notice = { kind: 'error', text: cbError };
      } else if (mine.e && (mine.e.code === 'signin_required' || mine.e.code === 'not_owner')) {
        // the server wants the site owner signed in first
        let providers: Array<{ id: string; label: string }> = [];
        try {
          const res = await (this.fetchImpl ?? window.fetch.bind(window))(`${this.authBase}/me`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
          const me = (await res.json()) as { providers?: Array<{ id: string; label: string }> };
          providers = Array.isArray(me.providers) ? me.providers.filter((p) => typeof p?.id === 'string' && typeof p?.label === 'string') : [];
        } catch {
          /* no sign-in routes: only the message */
        }
        this.st.phase = 'siteSignIn';
        this.st.site = { code: mine.e.code, message: mine.e.message, providers };
      } else {
        this.st.phase = 'error';
        this.st.error = mine.e;
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
      this.st.statuses[this.st.provider] = status;
      this.query = '';
    }

    /** Show another tracker (only while none is the site's). */
    private choose(p: SettingsProvider) {
      if (p === this.st.provider) return;
      this.st.provider = p;
      this.st.notice = null;
      this.st.repos = { loading: false, items: [], error: null };
      this.st.projects = { owner: null, loading: false, items: [], error: null };
      void this.reload(); // fresh: the other tracker may have been connected or disconnected meanwhile
    }

    // ------------------------------------------------------------ server

    private async api<T>(method: string, path: string, body?: unknown, provider: SettingsProvider = this.st.provider): Promise<T> {
      const doFetch = this.fetchImpl ?? window.fetch.bind(window);
      const extra = typeof this.headers === 'function' ? this.headers() : this.headers;
      let res: Response;
      try {
        res = await doFetch(this.base(provider) + path, {
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
      const status: SettingsStatus = { ...(this.st.status ?? { oauth: true, pat: true }), connected: false, reason: 'expired', syncing: !!this.st.status?.bot, account: undefined };
      this.applyStatus(status);
      this.render();
      return true;
    }

    private async loadRepos() {
      this.st.repos = { loading: true, items: this.st.repos.items, error: null };
      this.renderRepos();
      try {
        const { items, complete } = await this.api<{ items: SettingsRepo[]; complete?: boolean }>('GET', '/repos');
        this.st.repos = { loading: false, items, error: null, complete: complete !== false, search: null };
      } catch (err) {
        const e = asError(err);
        if (this.handleAuthError(e)) return;
        this.st.repos = { loading: false, items: [], error: e };
      }
      this.renderRepos();
      if (this.st.provider !== 'github') return; // Projects v2 are GitHub's
      const owner = this.selectedOwner();
      if (owner) void this.loadProjects(owner);
      else this.renderProjects();
    }

    /** The list was cut (very many GitLab projects): ask the server for what the owner types. */
    private searchServer(q: string) {
      clearTimeout(this.searchTimer);
      const query = q.trim();
      if (this.st.repos.complete !== false || query.length < 2) {
        if (this.st.repos.search) this.st.repos.search = null;
        return;
      }
      this.st.repos.search = { q: query, items: this.st.repos.search?.items ?? [], loading: true };
      this.searchTimer = setTimeout(async () => {
        try {
          const { items } = await this.api<{ items: SettingsRepo[] }>('GET', `/repos?q=${encodeURIComponent(query)}`);
          if (this.st.repos.search?.q !== query) return;
          this.st.repos.search = { q: query, items, loading: false };
        } catch {
          if (this.st.repos.search?.q === query) this.st.repos.search = { q: query, items: [], loading: false };
        }
        this.renderRepos();
      }, 300);
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

    /** GitLab address typed on the sign-in view. */
    private instance = '';

    private login() {
      const back = window.location.pathname + window.location.search;
      const extra = this.st.provider === 'gitlab' ? `&url=${encodeURIComponent(this.instance || this.st.status?.defaultUrl || '')}` : '';
      window.location.assign(`${this.base()}/auth/login?return=${encodeURIComponent(back)}${extra}`);
    }

    private async connectToken(token: string) {
      this.st.busy = true;
      this.st.notice = null;
      this.render();
      try {
        const status = await this.api<SettingsStatus>('POST', '/auth/token', this.st.provider === 'gitlab' ? { token, url: this.instance || this.st.status?.defaultUrl } : { token });
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
        const picked = [...this.st.repos.items, ...(this.st.repos.search?.items ?? [])].find((r) => r.fullName === this.st.repo);
        const body = this.st.provider === 'gitlab' ? { repo: this.st.repo, id: picked?.id ?? (this.st.status?.config?.repo.fullName === this.st.repo ? this.st.status?.config?.repo.id : undefined) } : { repo: this.st.repo, projectId: this.st.projectId };
        const { config } = await this.api<{ config: SettingsConfig }>('PUT', '/config', body);
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
      const M = this.M;
      const head = h(d, 'div', { class: 'cs-head' }, [
        logo(this.st.provider, d, 'cs-logo'),
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
        case 'siteSignIn':
          body = this.siteSignInView();
          break;
        case 'signedOut':
          body = this.signedOutView();
          break;
        default:
          body = this.connectedView();
      }
      const chooser = this.chooser();
      this.card.replaceChildren(...(chooser ? [head, chooser, body] : [head, body]));
      this.card.setAttribute('data-phase', this.st.phase);
      this.card.setAttribute('data-provider', this.st.provider);
    }

    /** GitHub | GitLab switch, when more than one tracker is offered. The other one is locked while one is in use. */
    private chooser(): HTMLElement | null {
      const providers = this.providers;
      if (providers.length < 2) return null;
      const d = document;
      const activeOne = providers.find((p) => this.st.statuses[p]?.active);
      const tabs = providers.map((p) => {
        const locked = !!activeOne && activeOne !== p;
        const b = h(
          d,
          'button',
          {
            type: 'button',
            role: 'radio',
            class: 'cs-choice',
            'data-provider': p,
            'aria-checked': p === this.st.provider ? 'true' : 'false',
            title: locked ? CHOOSE.blocked(PROVIDER_NAMES[activeOne!]) : null,
          },
          [logo(p, d, ''), PROVIDER_NAMES[p]],
        );
        b.disabled = locked;
        b.addEventListener('click', () => this.choose(p));
        return b;
      });
      return h(d, 'div', { class: 'cs-chooser' }, [
        h(d, 'span', { class: 'cs-label' }, [CHOOSE.label]),
        h(d, 'div', { class: 'cs-choices', role: 'radiogroup', 'aria-label': CHOOSE.label }, tabs),
      ]);
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

    /** Not signed in to the site, or signed in as someone who is not the owner. */
    private siteSignInView(): HTMLElement {
      const d = document;
      const site = this.st.site!;
      const back = window.location.pathname + window.location.search;
      const kids: Node[] = [this.note(site.code === 'not_owner' ? 'warn' : 'info', site.message)];
      for (const p of site.providers) {
        kids.push(h(d, 'a', { class: 'cs-btn cs-site-login', 'data-provider': p.id, href: `${this.authBase}/login/${encodeURIComponent(p.id)}?return=${encodeURIComponent(back)}` }, [`Войти через ${p.label}`]));
      }
      if (site.code === 'not_owner') {
        const out = h(d, 'button', { type: 'button', class: 'cs-btn cs-btn-sm cs-site-logout' }, ['Выйти']);
        out.addEventListener('click', () => {
          void (this.fetchImpl ?? window.fetch.bind(window))(`${this.authBase}/logout`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .catch(() => {})
            .then(() => this.reload());
        });
        kids.push(out);
      }
      return h(d, 'div', { class: 'cs-body cs-site' }, kids);
    }

    private signedOutView(): HTMLElement {
      const d = document;
      const s = this.st.status!;
      const M = this.M;
      const gl = this.st.provider === 'gitlab';
      const kids: Node[] = [];
      if (s.blockedBy) kids.push(this.note('info', CHOOSE.blocked(s.blockedBy)));
      if (s.reason === 'expired') kids.push(s.syncing ? this.note('info', M.sessionExpired) : this.note('warn', M.expired));
      if (s.owner) kids.push(this.note('info', M.ownedBy(s.owner)));
      if (this.st.notice?.kind === 'error') kids.push(this.note('error', this.st.notice.text));
      if (gl && (s.oauth || s.pat)) {
        // gitlab.com or a self-hosted GitLab: the address goes along with the sign-in
        if (!this.instance) this.instance = s.defaultUrl ?? 'https://gitlab.com';
        const listId = 'cs-instances';
        const input = h(d, 'input', { class: 'cs-input cs-instance', id: 'cs-instance', type: 'url', inputmode: 'url', autocomplete: 'url', spellcheck: 'false', list: listId, placeholder: 'https://gitlab.com', 'aria-label': GL_M.instance });
        input.value = this.instance;
        input.addEventListener('input', () => (this.instance = input.value.trim()));
        const options = [...new Set([...(s.instances ?? []), 'https://gitlab.com'])].map((u) => h(d, 'option', { value: u }));
        kids.push(
          h(d, 'div', { class: 'cs-field' }, [
            h(d, 'label', { class: 'cs-label', for: 'cs-instance' }, [GL_M.instance]),
            input,
            h(d, 'datalist', { id: listId }, options),
            h(d, 'span', { class: 'cs-hint' }, [GL_M.instanceHint]),
          ]),
        );
      }
      if (s.oauth) {
        const btn = h(d, 'button', { type: 'button', class: `cs-btn cs-btn-gh cs-login${gl ? ' cs-btn-gl' : ''}` }, [logo(this.st.provider, d, ''), s.reason === 'expired' ? M.relogin : M.login]);
        btn.disabled = !!s.blockedBy;
        btn.addEventListener('click', () => this.login());
        kids.push(h(d, 'div', { class: 'cs-field' }, [btn, h(d, 'span', { class: 'cs-hint' }, [M.loginHint])]));
      } else if (s.pat) {
        kids.push(this.note('info', M.noOauth));
      }
      if (s.pat) {
        const input = h(d, 'input', { class: 'cs-input cs-token', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: gl ? 'glpat-…' : 'ghp_… / github_pat_…', 'aria-label': M.patLabel });
        const go = h(d, 'button', { type: 'submit', class: 'cs-btn cs-btn-primary' }, [M.patConnect]);
        const form = h(d, 'form', { class: 'cs-field' }, [
          h(d, 'label', { class: 'cs-label' }, [M.patLabel]),
          h(d, 'div', { class: 'cs-row' }, [input, go]),
          h(d, 'span', { class: 'cs-hint' }, [M.patHint]),
        ]);
        const sync = () => (go.disabled = this.st.busy || !input.value.trim() || !!s.blockedBy);
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
      const M = this.M;
      const kids: Node[] = [];
      const account = h(d, 'div', { class: 'cs-account-wrap' });
      this.refs.account = account;
      kids.push(account);
      if (s.missingScopes?.length) kids.push(this.note('warn', M.scopes(s.missingScopes)));
      if (s.sync?.lastError || s.sync?.pending) kids.push(this.note('warn', M.syncProblem(s.sync.lastError?.message, s.sync.pending)));

      const reposBox = h(d, 'div', { class: 'cs-field' });
      const projectsBox = this.st.provider === 'github' ? h(d, 'div', { class: 'cs-field' }) : undefined;
      const footer = h(d, 'div', { class: 'cs-footer-wrap' });
      Object.assign(this.refs, { reposBox, projectsBox, footer });
      kids.push(...(projectsBox ? [reposBox, projectsBox, footer] : [reposBox, footer]));
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
      const M = this.M;
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
            h(d, 'a', { href: a.htmlUrl, target: '_blank', rel: 'noopener noreferrer' }, [`@${a.login}`, ...(this.st.status?.instanceUrl ? [` · ${GL_M.instanceAt(hostOf(this.st.status.instanceUrl))}`] : [])]),
          ]),
          out,
        ]),
      );
    }

    // ---- repository combobox

    private buildRepoField() {
      const box = this.refs.reposBox!;
      const d = document;
      const M = this.M;
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
        this.searchServer(this.query);
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
      const search = this.st.repos.search;
      const extra = search && q.includes(search.q.toLowerCase()) ? search.items.filter((r) => !this.st.repos.items.some((x) => x.fullName === r.fullName)) : [];
      const items = [...this.st.repos.items, ...extra];
      return q ? items.filter((r) => `${r.fullName} ${r.title ?? ''}`.toLowerCase().includes(q)) : items;
    }

    private renderRepos() {
      const box = this.refs.reposBox;
      if (!box) return;
      const d = document;
      const M = this.M;
      const state = box.querySelector('.cs-repos-state')!;
      const r = this.st.repos;
      const input = this.refs.input!;
      input.disabled = !r.items.length;
      input.placeholder = r.loading && !r.items.length ? M.reposLoading : M.repoPlaceholder;
      if (r.error) state.replaceChildren(this.note('error', r.error.message, M.retry, () => void this.loadRepos()));
      else if (!r.loading && !r.items.length) state.replaceChildren(this.note('info', this.st.status?.app ? M.reposEmptyApp : M.reposEmpty), ...this.manageLink());
      else if (r.loading) state.replaceChildren(h(d, 'span', { class: 'cs-hint', role: 'status' }, [M.reposLoading]));
      else if (r.search?.loading) state.replaceChildren(h(d, 'span', { class: 'cs-hint', role: 'status' }, [GL_M.searching]));
      else state.replaceChildren(h(d, 'span', { class: 'cs-hint' }, [r.complete === false ? GL_M.searchMore : M.repoHint]), ...this.manageLink());
      if (this.listOpen) this.renderList();
    }

    /** Repository access of a GitHub App is managed on GitHub; a new tab keeps the unsaved choice here. */
    private manageLink(): HTMLElement[] {
      if (!this.st.status?.app) return [];
      const back = window.location.pathname + window.location.search;
      return [h(document, 'a', { class: 'cs-manage', href: `${this.base()}/auth/install?return=${encodeURIComponent(back)}`, target: '_blank', rel: 'noopener noreferrer' }, [M.manageRepos])];
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
      const M = this.M;
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
            [h(d, 'span', { class: 'cs-opt-name', title: r.title ?? null }, [h(d, 'span', {}, [`${r.owner}/`]), r.name]), ...tags],
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
      if (this.st.provider !== 'github') {
        // no Projects v2 outside GitHub
      } else if (ownerChanged) {
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
      const M = this.M;
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
      const M = this.M;
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

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function asError(err: unknown): ApiError {
  if (err && typeof err === 'object' && 'message' in err) {
    const e = err as { code?: string; message: string };
    return { code: e.code ?? 'error', message: e.message };
  }
  return { code: 'error', message: String(err) };
}
