import { projectPath, type GitLabClient } from './client';
import { GitLabError, GL_MESSAGES } from './errors';

/** Minimum role that may create, close and comment on issues: Reporter. */
export const REPORTER = 20;

export interface GitLabProject {
  /** Numeric project id: stays the same when the project is renamed or moved. */
  id: number;
  /** `group/subgroup/project` */
  fullName: string;
  /** Namespace path: the user or the (sub)group, `group/subgroup`. */
  owner: string;
  /** Project path (the last part of `fullName`). */
  name: string;
  /** Human name, `Web App`. */
  title: string;
  private: boolean;
  hasIssues: boolean;
  /** The owner's role allows issues (Reporter or higher). */
  canWrite: boolean;
  /** User namespace or a group (shown as an organisation in the settings). */
  ownerType: 'User' | 'Organization';
  htmlUrl: string;
  lastActivityAt: string | null;
}

interface RawProject {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  namespace?: { full_path: string; kind?: string };
  visibility?: string;
  archived?: boolean;
  issues_enabled?: boolean;
  issues_access_level?: string;
  web_url: string;
  last_activity_at?: string | null;
  permissions?: { project_access?: { access_level: number } | null; group_access?: { access_level: number } | null } | null;
}

function toProject(r: RawProject): GitLabProject {
  const level = Math.max(r.permissions?.project_access?.access_level ?? 0, r.permissions?.group_access?.access_level ?? 0);
  return {
    id: r.id,
    fullName: r.path_with_namespace,
    owner: r.namespace?.full_path ?? r.path_with_namespace.split('/').slice(0, -1).join('/'),
    name: r.path,
    title: r.name,
    private: r.visibility !== 'public',
    hasIssues: r.issues_enabled !== false && r.issues_access_level !== 'disabled',
    // listings asked with min_access_level don't always carry permissions: unknown counts as allowed
    canWrite: r.permissions ? level >= REPORTER : true,
    ownerType: r.namespace?.kind === 'group' ? 'Organization' : 'User',
    htmlUrl: r.web_url,
    lastActivityAt: r.last_activity_at ?? null,
  };
}

/**
 * Projects the owner can create issues in (Reporter or higher, in their own namespace or through groups
 * and subgroups), most recently active first, archived ones left out. `search` filters on GitLab's side.
 * `complete` is false when there were more than `maxPages` × 100.
 */
export async function listProjects(client: GitLabClient, opts: { search?: string; maxPages?: number } = {}): Promise<{ items: GitLabProject[]; complete: boolean }> {
  const q = new URLSearchParams({ membership: 'true', min_access_level: String(REPORTER), archived: 'false', order_by: 'last_activity_at', sort: 'desc', per_page: '100' });
  if (opts.search?.trim()) {
    q.set('search', opts.search.trim());
    q.set('search_namespaces', 'true');
  }
  const { items, complete } = await client.paginate<RawProject>(`/projects?${q}`, opts.maxPages ?? 5);
  return { items: items.filter((r) => !r.archived).map(toProject).filter((p) => p.canWrite), complete };
}

/** One project with the owner's role. Throws a clear error when issues can't be created there. */
export async function checkProject(client: GitLabClient, idOrPath: number | string): Promise<GitLabProject> {
  const raw = await client.get<RawProject>(projectPath(idOrPath));
  const p = toProject(raw);
  if (raw.archived) throw new GitLabError('forbidden', 'Проект в архиве: в нём нельзя создавать issues.');
  if (!p.canWrite) throw new GitLabError('forbidden', 'Не хватает прав в этом проекте: нужна роль Reporter или выше, чтобы создавать и закрывать issues.');
  if (!p.hasIssues) throw new GitLabError('issues_disabled', GL_MESSAGES.issuesDisabled);
  return p;
}
