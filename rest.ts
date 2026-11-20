// GitHub REST v3 surface. Operates on the in-memory Store; every reply is JSON.
// Auth + X-GitHub-Request-Id are handled by app.ts; this module returns status/body.
import type { Issue, Pull, Repo, Store } from './store.ts';
import { FIXED_ISO, VIEWER, VIEWER_LOGIN, putObject } from './store.ts';

export interface RestResult { status: number; body: unknown; headers?: Record<string, string> }
const ok = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const err = (status: number, message: string): RestResult => ok(status, { message });
const notFound = (what = 'Not Found'): RestResult => err(404, what);

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
  };
}
function labelView(l: { name: string; color: string }): Record<string, unknown> {
  return { name: l.name, color: l.color, description: '' };
}
function issueView(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelView),
    user: { login: VIEWER_LOGIN, id: VIEWER.id },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
  };
}
function pullView(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged,
    mergeable: !pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}
function paginate<T>(items: T[], query: URLSearchParams, baseUrl: string, path: string): { items: T[]; link: string | null } {
  const { page, perPage } = parsePage(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URL(path, baseUrl);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    // preserve other query params the client sent (state/sort/...)
    for (const [k, v] of query) {
      if (k !== 'page' && k !== 'per_page') next.searchParams.set(k, v);
    }
    link = `<${next.toString()}>; rel="next"`;
  }
  return { items: slice, link };
}

function resolveRef(store: Store, repo: Repo, ref: string | null): string | undefined {
  if (!ref) return store.branchTip(repo, repo.defaultBranch);
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return undefined;
}

/** Commit a file through the contents API. Returns the commit/content shas and 201/200. */
function commitFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  expectedSha?: string,
): { status: number; commitSha: string; contentSha: string } | { status: 409 } {
  const tip = store.branchTip(repo, branch);
  const files = new Map<string, { oid: string; mode: string }>();
  let parents: string[] = [];
  let isUpdate = false;
  if (tip) {
    const commit = store.parseCommit(repo, tip);
    if (!commit) return { status: 409 };
    parents = [tip];
    for (const [p, e] of store.flattenTree(repo, commit.tree)) files.set(p, e);
    const existing = files.get(path);
    if (existing) {
      isUpdate = true;
      if (expectedSha !== undefined && expectedSha.toLowerCase() !== existing.oid.toLowerCase()) return { status: 409 };
    }
  }
  const contentSha = putObject(repo, 'blob', content);
  files.set(path, { oid: contentSha, mode: '100644' });
  const tree = store.treeFromFiles(repo, files);
  const commitSha = store.buildCommit(repo, tree, parents, message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { status: isUpdate ? 200 : 201, commitSha, contentSha };
}

function diffLines(a: string, b: string): { additions: number; deletions: number } {
  // multiset line diff: lines in b not in a = additions, lines in a not in b = deletions
  const count = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const line of s.split('\n')) m.set(line, (m.get(line) ?? 0) + 1);
    return m;
  };
  const ca = count(a);
  const cb = count(b);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of cb) additions += Math.max(0, n - (ca.get(line) ?? 0));
  for (const [line, n] of ca) deletions += Math.max(0, n - (cb.get(line) ?? 0));
  return { additions, deletions };
}

/** Changed files of a pull request (base tree vs head tree), shared with GraphQL. */
export function pullRequestFiles(store: Store, repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] | null {
  const baseCommit = store.parseCommit(repo, pull.baseSha);
  const headCommit = store.parseCommit(repo, pull.headSha);
  if (!baseCommit || !headCommit) return null;
  const baseFiles = store.flattenTree(repo, baseCommit.tree);
  const headFiles = store.flattenTree(repo, headCommit.tree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  for (const p of [...paths].sort()) {
    const b = baseFiles.get(p);
    const h = headFiles.get(p);
    if (b && h && b.oid === h.oid) continue;
    let status = 'modified';
    let additions = 0;
    let deletions = 0;
    if (!b && h) {
      status = 'added';
      const data = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      additions = data === '' ? 0 : data.split('\n').length;
    } else if (b && !h) {
      status = 'removed';
      const data = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      deletions = data === '' ? 0 : data.split('\n').length;
    } else if (b && h) {
      const oldData = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const newData = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const d = diffLines(oldData, newData);
      additions = d.additions;
      deletions = d.deletions;
      if (additions === 0 && deletions === 0) { additions = 1; }
    }
    out.push({ filename: p, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

/** Squash-merge a pull request. Shared with GraphQL's mergePullRequest. */
export function mergePullRequest(store: Store, repo: Repo, pull: Pull): { status: number; sha?: string; message?: string } {
  if (pull.merged || pull.state !== 'open') return { status: 405, message: 'pull request is already merged or closed' };
  const baseTip = store.branchTip(repo, pull.base);
  if (!baseTip) return { status: 404, message: 'Not Found' };
  if (baseTip !== pull.baseSha) {
    const origBase = store.parseCommit(repo, pull.baseSha);
    const curBase = store.parseCommit(repo, baseTip);
    const headC = store.parseCommit(repo, pull.headSha);
    if (origBase && curBase && headC) {
      const origFiles = store.flattenTree(repo, origBase.tree);
      const curFiles = store.flattenTree(repo, curBase.tree);
      const headFiles = store.flattenTree(repo, headC.tree);
      for (const [p, hf] of headFiles) {
        const of = origFiles.get(p);
        const cf = curFiles.get(p);
        if (of && cf && of.oid !== cf.oid && hf.oid !== cf.oid && hf.oid !== of.oid) {
          return { status: 405, message: 'merge conflict' };
        }
      }
    }
  }
  const headCommit = store.parseCommit(repo, pull.headSha);
  if (!headCommit) return { status: 404, message: 'Not Found' };
  const mergeSha = store.buildCommit(repo, headCommit.tree, [baseTip], `Merge pull request #${pull.number} from ${pull.head}`);
  repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = mergeSha;
  return { status: 200, sha: mergeSha, message: `Pull request #${pull.number} merged` };
}

export function handleRest(
  store: Store,
  method: string,
  segs: string[],
  query: URLSearchParams,
  body: Record<string, unknown> | null,
  baseUrl: string,
): RestResult {
  // segs are the path segments after /api/v3 (decoded)
  const [a, b, c, d, e, f] = segs;
  // Root / meta
  if (segs.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (a === 'meta' && segs.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0' });
  }
  if (a === 'user' && b === 'repos') {
    if (method === 'POST') {
      const name = typeof body?.name === 'string' ? body.name : '';
      if (!name) return err(422, 'name is required');
      const { repo, exists } = store.createRepo(name, {
        private: body?.private === true,
        description: typeof body?.description === 'string' ? body.description : '',
      });
      if (exists) return err(422, 'Repository already exists');
      return ok(201, repoView(repo!));
    }
    if (method === 'GET') {
      const all = [...store.repoList].sort((x, y) => x.seq - y.seq).map(repoView);
      const { items, link } = paginate(all, query, baseUrl, '/api/v3/user/repos');
      return ok(200, items, link ? { link } : undefined);
    }
    return err(404, 'Not Found');
  }
  if (a !== 'repos' || !b || !c) return err(404, 'Not Found');
  const owner = b;
  const repoName = c;
  if (owner !== VIEWER_LOGIN) return notFound('Not Found');
  const repo = store.getRepo(owner, repoName);
  const rest = segs.slice(3); // after /repos/{o}/{r}
  if (!repo) return notFound('Not Found');
  const repoPath = `/api/v3/repos/${owner}/${repoName}`;

  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoView(repo));
    if (method === 'PATCH') {
      if (typeof body?.description === 'string') repo.description = body.description;
      if (typeof body?.private === 'boolean') repo.private = body.private;
      return ok(200, repoView(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }
  if (rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
    const ref = typeof body?.ref === 'string' ? body.ref : '';
    const sha = typeof body?.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha)) return err(422, 'invalid ref or sha');
    repo.refs.set(ref, sha.toLowerCase());
    return ok(201, { ref, object: { sha: sha.toLowerCase() }, url: `${repoPath}/git/refs/${encodeURIComponent(ref)}` });
  }
  if (rest[0] === 'branches' && method === 'GET') {
    const out: Record<string, unknown>[] = [];
    for (const [name, sha] of [...repo.refs.entries()].sort()) {
      if (!name.startsWith('refs/heads/')) continue;
      out.push({ name: name.slice('refs/heads/'.length), commit: { sha }, protected: false });
    }
    return ok(200, out);
  }
  if (rest[0] === 'commits' && method === 'GET') {
    const tip = resolveRef(store, repo, query.get('sha'));
    if (tip === undefined) return ok(200, []);
    const list = store.commitList(repo, tip).map((cm) => ({
      sha: cm.sha,
      // git commit objects end the message with '\n'; the REST view reports it without.
      commit: { message: cm.message.replace(/\n$/, ''), author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } },
      parents: (store.parseCommit(repo, cm.sha)?.parents ?? []).map((p) => ({ sha: p })),
    }));
    return ok(200, list);
  }
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'PUT') {
      if (typeof body?.content !== 'string' || typeof body?.message !== 'string') return err(422, 'message and content are required');
      const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
      if (!repo.refs.has(`refs/heads/${branch}`) && store.branchTip(repo, branch) === undefined && repo.refs.size > 0) {
        // branch must exist once the repo has commits; unborn repo accepts the default branch
        if (branch !== repo.defaultBranch) return notFound('Not Found');
      }
      let content: Buffer;
      try { content = Buffer.from(body.content, 'base64'); } catch { return err(422, 'content is not valid base64'); }
      const result = commitFile(store, repo, branch, path, content, body.message, typeof body?.sha === 'string' ? body.sha : undefined);
      if (result.status === 409) return err(409, 'sha does not match the current file');
      return ok(result.status, { content: { sha: result.contentSha, encoding: 'base64', size: content.length, name: path.split('/').pop(), path }, commit: { sha: result.commitSha } });
    }
    if (method === 'GET') {
      const tip = resolveRef(store, repo, query.get('ref'));
      if (tip === undefined) return notFound('Not Found');
      const commit = store.parseCommit(repo, tip);
      if (!commit) return notFound('Not Found');
      const files = store.flattenTree(repo, commit.tree);
      const file = files.get(path);
      if (file) {
        const obj = repo.objects.get(file.oid);
        if (!obj) return notFound('Not Found');
        return ok(200, {
          type: 'file', encoding: 'base64', size: obj.data.length,
          name: path.split('/').pop(), path, sha: file.oid,
          content: obj.data.toString('base64'),
        });
      }
      // directory listing: immediate children under path ('' = root)
      const prefix = path === '' ? '' : `${path}/`;
      const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
      const treeEntries = (treeOid: string, base: string): void => {
        const entries = store.parseTree(repo, treeOid);
        if (!entries) return;
        for (const en of entries) {
          const p = base ? `${base}/${en.name}` : en.name;
          if (path !== '' && !p.startsWith(prefix) && p !== path) continue;
          if (path === '') {
            children.set(en.name, { type: en.mode === '40000' ? 'dir' : 'file', name: en.name, path: en.name, sha: en.oid });
          } else if (p.startsWith(prefix)) {
            const restPath = p.slice(prefix.length);
            if (!restPath.includes('/')) {
              children.set(en.name, { type: en.mode === '40000' ? 'dir' : 'file', name: en.name, path: p, sha: en.oid });
            }
          }
        }
      };
      // Walk the tree to the directory node, then list it.
      let dirTree: string | null = commit.tree;
      if (path !== '') {
        const parts = path.split('/');
        for (const part of parts) {
          const entries = dirTree ? store.parseTree(repo, dirTree) : null;
          const found = entries?.find((en) => en.name === part && en.mode === '40000');
          if (!found) { dirTree = null; break; }
          dirTree = found.oid;
        }
      }
      if (dirTree === null) return notFound('Not Found');
      treeEntries(dirTree, path);
      if (children.size === 0) return notFound('Not Found');
      return ok(200, [...children.values()].sort((x, y) => (x.name < y.name ? -1 : 1)));
    }
    if (method === 'DELETE') {
      const tip = store.branchTip(repo, repo.defaultBranch);
      if (!tip) return notFound('Not Found');
      const commit = store.parseCommit(repo, tip);
      if (!commit) return notFound('Not Found');
      const files = store.flattenTree(repo, commit.tree);
      if (!files.has(path)) return notFound('Not Found');
      files.delete(path);
      const tree = store.treeFromFiles(repo, files);
      const commitSha = store.buildCommit(repo, tree, [tip], typeof body?.message === 'string' ? body.message : 'Delete file');
      repo.refs.set(`refs/heads/${repo.defaultBranch}`, commitSha);
      return ok(200, { commit: { sha: commitSha } });
    }
    return err(404, 'Not Found');
  }
  if (rest[0] === 'labels' && method === 'POST') {
    const name = typeof body?.name === 'string' ? body.name : '';
    if (!name) return err(422, 'name is required');
    const color = typeof body?.color === 'string' ? body.color : 'ededed';
    if (!repo.labels.has(name)) repo.labels.set(name, { name, color });
    return ok(201, labelView(repo.labels.get(name)!));
  }
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = typeof body?.title === 'string' ? body.title : '';
        const issueBody = typeof body?.body === 'string' ? body.body : '';
        const labels = Array.isArray(body?.labels) ? (body.labels as unknown[]).map(String) : [];
        for (const l of labels) {
          if (!repo.labels.has(l)) return err(422, `label ${l} does not exist`);
        }
        const issue: Issue = {
          id: store.nextNodeId++,
          number: repo.nextIssue++,
          title,
          body: issueBody,
          state: 'open',
          labels: labels.map((l) => repo.labels.get(l)!),
          comments: [],
          seq: repo.nextIssue,
        };
        repo.issues.set(issue.number, issue);
        return ok(201, issueView(issue, repo));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let list = [...repo.issues.values()];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        if (sort === 'created') list.sort((x, y) => (direction === 'asc' ? x.seq - y.seq : y.seq - x.seq));
        else list.sort((x, y) => x.number - y.number);
        const views = list.map((i) => issueView(i, repo));
        const { items, link } = paginate(views, query, baseUrl, `${repoPath}/issues`);
        return ok(200, items, link ? { link } : undefined);
      }
      return err(404, 'Not Found');
    }
    const num = parseInt(rest[1], 10);
    const issue = repo.issues.get(num);
    if (rest.length === 2) {
      if (!issue) return notFound('Not Found');
      if (method === 'GET') return ok(200, issueView(issue, repo));
      if (method === 'PATCH') {
        if (body?.state === 'open' || body?.state === 'closed') issue.state = body.state;
        if (typeof body?.title === 'string') issue.title = body.title;
        if (typeof body?.body === 'string') issue.body = body.body;
        return ok(200, issueView(issue, repo));
      }
      return err(404, 'Not Found');
    }
    if (rest[2] === 'comments') {
      if (!issue) return notFound('Not Found');
      if (method === 'POST') {
        const commentBody = typeof body?.body === 'string' ? body.body : '';
        const comment = { id: repo.nextComment++, body: commentBody };
        issue.comments.push(comment);
        return ok(201, { id: comment.id, body: comment.body });
      }
      if (method === 'GET') {
        return ok(200, issue.comments.map((cm) => ({ id: cm.id, body: cm.body })));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const head = typeof body?.head === 'string' ? body.head : '';
        const base = typeof body?.base === 'string' ? body.base : repo.defaultBranch;
        const headSha = store.branchTip(repo, head);
        const baseSha = store.branchTip(repo, base);
        if (!headSha || !baseSha) return err(422, 'head or base branch does not exist');
        const pull: Pull = {
          id: store.nextNodeId++,
          number: repo.nextPull++,
          title: typeof body?.title === 'string' ? body.title : '',
          body: typeof body?.body === 'string' ? body.body : '',
          state: 'open',
          head,
          base,
          headSha,
          baseSha,
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          seq: repo.nextPull,
        };
        repo.pulls.set(pull.number, pull);
        return ok(201, pullView(pull, repo));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((x, y) => x.number - y.number);
        const views = list.map((p) => pullView(p, repo));
        const { items, link } = paginate(views, query, baseUrl, `${repoPath}/pulls`);
        return ok(200, items, link ? { link } : undefined);
      }
      return err(404, 'Not Found');
    }
    const num = parseInt(rest[1], 10);
    const pull = repo.pulls.get(num);
    if (rest.length === 2) {
      if (!pull) return notFound('Not Found');
      if (method === 'GET') return ok(200, pullView(pull, repo));
      return err(404, 'Not Found');
    }
    if (rest[2] === 'files' && method === 'GET') {
      if (!pull) return notFound('Not Found');
      const files = pullRequestFiles(store, repo, pull);
      if (!files) return notFound('Not Found');
      return ok(200, files);
    }
    if (rest[2] === 'merge' && method === 'PUT') {
      if (!pull) return notFound('Not Found');
      const result = mergePullRequest(store, repo, pull);
      if (result.status !== 200) return err(result.status, result.message ?? 'merge failed');
      return ok(200, { merged: true, sha: result.sha, message: result.message });
    }
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}
