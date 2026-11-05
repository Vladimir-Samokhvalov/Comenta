/**
 * Server-side GitHub integration (`@comenta/feedback/github`). Runs where the owner's token lives:
 * Node 18+, Deno, Bun, edge runtimes — anything with `fetch`. Never ship it to the browser.
 */
export { GitHubClient, scopeMessage } from './client';
export type { GitHubClientOptions, RequestOptions, GitHubResponse } from './client';
export { GitHubError, rateLimitMessage } from './errors';
export type { GitHubErrorCode } from './errors';
export { authorizeUrl, exchangeCode, revokeGrant, getAccount, DEFAULT_SCOPES } from './oauth';
export type { OAuthAppOptions, TokenResult, GitHubAccount } from './oauth';
export { listRepos, checkRepo, listProjects } from './resources';
export type { GitHubRepo, GitHubProject } from './resources';
export { issueTitle, issueBody, attachmentCaption, formatDuration, neutralize, marker } from './issue';
export type { UploadedAttachment } from './issue';
export { syncComment, findIssue, addToProject, uploadAttachments, ensureBranch } from './sync';
export type { GitHubTarget, SyncFile, SyncOptions, SyncResult } from './sync';
