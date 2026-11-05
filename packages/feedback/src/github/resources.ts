import type { GitHubClient } from './client';
import { GitHubError, MESSAGES } from './errors';

export interface GitHubRepo {
  /** `owner/name` */
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  /** Issues are enabled. */
  hasIssues: boolean;
  /** The token may push (needed to upload recordings). */
  canPush: boolean;
  /** Owner is a user or an organisation. */
  ownerType: 'User' | 'Organization';
  htmlUrl: string;
  defaultBranch: string;
  pushedAt: string | null;
}

export interface GitHubProject {
  /** GraphQL node id (what `addProjectV2ItemById` takes). */
  id: string;
  number: number;
  title: string;
  url: string;
  closed: boolean;
}

interface RawRepo {
  full_name: string;
  name: string;
  owner: { login: string; type: string };
  private: boolean;
  has_issues: boolean;
  archived?: boolean;
  html_url: string;
  default_branch: string;
  pushed_at: string | null;
  permissions?: { admin?: boolean; push?: boolean; triage?: boolean };
}

function toRepo(r: RawRepo): GitHubRepo {
  return {
    fullName: r.full_name,
    owner: r.owner.login,
    name: r.name,
    private: r.private,
    hasIssues: r.has_issues,
    canPush: !!(r.permissions?.push || r.permissions?.admin),
    ownerType: r.owner.type === 'Organization' ? 'Organization' : 'User',
    htmlUrl: r.html_url,
    defaultBranch: r.default_branch,
    pushedAt: r.pushed_at,
  };
}

/**
 * Repositories the owner can create issues in and push recordings to, most recently pushed first.
 * Archived repositories and ones without write access are left out.
 */
export async function listRepos(client: GitHubClient, opts: { maxPages?: number } = {}): Promise<GitHubRepo[]> {
  const raw = await client.paginate<RawRepo>('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member', opts.maxPages ?? 10);
  return raw.filter((r) => !r.archived).map(toRepo).filter((r) => r.canPush);
}

/** One repository with the token's permissions. Throws a clear error when issues can't be created there. */
export async function checkRepo(client: GitHubClient, owner: string, name: string): Promise<GitHubRepo> {
  const raw = await client.get<RawRepo>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  const repo = toRepo(raw);
  if (raw.archived) throw new GitHubError('forbidden', 'Репозиторий в архиве: в нём нельзя создавать issues.');
  if (!repo.canPush) throw new GitHubError('forbidden', 'Нет прав на запись в этот репозиторий. Нужны права write, чтобы создавать issues и загружать записи.');
  if (!repo.hasIssues) throw new GitHubError('issues_disabled', MESSAGES.issuesDisabled);
  return repo;
}

const PROJECTS_QUERY = /* GraphQL */ `
  query ComentaProjects($login: String!) {
    repositoryOwner(login: $login) {
      __typename
      ... on User { projectsV2(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { id number title url closed } } }
      ... on Organization { projectsV2(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { id number title url closed } } }
    }
  }
`;

/** Projects v2 of a user or organisation (open ones first). Needs the `project` or `read:project` scope. */
export async function listProjects(client: GitHubClient, owner: string): Promise<GitHubProject[]> {
  const data = await client.graphql<{ repositoryOwner: { projectsV2?: { nodes: Array<GitHubProject | null> } } | null }>(PROJECTS_QUERY, { login: owner });
  if (!data?.repositoryOwner) throw new GitHubError('not_found', MESSAGES.notFound);
  const nodes = (data.repositoryOwner.projectsV2?.nodes ?? []).filter((p): p is GitHubProject => !!p);
  return nodes.sort((a, b) => Number(a.closed) - Number(b.closed));
}
