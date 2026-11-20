// Minimal GraphQL executor for the exact documents gh / github-mcp-server send.
// Hand-written parser (no dependencies) + resolvers over the in-memory Store.
import type { Issue, Pull, Repo, Store } from './store.ts';
import { FIXED_ISO, VIEWER, VIEWER_LOGIN } from './store.ts';
import { mergePullRequest, pullRequestFiles } from './rest.ts';

// ------------------------------------------------------------------ parser
type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface Field {
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selections: Selection[] | null;
  fragmentType: string | null; // for `... on Type { }`
}
type Selection = Field;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly src: string;
  constructor(src: string) { this.src = src; }

  private skipWs(): void {
    for (;;) {
      while (this.pos < this.src.length && /[\s,]/.test(this.src[this.pos])) this.pos += 1;
      if (this.src[this.pos] === '#') { while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1; continue; }
      break;
    }
  }
  private peek(): string { this.skipWs(); return this.src[this.pos] ?? ''; }
  private expect(ch: string): void {
    this.skipWs();
    if (this.src[this.pos] !== ch) throw new Error(`expected ${ch} at ${this.pos}`);
    this.pos += 1;
  }
  private readName(): string {
    this.skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!m) throw new Error(`expected name at ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }
  private readString(): string {
    this.skipWs();
    if (this.src[this.pos] !== '"') throw new Error(`expected string at ${this.pos}`);
    this.pos += 1;
    let out = '';
    for (;;) {
      const ch = this.src[this.pos];
      if (ch === undefined) throw new Error('unterminated string');
      if (ch === '"') { this.pos += 1; break; }
      if (ch === '\\') {
        const esc = this.src[this.pos + 1];
        this.pos += 2;
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === '"') out += '"';
        else if (esc === '\\') out += '\\';
        else if (esc === '/') out += '/';
        else if (esc === 'u') { out += String.fromCharCode(parseInt(this.src.slice(this.pos, this.pos + 4), 16)); this.pos += 4; }
        else out += esc;
        continue;
      }
      out += ch;
      this.pos += 1;
    }
    return out;
  }
  private readValue(): Value {
    this.skipWs();
    const ch = this.src[this.pos];
    if (ch === '"') return { kind: 'string', value: this.readString() };
    if (ch === '$') { this.pos += 1; return { kind: 'variable', name: this.readName() }; }
    if (ch === '[') {
      this.pos += 1;
      const values: Value[] = [];
      while (this.peek() !== ']') values.push(this.readValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (ch === '{') {
      this.pos += 1;
      const fields: Record<string, Value> = {};
      while (this.peek() !== '}') {
        const name = this.readName();
        this.expect(':');
        fields[name] = this.readValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const m = /^-?[0-9]+/.exec(this.src.slice(this.pos));
      if (!m) throw new Error(`bad number at ${this.pos}`);
      this.pos += m[0].length;
      return { kind: 'int', value: parseInt(m[0], 10) };
    }
    const name = this.readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }
  private readArgs(): Record<string, Value> {
    const args: Record<string, Value> = {};
    if (this.peek() !== '(') return args;
    this.pos += 1;
    while (this.peek() !== ')') {
      const name = this.readName();
      this.expect(':');
      args[name] = this.readValue();
    }
    this.expect(')');
    return args;
  }
  private readSelectionSet(): Selection[] {
    this.expect('{');
    const sels: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.src.slice(this.pos, this.pos + 3) === '...') {
        this.pos += 3;
        this.skipWs();
        let fragmentType: string | null = null;
        if (this.src.slice(this.pos, this.pos + 2) === 'on') {
          this.pos += 2;
          fragmentType = this.readName();
        } else {
          // named fragment spread — not used by the suite; skip its name
          this.readName();
        }
        const inner = this.readSelectionSet();
        for (const s of inner) sels.push({ ...s, fragmentType });
        continue;
      }
      const first = this.readName();
      let alias: string | null = null;
      let name = first;
      if (this.peek() === ':') { this.pos += 1; alias = first; name = this.readName(); }
      const args = this.readArgs();
      const selections = this.peek() === '{' ? this.readSelectionSet() : null;
      sels.push({ alias, name, args, selections, fragmentType: null });
    }
    this.expect('}');
    return sels;
  }
  parse(): Operation {
    this.skipWs();
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const ch = this.src[this.pos];
    if (ch === '{') {
      return { type: 'query', name: null, selections: this.readSelectionSet() };
    }
    const kw = this.readName();
    if (kw === 'query' || kw === 'mutation') type = kw;
    else throw new Error(`unsupported operation ${kw}`);
    this.skipWs();
    if (/[A-Za-z_]/.test(this.src[this.pos] ?? '')) name = this.readName();
    // variable definitions: ($x: Type!, ...) — skip balanced parens
    if (this.peek() === '(') {
      let depth = 0;
      while (this.pos < this.src.length) {
        const c = this.src[this.pos++];
        if (c === '(') depth += 1;
        else if (c === ')') { depth -= 1; if (depth === 0) break; }
      }
    }
    return { type, name, selections: this.readSelectionSet() };
  }
}

function evalValue(v: Value, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'variable': return variables[v.name] ?? null;
    case 'string': return v.value;
    case 'int': return v.value;
    case 'boolean': return v.value;
    case 'null': return null;
    case 'enum': return v.value;
    case 'list': return v.values.map((x) => evalValue(x, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v.fields)) out[k] = evalValue(x, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------ schema (introspection)
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'mergedAt', 'files', 'headRef', 'baseRef', 'author', 'createdAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt'],
};
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

// ------------------------------------------------------------------ node wrappers
type NodeValue =
  | { __typename: 'Query' }
  | { __typename: 'User'; login: string; id: number }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __typename: 'PullRequestConnection'; repo: Repo; pulls: Pull[] }
  | { __typename: 'PullRequestFileConnection'; files: { filename: string; status: string; additions: number; deletions: number; changes: number }[] }
  | { __typename: 'PullRequestFile'; file: { filename: string; status: string; additions: number; deletions: number; changes: number } }
  | { __typename: 'IssueEdge'; node: Issue; repo: Repo }
  | { __typename: 'CommentEdge'; node: { id: string; body: string } }
  | { __typename: 'Comment'; id: string; body: string }
  | { __typename: 'CreateIssuePayload'; issue: Issue; repo: Repo }
  | { __typename: 'CloseIssuePayload'; issue: Issue; repo: Repo }
  | { __typename: 'CreatePullRequestPayload'; pull: Pull; repo: Repo }
  | { __typename: 'MergePullRequestPayload'; pull: Pull; repo: Repo }
  | { __typename: 'AddCommentPayload'; comment: { id: string; body: string } }
  | { __typename: '__Type'; name: string };

function repoId(repo: Repo): string { return `R_${repo.id}`; }
function issueId(issue: Issue): string { return `I_${issue.id}`; }
function pullId(pull: Pull): string { return `PR_${pull.id}`; }

function findRepoByGlobalId(store: Store, globalId: string): Repo | undefined {
  const m = /^R_(\d+)$/.exec(globalId);
  if (!m) return undefined;
  const id = Number(m[1]);
  return store.repoList.find((r) => r.id === id);
}
function findIssueByGlobalId(store: Store, globalId: string): { repo: Repo; issue: Issue } | undefined {
  const m = /^I_(\d+)$/.exec(globalId);
  if (!m) return undefined;
  const id = Number(m[1]);
  for (const repo of store.repoList) {
    const issue = [...repo.issues.values()].find((i) => i.id === id);
    if (issue) return { repo, issue };
  }
  return undefined;
}
function findPullByGlobalId(store: Store, globalId: string): { repo: Repo; pull: Pull } | undefined {
  const m = /^PR_(\d+)$/.exec(globalId);
  if (!m) return undefined;
  const id = Number(m[1]);
  for (const repo of store.repoList) {
    const pull = [...repo.pulls.values()].find((p) => p.id === id);
    if (pull) return { repo, pull };
  }
  return undefined;
}

// ------------------------------------------------------------------ executor
interface Ctx { store: Store; errors: { message: string }[]; variables: Record<string, unknown> }

function argValue(field: Field, name: string, ctx: Ctx): unknown {
  const v = field.args[name];
  return v === undefined ? undefined : evalValue(v, ctx.variables);
}

function resolveIssuesConnection(store: Store, repo: Repo, field: Field, ctx: Ctx): NodeValue {
  const first = argValue(field, 'first', ctx) as number | undefined;
  const after = argValue(field, 'after', ctx) as string | null | undefined;
  const states = argValue(field, 'states', ctx) as string[] | undefined;
  const orderBy = argValue(field, 'orderBy', ctx) as { field?: string; direction?: string } | undefined;
  let list = [...repo.issues.values()];
  if (states) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  if (orderBy?.field === 'CREATED_AT') {
    list.sort((a, b) => (orderBy.direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  } else {
    list.sort((a, b) => a.seq - b.seq);
  }
  if (after !== undefined && after !== null) {
    const m = /^cursor:(\d+)$/.exec(String(after));
    if (m) {
      const idx = list.findIndex((i) => i.number === Number(m[1]));
      if (idx >= 0) list = list.slice(idx + 1);
    }
  }
  const total = list.length;
  const page = first === undefined ? list : list.slice(0, first);
  const hasNextPage = page.length < total;
  const endCursor = page.length > 0 ? `cursor:${page[page.length - 1].number}` : null;
  return { __typename: 'IssueConnection', repo, issues: page, pageInfo: { hasNextPage, endCursor } };
}

function resolveField(node: NodeValue, field: Field, ctx: Ctx): unknown {
  const store = ctx.store;
  const name = field.name;
  switch (node.__typename) {
    case 'Query': {
      if (name === 'viewer') return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER.id } as NodeValue;
      if (name === 'repository') {
        const owner = argValue(field, 'owner', ctx) as string | undefined;
        const repoName = argValue(field, 'name', ctx) as string | undefined;
        if (owner !== VIEWER_LOGIN) return null;
        const repo = store.getRepo(owner ?? '', repoName ?? '');
        return repo ? ({ __typename: 'Repository', repo } as NodeValue) : null;
      }
      if (name === 'node') {
        const id = argValue(field, 'id', ctx) as string | undefined;
        if (!id) return null;
        const repo = findRepoByGlobalId(store, id);
        if (repo) return { __typename: 'Repository', repo } as NodeValue;
        const issue = findIssueByGlobalId(store, id);
        if (issue) return { __typename: 'Issue', repo: issue.repo, issue: issue.issue } as NodeValue;
        const pull = findPullByGlobalId(store, id);
        if (pull) return { __typename: 'PullRequest', repo: pull.repo, pull: pull.pull } as NodeValue;
        return null;
      }
      if (name === '__type') {
        const typeName = argValue(field, 'name', ctx) as string | undefined;
        if (!typeName || !(typeName in TYPE_FIELDS) && typeName !== 'SearchType') return null;
        return { __typename: '__Type', name: typeName } as NodeValue;
      }
      if (name === '__schema') return { __typename: '__Type', name: 'Query' } as NodeValue;
      if (name === 'createIssue' || name === 'closeIssue' || name === 'createPullRequest' || name === 'mergePullRequest' || name === 'addComment') {
        return resolveMutation(node, field, ctx);
      }
      ctx.errors.push({ message: `Cannot query field "${name}" on type "Query".` });
      return null;
    }
    case 'User': {
      if (name === 'login') return node.login;
      if (name === 'id') return `U_${node.id}`;
      ctx.errors.push({ message: `Cannot query field "${name}" on type "User".` });
      return null;
    }
    case 'Repository': {
      const repo = node.repo;
      if (name === 'id') return repoId(repo);
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'owner') return { __typename: 'User', login: repo.owner, id: VIEWER.id } as NodeValue;
      if (name === 'defaultBranchRef') {
        const tip = store.branchTip(repo, repo.defaultBranch);
        return tip ? ({ __typename: 'Ref', name: repo.defaultBranch } as NodeValue) : null;
      }
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'description') return repo.description;
      if (name === 'url') return `https://example.invalid/${repo.owner}/${repo.name}`;
      if (name === 'createdAt') return FIXED_ISO;
      if (name === 'issue') {
        const number = argValue(field, 'number', ctx) as number | undefined;
        const issue = number === undefined ? undefined : repo.issues.get(number);
        return issue ? ({ __typename: 'Issue', repo, issue } as NodeValue) : null;
      }
      if (name === 'issues') return resolveIssuesConnection(store, repo, field, ctx);
      if (name === 'pullRequest') {
        const number = argValue(field, 'number', ctx) as number | undefined;
        const pull = number === undefined ? undefined : repo.pulls.get(number);
        return pull ? ({ __typename: 'PullRequest', repo, pull } as NodeValue) : null;
      }
      if (name === 'pullRequests') {
        const first = argValue(field, 'first', ctx) as number | undefined;
        let pulls = [...repo.pulls.values()].filter((p) => p.state === 'open').sort((a, b) => a.number - b.number);
        if (first !== undefined) pulls = pulls.slice(0, first);
        return { __typename: 'PullRequestConnection', repo, pulls } as NodeValue;
      }
      ctx.errors.push({ message: `Cannot query field "${name}" on type "Repository".` });
      return null;
    }
    case 'Issue': {
      const issue = node.issue;
      if (name === 'id') return issueId(issue);
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'body') return issue.body;
      if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'url') return `https://example.invalid/${node.repo.owner}/${node.repo.name}/issues/${issue.number}`;
      if (name === 'createdAt') return FIXED_ISO;
      if (name === 'author') return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER.id } as NodeValue;
      if (name === 'labels') return issue.labels.map((l) => ({ name: l.name }));
      if (name === 'comments') return issue.comments.map((c) => ({ id: `IC_${c.id}`, body: c.body }));
      ctx.errors.push({ message: `Cannot query field "${name}" on type "Issue".` });
      return null;
    }
    case 'PullRequest': {
      const pull = node.pull;
      if (name === 'id') return pullId(pull);
      if (name === 'number') return pull.number;
      if (name === 'title') return pull.title;
      if (name === 'body') return pull.body;
      if (name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'headRefName') return pull.head;
      if (name === 'baseRefName') return pull.base;
      if (name === 'mergeable') return 'MERGEABLE';
      if (name === 'merged') return pull.merged;
      if (name === 'mergedAt') return pull.mergedAt;
      if (name === 'createdAt') return FIXED_ISO;
      if (name === 'author') return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER.id } as NodeValue;
      if (name === 'headRef') return { __typename: 'Ref', name: pull.head } as NodeValue;
      if (name === 'baseRef') return { __typename: 'Ref', name: pull.base } as NodeValue;
      if (name === 'files') {
        const first = argValue(field, 'first', ctx) as number | undefined;
        const files = pullRequestFiles(store, node.repo, pull) ?? [];
        const page = first === undefined ? files : files.slice(0, first);
        return { __typename: 'PullRequestFileConnection', files: page } as NodeValue;
      }
      ctx.errors.push({ message: `Cannot query field "${name}" on type "PullRequest".` });
      return null;
    }
    case 'Ref': {
      if (name === 'name') return node.name;
      ctx.errors.push({ message: `Cannot query field "${name}" on type "Ref".` });
      return null;
    }
    case 'IssueConnection': {
      if (name === 'nodes') return node.issues.map((i) => ({ __typename: 'Issue', repo: node.repo, issue: i } as NodeValue));
      if (name === 'pageInfo') return node.pageInfo;
      if (name === 'totalCount') return node.issues.length;
      ctx.errors.push({ message: `Cannot query field "${name}" on type "IssueConnection".` });
      return null;
    }
    case 'PullRequestConnection': {
      if (name === 'nodes') return node.pulls.map((p) => ({ __typename: 'PullRequest', repo: node.repo, pull: p } as NodeValue));
      ctx.errors.push({ message: `Cannot query field "${name}" on type "PullRequestConnection".` });
      return null;
    }
    case 'PullRequestFileConnection': {
      if (name === 'nodes') return node.files.map((f) => ({ __typename: 'PullRequestFile', file: f } as NodeValue));
      ctx.errors.push({ message: `Cannot query field "${name}" on type "PullRequestFileConnection".` });
      return null;
    }
    case 'PullRequestFile': {
      if (name === 'path') return node.file.filename;
      if (name === 'additions') return node.file.additions;
      if (name === 'deletions') return node.file.deletions;
      if (name === 'changes') return node.file.changes;
      ctx.errors.push({ message: `Cannot query field "${name}" on type "PullRequestChangedFile".` });
      return null;
    }
    case 'CreateIssuePayload': {
      if (name === 'issue') return { __typename: 'Issue', repo: node.repo, issue: node.issue } as NodeValue;
      ctx.errors.push({ message: `Cannot query field "${name}" on type "CreateIssuePayload".` });
      return null;
    }
    case 'CloseIssuePayload': {
      if (name === 'issue') return { __typename: 'Issue', repo: node.repo, issue: node.issue } as NodeValue;
      ctx.errors.push({ message: `Cannot query field "${name}" on type "CloseIssuePayload".` });
      return null;
    }
    case 'CreatePullRequestPayload': {
      if (name === 'pullRequest') return { __typename: 'PullRequest', repo: node.repo, pull: node.pull } as NodeValue;
      ctx.errors.push({ message: `Cannot query field "${name}" on type "CreatePullRequestPayload".` });
      return null;
    }
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return { __typename: 'PullRequest', repo: node.repo, pull: node.pull } as NodeValue;
      ctx.errors.push({ message: `Cannot query field "${name}" on type "MergePullRequestPayload".` });
      return null;
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') return { __typename: 'CommentEdge', node: node.comment } as NodeValue;
      ctx.errors.push({ message: `Cannot query field "${name}" on type "AddCommentPayload".` });
      return null;
    }
    case 'CommentEdge': {
      if (name === 'node') return { __typename: 'Comment', id: node.node.id, body: node.node.body } as NodeValue;
      ctx.errors.push({ message: `Cannot query field "${name}" on type "IssueCommentEdge".` });
      return null;
    }
    case 'Comment': {
      if (name === 'id') return node.id;
      if (name === 'body') return node.body;
      ctx.errors.push({ message: `Cannot query field "${name}" on type "IssueComment".` });
      return null;
    }
    case '__Type': {
      if (name === 'name') return node.name;
      if (name === 'kind') return 'OBJECT';
      if (name === 'fields') {
        const names = TYPE_FIELDS[node.name] ?? [];
        return names.map((n) => ({ name: n }));
      }
      if (name === 'enumValues') {
        if (node.name === 'SearchType') return SEARCH_TYPE_VALUES.map((n) => ({ name: n }));
        return [];
      }
      ctx.errors.push({ message: `Cannot query field "${name}" on type "__Type".` });
      return null;
    }
  }
  return null;
}

function resolveMutation(_node: NodeValue, field: Field, ctx: Ctx): unknown {
  const store = ctx.store;
  const input = argValue(field, 'input', ctx) as Record<string, unknown> | undefined;
  if (field.name === 'createIssue') {
    const repo = input ? findRepoByGlobalId(store, String(input.repositoryId ?? '')) : undefined;
    if (!repo) { ctx.errors.push({ message: 'createIssue: repository not found' }); return null; }
    const issue: Issue = {
      id: store.nextNodeId++,
      number: repo.nextIssue++,
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      comments: [],
      seq: repo.nextIssue,
    };
    repo.issues.set(issue.number, issue);
    return { __typename: 'CreateIssuePayload', issue, repo } as NodeValue;
  }
  if (field.name === 'closeIssue') {
    const found = input ? findIssueByGlobalId(store, String(input.issueId ?? '')) : undefined;
    if (!found) { ctx.errors.push({ message: 'closeIssue: issue not found' }); return null; }
    found.issue.state = 'closed';
    return { __typename: 'CloseIssuePayload', issue: found.issue, repo: found.repo } as NodeValue;
  }
  if (field.name === 'createPullRequest') {
    const repo = input ? findRepoByGlobalId(store, String(input.repositoryId ?? '')) : undefined;
    if (!repo) { ctx.errors.push({ message: 'createPullRequest: repository not found' }); return null; }
    const head = typeof input.headRefName === 'string' ? input.headRefName : '';
    const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
    const headSha = store.branchTip(repo, head);
    const baseSha = store.branchTip(repo, base);
    if (!headSha || !baseSha) { ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist' }); return null; }
    const pull: Pull = {
      id: store.nextNodeId++,
      number: repo.nextPull++,
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
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
    return { __typename: 'CreatePullRequestPayload', pull, repo } as NodeValue;
  }
  if (field.name === 'mergePullRequest') {
    const found = input ? findPullByGlobalId(store, String(input.pullRequestId ?? '')) : undefined;
    if (!found) { ctx.errors.push({ message: 'mergePullRequest: pull request not found' }); return null; }
    const result = mergePullRequest(store, found.repo, found.pull);
    if (result.status !== 200) { ctx.errors.push({ message: `mergePullRequest: ${result.message ?? 'merge failed'}` }); return null; }
    return { __typename: 'MergePullRequestPayload', pull: found.pull, repo: found.repo } as NodeValue;
  }
  if (field.name === 'addComment') {
    const found = input ? findIssueByGlobalId(store, String(input.subjectId ?? '')) : undefined;
    if (!found) { ctx.errors.push({ message: 'addComment: issue not found' }); return null; }
    const body = typeof input.body === 'string' ? input.body : '';
    const comment = { id: found.repo.nextComment++, body };
    found.issue.comments.push(comment);
    return { __typename: 'AddCommentPayload', comment: { id: `IC_${comment.id}`, body } } as NodeValue;
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
  return null;
}

function isNodeValue(v: unknown): v is NodeValue {
  return typeof v === 'object' && v !== null && '__typename' in (v as Record<string, unknown>);
}

function executeSelections(node: NodeValue, selections: Selection[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.fragmentType !== null && sel.fragmentType !== node.__typename) continue;
    const key = sel.alias ?? sel.name;
    const value = resolveField(node, sel, ctx);
    if (sel.selections === null) {
      out[key] = value;
    } else if (value === null || value === undefined) {
      out[key] = null;
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) => (isNodeValue(item) ? executeSelections(item, sel.selections!, ctx) : item));
    } else if (isNodeValue(value)) {
      out[key] = executeSelections(value, sel.selections, ctx);
    } else if (typeof value === 'object') {
      // plain object (pageInfo, __Field lists): apply sub-selections by property name
      const obj = value as Record<string, unknown>;
      const sub: Record<string, unknown> = {};
      for (const s of sel.selections) {
        if (s.fragmentType !== null) continue;
        const k = s.alias ?? s.name;
        const v = obj[s.name];
        if (s.selections === null) sub[k] = v ?? null;
        else if (Array.isArray(v)) sub[k] = v.map((item) => (isNodeValue(item) ? executeSelections(item, s.selections!, ctx) : item));
        else if (isNodeValue(v)) sub[k] = executeSelections(v, s.selections!, ctx);
        else sub[k] = v ?? null;
      }
      out[key] = sub;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>): { data?: Record<string, unknown>; errors?: { message: string }[] } {
  const ctx: Ctx = { store, errors: [], variables: variables ?? {} };
  let op: Operation;
  try {
    op = new Parser(query).parse();
  } catch (e) {
    return { errors: [{ message: `GraphQL parse error: ${e instanceof Error ? e.message : String(e)}` }] };
  }
  const root: NodeValue = { __typename: 'Query' };
  const data = executeSelections(root, op.selections, ctx);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/** Handle one POST /api/graphql body (single operation or a batched array). */
export function handleGraphQL(store: Store, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((op) => {
      if (typeof op !== 'object' || op === null) return { errors: [{ message: 'invalid operation' }] };
      const o = op as Record<string, unknown>;
      return executeGraphQL(store, typeof o.query === 'string' ? o.query : '', (o.variables as Record<string, unknown>) ?? {});
    });
  }
  if (typeof body !== 'object' || body === null) return { errors: [{ message: 'invalid request' }] };
  const o = body as Record<string, unknown>;
  return executeGraphQL(store, typeof o.query === 'string' ? o.query : '', (o.variables as Record<string, unknown>) ?? {});
}
