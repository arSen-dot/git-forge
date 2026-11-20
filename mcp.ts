// MCP Streamable HTTP endpoint (POST /mcp), JSON-RPC 2.0.
// Modern revision 2026-07-28 via server/discover; legacy initialize also supported.
import type { Issue, Pull, Repo, Store } from './store.ts';
import { VIEWER, VIEWER_LOGIN } from './store.ts';
import { mergePullRequest } from './rest.ts';

const SERVER_NAME = 'doeng-forge';
const SERVER_VERSION = '1.0.0';
const REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Record<string, unknown>>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}
function issueView(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name })),
  };
}
function pullView(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    merged: pull.merged,
  };
}

function textResult(obj: unknown): { content: { type: 'text'; text: string }[]; structuredContent: unknown; isError: false } {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj, isError: false };
}
function errorResult(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): { content: { type: 'text'; text: string }[]; structuredContent?: unknown; isError: boolean } {
  const str = (k: string): string | undefined => (typeof args[k] === 'string' ? (args[k] as string) : undefined);
  const repoName = str('repo') ?? str('repository') ?? str('repo_name');
  const owner = str('owner') ?? VIEWER_LOGIN;
  switch (name) {
    case 'create_repo': {
      const repoNameArg = str('name') ?? repoName;
      if (!repoNameArg) return errorResult('create_repo: name is required');
      const { repo, exists } = store.createRepo(repoNameArg, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      if (exists) return errorResult(`create_repo: repository ${repoNameArg} already exists`);
      return textResult(repoView(repo!));
    }
    case 'get_repo': {
      if (!repoName) return errorResult('get_repo: repo is required');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errorResult(`get_repo: repository ${owner}/${repoName} not found`);
      return textResult(repoView(repo));
    }
    case 'create_issue': {
      if (!repoName || !str('title')) return errorResult('create_issue: owner, repo and title are required');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errorResult(`create_issue: repository ${owner}/${repoName} not found`);
      const issue: Issue = {
        id: store.nextNodeId++,
        number: repo.nextIssue++,
        title: str('title')!,
        body: str('body') ?? '',
        state: 'open',
        labels: [],
        comments: [],
        seq: repo.nextIssue,
      };
      repo.issues.set(issue.number, issue);
      return textResult(issueView(issue));
    }
    case 'list_issues': {
      if (!repoName) return errorResult('list_issues: owner and repo are required');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errorResult(`list_issues: repository ${owner}/${repoName} not found`);
      const state = str('state') ?? 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => a.number - b.number);
      return textResult(list.map(issueView));
    }
    case 'create_pull_request': {
      const head = str('head');
      const base = str('base');
      if (!repoName || !str('title') || !head || !base) return errorResult('create_pull_request: owner, repo, title, head and base are required');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errorResult(`create_pull_request: repository ${owner}/${repoName} not found`);
      const headSha = store.branchTip(repo, head);
      const baseSha = store.branchTip(repo, base);
      if (!headSha || !baseSha) return errorResult('create_pull_request: head or base branch does not exist');
      const pull: Pull = {
        id: store.nextNodeId++,
        number: repo.nextPull++,
        title: str('title')!,
        body: str('body') ?? '',
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
      return textResult(pullView(pull));
    }
    case 'merge_pull_request': {
      const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : null;
      if (!repoName || pullNumber === null) return errorResult('merge_pull_request: owner, repo and pull_number are required');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errorResult(`merge_pull_request: repository ${owner}/${repoName} not found`);
      const pull = repo.pulls.get(pullNumber);
      if (!pull) return errorResult(`merge_pull_request: pull request #${pullNumber} not found`);
      const result = mergePullRequest(store, repo, pull);
      if (result.status !== 200) return errorResult(`merge_pull_request: ${result.message ?? 'merge failed'}`);
      return textResult(pullView(pull));
    }
    default:
      return errorResult(`unknown tool: ${name}`);
  }
}

export interface McpResult { status: number; body: unknown }

/** Handle one POST /mcp with a parsed JSON body. Returns HTTP status + JSON body. */
export function handleMcp(store: Store, body: unknown): McpResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const req = body as Record<string, unknown>;
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (typeof req.params === 'object' && req.params !== null ? req.params : {}) as Record<string, unknown>;
  const ok = (result: unknown): McpResult => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const rpcError = (code: number, message: string, data?: unknown): McpResult => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } },
  });

  // Notifications have no id: acknowledge with 202 and no body.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    return ok({
      protocolVersion: REVISIONS[0],
      supportedVersions: REVISIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const chosen = REVISIONS.includes(requested) ? requested : REVISIONS[1];
    return ok({
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') {
    return ok({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    if (!TOOLS.some((t) => t.name === toolName)) {
      return rpcError(-32602, `unknown tool: ${toolName}`);
    }
    const result = callTool(store, toolName, args);
    return ok(result);
  }
  return rpcError(-32601, `method not found: ${method}`);
}
