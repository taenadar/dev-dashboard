// Dev dashboard: a local dashboard for a team backlog in Azure Boards, your PRs in Azure DevOps, a repo's worktrees,
// Docker and the local sites. Node stdlib only; same-origin JSON endpoints so the page needs no auth of its own.
//   node server.js   ->   http://localhost:8138
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { exec, execFile } = require('child_process');

// Every setting can be overridden in config.json next to this file (see config.example.json). A panel whose
// settings are empty shows "not set up" instead of failing.
const DEFAULTS = {
  PORT: 8138,
  NAME: '', // your first name, for the greeting
  ORG: '', // https://dev.azure.com/<your-org>
  ME: '', // your Azure DevOps sign-in name (uniqueName): tells your PRs, votes and comments apart
  NAME_SUFFIX: '', // a suffix your org adds to every display name, cut off on screen (e.g. ' | Contoso')
  REPO_ROOT: '', // the main checkout of the repo whose worktrees are listed, e.g. 'C:/Code/my-app'
  // [project, repo or null for every repo in the project, 'all' to watch every open PR there and not only yours,
  // the ones you review and the ones into WATCH_TARGET]. The first entry is the main repo.
  PR_SOURCES: [],
  WATCH_TARGET: 'refs/heads/main', // the team branch: PRs into it are always shown, Start work branches from it
  // completed PRs per week: the team's (into WATCH_TARGET) against everyone else's in this repo
  THROUGHPUT_REPO: null, // [project, repo]
  THROUGHPUT_FROM: '', // a Monday, 'YYYY-MM-DD'
  // T3 Code webhook task that starts a review thread; the signing secret lives in .review-secret next to this file
  REVIEW_WEBHOOK: '',
  // a re-check votes Approve on someone else's PR when its merge confidence is at least this (out of 10)
  APPROVE_SCORE: 9,
  // the T3 Code CLI, and the T3 projects (folders) whose threads can be linked to a PR or work item
  T3_CLI: path.join(os.homedir(), '.t3', 'bin', 't3.cmd'),
  T3_PROJECTS: [],
  BACKLOG_PROJECT: '', // the Azure Boards project
  BACKLOG_AREA: '', // area path, e.g. 'MyProject\\MyTeam'
  BASES: ['origin/main'], // a worktree is compared with whichever of these it is closest to
  DRIFT: null, // ['team-branch', 'branch-it-syncs-with'] in the main repo
  // a markdown file with a table of open questions (| Q-1 | question | position | owner | needed by |): [project, repo, file, branch]
  DESIGN: null,
  DB_CONFIG: '', // a file in each worktree holding its local database connection string ("Data Source=localhost,<port>")
  DEV_IMAGE_PREFIX: '', // Docker images with this name prefix and no container are listed for clean-up
  // what the agent threads are told about building and testing this repo
  BUILD_HINT: 'Build the projects that changed and run the tests that cover them.',
  // local sites to probe: [label, url, IIS site name]
  SITES: [],
};
let CFG = { ...DEFAULTS };
try { CFG = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) }; }
catch (e) { if (e.code !== 'ENOENT') console.warn('config.json ignored:', e.message); }

const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const DAY_MS = 864e5;
const cleanName = n => { n = String(n || ''); return CFG.NAME_SUFFIX && n.endsWith(CFG.NAME_SUFFIX) ? n.slice(0, -CFG.NAME_SUFFIX.length) : n; };
const notSetUp = what => ({ error: { kind: 'off', message: `set ${what} in config.json` } });
const LOG = path.join(__dirname, 'dashboard.log');
const log = (...a) => { const line = `${new Date().toISOString()} ${a.join(' ')}\n`; process.stdout.write(line); try { fs.appendFileSync(LOG, line); } catch {} };

// ---------- process helpers ----------
function run(cmd, { cwd, timeout = 30000 } = {}) {
  return new Promise(res => exec(cmd, { cwd, timeout, maxBuffer: 64 << 20, windowsHide: true }, (err, out, errOut) =>
    res(err ? { ok: false, out, error: classify(errOut || err.message, err) } : { ok: true, out })));
}
function git(cwd, args, timeout = 20000) {
  return new Promise(res => execFile('git', args, { cwd, timeout, maxBuffer: 16 << 20, windowsHide: true }, (err, out) => res(err ? null : out.trim())));
}
function classify(msg, err) {
  const m = String(msg || '').trim().slice(-600);
  if (err && err.killed) return { kind: 'timeout', message: 'timed out' };
  if (/AADSTS|az login|Unauthorized|401/i.test(m)) return { kind: 'auth', message: m };
  if (/is not recognized|not found|ENOENT/i.test(m)) return { kind: 'missing', message: m };
  if (/docker daemon|pipe\/docker|Cannot connect/i.test(m)) return { kind: 'down', message: m };
  return { kind: 'error', message: m };
}
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
// cached(fn, ms): one in-flight call shared by concurrent callers, result kept for ms.
function cached(fn, ms) {
  let at = 0, val, inflight;
  const get = async (force) => {
    if (!force && val && Date.now() - at < ms) return val;
    if (inflight) return inflight;
    inflight = fn().then(v => { val = v; at = Date.now(); return v; }).catch(e => { log('error', e.stack || e); return val || { error: { kind: 'error', message: String(e.message || e) } }; }).finally(() => inflight = null);
    return inflight;
  };
  return get;
}

// ---------- Azure DevOps ----------
let tok = null, tokP = null;
async function token() {
  if (tok && tok.exp - Date.now() > 5 * 60e3) return tok.value;
  if (tokP) return tokP;
  tokP = run(`az account get-access-token --resource ${ADO_RESOURCE} -o json`, { timeout: 120000 }).then(r => {
    if (!r.ok) { const e = new Error(r.error.message); e.kind = r.error.kind; throw e; }
    const j = JSON.parse(r.out);
    tok = { value: j.accessToken, exp: j.expires_on ? j.expires_on * 1000 : Date.parse(j.expiresOn) };
    return tok.value;
  }).finally(() => tokP = null);
  return tokP;
}
async function ado(url, body) {
  if (!CFG.ORG) throw Object.assign(new Error('set ORG in config.json'), { kind: 'off' });
  const t = await token();
  const r = await fetch(url.startsWith('http') ? url : CFG.ORG + url, {
    method: body ? 'POST' : 'GET', body: body && JSON.stringify(body),
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw Object.assign(new Error(`${r.status} ${r.statusText} on ${url.split('?')[0]}`), { kind: r.status === 401 ? 'auth' : 'error' });
  return r.json();
}
const asError = e => ({ error: { kind: e.kind || (e.name === 'TimeoutError' ? 'timeout' : 'error'), message: String(e.message || e) } });
const localDay = v => v ? new Date(v).toLocaleDateString('sv-SE') : '';

const getBacklog = cached(async () => {
  if (!CFG.BACKLOG_PROJECT || !CFG.BACKLOG_AREA) return notSetUp('BACKLOG_PROJECT and BACKLOG_AREA');
  try {
    const q = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${CFG.BACKLOG_PROJECT}' AND [System.AreaPath] UNDER '${CFG.BACKLOG_AREA}' AND [System.WorkItemType] IN ('Product Backlog Item', 'Bug')`;
    const ids = (await ado(`/${CFG.BACKLOG_PROJECT}/_apis/wit/wiql?api-version=7.1`, { query: q })).workItems.map(w => w.id);
    // $expand=Relations can't be combined with a field list, so this pulls every field; the text is reduced to references below
    const rows = [];
    for (let k = 0; k < ids.length; k += 200)
      rows.push(...(await ado(`/${CFG.BACKLOG_PROJECT}/_apis/wit/workitemsbatch?api-version=7.1`, { ids: ids.slice(k, k + 200), $expand: 'Relations', errorPolicy: 'omit' })).value.filter(Boolean));
    const text = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
    const uniq = a => [...new Set(a)];
    const live = t => t.split(/(?<=[.;])\s+/).filter(x => !/remov|absorb|dropp|merged into|duplicate|replaced|no longer|struck|retired|PO decision/i.test(x));
    return {
      snap: localDay(Date.now()), at: Date.now(),
      items: rows.map(({ id, fields: f, relations = [] }) => {
        const open = !['Done', 'Removed'].includes(f['System.State']);
        const body = open ? text(f['System.Description']) + ' ' + text(f['Microsoft.VSTS.Common.AcceptanceCriteria']) : '';
        return {
          id, type: f['System.WorkItemType'], state: f['System.State'], title: f['System.Title'],
          created: localDay(f['System.CreatedDate']), createdAt: f['System.CreatedDate'], closed: localDay(f['Microsoft.VSTS.Common.ClosedDate']),
          changed: f['System.ChangedDate'], stateChanged: f['Microsoft.VSTS.Common.StateChangeDate'], activated: f['Microsoft.VSTS.Common.ActivatedDate'],
          who: cleanName(f['System.AssignedTo']?.displayName), tags: f['System.Tags'] || '',
          mine: (f['System.AssignedTo']?.uniqueName || '').toLowerCase() === CFG.ME.toLowerCase(),
          prs: relations.filter(r => r.rel === 'ArtifactLink' && /PullRequestId/i.test(r.url)).length,
          commits: relations.filter(r => r.rel === 'ArtifactLink' && /Git\/Commit/i.test(r.url)).length,
          noAc: open && !text(f['Microsoft.VSTS.Common.AcceptanceCriteria']),
          // what an open item's text points at: PBI codes, work item numbers in brackets or after #, open-question ids
          // a sentence that says the item was removed, absorbed or dropped isn't a live reference
          codes: open ? uniq(live(body).flatMap(s => s.match(/\bPBI-\d+[a-z]?\b/g) || [])) : [],
          nums: open ? uniq(live(body).flatMap(s => [...s.matchAll(/(?:#|\()(\d{5})\b/g)].map(m => +m[1]))) : [],
          qs: open ? uniq(body.match(/\bQ-(?:\d+|[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\b/g) || []) : [],
        };
      }),
    };
  } catch (e) { log('backlog', e.message); return asError(e); }
}, 10 * 60e3);

const shapePr = (p, project) => ({
  id: p.pullRequestId, title: p.title, project, repo: p.repository.name, draft: !!p.isDraft, status: p.status,
  source: p.sourceRefName.replace('refs/heads/', ''), target: p.targetRefName.replace('refs/heads/', ''),
  by: cleanName(p.createdBy.displayName), byId: (p.createdBy.uniqueName || '').toLowerCase(), mine: (p.createdBy.uniqueName || '').toLowerCase() === CFG.ME.toLowerCase(),
  created: p.creationDate, closed: p.closedDate, merge: p.mergeStatus,
  reviewers: (p.reviewers || []).filter(r => !r.isContainer || r.vote).map(r => ({ name: cleanName(r.displayName).replace(/^\[.*?\]\\/, ''), id: (r.uniqueName || '').toLowerCase(), vote: r.vote, required: !!r.isRequired, me: (r.uniqueName || '').toLowerCase() === CFG.ME.toLowerCase(), group: !!r.isContainer })),
  url: `${CFG.ORG}/${encodeURIComponent(project)}/_git/${encodeURIComponent(p.repository.name)}/pullrequest/${p.pullRequestId}`,
});
// Open threads are active or pending ones with at least one written comment (votes and pushes are system threads).
// One is waiting on you when someone else had the last word: on your own PR in any thread, on someone else's PR in
// the threads you started.
const isMe = a => (a?.uniqueName || '').toLowerCase() === CFG.ME.toLowerCase();
// Also, on someone else's PR: the threads you started (resolved, answered by someone else, or still waiting on the
// author), and who else started threads, which with the votes tells whether someone else already reviewed it.
function openThreads(pr, threads) {
  const text = t => t.isDeleted ? [] : (t.comments || []).filter(c => !c.isDeleted && c.commentType === 'text');
  const isOpen = t => ['active', 'pending'].includes(t.status);
  const open = threads.flatMap(t => {
    const c = isOpen(t) ? text(t) : [];
    return c.length ? [!isMe(c[c.length - 1].author) && (pr.mine || isMe(c[0].author))] : [];
  });
  const mineT = { total: 0, resolved: 0, answered: 0, waiting: 0, last: null }, others = {};
  for (const t of threads) {
    const c = text(t); if (!c.length) continue;
    const first = c[0].author, last = c[c.length - 1];
    if (isMe(first)) {
      mineT.total++;
      if (!isOpen(t)) mineT.resolved++; else if (isMe(last.author)) mineT.waiting++; else mineT.answered++;
      const at = c.filter(x => isMe(x.author)).map(x => x.publishedDate).sort().pop();
      if (at > (mineT.last || '')) mineT.last = at;
    } else if ((first.uniqueName || '').toLowerCase() !== pr.byId) {
      const n = cleanName(first.displayName);
      others[n] = (others[n] || 0) + 1;
    }
  }
  return { open: open.length, you: open.filter(Boolean).length, mine: mineT, others };
}
// people other than the author and you who voted or started a thread: if any, someone else already reviewed it
const reviewedBy = p => {
  const by = new Map(p.reviewers.filter(r => !r.me && !r.group && r.vote && r.id !== p.byId).map(r => [r.name, { name: r.name, vote: r.vote, threads: 0 }]));
  for (const [n, k] of Object.entries(p.comments?.others || {})) by.set(n, { name: n, vote: by.get(n)?.vote || p.reviewers.find(r => r.name === n && !r.group)?.vote || 0, threads: k });
  return [...by.values()];
};
const getPrs = cached(async () => {
  try {
    const active = [], recent = [];
    for (const [project, repo, watch] of CFG.PR_SOURCES) {
      const proj = encodeURIComponent(project), base = repo ? `/${proj}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests` : `/${proj}/_apis/git/pullrequests`;
      (await ado(`${base}?searchCriteria.status=active&$top=300&api-version=7.1`)).value.forEach(p => active.push({ ...shapePr(p, project), watchAll: watch === 'all' }));
      if (repo) (await ado(`${base}?searchCriteria.status=all&$top=150&api-version=7.1`)).value.forEach(p => recent.push(shapePr(p, project)));
    }
    const watched = active.filter(p => p.watchAll || p.mine || p.reviewers.some(r => r.me) || 'refs/heads/' + p.target === CFG.WATCH_TARGET);
    // the work items linked to each PR (for the review), and its open comment threads
    await pool(watched, 6, async p => {
      const at = `/${encodeURIComponent(p.project)}/_apis/git/repositories/${encodeURIComponent(p.repo)}/pullRequests/${p.id}`;
      const [wis, thr] = await Promise.all([ado(`${at}/workitems?api-version=7.1`).catch(() => ({ value: [] })), ado(`${at}/threads?api-version=7.1`).catch(e => (log('threads', p.id, e.message), null))]);
      p.workItems = wis.value.map(w => +w.id);
      p.comments = thr && openThreads(p, thr.value);
      p.reviewedBy = reviewedBy(p);
    });
    return { at: Date.now(), active: watched, recent: recent.map(({ id, repo, source, target, status, created, closed, title, url, mine, by }) => ({ id, repo, source, target, status, created, closed, title, url, mine, by })) };
  } catch (e) { log('prs', e.message); return asError(e); }
}, 2 * 60e3);

// ---------- completed PRs per week ----------
// Every PR completed in the repo since THROUGHPUT_FROM, reduced to what the chart needs.
const getThroughput = cached(async () => {
  if (!CFG.THROUGHPUT_REPO || !CFG.THROUGHPUT_FROM) return notSetUp('THROUGHPUT_REPO and THROUGHPUT_FROM');
  try {
    const [project, repo] = CFG.THROUGHPUT_REPO, since = CFG.THROUGHPUT_FROM, prs = [];
    for (let skip = 0; ; skip += 500) {
      const v = (await ado(`/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests?searchCriteria.status=completed&searchCriteria.queryTimeRangeType=closed&searchCriteria.minTime=${new Date(since + 'T00:00:00').toISOString()}&$top=500&$skip=${skip}&api-version=7.1`)).value;
      prs.push(...v.map(p => ({ id: p.pullRequestId, target: p.targetRefName.replace('refs/heads/', ''), created: p.creationDate, closed: p.closedDate, by: cleanName(p.createdBy.displayName) })));
      if (v.length < 500) break;
    }
    return { at: Date.now(), repo: `${project}/${repo}`, since, team: CFG.WATCH_TARGET.replace('refs/heads/', ''), prs };
  } catch (e) { log('throughput', e.message); return asError(e); }
}, 30 * 60e3);

// ---------- the team branch vs the branch it syncs with ----------
// The commits API lists the commits in compareVersion that itemVersion lacks.
const getDrift = cached(async () => {
  if (!CFG.DRIFT || !CFG.PR_SOURCES[0]?.[1]) return notSetUp('DRIFT and PR_SOURCES');
  try {
    const [project, repo] = CFG.PR_SOURCES[0], base = `/${project}/_apis/git/repositories/${repo}`;
    const [b, t] = CFG.DRIFT;
    const commits = (item, compare) => ado(`${base}/commits?searchCriteria.itemVersion.version=${item}&searchCriteria.compareVersion.version=${compare}&searchCriteria.$top=500&api-version=7.1`);
    const changes = (from, to, common = true) => ado(`${base}/diffs/commits?baseVersion=${from}&baseVersionType=branch&targetVersion=${to}&targetVersionType=branch&diffCommonCommit=${common}&$top=5000&api-version=7.1`);
    const [inT, inB, dT, dB, dTip] = await Promise.all([commits(b, t), commits(t, b), changes(b, t), changes(t, b), changes(b, t, false)]);
    const files = d => d.changes.filter(c => !c.item.isFolder && c.item.gitObjectType !== 'tree').map(c => ({ path: c.item.path, type: c.changeType }));
    const common = await ado(`${base}/commits/${dT.commonCommit}?api-version=7.1`);
    // The branches are synced by squash merges, which leave no shared history: a change the other branch made can already be
    // in the team branch by content. "Pending" is what the other branch changed since the common commit that still differs between the tips.
    const tip = new Set(files(dTip).map(f => f.path)), fB = new Set(files(dB).map(f => f.path));
    const fT = files(dT), pending = fT.filter(f => tip.has(f.path)), pendingSet = new Set(pending.map(f => f.path));
    const shape = c => ({ id: c.commitId.slice(0, 10), full: c.commitId, date: c.committer.date, by: cleanName(c.author.name), msg: c.comment.split('\n')[0], pr: c.comment.match(/^Merged PR (\d+)/)?.[1] || null });
    const otherAhead = await pool(inT.value.slice(0, 30).map(shape), 6, async c => {
      try { const ch = await ado(`${base}/commits/${c.full}/changes?api-version=7.1`); const ps = ch.changes.filter(x => !x.item.isFolder && x.item.gitObjectType !== 'tree').map(x => x.item.path);
        return { ...c, files: ps.length, pending: ps.filter(p => pendingSet.has(p)).length }; } catch { return { ...c, files: null, pending: null }; }
    });
    return {
      at: Date.now(), base: b, other: t, commonDate: common.committer.date, commonMsg: common.comment.split('\n')[0],
      otherAhead, otherAheadCount: inT.count, baseAhead: inB.count,
      files: fT, pending, both: pending.map(f => f.path).filter(p => fB.has(p)), complete: dT.allChangesIncluded !== false,
      repoUrl: `${CFG.ORG}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`,
    };
  } catch (e) { log('drift', e.message); return asError(e); }
}, 10 * 60e3);

// ---------- design repo: open questions + recent commits ----------
// The file has a "### 2.2" section with a table of open questions (| Q-id | question | position | owner | needed by |)
// and, in "### 2.1", the dates they were opened. Adapt parseQuestions to your own format.
const md = s => String(s).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/`/g, '').replace(/~~[^~]*~~/g, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
function parseQuestions(src) {
  const intro = (src.match(/### 2\.1[\s\S]*?### 2\.2/) || [''])[0];
  const opened = {};
  for (const m of intro.matchAll(/`(Q-[\w-]+)`[^.;]*?opened (?:on )?(\d{4}-\d\d-\d\d)/g)) opened[m[1]] ||= m[2];
  for (const m of intro.matchAll(/`(Q-[\w-]+)`\*\*\s*was opened on (\d{4}-\d\d-\d\d)/g)) opened[m[1]] ||= m[2];
  const section = (src.match(/### 2\.2[\s\S]*?## 3\./) || [''])[0];
  const out = [];
  for (const line of section.split(/\r?\n/)) {
    if (!/^\|\s*Q-/.test(line)) continue;
    const cells = line.replace(/^\|/, '').replace(/\|\s*$/, '').split(/\s\|\s/).map(c => c.trim());
    if (cells.length < 5) continue;
    const [id, q, pos, owner, need] = cells;
    const bold = q.match(/^\*\*(.+?)\*\*/);
    const question = md(bold ? bold[1] : q.split(/(?<=\?)\s/)[0]).slice(0, 220);
    out.push({ id, question, position: md(pos).slice(0, 400), owner: md(owner), need: md(need), opened: opened[id] || (q.match(/(?:On|opened on|opened) (\d{4}-\d\d-\d\d)/) || [])[1] || null });
  }
  return out;
}
const getDesign = cached(async () => {
  if (!CFG.DESIGN) return notSetUp('DESIGN');
  try {
    const [project, repo, file, branch = 'main'] = CFG.DESIGN, base = `/${encodeURIComponent(project)}/_apis/git/repositories/${repo}`;
    const since = new Date(Date.now() - 14 * DAY_MS).toISOString();
    const [content, commits] = await Promise.all([
      ado(`${base}/items?path=/${encodeURIComponent(file)}&versionDescriptor.version=${encodeURIComponent(branch)}&includeContent=true&$format=json&api-version=7.1`),
      ado(`${base}/commits?searchCriteria.itemVersion.version=${encodeURIComponent(branch)}&searchCriteria.fromDate=${since}&searchCriteria.$top=200&api-version=7.1`),
    ]);
    return {
      at: Date.now(), questions: parseQuestions(content.content || ''),
      commits: commits.value.map(c => ({ id: c.commitId.slice(0, 10), date: c.committer.date, by: cleanName(c.author.name), msg: c.comment.split('\n')[0] })),
      url: `${CFG.ORG}/${encodeURIComponent(project)}/_git/${repo}`, file,
      fileUrl: `${CFG.ORG}/${encodeURIComponent(project)}/_git/${repo}?path=/${encodeURIComponent(file)}&version=GB${encodeURIComponent(branch)}`,
    };
  } catch (e) { log('design', e.message); return asError(e); }
}, 10 * 60e3);

// ---------- worktrees ----------
const prById = new Map();
const getWorktrees = cached(async () => {
  if (!CFG.REPO_ROOT) return notSetUp('REPO_ROOT');
  const list = await git(CFG.REPO_ROOT, ['worktree', 'list', '--porcelain']);
  if (list == null) return { error: { kind: 'error', message: `git worktree list failed in ${CFG.REPO_ROOT}` } };
  const wts = list.split(/\r?\n\r?\n/).filter(Boolean).map(b => {
    const o = {}; for (const l of b.split(/\r?\n/)) { const [k, ...v] = l.split(' '); o[k] = v.join(' ') || true; }
    return { path: o.worktree, head: o.HEAD, branch: o.branch ? o.branch.replace('refs/heads/', '') : null, detached: !!o.detached, prunable: !!o.prunable };
  });
  const bases = {};
  for (const b of CFG.BASES) { const r = await git(CFG.REPO_ROOT, ['log', '-1', '--format=%cI', b]); if (r) bases[b] = r; }
  const iis = readIis();
  // the PR behind each worktree: by source branch, or by id for the review-<id> checkouts
  const prs = await getPrs();
  const [project, repo] = CFG.PR_SOURCES[0] || [];
  const prOf = async w => {
    const byBranch = w.branch && (prs.recent || []).find(p => p.repo === repo && p.source === w.branch);
    if (byBranch) return byBranch;
    const id = path.basename(w.path).match(/review-(\d+)$/)?.[1];
    if (!id || !repo) return null;
    if (!prById.has(id)) {
      try { const p = shapePr(await ado(`/${project}/_apis/git/repositories/${repo}/pullrequests/${id}?api-version=7.1`), project); prById.set(id, { id: p.id, source: p.source, status: p.status, closed: p.closed, title: p.title, url: p.url, mine: p.mine }); }
      catch (e) { log('pr', id, e.message); return null; }
    }
    const p = prById.get(id); if (p.status === 'active') prById.delete(id);
    return p;
  };
  const rows = await pool(wts, 6, async w => {
    if (!fs.existsSync(w.path)) return { ...w, missing: true };
    const [lg, st] = await Promise.all([git(w.path, ['log', '-1', '--format=%h%x1f%cI%x1f%s']), git(w.path, ['status', '--porcelain'])]);
    const [short, date, subject] = (lg || '').split('\x1f');
    const lines = (st || '').split(/\r?\n/).filter(Boolean);
    let best = null;
    for (const b of Object.keys(bases)) {
      const c = await git(w.path, ['rev-list', '--left-right', '--count', `${b}...HEAD`]);
      if (!c) continue; const [behind, ahead] = c.split(/\s+/).map(Number);
      if (!best || ahead < best.ahead) best = { base: b.replace('origin/', ''), behind, ahead };
    }
    let db = null;
    if (CFG.DB_CONFIG) try { const m = fs.readFileSync(path.join(w.path, CFG.DB_CONFIG), 'utf8').match(/Data Source=(?:localhost|127\.0\.0\.1|\.),(\d+)/i); if (m) db = +m[1]; } catch {}
    const norm = p => p.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
    const sites = iis ? iis.filter(s => norm(s.path).startsWith(norm(w.path) + '/')).map(s => s.name) : null;
    return { ...w, short, date, subject, modified: lines.filter(l => !l.startsWith('??')).length, untracked: lines.filter(l => l.startsWith('??')).length, ...best, db, sites,
      main: path.resolve(w.path) === path.resolve(CFG.REPO_ROOT), pr: await prOf(w) };
  });
  return { at: Date.now(), bases, iisReadable: !!iis, worktrees: rows };
}, 2 * 60e3);

// applicationHost.config is readable unelevated on most dev machines; when it isn't, the worktree column says so.
function readIis() {
  try {
    const x = fs.readFileSync(path.join(process.env.windir || 'C:/Windows', 'System32/inetsrv/config/applicationHost.config'), 'utf8');
    const sites = [];
    for (const m of x.matchAll(/<site name="([^"]+)"[\s\S]*?<\/site>/g)) {
      const p = m[0].match(/<application path="\/"[^>]*>[\s\S]*?<virtualDirectory path="\/" physicalPath="([^"]+)"/);
      if (p) sites.push({ name: m[1], path: p[1].replace(/%([^%]+)%/g, (_, v) => process.env[v] || '') });
    }
    return sites;
  } catch { return null; }
}

// ---------- docker ----------
const dockerState = { at: 0, containers: [], df: [], error: null, hist: {} };
const HIST = 60;
const parseBytes = s => { const m = String(s).match(/([\d.]+)\s*([KMGT]?i?B)/i); if (!m) return 0; const u = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 }[m[2].toUpperCase()] || 1; return +m[1] * u; };
const jsonLines = s => s.split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
let dfAt = 0;
async function sampleDocker() {
  const ps = await run(`docker ps -a --no-trunc --format "{{json .}}"`, { timeout: 20000 });
  if (!ps.ok) { dockerState.error = ps.error; dockerState.containers = []; dockerState.at = Date.now(); return; }
  const st = await run(`docker stats --no-stream --format "{{json .}}"`, { timeout: 30000 });
  const stats = Object.fromEntries((st.ok ? jsonLines(st.out) : []).map(s => [s.Name, s]));
  const now = Date.now();
  dockerState.error = null;
  dockerState.containers = jsonLines(ps.out).map(c => {
    const s = stats[c.Names], h = dockerState.hist[c.Names] ||= [];
    if (s) { h.push([now, parseFloat(s.CPUPerc) || 0, parseBytes(String(s.MemUsage).split('/')[0])]); if (h.length > HIST) h.shift(); }
    return { name: c.Names, image: c.Image, state: c.State, status: c.Status, health: c.HealthStatus || '', created: c.CreatedAt, ports: [...new Set([...String(c.Ports).matchAll(/:(\d+)->(\d+)/g)].map(m => `${m[1]}:${m[2]}`))],
      size: c.Size, cpu: s ? parseFloat(s.CPUPerc) : null, mem: s ? parseBytes(String(s.MemUsage).split('/')[0]) : null, memLimit: s ? parseBytes(String(s.MemUsage).split('/')[1]) : null, hist: h };
  });
  if (now - dfAt > 5 * 60e3) {
    const [df, im] = await Promise.all([run(`docker system df --format "{{json .}}"`, { timeout: 60000 }), run(`docker images --format "{{json .}}"`, { timeout: 30000 })]);
    if (df.ok) { dockerState.df = jsonLines(df.out).map(d => ({ type: d.Type, total: +d.TotalCount, active: +d.Active, size: parseBytes(d.Size), reclaim: parseBytes(d.Reclaimable) })); dfAt = now; }
    if (im.ok) dockerState.images = jsonLines(im.out).map(i => ({ repo: i.Repository, tag: i.Tag, id: i.ID, size: parseBytes(i.Size), created: i.CreatedSince }));
  }
  dockerState.at = now;
}

// ---------- local machine + IIS ----------
const machine = { cpu: [], mem: [] };
let lastCpu = os.cpus();
function sampleCpu() {
  const cur = os.cpus(); let idle = 0, total = 0;
  cur.forEach((c, i) => { const p = lastCpu[i].times, t = c.times; const d = k => t[k] - p[k]; idle += d('idle'); total += d('user') + d('nice') + d('sys') + d('irq') + d('idle'); });
  lastCpu = cur; const now = Date.now();
  machine.cpu.push([now, total ? 100 * (1 - idle / total) : 0]); machine.mem.push([now, os.totalmem() - os.freemem()]);
  if (machine.cpu.length > 120) { machine.cpu.shift(); machine.mem.shift(); }
}
function probe(url) {
  return new Promise(res => {
    const t0 = Date.now();
    const req = https.get(url, { rejectUnauthorized: false, timeout: 8000 }, r => { r.resume(); res({ up: true, code: r.statusCode, ms: Date.now() - t0 }); });
    req.on('timeout', () => { req.destroy(); res({ up: false, error: 'timed out', ms: Date.now() - t0 }); });
    req.on('error', e => res({ up: false, error: e.code === 'ECONNREFUSED' ? 'not listening' : e.code || e.message, ms: Date.now() - t0 }));
  });
}
const PS_LOCAL = `$p = Get-CimInstance Win32_Process -Filter "Name='w3wp.exe' or Name='iisexpress.exe' or Name='vmmem.exe' or Name='vmmemWSL' or Name='devenv.exe' or Name='node.exe' or Name='Rider64.exe'" | Select-Object ProcessId,Name,CommandLine,WorkingSetSize,CreationDate;
$ports = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess -Unique;
$disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,Size,FreeSpace,VolumeName;
$vm = Get-Process -Name 'vmmem*' -ErrorAction SilentlyContinue | Select-Object Name,Id,WorkingSet64;
[pscustomobject]@{ procs = @($p); ports = @($ports); disks = @($disks); vm = @($vm) } | ConvertTo-Json -Depth 4 -Compress`;
const getLocal = cached(async () => {
  const [probes, ps] = await Promise.all([
    Promise.all(CFG.SITES.map(([name, url, site]) => probe(url).then(p => ({ name, url, site, ...p })))),
    run(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(PS_LOCAL, 'utf16le').toString('base64')}`, { timeout: 30000 }),
  ]);
  let procs = [], ports = [], disks = [], vm = [];
  if (ps.ok) { try { ({ procs, ports, disks, vm } = JSON.parse(ps.out)); } catch (e) { log('local json', e.message); } }
  const portsOf = pid => ports.filter(p => p.OwningProcess === pid).map(p => p.LocalPort);
  const pools = procs.filter(p => p.Name === 'w3wp.exe').map(p => ({ pid: p.ProcessId, pool: (p.CommandLine || '').match(/-ap "([^"]+)"/)?.[1] || '?', mem: p.WorkingSetSize, started: p.CreationDate }));
  const express = procs.filter(p => p.Name === 'iisexpress.exe').map(p => ({ pid: p.ProcessId, site: (p.CommandLine || '').match(/\/site:"?([^"\s]+)/i)?.[1] || '', config: (p.CommandLine || '').match(/\/config:"?([^"]+?)"?(\s|$)/i)?.[1] || '', ports: portsOf(p.ProcessId), mem: p.WorkingSetSize, started: p.CreationDate }));
  const iis = readIis();
  return {
    at: Date.now(), host: os.hostname(), uptime: os.uptime(), totalmem: os.totalmem(), cpus: os.cpus().length,
    sites: probes.map(s => ({ ...s, path: iis?.find(x => x.name === s.site)?.path || null })), iisReadable: !!iis, pools, express,
    disks: disks.map(d => ({ id: d.DeviceID, size: d.Size, free: d.FreeSpace, label: d.VolumeName })),
    vm: vm.reduce((t, v) => t + v.WorkingSet64, 0),
    dev: procs.filter(p => /devenv|Rider64/.test(p.Name)).map(p => ({ name: p.Name, mem: p.WorkingSetSize })),
  };
}, 20e3);

// ---------- review threads ----------
// "Start review" posts the PR's facts to a T3 Code webhook task, signed with HMAC-SHA256. The task holds the review
// instructions; the request only carries data, so nothing in a PR title can steer the run.
const REVIEWS = path.join(__dirname, 'reviews.json');
let reviews = {}; try { reviews = JSON.parse(fs.readFileSync(REVIEWS, 'utf8')); } catch {}
const reviewSecret = () => { try { return fs.readFileSync(path.join(__dirname, '.review-secret'), 'utf8').trim(); } catch { return ''; } };
// the T3 thread that reviewed a PR last: a re-check sent from here, a Start review click, or a thread named after it
async function reviewThreadFor(id, force) {
  const { byReviewPr = {}, dashReviews = [] } = await getThreads(force);
  const known = new Map([...dashReviews, ...Object.values(byReviewPr)].map(t => [t.id, t]));
  const found = [byReviewPr[id]];
  if (reviews[id]) found.push(dashReviews.find(t => Math.abs(Date.parse(t.createdAt) - reviews[id].at) < 60e3));
  // a re-check made since the last thread list, before the list knows it
  const rc = RECHECKS.v[id]; if (rc?.thread) found.push(known.get(rc.thread) || { id: rc.thread, title: 'Re-check', status: 'starting', updatedAt: new Date(rc.at).toISOString() });
  return found.filter(Boolean).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0] || null;
}
// "Merge confidence: 7/10" (or "merge confidence is now 7/10", "confidence score 8 out of 10") in the thread's latest
// answer that has one; read again only when the thread changed
const SCORES = new Map();
async function reviewScore(thread) {
  const hit = SCORES.get(thread.id);
  if (hit && hit.updatedAt === thread.updatedAt) return hit.score;
  const r = await t3(['thread', 'show', '--json', '--messages', '12', thread.id]);
  let score = null;
  if (r.ok) try {
    const msgs = JSON.parse(r.out).messages.filter(m => m.role === 'assistant').reverse();
    for (const m of msgs) {
      const all = [...String(m.text).matchAll(/confidence[^0-9\n]{0,40}?(\d{1,2})\s*(?:\/|out of)\s*10\b/gi)];
      if (all.length) { score = { value: +all[all.length - 1][1], at: thread.updatedAt }; break; }
    }
  } catch (e) { log('score', thread.id, e.message); }
  SCORES.set(thread.id, { updatedAt: thread.updatedAt, score });
  return score;
}
// per PR of someone else's: its review thread, the last score, and whether a re-check can be sent
async function reviewState(prs) {
  const others = (prs.active || []).filter(p => !p.mine), threads = {};
  if (others.length) await pool(others, 4, async p => {
    const t = await reviewThreadFor(p.id); if (!t || !/^[\w:-]+$/.test(t.id)) return;
    threads[p.id] = { id: t.id, title: t.title, status: t.status, updatedAt: t.updatedAt, score: await reviewScore(t) };
  });
  return { configured: !!(CFG.REVIEW_WEBHOOK && reviewSecret()), started: reviews, threads, rechecks: RECHECKS.v, approveAt: CFG.APPROVE_SCORE };
}
async function startReview(id) {
  const secret = reviewSecret();
  if (!CFG.REVIEW_WEBHOOK || !secret) return [409, { error: "The review webhook isn't set up: it needs REVIEW_WEBHOOK in config.json and a .review-secret file." }];
  const prs = await getPrs(), pr = (prs.active || []).find(p => p.id === id);
  if (!pr || pr.mine) return [400, { error: `!${id} isn't an open PR of someone else's on this dashboard` }];
  // a second click shouldn't start a second thread; T3 starts each request at once, so the guard lives here
  if (Date.now() - (reviews[id]?.at || 0) < 2 * 60e3) return [409, { error: `a review of !${id} was started less than 2 minutes ago` }];
  const [backlog, wts] = await Promise.all([getBacklog(), getWorktrees()]);
  const pbis = (pr.workItems || []).map(w => { const i = (backlog.items || []).find(x => x.id === w); return i ? { id: w, title: i.title, state: i.state, assignedTo: i.who } : { id: w }; });
  const wt = (wts.worktrees || []).find(w => w.pr?.id === id || w.path.endsWith('-review-' + id));
  const body = JSON.stringify({
    pr: id, project: pr.project, repo: pr.repo, url: pr.url, title: pr.title, author: pr.by, source: pr.source, target: pr.target, draft: pr.draft,
    pbis, worktree: wt ? path.resolve(wt.path) : null, votedBefore: !!pr.reviewers.find(r => r.me)?.vote,
  });
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  const r = await fetch(CFG.REVIEW_WEBHOOK, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Dashboard-Signature': sig }, signal: AbortSignal.timeout(20000) });
  const text = (await r.text()).slice(0, 300);
  log('review', id, r.status, text.replace(/\s+/g, ' '));
  if (!r.ok) return [502, { error: `T3 Code answered ${r.status}: ${text}` }];
  reviews[id] = { at: Date.now() }; fs.writeFileSync(REVIEWS, JSON.stringify(reviews, null, 2));
  return [200, { ok: true }];
}

// ---------- Fix comments: hand the open comments on your PR to the T3 Code thread that made it ----------
// The `t3` CLI lists each project's threads with the PRs linked to them, and `t3 thread send` queues a message for
// a thread: a busy thread gets it as its next turn. The .cmd needs a shell, so args are fixed words, checked ids and
// quoted paths, and the message goes through stdin.
function t3(args, input, timeout = 30000) {
  return new Promise(res => {
    const p = exec(`"${CFG.T3_CLI}" ${args.join(' ')}`, { timeout, maxBuffer: 32 << 20, windowsHide: true }, (err, out, errOut) =>
      res(err ? { ok: false, error: classify(errOut || out || err.message, err) } : { ok: true, out }));
    p.stdin.end(input ?? '');
  });
}
// PR url → the most recently active top-level thread linked to it; work item id → the same for threads with "#<id>" or
// "PBI <id>" in their title, which is how PBI threads are named
// Review threads: the webhook task names every thread "PR review from the dashboard", so those are matched to a PR by
// their start time (within a minute of the Start review click in reviews.json); threads made by hand name the PR in
// their title ("Code review PR 1234").
const getThreads = cached(async () => {
  const byPr = {}, byPbi = {}, byReviewPr = {}, dashReviews = [];
  const keep = (map, key, t) => { if (!map[key] || map[key].updatedAt < t.updatedAt) map[key] = { id: t.threadId, title: t.title, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt }; };
  await pool(CFG.T3_PROJECTS.filter(p => fs.existsSync(p)), 4, async project => {
    const r = await t3(['thread', 'list', '--json', '--project', `"${project}"`]);
    if (!r.ok) return log('t3', project, r.error.message);
    for (const t of JSON.parse(r.out)) {
      if (t.parentThreadId) continue;
      for (const p of t.pullRequests || []) keep(byPr, p.url.toLowerCase(), t);
      for (const m of String(t.title).matchAll(/(?:#|\bPBI\s+)(\d{5,6})\b/gi)) keep(byPbi, m[1], t);
      if (t.title === 'PR review from the dashboard') dashReviews.push({ id: t.threadId, title: t.title, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt });
      else if (/review|re-?check/i.test(t.title)) for (const m of String(t.title).matchAll(/\bPR\s*!?(\d{5,6})\b/gi)) keep(byReviewPr, m[1], t);
    }
  });
  return { byPr, byPbi, byReviewPr, dashReviews };
}, 5 * 60e3);
const getPrThreads = async force => (await getThreads(force)).byPr || {};
// what was sent to which thread, per button: fixes.json and finishes.json
const store = file => { const f = path.join(__dirname, file); let v = {}; try { v = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {} return { v, save: () => fs.writeFileSync(f, JSON.stringify(v, null, 2)) }; };
const SENT = { fix: store('fixes.json'), finish: store('finishes.json') };
// your PR can be finished once someone else approved it, nobody rejected it or waits on you, and it merges cleanly;
// a branch with a comment policy also needs every comment resolved, so the page greys the button out while comments are open
const approved = pr => pr.reviewers.some(r => !r.me && r.vote >= 5) && !pr.reviewers.some(r => r.vote < 0);
const finishable = pr => pr.mine && !pr.draft && approved(pr) && pr.merge !== 'conflicts';
// threads are only looked up when one of your PRs has a button to show
async function threadState(prs) {
  const mine = (prs.active || []).filter(p => p.mine), threads = mine.some(p => p.comments?.you || finishable(p)) ? await getPrThreads() : {};
  return { threads: Object.fromEntries(mine.filter(p => threads[p.url.toLowerCase()]).map(p => [p.id, threads[p.url.toLowerCase()]])),
    finishable: mine.filter(finishable).map(p => p.id), sent: { fix: SENT.fix.v, finish: SENT.finish.v } };
}
// checks the PR and its thread, then queues the message for that thread
async function sendToThread(kind, id, check, message) {
  const prs = await getPrs(true), pr = (prs.active || []).find(p => p.id === id);
  if (!pr || !pr.mine) return [400, { error: `!${id} isn't an open PR of yours on this dashboard` }];
  const why = check(pr); if (why) return [409, { error: why }];
  const sent = SENT[kind];
  if (Date.now() - (sent.v[id]?.at || 0) < 2 * 60e3) return [409, { error: `this was sent for !${id} less than 2 minutes ago` }];
  const thread = (await getPrThreads())[pr.url.toLowerCase()];
  // ids are a uuid, or prefixed like mcp:<uuid> and thread:project:<id>:<uuid> for threads an agent made
  if (!thread || !/^[\w:-]+$/.test(thread.id)) { log(kind, id, 'no usable thread', thread?.id); return [409, { error: `no T3 Code thread is linked to !${id}` }]; }
  const r = await t3(['thread', 'send', thread.id, '-'], await message(pr));
  log(kind, id, thread.id, r.ok ? 'sent' : r.error.message);
  if (!r.ok) return [502, { error: `t3 thread send failed: ${r.error.message}` }];
  sent.v[id] = { at: Date.now(), thread: thread.id }; sent.save();
  return [200, { ok: true, thread: thread.title }];
}
const fixComments = id => sendToThread('fix', id, pr => !pr.comments?.you && `no comments on !${id} wait on you`, pr => {
  const n = pr.comments.you;
  return `PR !${id} (${pr.url}) has ${n} open review comment${n > 1 ? 's' : ''} waiting on you. Sent from my dashboard.

1. Read the open comment threads on the PR in Azure DevOps: status active or pending, where someone else wrote the last comment.
2. Handle each one in this PR's worktree. Fix what it asks and run the tests that cover the change. If a comment is a question, or you think the code should stay as it is, answer it instead of changing code. If a fix needs a decision from me, ask me first and leave that thread alone.
3. Commit and push.
4. Reply on each thread you handled with what you did and the commit, then resolve it (status Fixed, or Closed when you only answered). Leave the threads that wait on my decision open.
5. Finish with a short list per thread: what you did, or what you need from me.`;
});
const finishPr = id => sendToThread('finish', id,
  pr => !finishable(pr) ? `!${id} isn't approved, or it is a draft, rejected or has conflicts`
    : pr.comments?.open ? `!${id} still has ${pr.comments.open} open comment${pr.comments.open > 1 ? 's' : ''}` : null,
  async pr => {
    const wt = ((await getWorktrees()).worktrees || []).find(w => w.pr?.id === id);
    const by = pr.reviewers.filter(r => !r.me && r.vote >= 5).map(r => r.name).join(', ');
    const sim = pr.repo === CFG.PR_SOURCES[0]?.[1];
    const build = sim ? `Build on the merged ${pr.target} (fetch, then check out origin/${pr.target} in the PR's worktree): ${CFG.BUILD_HINT} If it breaks, stop before step 5 and tell me.`
      : `This PR is in ${pr.repo}: check the merged result the way that repo is checked.`;
    const clean = `Clean up what this PR used, and nothing that other work still uses: any containers or local sites you started for it, the local branch, and last the worktree itself${sim ? `, run from ${CFG.REPO_ROOT}` : ' if you made one'}. Keep the main checkout and anything another open PR uses. Ask me when you aren't sure.`;
    return `PR !${id} (${pr.url}) is approved by ${by}. Finish it. Sent from my dashboard.
Branch ${pr.source} into ${pr.target}. Linked work items: ${(pr.workItems || []).map(w => '#' + w).join(', ') || 'none'}.${wt ? ` Worktree: ${path.resolve(wt.path)}${wt.db ? `, dev-DB on port ${wt.db}` : ''}.` : ''}

1. Check the PR in Azure DevOps first: still active, the approval counts for the latest push, no comment thread open, no merge conflicts, and every policy passes. If any of that fails, stop and tell me. Never bypass a policy.
2. Complete the PR the way our PRs into ${pr.target} are completed: squash merge, delete the source branch, and the default "Merged PR ${id}: <title>" message with the description. Don't let the completion move work items; step 4 does that.
3. ${build}
4. For each linked PBI, check its acceptance criteria against what was merged. Set it to Done when all of them are met, and read it back to confirm. If a line isn't met, leave the state and list that line for me.
5. ${clean}
6. Finish with a short list: merged commit, PBI states, what you removed, what you kept and why.`;
  });

// ---------- Re-check: your comments on someone else's PR are resolved or answered ----------
// Goes to the thread that reviewed the PR, which knows its findings and worktree; without one, a new thread starts in
// the project checkout and makes its own review worktree, as Start review does. rechecks.json remembers what was sent.
const RECHECKS = store('rechecks.json');
SENT.recheck = RECHECKS;
async function recheckPr(id) {
  const prs = await getPrs(true), pr = (prs.active || []).find(p => p.id === id);
  if (!pr || pr.mine) return [400, { error: `!${id} isn't an open PR of someone else's on this dashboard` }];
  const c = pr.comments?.mine;
  if (!c?.total) return [409, { error: `you have no comment threads on !${id}` }];
  if (c.waiting) return [409, { error: `${c.waiting} of your comment${c.waiting > 1 ? 's' : ''} on !${id} still wait${c.waiting > 1 ? '' : 's'} on ${pr.by}` }];
  if (Date.now() - (RECHECKS.v[id]?.at || 0) < 2 * 60e3) return [409, { error: `a re-check of !${id} was sent less than 2 minutes ago` }];
  const thread = await reviewThreadFor(id, true), old = thread && /^[\w:-]+$/.test(thread.id) ? thread : null;
  const before = old && (await reviewScore(old))?.value;
  const sim = pr.repo === CFG.PR_SOURCES[0]?.[1], at = CFG.APPROVE_SCORE;
  const others = (pr.reviewedBy || []).map(r => `${r.name} (${VOTE_WORD[r.vote] || 'no vote'}${r.threads ? `, ${r.threads} thread${r.threads > 1 ? 's' : ''}` : ''})`).join(', ');
  const message = `Re-check PR !${id} (${pr.url}) by ${pr.by}: "${pr.title}". Sent from my dashboard.
Branch ${pr.source} into ${pr.target}. Linked work items: ${(pr.workItems || []).map(w => '#' + w).join(', ') || 'none'}.
My comment threads on it: ${c.total}, of which ${c.resolved} resolved and ${c.answered} answered by someone else but still open.${others ? ` Other reviewers: ${others}.` : ''}${old ? `${before ? ` Your last merge confidence was ${before}/10.` : ''}` : ' No earlier review thread of mine was found, so read my threads on the PR for what I asked;'}

1. Fetch the PR's latest head and bring the review worktree up to it (${old ? 'the one you used' : `${path.basename(CFG.REPO_ROOT || 'repo')}-review-${id} or the like; make one if there is none`}). Never touch the author's own worktree or branch.${sim ? ` Then start the build in the background (${CFG.BUILD_HINT}) and do step 2 while it runs.` : ''}
2. For each thread I started: check that the code on the new head really fixes it, or that the author's answer holds. Also read the threads other reviewers started.
3. ${sim ? 'Rerun the tests that cover the changes once the build is done. Check in the running app only what changed on screen since the last review (views, JavaScript, CSS, controllers), reusing what the first review set up if it is still there; for back-end-only fixes the build and tests are enough. Give the app check about 10 minutes at most, then report it as "not checked in the app" with the reason instead of retrying.' : `This PR is in ${pr.repo}: check it the way that repo is checked.`} Look at everything that changed since the last review for new problems, and check the acceptance criteria of the linked work items again.
4. Don't post comments, reply or resolve threads on the PR.
5. Report per thread: fixed, not fixed, or answer accepted (with the thread id), then new findings by priority, and end with the line "Merge confidence: N/10".
6. If N is ${at} or higher, vote Approve on the PR in Azure DevOps and read the vote back. Only the vote: no auto-complete, no merge, no completion options. Below ${at}, don't vote, and say what holds the score back.`;
  let r, threadId = old?.id;
  if (old) r = await t3(['thread', 'send', old.id, '-'], message);
  else {
    r = await t3(['thread', 'start', '--json', '--title', `"${safeTitle(`Re-check PR ${id} — ${pr.title}`)}"`, `"${CFG.REPO_ROOT}"`, '-'], message, 300000);
    if (r.ok) try { threadId = JSON.parse(r.out).threadId; } catch { threadId = (r.out.match(/[\w:-]{20,}/) || [''])[0]; }
  }
  log('recheck', id, old ? 'send ' + old.id : 'start', r.ok ? 'ok' : r.error.message);
  if (!r.ok) return [502, { error: `t3 thread ${old ? 'send' : 'start'} failed: ${r.error.message}` }];
  RECHECKS.v[id] = { at: Date.now(), thread: threadId }; RECHECKS.save();
  getThreads(true).catch(() => {});
  return [200, { ok: true, thread: old ? old.title : 'a new thread', sent: !!old }];
}
const VOTE_WORD = { 10: 'approved', 5: 'approved with suggestions', '-5': 'waiting for author', '-10': 'rejected' };

// ---------- start work on a PBI ----------
// Starts a new T3 Code thread in a new worktree from the team branch, with a brief to plan, build and open a draft PR.
// Only for an open backlog item that is unassigned or yours and has no thread yet; starts.json remembers what was started.
SENT.start = store('starts.json');
const START_BASE = CFG.WATCH_TARGET.replace('refs/heads/', '');
const graphData = () => new Function(`${fs.readFileSync(path.join(__dirname, 'backlog-data.js'), 'utf8')}; return { N, E };`)();
const STOP = new Set(['a', 'an', 'and', 'the', 'of', 'to', 'in', 'on', 'for', 'by', 'with', 'its', 'their', 'pbi']);
const branchFor = (id, title) => `feature/${id}-${title.replace(/^PBI-\S+\s*[—–-]\s*/, '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w && !STOP.has(w)).slice(0, 4).join('-') || 'work'}`;
// the title goes on a cmd.exe command line, so it keeps only characters that are inert there
const safeTitle = t => t.replace(/[^\p{L}\p{N} #—–.,:()/+'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 120);
async function workState() {
  const { byPbi = {} } = await getThreads();
  return { threads: byPbi, started: SENT.start.v, available: CFG.T3_PROJECTS.length > 0 && fs.existsSync(CFG.T3_CLI) };
}
async function startWork(id) {
  if (Date.now() - (SENT.start.v[id]?.at || 0) < 10 * 60e3) return [409, { error: `#${id} was started less than 10 minutes ago` }];
  const w = await ado(`/${CFG.BACKLOG_PROJECT}/_apis/wit/workitems/${id}?fields=System.Title,System.State,System.Tags,System.AssignedTo,System.AreaPath,System.WorkItemType&api-version=7.1`).catch(e => (log('start', id, e.message), null));
  if (!w) return [404, { error: `#${id} could not be read from Azure Boards` }];
  const f = w.fields, title = f['System.Title'], who = f['System.AssignedTo'];
  if (!String(f['System.AreaPath']).startsWith(CFG.BACKLOG_AREA)) return [400, { error: `#${id} isn't in ${CFG.BACKLOG_AREA}` }];
  if (!['Product Backlog Item', 'Bug'].includes(f['System.WorkItemType'])) return [400, { error: `#${id} is a ${f['System.WorkItemType']}` }];
  if (['Done', 'Removed'].includes(f['System.State'])) return [409, { error: `#${id} is ${f['System.State']}` }];
  if (who && (who.uniqueName || '').toLowerCase() !== CFG.ME.toLowerCase()) return [409, { error: `#${id} is assigned to ${cleanName(who.displayName)}` }];
  const thread = (await getThreads(true)).byPbi?.[id];
  if (thread) return [409, { error: `#${id} already has a T3 thread: ${thread.title}` }];
  const branch = branchFor(id, title);
  const remote = (await git(CFG.REPO_ROOT, ['ls-remote', '--heads', 'origin'], 60000) || '').split('\n').map(l => l.split('refs/heads/')[1]).filter(b => b && new RegExp(`(^|/)${id}[-_]`).test(b));
  if (remote.length) return [409, { error: `#${id} already has a branch: ${remote.join(', ')}` }];
  await git(CFG.REPO_ROOT, ['fetch', 'origin', START_BASE], 120000);

  // where it sits in the curated graph: the open items it waits on and the ones waiting on it
  const live = new Map(((await getBacklog()).items || []).map(i => [i.id, i]));
  const { N, E } = graphData(), row = N.find(r => r[0] === id), isOpen = x => live.get(x) && !['Done', 'Removed'].includes(live.get(x).state);
  const name = x => { const r = N.find(n => n[0] === x); return `${r ? r[1] + ' ' : ''}#${x} "${live.get(x)?.title.replace(/^PBI-\S+\s*[—–-]\s*/, '') || r?.[2] || ''}" (${live.get(x)?.state || '?'}${live.get(x)?.who ? ', ' + live.get(x).who : ''})`; };
  const waits = E.filter(e => e[1] === id && isOpen(e[0])).map(e => name(e[0]) + (e[2] ? ', for one acceptance criterion only' : ''));
  const unblocks = E.filter(e => e[0] === id && isOpen(e[1])).map(e => name(e[1]));
  const tags = String(f['System.Tags'] || '').split(/;\s*/).filter(Boolean), phase = tags.find(t => /^p[01]$/i.test(t))?.toUpperCase() || 'untagged';
  const code = title.match(/^(PBI-\S+)/)?.[1] || (f['System.WorkItemType'] === 'Bug' ? 'Bug' : 'PBI');
  const plain = title.replace(/^PBI-\S+\s*[—–-]\s*/, '');
  const list = a => a.length ? a.map(x => `\n  - ${x}`).join('') : ' nothing open';

  const message = `Start ${code} #${id} "${plain}" (${f['System.WorkItemType']}, ${phase}, area ${f['System.AreaPath']}). Sent from my dashboard. You're in a new worktree from \`origin/${START_BASE}\` on \`${branch}\`.

When you start, assign #${id} to me and set it to Committed. Read it back afterwards to confirm the write landed.

Where it sits in my dependency graph (curated by hand in the dashboard, so check it against the work item itself):
- Waits on:${list(waits)}
- Unblocks:${list(unblocks)}${row?.[6] ? `\n- Note: ${row[6]}` : ''}${row?.[7] ? `\n- Outside the team: ${row[7]}` : ''}

## Step 1: read, study, and agree the plan with me before building
- **The work item:** the whole description and acceptance criteria, and the items next to it in the graph, so this one leaves room for them without building them.
- **What already exists** in ${START_BASE} for it, and the screens or code to reuse.
- **Others' work:** if someone else is working in the same code right now (the In Progress and Committed items on the board, their open PRs into ${START_BASE}), tell me before you touch it.

Then **send me the plan and wait for my OK before writing code**. Cover what you'll build per acceptance criterion, where it lives, data changes, the tests, and every gap or contradiction you found, each with your recommendation.

## Making sure it works
- ${CFG.BUILD_HINT} Add tests for what you build.
- If it changes what users see, check it in the running app and take screenshots.

## Commits and PR
- Mention #${id} in the commit subjects. Never \`git add -A\`: add the files you changed.
- Rebase on \`origin/${START_BASE}\` before pushing, and build again afterwards.
- Open a **draft** PR into \`${START_BASE}\`, link #${id}, and give the full PR URL. Keep the description to what changed and what a reviewer must do. Don't publish it or add reviewers: I look at it first.

## Review our own work
Once it works, review the diff against \`origin/${START_BASE}\` and check every acceptance criterion against the code. Fix the real findings, rebuild, retest and push.

Finish with a short report: the PR URL, each acceptance criterion and whether it's met, what the review found and what you fixed, anything open or needing my decision, and a merge confidence score from 1 to 10.`;

  const r = await t3(['thread', 'start', '--json', '--worktree', `origin/${START_BASE}`, '--branch', branch, '--title', `"${safeTitle(`${code} #${id} — ${plain}`)}"`, `"${CFG.REPO_ROOT}"`, '-'], message, 300000);
  log('start', id, branch, r.ok ? 'started' : r.error.message);
  if (!r.ok) return [502, { error: `t3 thread start failed: ${r.error.message}` }];
  let started = {}; try { started = JSON.parse(r.out); } catch { started = { threadId: (r.out.match(/[\w:-]{20,}/) || [''])[0] }; }
  SENT.start.v[id] = { at: Date.now(), thread: started.threadId || started.id || '', branch, title }; SENT.start.save();
  getThreads(true).catch(() => {});
  return [200, { ok: true, branch, title }];
}

// ---------- http ----------
const send = (res, code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/backlog-data.js': ['backlog-data.js', 'text/javascript; charset=utf-8'] };
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'), force = u.searchParams.has('force');
    if (req.method === 'GET' && u.pathname === '/api/config') return send(res, 200, {
      name: CFG.NAME, team: START_BASE, designRepo: CFG.DESIGN?.[1] || '', devImagePrefix: CFG.DEV_IMAGE_PREFIX,
      workItemUrl: CFG.ORG && CFG.BACKLOG_PROJECT ? `${CFG.ORG}/${encodeURIComponent(CFG.BACKLOG_PROJECT)}/_workitems/edit/` : '' });
    if (req.method === 'GET' && u.pathname === '/api/backlog') return send(res, 200, await getBacklog(force));
    if (req.method === 'GET' && u.pathname === '/api/prs') { const prs = await getPrs(force); return send(res, 200, { ...prs, review: await reviewState(prs), thread: await threadState(prs), work: await workState() }); }
    // writes only from this page: a custom header forces a CORS preflight (which this server never grants), and the
    // Host check stops a rebound DNS name from reaching it
    if (req.method === 'POST' && (req.headers['x-dashboard'] !== '1' || !/^(localhost|127\.0\.0\.1):\d+$/.test(req.headers.host || ''))) return send(res, 403, { error: 'forbidden' });
    const rv = u.pathname.match(/^\/api\/review\/(\d+)$/);
    if (req.method === 'POST' && rv) { const [code, body] = await startReview(+rv[1]); return send(res, code, body); }
    const fx = u.pathname.match(/^\/api\/fix-comments\/(\d+)$/);
    if (req.method === 'POST' && fx) { const [code, body] = await fixComments(+fx[1]); return send(res, code, body); }
    const fin = u.pathname.match(/^\/api\/finish\/(\d+)$/);
    if (req.method === 'POST' && fin) { const [code, body] = await finishPr(+fin[1]); return send(res, code, body); }
    const rc = u.pathname.match(/^\/api\/recheck\/(\d+)$/);
    if (req.method === 'POST' && rc) { const [code, body] = await recheckPr(+rc[1]); return send(res, code, body); }
    const sw = u.pathname.match(/^\/api\/start-work\/(\d+)$/);
    if (req.method === 'POST' && sw) { const [code, body] = await startWork(+sw[1]); return send(res, code, body); }
    if (req.method === 'GET' && u.pathname === '/api/drift') return send(res, 200, await getDrift(force));
    if (req.method === 'GET' && u.pathname === '/api/throughput') return send(res, 200, await getThroughput(force));
    if (req.method === 'GET' && u.pathname === '/api/design') return send(res, 200, await getDesign(force));
    if (req.method === 'GET' && u.pathname === '/api/worktrees') return send(res, 200, await getWorktrees(force));
    if (req.method === 'GET' && u.pathname === '/api/local') return send(res, 200, { ...(await getLocal(force)), cpu: machine.cpu, mem: machine.mem });
    if (req.method === 'GET' && u.pathname === '/api/docker') { if (force) await sampleDocker(); return send(res, 200, dockerState); }
    const m = u.pathname.match(/^\/api\/docker\/([^/]+)\/(start|stop)$/);
    if (req.method === 'POST' && m) {
      // the name must be a container docker itself listed: that check is the injection boundary for the command line
      const name = decodeURIComponent(m[1]);
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || !dockerState.containers.some(c => c.name === name)) return send(res, 400, { error: 'unknown container' });
      log('docker', m[2], name);
      const r = await run(`docker ${m[2]} ${name}`, { timeout: 90000 });
      await sampleDocker();
      return send(res, r.ok ? 200 : 500, r.ok ? { ok: true } : { error: r.error });
    }
    const s = STATIC[u.pathname];
    if (req.method === 'GET' && s) return send(res, 200, fs.readFileSync(path.join(__dirname, s[0])), s[1]);
    send(res, 404, { error: 'not found' });
  } catch (e) { log('request', req.url, e.stack || e); send(res, 502, { error: String(e.message || e) }); }
});
process.on('uncaughtException', e => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} uncaught ${e.stack}\n`); } catch {} process.exit(1); });

server.listen(CFG.PORT, '127.0.0.1', () => {
  log(`Dev dashboard on http://localhost:${CFG.PORT}`);
  // keep everything warm so a fresh tab renders at once
  sampleCpu(); setInterval(sampleCpu, 5000);
  sampleDocker(); setInterval(sampleDocker, 15000);
  const warm = () => { getBacklog(); getPrs(); getWorktrees(); getLocal(); getDrift(); getDesign(); };
  warm(); setInterval(warm, 60000);
});
