// In-memory store for the forge, plus the scenario-derived viewer identity.
// The suite's viewer login is deterministic from SCENARIO_SEED (wire.ts in the
// kit): the bearer token carries no identity, and GraphQL `viewer { login }`
// plus the foreign-owner 404 both need it. Ported exactly from wire.ts.
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- scenario RNG
const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}
class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}
const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];
export interface ScenarioUser { id: number; login: string; name: string; email: string }
function scenarioUsers(): ScenarioUser[] {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) { login = `${base}-${suffix}`; suffix += 1; }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}
const USERS = scenarioUsers();
export const VIEWER: ScenarioUser = USERS[0];
export const STRANGER: ScenarioUser = USERS[2];
export const VIEWER_LOGIN = VIEWER.login;

// ---------------------------------------------------------------- git objects
export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: ObjType; data: Buffer }
export function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}
export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

// Deterministic timestamps: the suite's fixed epochs, never the wall clock.
export const FIXED_TS = 1700000000;
export const FIXED_ISO = '2025-01-01T00:00:00Z';
export function ident(user: ScenarioUser = VIEWER): string {
  return `${user.name} <${user.email}> ${FIXED_TS} +0000`;
}

// ---------------------------------------------------------------- domain types
export interface Issue {
  id: number; // global node id counter
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: { name: string; color: string }[];
  comments: { id: number; body: string }[];
  seq: number; // creation order
}
export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string; // branch name
  base: string; // branch name
  headSha: string;
  baseSha: string; // base tip at creation
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}
export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>; // full ref name -> oid
  objects: Map<string, GitObject>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  seq: number; // creation order (for pagination)
}

export class Store {
  repos = new Map<string, Repo>(); // key `${owner}/${name}`
  repoList: Repo[] = []; // creation order
  nextRepoId = 1;
  nextNodeId = 1;
  private seqCounter = 0;

  key(owner: string, name: string): string { return `${owner}/${name}`; }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, opts: { private?: boolean; description?: string }): { repo: Repo | null; exists: boolean } {
    const existing = this.getRepo(VIEWER_LOGIN, name);
    if (existing) return { repo: null, exists: true };
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: VIEWER_LOGIN,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      seq: this.seqCounter++,
    };
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    this.repoList.push(repo);
    return { repo, exists: false };
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
    const i = this.repoList.indexOf(repo);
    if (i >= 0) this.repoList.splice(i, 1);
  }

  // ---- git helpers on a repo ----
  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }
  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }
  headRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** Parse a commit object. Returns null when malformed / not a commit. */
  parseCommit(repo: Repo, oid: string): { tree: string; parents: string[]; message: string; author: string; committer: string } | null {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    const text = obj.data.toString('utf8');
    const blank = text.indexOf('\n\n');
    const header = blank < 0 ? text : text.slice(0, blank);
    const message = blank < 0 ? '' : text.slice(blank + 2);
    const parents: string[] = [];
    let tree = '';
    let author = '';
    let committer = '';
    for (const line of header.split('\n')) {
      const sp = line.indexOf(' ');
      const k = sp < 0 ? line : line.slice(0, sp);
      const v = sp < 0 ? '' : line.slice(sp + 1);
      if (k === 'tree') tree = v;
      else if (k === 'parent') parents.push(v);
      else if (k === 'author') author = v;
      else if (k === 'committer') committer = v;
    }
    if (!tree) return null;
    return { tree, parents, message, author, committer };
  }

  parseTree(repo: Repo, oid: string): { mode: string; name: string; oid: string }[] | null {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return null;
    const buf = obj.data;
    const entries: { mode: string; name: string; oid: string }[] = [];
    let off = 0;
    while (off < buf.length) {
      const sp = buf.indexOf(0x20, off);
      const nul = buf.indexOf(0x00, sp + 1);
      if (sp < 0 || nul < 0 || nul + 21 > buf.length) return null;
      entries.push({ mode: buf.subarray(off, sp).toString('ascii'), name: buf.subarray(sp + 1, nul).toString('utf8'), oid: buf.subarray(nul + 1, nul + 21).toString('hex') });
      off = nul + 21;
    }
    return entries;
  }

  /** Build a tree object from entries (sorted git-style: dirs compare as name+'/'). */
  buildTree(repo: Repo, entries: { mode: string; name: string; oid: string }[]): string {
    const sorted = [...entries].sort((a, b) => {
      const la = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
      const lb = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
      return Buffer.compare(la, lb);
    });
    const parts: Buffer[] = [];
    for (const e of sorted) {
      parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
      parts.push(Buffer.from(e.oid, 'hex'));
    }
    return putObject(repo, 'tree', Buffer.concat(parts));
  }

  buildCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const lines = [`tree ${tree}`];
    for (const p of parents) lines.push(`parent ${p}`);
    lines.push(`author ${ident()}`, `committer ${ident()}`, '');
    const msg = message.endsWith('\n') ? message : `${message}\n`;
    return putObject(repo, 'commit', Buffer.from(`${lines.join('\n')}\n${msg}`, 'utf8'));
  }

  /** Flatten a tree to path -> {oid, mode} (recursive). */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const entries = this.parseTree(repo, treeOid);
    if (!entries) return out;
    for (const e of entries) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') this.flattenTree(repo, e.oid, path, out);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
    return out;
  }

  /** Build a tree from a flat path map (nested dirs created as needed). */
  treeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node> }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segs = path.split('/');
      let node = root;
      for (let i = 0; i < segs.length - 1; i += 1) {
        if (!node.dirs.has(segs[i])) node.dirs.set(segs[i], make());
        node = node.dirs.get(segs[i])!;
      }
      node.files.set(segs[segs.length - 1], entry);
    }
    const build = (node: Node): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.buildTree(repo, entries);
    };
    return build(root);
  }

  /** Commits reachable from `tip`, newest-first (BFS by parent order, deduped). */
  commitList(repo: Repo, tip: string | undefined): { sha: string; message: string }[] {
    if (!tip) return [];
    const out: { sha: string; message: string }[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const c = this.parseCommit(repo, oid);
      if (!c) continue;
      out.push({ sha: oid, message: c.message });
      for (const p of c.parents) queue.push(p);
    }
    return out;
  }

  /** All object oids reachable from roots (commit->tree+parents, tag->target, tree->entries). */
  reachable(repo: Repo, roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [...roots];
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const c = this.parseCommit(repo, oid);
        if (c) { queue.push(c.tree); for (const p of c.parents) queue.push(p); }
      } else if (obj.type === 'tag') {
        const text = obj.data.toString('utf8');
        const m = /^object ([0-9a-f]{40})$/m.exec(text);
        if (m) queue.push(m[1]);
      } else if (obj.type === 'tree') {
        for (const e of this.parseTree(repo, oid) ?? []) {
          if (e.mode !== '160000') queue.push(e.oid);
        }
      }
    }
    return seen;
  }
}
