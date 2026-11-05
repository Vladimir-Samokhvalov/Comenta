/**
 * Server-side GitLab integration (`@comenta/feedback/gitlab`), gitlab.com and self-hosted.
 * Runs where the owner's token lives: Node 18+, Deno, Bun — anything with `fetch` and `FormData`.
 * Never ship it to the browser.
 */
export { GitLabClient, normalizeBaseUrl, projectPath } from './client';
export type { GitLabClientOptions, GitLabRequestOptions, GitLabResponse } from './client';
export { GitLabError, GL_MESSAGES, rateLimitMessage, connectionError } from './errors';
export type { GitLabErrorCode } from './errors';
export { GITLAB_SCOPES, authorizeUrl, exchangeCode, refreshAccessToken, revokeToken, getAccount, tokenScopes, missingScopes, probeInstance } from './oauth';
export type { GitLabOAuthOptions, GitLabTokenResult, GitLabAccount } from './oauth';
export { REPORTER, listProjects, checkProject } from './resources';
export type { GitLabProject } from './resources';
export { syncComment, findIssue, uploadFiles, linkOf, issueProjectPath } from './sync';
export type { GitLabTarget, GitLabFile, GitLabSyncOptions, GitLabSyncResult, GitLabIssueJson } from './sync';
export {
  projectOf,
  issueStateOf,
  setIssueState,
  fetchIssue,
  fetchNotes,
  fetchProjectActivity,
  commentOf,
  isPublicNote,
  mergeNotes,
  findReplyNote,
  postNote,
  updateNote,
  deleteNote,
} from './threads';
export type { GitLabNote, GitLabIssueFetch, ProjectCursor, ProjectActivity, PostNoteOptions } from './threads';
export {
  TrackerError,
  providerName,
  issueTitle,
  issueBody,
  attachmentCaption,
  formatDuration,
  neutralize,
  marker,
  replyMarker,
  replyIdOf,
  applyIssueState,
  applyIssueStatus,
  replyCommentBody,
  mergeComments,
  forViewer,
} from '../tracker';
export type { TrackerErrorCode, TrackerComment, TrackerIssueState, MergeResult, Viewer, UploadedAttachment } from '../tracker';
