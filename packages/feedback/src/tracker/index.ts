/** Provider-neutral helpers shared by `@comenta/feedback/github` and `@comenta/feedback/gitlab`. */
export { TrackerError, waitMessage, nextLink } from './errors';
export type { TrackerErrorCode, TrackerErrorExtra } from './errors';
export { issueTitle, issueBody, attachmentCaption, attachmentLines, formatDuration, neutralize, marker } from './format';
export type { UploadedAttachment, BodyOptions } from './format';
export {
  providerName,
  replyMarker,
  replyIdOf,
  applyIssueState,
  applyIssueStatus,
  replyCommentBody,
  keepUploadLinks,
  replyFromComment,
  mergeComments,
  forViewer,
} from './threads';
export type { TrackerComment, TrackerIssueState, MergeResult, Viewer, ReplyBodyOptions } from './threads';
