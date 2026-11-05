// Provider-neutral sync engine of the demo backend: the part of an integration that is the same
// for GitHub, GitLab and whatever comes next. A provider (demo/github.mjs, demo/gitlab.mjs) keeps
// sign-in, settings and its API calls; this file keeps the queues, the polling and the single status.
//
//   comments → issues      queue per space, retried with backoff (doubling up to 30×), idempotent by
//                          comment id (the provider finds an issue an earlier attempt created by its marker)
//   tracker → Comenta      repository-wide poll every pollMs + per-issue refresh when the owner or an author
//                          opens the widget (throttled by refreshMs): issue state and comments
//   Comenta → tracker      queue of reply operations (create / edit / delete), retried with backoff;
//                          comments Comenta posted carry a hidden marker, so polling never imports them back
//   one status             closing / reopening a thread closes / reopens its issue first (error and no change
//                          when the tracker fails); closing / reopening on the tracker drives the thread
//
// The provider driver:
//   name, label                               'gitlab', 'GitLab'
//   canSync(integ)                            comments can be sent now (token alive, settings saved)
//   withApi(integ, fn)                        run fn(api, retried) with the right credentials (may retry once)
//   authFailed(integ, err)                    a call answered `unauthorized` (mark the owner's token expired)
//   tracks(integ, issueLink)                  the issue belongs to the configured repository / project
//   pollKey(integ)                            the configured repository / project (a new one restarts the cursor)
//   createIssue(api, integ, payload, files, { checkExisting }) → { link, existed, warning? }
//   fetchIssue(api, link, etag)               → { kind: 'unchanged' | 'ok' | 'unavailable', … }
//   fetchComments(api, link, etag)            → { kind: 'unchanged' } | { kind: 'ok', comments, etag, complete }
//   poll(api, integ, cursor)                  → { cursor, issues: TrackerIssueState[], comments?: [{ issueNumber, …TrackerComment }],
//                                                 touched?: [{ number, updatedAt }] (re-read these issues in full) }
//   setState(api, link, 'open' | 'closed')    → TrackerIssueState
//   postReply(api, link, reply, files, { checkExisting, guestName }) → { id, url }
//   updateReply(api, link, replyLink, reply, guestName)
//   deleteReply(api, link, replyLink)
//   findReply(api, link, replyId)             → { id, url } | null
//   toError(err)                              → TrackerError (anything thrown that isn't one yet)
//   error(code, message)                      → a new TrackerError of this provider
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TrackerError, applyIssueState, applyIssueStatus, mergeComments } from '../dist/tracker.js';

export function createSyncEngine({ driver, db, save, persistComments, findComment, listComments = () => [], uploadsDir, log = console.log, timing = {} }) {
  const { name, label } = driver;
  const backoffMs = timing.backoffMs ?? 60_000;
  const pollMs = timing.pollMs ?? 45_000;
  const refreshMs = timing.refreshMs ?? 20_000;
  const drainMs = timing.drainMs ?? 30_000;
  const inflight = new Map(); // `${space}:${id}` → Promise
  const inflightIssue = new Map(); // `${space}:${repo}#${n}` → Promise
  const inflightReply = new Map(); // `${space}:${commentId}:${replyId}` → Promise
  const toError = (err) => (err instanceof TrackerError ? err : driver.toError(err));
  const tag = `[${name}]`;
  const mine = (c) => c?.issue?.provider === name;

  // ------------------------------------------------------------------ comments → issues

  /**
   * Turn a stored comment into an issue. Waits up to `waitMs`; if the tracker is slow the work goes on
   * in the background and the link shows up in the thread on the next refresh.
   */
  async function onComment(space, payload, files, waitMs = 8000) {
    if (payload.issue) return payload.issue;
    const integ = db.spaces[space];
    if (!integ?.config || integ.disconnected) return null;
    if (!driver.canSync(integ)) {
      queue(integ, payload.id, null);
      return null;
    }
    const p = syncOne(space, payload, files);
    const timeout = new Promise((r) => setTimeout(() => r(null), waitMs));
    return Promise.race([p, timeout]);
  }

  function queue(integ, id, err) {
    integ.pending ??= {};
    const prev = integ.pending[id] ?? { attempts: 0 };
    const attempts = prev.attempts + 1;
    let nextAt = Date.now() + Math.min(30, 2 ** (attempts - 1)) * backoffMs;
    if (err?.code === 'rate_limited' && err.resetAt) nextAt = Math.max(nextAt, err.resetAt);
    // permission / config problems wait for the owner (re-login, new settings)
    if (err && !err.retryable) nextAt = Number.MAX_SAFE_INTEGER;
    integ.pending[id] = { attempts, nextAt, ...(err ? { error: err.message } : {}) };
    save();
  }

  function syncOne(space, payload, files) {
    const key = `${space}:${payload.id}`;
    if (inflight.has(key)) return inflight.get(key);
    const run = (async () => {
      const integ = db.spaces[space];
      if (!driver.canSync(integ) || payload.issue) return payload.issue ?? null;
      const attempts = integ.pending?.[payload.id]?.attempts ?? 0;
      files ??= await filesFromDisk(payload);
      try {
        const res = await driver.withApi(integ, (api, retried) => driver.createIssue(api, integ, payload, files, { checkExisting: attempts > 0 || !!retried }));
        payload.issue = res.link;
        persistComments();
        if (integ.pending) delete integ.pending[payload.id];
        integ.lastError = res.warning ? { code: 'warning', message: res.warning, at: new Date().toISOString() } : undefined;
        save();
        log(`${tag} ${payload.id.slice(0, 8)} → ${res.link.url}${res.existed ? ' (уже был)' : ''}${res.warning ? ` (${res.warning})` : ''}`);
        // replies written while the issue was being created go out now
        for (const r of payload.replies ?? []) if (!r.origin && !r.link) enqueueReply(space, payload.id, r.id, 'create');
        void drainReplies(space, true);
        return payload.issue;
      } catch (err) {
        const e = toError(err);
        if (e.code === 'unauthorized') driver.authFailed(integ, e);
        integ.lastError = { code: e.code, message: e.message, at: new Date().toISOString() };
        queue(integ, payload.id, e);
        log(`${tag} ${payload.id.slice(0, 8)}: ${e.code} — ${e.message} (повторим позже)`);
        return null;
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, run);
    return run;
  }

  /** Recordings of a comment were saved by the feedback route; read them back for a retry. */
  async function filesFromDisk(item) {
    const out = [];
    for (const a of item.attachments ?? []) {
      if (!a.url?.startsWith('/uploads/')) continue;
      try {
        out.push({ attachment: a, data: new Uint8Array(await readFile(join(uploadsDir, a.url.slice('/uploads/'.length)))) });
      } catch {
        /* file gone: the issue lists it as "not uploaded" */
      }
    }
    return out;
  }

  /** Retry queued comments of a space (`force`: ignore backoff, e.g. after re-login or new settings). */
  async function drain(space, force = false) {
    const integ = db.spaces[space];
    if (!integ?.pending || !driver.canSync(integ)) return;
    for (const [id, p] of Object.entries(integ.pending)) {
      if (!force && p.nextAt > Date.now()) continue;
      const payload = findComment(space, id);
      if (!payload || payload.issue) {
        delete integ.pending[id];
        continue;
      }
      await syncOne(space, payload);
      if (!driver.canSync(db.spaces[space])) break;
    }
    save();
  }

  // ------------------------------------------------------------------ tracker → Comenta

  /** { key, cursor, issues: { [repo#n]: { etag, commentsEtag, at, full, updatedAt } }, replies: { [key]: op }, pausedUntil } */
  const threads = (integ) => {
    integ.threads ??= {};
    integ.threads.issues ??= {};
    integ.threads.replies ??= {};
    return integ.threads;
  };
  const issueKey = (i) => `${String(i.repoId ?? i.repo).toLowerCase()}#${i.number}`;
  const paused = (integ) => (integ.threads?.pausedUntil ?? 0) > Date.now();

  /** A read failed: wait out rate limits, mark a dead owner token. */
  function readFailed(integ, err, what) {
    const e = toError(err);
    if (e.code === 'rate_limited') threads(integ).pausedUntil = e.resetAt ?? Date.now() + 60_000;
    if (e.code === 'unauthorized') driver.authFailed(integ, e);
    save();
    log(`${tag} ${what}: ${e.code} — ${e.message}`);
  }

  /** Repository-wide poll: issue states and new / edited comments since the last cursor. */
  async function pollSpace(space) {
    const integ = db.spaces[space];
    if (!driver.canSync(integ) || paused(integ)) return;
    const tracked = listComments(space).filter((c) => mine(c) && driver.tracks(integ, c.issue));
    if (!tracked.length) return;
    const t = threads(integ);
    const key = driver.pollKey(integ);
    if (t.key !== key || !t.cursor) {
      // start from the oldest tracked comment; later polls only ask for what changed
      t.key = key;
      t.cursor = tracked.reduce((m, c) => (c.createdAt < m ? c.createdAt : m), new Date().toISOString());
    }
    try {
      const act = await driver.withApi(integ, (api) => driver.poll(api, integ, t.cursor));
      t.cursor = act.cursor;
      const byNumber = new Map(tracked.map((c) => [c.issue.number, c]));
      let changed = false;
      for (const st of act.issues ?? []) {
        const c = byNumber.get(st.number);
        if (!c) continue;
        if (applyIssueState(c.issue, st)) changed = true;
        if (applyIssueStatus(c, st)) {
          changed = true;
          // listings may not say who closed it: one single-issue read does
          if (c.status === 'resolved' && !st.closedBy) void refreshIssue(space, c, true);
        }
      }
      const groups = new Map();
      for (const gc of act.comments ?? []) {
        if (!groups.has(gc.issueNumber)) groups.set(gc.issueNumber, []);
        groups.get(gc.issueNumber).push(gc);
      }
      for (const [n, list] of groups) {
        const c = byNumber.get(n);
        if (!c) continue;
        const m = mergeComments(c, list, { provider: name });
        if (m.changed) {
          c.replies = m.replies;
          changed = true;
        }
      }
      // trackers without a repository-wide comment listing: re-read the issues that changed
      for (const { number, updatedAt } of act.touched ?? []) {
        const c = byNumber.get(number);
        if (!c) continue;
        const rec = (t.issues[issueKey(c.issue)] ??= {});
        if (rec.updatedAt && updatedAt <= rec.updatedAt) continue; // seen it (the listing's `since` is inclusive)
        rec.updatedAt = updatedAt;
        void refreshIssue(space, c, true);
      }
      if (changed) persistComments();
      save();
    } catch (err) {
      readFailed(integ, err, `опрос ${key}`);
    }
  }

  /** One issue in full: state, every comment (finds deletions), deleted / moved issues. Throttled unless `force`. */
  function refreshIssue(space, c, force = false) {
    const integ = db.spaces[space];
    if (!mine(c) || !driver.canSync(integ) || paused(integ)) return Promise.resolve(false);
    const t = threads(integ);
    const key = issueKey(c.issue);
    const rec = (t.issues[key] ??= {});
    if (!force && rec.at && Date.now() - rec.at < refreshMs) return Promise.resolve(false);
    const lock = `${space}:${key}`;
    if (inflightIssue.has(lock)) return inflightIssue.get(lock);
    const run = (async () => {
      rec.at = Date.now();
      try {
        let changed = false;
        const res = await driver.withApi(integ, (api) => driver.fetchIssue(api, c.issue, rec.etag));
        if (res.kind === 'unavailable') {
          delete rec.etag;
          delete rec.commentsEtag;
          changed = applyIssueState(c.issue, { unavailable: res.reason });
        } else {
          if (res.kind === 'ok') {
            rec.etag = res.etag;
            if (!rec.updatedAt || res.issue.updatedAt > rec.updatedAt) rec.updatedAt = res.issue.updatedAt;
            changed = applyIssueState(c.issue, res.issue);
            if (applyIssueStatus(c, res.issue)) changed = true;
          }
          const cs = await driver.withApi(integ, (api) => driver.fetchComments(api, c.issue, rec.commentsEtag));
          if (cs.kind === 'ok') {
            rec.commentsEtag = cs.etag;
            const m = mergeComments(c, cs.comments, { provider: name, complete: cs.complete });
            if (m.changed) {
              c.replies = m.replies;
              changed = true;
            }
          }
          if (!rec.full) {
            // first full look at this card: replies written before the sync existed go to the tracker
            rec.full = true;
            for (const r of c.replies ?? []) if (!r.origin && !r.link) enqueueReply(space, c.id, r.id, 'create', { checkExisting: true });
            void drainReplies(space, true);
          }
        }
        if (changed) persistComments();
        save();
        return changed;
      } catch (err) {
        readFailed(integ, err, `issue ${c.issue.repo}#${c.issue.number}`);
        return false;
      }
    })().finally(() => inflightIssue.delete(lock));
    inflightIssue.set(lock, run);
    return run;
  }

  /**
   * The owner or an author opened the widget (or it polled): refresh the shown cards' issues, newest first.
   * Waits up to `waitMs`, the rest finishes in the background and shows up on the next poll.
   */
  async function refreshComments(space, comments, waitMs = 1500) {
    const integ = db.spaces[space];
    if (!driver.canSync(integ) || paused(integ)) return;
    const list = comments.filter(mine).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 25);
    if (!list.length) return;
    const all = (async () => {
      for (const c of list) await refreshIssue(space, c);
    })();
    await Promise.race([all, new Promise((r) => setTimeout(r, waitMs))]);
  }

  // ------------------------------------------------------------------ Comenta → tracker

  /** Remember what has to happen to a reply on the tracker. A newer operation replaces an older one. */
  function enqueueReply(space, commentId, replyId, op, extra = {}) {
    const integ = db.spaces[space];
    if (!integ?.config || integ.disconnected) return;
    const t = threads(integ);
    const key = `${commentId}:${replyId}`;
    const prev = t.replies[key];
    // a create that hasn't run yet already sends the latest text
    if (op === 'edit' && prev && prev.op === 'create') return;
    if (op === 'create' && prev) return;
    t.replies[key] = { commentId, replyId, op, attempts: 0, nextAt: 0, ...extra };
    save();
  }

  function processReply(space, key) {
    const lock = `${space}:${key}`;
    if (inflightReply.has(lock)) return inflightReply.get(lock);
    const run = (async () => {
      const integ = db.spaces[space];
      const op = integ?.threads?.replies?.[key];
      if (!op) return;
      const t = integ.threads;
      const c = findComment(space, op.commentId);
      const reply = c?.replies?.find((r) => r.id === op.replyId);
      const issue = c?.issue ?? op.issue;
      const done = () => {
        if (t.replies[key] === op) delete t.replies[key];
        save();
      };
      if (op.op !== 'delete' && (!reply || reply.origin)) return done(); // deleted meanwhile
      if (!issue) return; // waits for the issue to be created
      if (issue.provider !== name || issue.unavailable) return done(); // nowhere to post
      if (!driver.canSync(integ)) return;
      const guestName = 'Гость';
      try {
        await driver.withApi(integ, async (api) => {
          if (op.op === 'delete') {
            const link = op.link ?? (await driver.findReply(api, issue, op.replyId));
            if (link) await driver.deleteReply(api, issue, link);
          } else if (reply.link) {
            if (op.op === 'edit') await driver.updateReply(api, issue, reply.link, reply, guestName);
          } else {
            const files = await filesFromDisk(reply);
            const link = await driver.postReply(api, issue, reply, files, { checkExisting: op.attempts > 0 || !!op.checkExisting, guestName });
            reply.link = { provider: name, id: link.id, url: link.url };
            persistComments();
          }
        });
        log(`${tag} ответ ${op.replyId.slice(0, 8)}: ${op.op} → ${issue.repo}#${issue.number}`);
        done();
      } catch (err) {
        const e = toError(err);
        if (e.code === 'unauthorized') driver.authFailed(integ, e);
        if (t.replies[key] === op) {
          op.attempts++;
          op.nextAt = Date.now() + Math.min(30, 2 ** (op.attempts - 1)) * backoffMs;
          if (e.code === 'rate_limited' && e.resetAt) op.nextAt = Math.max(op.nextAt, e.resetAt);
          if (!e.retryable) op.nextAt = Number.MAX_SAFE_INTEGER; // waits for re-login / new settings
          op.error = e.message;
        }
        save();
        log(`${tag} ответ ${op.replyId.slice(0, 8)}: ${e.code} — ${e.message} (повторим позже)`);
      }
    })()
      .catch((err) => console.error(err))
      .finally(() => inflightReply.delete(lock));
    inflightReply.set(lock, run);
    return run;
  }

  /** Send queued reply operations (`force`: ignore backoff). */
  async function drainReplies(space, force = false) {
    const integ = db.spaces[space];
    if (!integ?.threads?.replies || !driver.canSync(integ)) return;
    for (const [key, op] of Object.entries(integ.threads.replies)) {
      if (!force && op.nextAt > Date.now()) continue;
      await processReply(space, key);
      if (!driver.canSync(db.spaces[space])) break;
    }
  }

  // ------------------------------------------------------------------ one status

  /**
   * The thread was closed or reopened in Comenta: close or reopen its issue first. Throws a TrackerError
   * when the tracker can't be reached: the route then answers with the error and keeps the status.
   * Threads without a reachable issue change locally only.
   */
  async function onStatus(space, comment, status) {
    const integ = db.spaces[space];
    const issue = comment.issue;
    if (!mine(comment) || issue.unavailable || !integ?.config || integ.disconnected) return;
    if (!driver.canSync(integ)) throw driver.error('unauthorized', `Нет доступа к ${label}, поэтому issue не изменить. Войдите заново на странице настроек ${label}.`);
    // replies still queued for this thread go first, so "reply and close" reads in order on the tracker
    for (const key of Object.keys(integ.threads?.replies ?? {})) if (key.startsWith(`${comment.id}:`)) await processReply(space, key);
    try {
      const st = await driver.withApi(integ, (api) => driver.setState(api, issue, status === 'resolved' ? 'closed' : 'open'));
      applyIssueState(issue, st);
      persistComments();
      log(`${tag} ${issue.repo}#${issue.number}: ${st.state === 'closed' ? 'закрыт' : 'открыт'} из Comenta`);
    } catch (err) {
      const e = toError(err);
      // deleted or no access: the status lives in Comenta from now on
      if (e.status === 404 || e.status === 410) {
        applyIssueState(issue, { unavailable: e.status === 410 ? 'deleted' : 'no_access' });
        persistComments();
        return;
      }
      if (e.code === 'unauthorized') driver.authFailed(integ, e);
      throw e;
    }
  }

  // hooks for the feedback routes
  function onReply(space, comment, reply) {
    if (reply.origin) return;
    enqueueReply(space, comment.id, reply.id, 'create');
    void processReply(space, `${comment.id}:${reply.id}`);
  }
  function onReplyEdit(space, comment, reply) {
    if (reply.origin) return;
    enqueueReply(space, comment.id, reply.id, 'edit');
    void processReply(space, `${comment.id}:${reply.id}`);
  }
  function onReplyDelete(space, comment, reply) {
    if (reply.origin) return;
    enqueueReply(space, comment.id, reply.id, 'delete', { link: reply.link, issue: comment.issue });
    void processReply(space, `${comment.id}:${reply.id}`);
  }

  /** Comments waiting to become issues and reply operations waiting to be sent. */
  const counts = (integ) => ({ pending: Object.keys(integ?.pending ?? {}).length, replies: Object.keys(integ?.threads?.replies ?? {}).length });

  const drainTimer = setInterval(() => {
    for (const space of Object.keys(db.spaces)) void drain(space).then(() => drainReplies(space));
  }, drainMs);
  drainTimer.unref?.();
  const pollTimer = setInterval(() => {
    for (const space of Object.keys(db.spaces)) void pollSpace(space);
  }, pollMs);
  pollTimer.unref?.();

  return {
    onComment,
    onStatus,
    onReply,
    onReplyEdit,
    onReplyDelete,
    drain,
    drainReplies,
    pollSpace,
    refreshComments,
    refreshIssue,
    counts,
    close: () => (clearInterval(drainTimer), clearInterval(pollTimer)),
  };
}
