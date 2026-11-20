// Git smart-HTTP: pkt-line framing, packfile read/write, object model helpers,
// and the upload-pack (v2 + v0) / receive-pack (v0) handlers.
// Stdlib only (node:zlib, node:crypto). No deltas are ever sent; packs are
// full objects, which the client's readPack resolves fine.
import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { GitObject, ObjType, Repo, Store } from './store.ts';
import { hashObject } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const AGENT = 'forge/1.0';

// ---------------------------------------------------------------- pkt-line
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}
export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');
export function pktLines(items: (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(pktFlush());
    else if (it === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(it));
  }
  return Buffer.concat(parts);
}
export type Packet = { kind: 'data' | 'flush' | 'delim' | 'response-end'; payload?: Buffer };
/** Decode pkt-lines from the start of buf; returns packets and the offset just past the last complete packet (trailing raw bytes, e.g. a pack, start there). */
export function decodePackets(buf: Buffer): { packets: Packet[]; offset: number } {
  const packets: Packet[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) { packets.push({ kind: 'flush' }); off += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim' }); off += 4; continue; }
    if (len === 2) { packets.push({ kind: 'response-end' }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, offset: off };
}
export function packetLines(packets: Packet[]): string[] {
  return packets.filter((p) => p.kind === 'data').map((p) => p.payload!.toString('utf8'));
}

// ---------------------------------------------------------------- packfile
function readVarintSize(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buf[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}
function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else throw new Error('delta opcode 0');
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}
export interface PackRead { objects: Map<string, GitObject>; deltaCount: number }
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) throw new Error(`pack entry ${i} unknown type ${typeCode}`);
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  const resolve = (entry: Raw, seen = new Set<number>()): GitObject => {
    if (seen.has(entry.offset)) throw new Error('delta cycle');
    seen.add(entry.offset);
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      deltaCount += 1;
      let base: GitObject | undefined;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (!baseEntry) throw new Error('ofs-delta base not in pack');
        base = resolve(baseEntry, seen);
      } else {
        base = resolveBase?.(entry.baseOid!);
        if (!base) {
          // base may be another entry in this pack with that oid
          for (const e of raw) {
            if (e.typeCode !== 6 && e.typeCode !== 7) {
              const oid = hashObject(CODE_TYPE[e.typeCode], e.data);
              if (oid === entry.baseOid) { base = { type: CODE_TYPE[e.typeCode], data: e.data }; break; }
            }
          }
        }
        if (!base) throw new Error(`ref-delta base ${entry.baseOid} not available`);
      }
      const data = applyDelta(base.data, entry.data);
      return { type: base.type, data };
    }
    return { type: CODE_TYPE[entry.typeCode], data: entry.data };
  };
  for (const entry of raw) {
    const obj = resolve(entry);
    const oid = hashObject(obj.type, obj.data);
    objects.set(oid, obj);
  }
  return { objects, deltaCount };
}
function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const parts: number[] = [];
  let first = (TYPE_CODE[type] << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) first |= 0x80;
  parts.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>>= 7;
    if (size > 0) b |= 0x80;
    parts.push(b);
  }
  return Buffer.from(parts);
}
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of list) {
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- fetch computation
export interface FetchPlan {
  objects: GitObject[]; // objects to send (full, no deltas)
  objectOids: string[]; // sorted oids of `objects`, in pack order (cache key)
  shallow: string[]; // new shallow boundary commits
  unshallow: string[]; // old boundaries no longer shallow
  acks: string[]; // common haves
}

// ---------------------------------------------------------------- response caches
// The clone workload issues the same requests 50x concurrently for one tip:
// identical info/refs, ls-refs and depth-1 packs. All cached values are pure
// functions of content-addressed data, so the cache keys are exact and no
// invalidation is needed: a different ref set / object set yields a different
// key, and the cached bytes are byte-identical to a fresh build (writePack is
// deterministic: sorted objects, fixed deflate level, sha1 trailer).
interface RepoCache { info: Map<string, Buffer>; ls: Map<string, Buffer>; pack: Map<string, Buffer>; fetch: Map<string, Buffer> }
const repoCaches = new WeakMap<Repo, RepoCache>();
function cacheFor(repo: Repo): RepoCache {
  let c = repoCaches.get(repo);
  if (!c) { c = { info: new Map(), ls: new Map(), pack: new Map(), fetch: new Map() }; repoCaches.set(repo, c); }
  return c;
}
function cachePut(map: Map<string, Buffer>, key: string, value: Buffer, cap = 32): void {
  if (map.size >= cap) {
    const first = map.keys().next();
    if (!first.done) map.delete(first.value);
  }
  map.set(key, value);
}
/** Exact signature of a repo's ref advertisement (oids + names + peels). */
function refSignature(repo: Repo): string {
  const lines = refLines(repo);
  return lines.map((l) => `${l.oid} ${l.name}${l.peeled ? `^${l.peeled}` : ''}`).join('|');
}
/** Pack bytes for `objects`, cached by their oids (exact: pack is a pure function of the object list). */
function cachedPack(repo: Repo, objects: GitObject[], oids: string[]): Buffer {
  const key = oids.join(',');
  const cache = cacheFor(repo).pack;
  const hit = cache.get(key);
  if (hit) return hit;
  const pack = writePack(objects);
  cachePut(cache, key, pack);
  return pack;
}
/** Compute what a fetch/upload-pack must send. */
export function planFetch(
  store: Store,
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  oldShallow: string[],
): FetchPlan {
  // Commit distances from wants (following parents).
  const dist = new Map<string, number>(); // commit oid -> min distance from a want
  const queue: { oid: string; d: number }[] = [];
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m) queue.push({ oid: m[1], d: 0 });
    } else if (obj.type === 'commit') queue.push({ oid: w, d: 0 });
    else queue.push({ oid: w, d: 0 });
  }
  const includedCommits = new Set<string>();
  const shallow = new Set<string>();
  while (queue.length) {
    const { oid, d } = queue.shift()!;
    if (dist.has(oid) && dist.get(oid)! <= d) continue;
    if (depth !== null && d >= depth) continue;
    dist.set(oid, d);
    const c = store.parseCommit(repo, oid);
    if (!c) continue;
    includedCommits.add(oid);
    if (depth !== null && d === depth - 1) {
      // parents excluded: this commit is a shallow boundary if it has parents
      if (c.parents.length > 0) shallow.add(oid);
    }
    for (const p of c.parents) queue.push({ oid: p, d: d + 1 });
  }
  // Objects the client already holds. A shallow-boundary have covers only itself +
  // its tree/blobs, not its parents; any other have covers its full closure.
  const haveObjects = new Set<string>();
  const shallowSet = new Set(oldShallow);
  for (const h of haves) {
    const obj = repo.objects.get(h);
    if (!obj) continue;
    if (shallowSet.has(h)) {
      haveObjects.add(h);
      if (obj.type === 'commit') {
        const c = store.parseCommit(repo, h);
        if (c) for (const o of store.reachable(repo, [c.tree])) haveObjects.add(o);
      } else if (obj.type === 'tag') {
        const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (m) {
          haveObjects.add(m[1]);
          const c = store.parseCommit(repo, m[1]);
          if (c) for (const o of store.reachable(repo, [c.tree])) haveObjects.add(o);
        }
      }
    } else {
      for (const o of store.reachable(repo, [h])) haveObjects.add(o);
    }
  }
  // Wanted objects: exactly the included commits (depth-limited) plus each one's
  // tree closure — never parents beyond the depth limit — plus tag objects wanted
  // directly (their targets are included commits already).
  const wanted = new Set<string>();
  for (const c of includedCommits) {
    wanted.add(c);
    const commit = store.parseCommit(repo, c);
    if (commit) for (const o of store.reachable(repo, [commit.tree])) wanted.add(o);
  }
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (!obj) continue;
    if (obj.type === 'tag') wanted.add(w);
    else if (obj.type !== 'commit') for (const o of store.reachable(repo, [w])) wanted.add(o);
  }
  const objects: GitObject[] = [];
  const objectOids: string[] = [];
  for (const oid of [...wanted].sort()) {
    if (haveObjects.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) { objects.push(obj); objectOids.push(oid); }
  }
  const acks: string[] = [];
  for (const h of haves) {
    // a have is common if it is an ancestor of a want (or a want itself)
    if (wants.includes(h)) { acks.push(h); continue; }
    for (const w of wants) {
      const reach = store.reachable(repo, [w]);
      if (reach.has(h)) { acks.push(h); break; }
    }
  }
  // Unshallow: an old boundary that is now interior — it is in the included set,
  // is no longer a boundary, and all of its parents are included too.
  const unshallow = oldShallow.filter((s) => {
    if (!includedCommits.has(s) || shallow.has(s)) return false;
    const c = store.parseCommit(repo, s);
    if (!c) return true;
    return c.parents.every((p) => includedCommits.has(p));
  });
  return { objects, objectOids, shallow: [...shallow], unshallow, acks };
}

// ---------------------------------------------------------------- advertisements
function refLines(repo: Repo): { oid: string; name: string; peeled?: string }[] {
  const lines: { oid: string; name: string; peeled?: string }[] = [];
  const head = repo.refs.get('HEAD') ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  if (head) lines.push({ oid: head, name: 'HEAD' });
  const names = [...repo.refs.keys()].filter((n) => n.startsWith('refs/')).sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    lines.push({ oid, name });
    const obj = repo.objects.get(oid);
    if (name.startsWith('refs/tags/') && obj?.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m) lines.push({ oid: m[1], name: `${name}^{}` });
    }
  }
  void headTarget;
  return lines;
}
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT} side-band-64k multi_ack thin-pack ofs-delta shallow`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const lines = refLines(repo);
  const items: (string | 'flush')[] = [];
  if (service === 'git-upload-pack') items.push(`# service=${service}\n`);
  else items.push(`# service=${service}\n`);
  items.push('flush');
  if (lines.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.forEach((l, i) => {
      if (i === 0) items.push(`${l.oid} ${l.name}\0${caps}\n`);
      else items.push(`${l.oid} ${l.name}\n`);
    });
  }
  items.push('flush');
  return pktLines(items);
}
function v2Advertisement(): Buffer {
  return pktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}
// The v2 advertisement is constant (capabilities only, no refs): build once.
const V2_ADVERTISEMENT = v2Advertisement();
function sidebandPack(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const SIZE = 32768;
  for (let i = 0; i < pack.length; i += SIZE) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + SIZE));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return chunks;
}

// ---------------------------------------------------------------- handlers
export interface GitRequest {
  repo: Repo;
  method: string;
  path: string; // e.g. /info/refs or /git-upload-pack
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
}
export interface GitResponse { status: number; contentType: string; body: Buffer }

export function handleInfoRefs(req: GitRequest): GitResponse {
  const service = req.query.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'unknown service' })) };
  }
  if (service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2') {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: V2_ADVERTISEMENT };
  }
  // v0 advertisement depends only on the ref set: cache by its exact signature.
  const cache = cacheFor(req.repo).info;
  const key = `${service}|${refSignature(req.repo)}`;
  const hit = cache.get(key);
  if (hit) return { status: 200, contentType: `application/x-${service}-advertisement`, body: hit };
  const body = v0Advertisement(req.repo, service);
  cachePut(cache, key, body, 8);
  return { status: 200, contentType: `application/x-${service}-advertisement`, body };
}

export function handleUploadPack(store: Store, req: GitRequest): GitResponse {
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const { packets } = decodePackets(req.body);
  const lines = packetLines(packets);
  if (isV2) return handleUploadPackV2(store, req.repo, lines);
  return handleUploadPackV0(store, req.repo, lines);
}

function handleUploadPackV2(store: Store, repo: Repo, lines: string[]): GitResponse {
  const command = (lines[0] ?? '').trim();
  if (command === 'command=ls-refs') {
    const args = lines.slice(1);
    const prefixes: string[] = [];
    let peel = false;
    let symrefs = false;
    for (const a of args) {
      const t = a.trim();
      if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
      else if (t === 'peel') peel = true;
      else if (t === 'symrefs') symrefs = true;
    }
    // ls-refs output is a pure function of the ref set + args: cache it.
    const sig = refSignature(repo);
    const lsKey = `${sig}|${prefixes.join(',')}|${peel ? 1 : 0}|${symrefs ? 1 : 0}`;
    const lsCache = cacheFor(repo).ls;
    const lsHit = lsCache.get(lsKey);
    if (lsHit) return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsHit };
    const refs = refLines(repo);
    const clean: string[] = [];
    if (refs.length > 0) {
      const byName = new Map<string, { oid: string; peeled?: string }>();
      for (const r of refs) {
        if (r.name.endsWith('^{}')) {
          const base = r.name.slice(0, -3);
          const e = byName.get(base);
          if (e) e.peeled = r.oid;
          continue;
        }
        byName.set(r.name, { oid: r.oid });
      }
      for (const [name, e] of byName) {
        if (prefixes.length && !prefixes.some((p) => name.startsWith(p))) continue;
        if (name === 'HEAD') { clean.push(`${e.oid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`); continue; }
        clean.push(`${e.oid} ${name}${peel && e.peeled ? ` peeled:${e.peeled}` : ''}\n`);
      }
    } else {
      clean.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
    const body = pktLines([...clean, 'flush']);
    cachePut(lsCache, lsKey, body, 8);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
  }
  if (command === 'command=fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    for (const a of lines.slice(1)) {
      const t = a.trim();
      if (t.startsWith('want ')) wants.push(t.slice(5).trim());
      else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
      else if (t.startsWith('shallow ')) shallow.push(t.slice(8).trim());
      else if (t.startsWith('deepen ')) depth = parseInt(t.slice(7).trim(), 10);
      else if (t.startsWith('deepen-since ')) { /* not supported: ignore */ }
      else if (t.startsWith('deepen-not ')) { /* ignore */ }
    }
    const plan = planFetch(store, repo, wants, haves, depth, shallow);
    // The whole fetch response is a pure function of the plan's outputs
    // (object oids, acks, shallow/unshallow): cache it wholesale.
    const fetchKey = `v2|${plan.objectOids.join(',')}|${plan.acks.join(',')}|${plan.shallow.join(',')}|${plan.unshallow.join(',')}`;
    const fetchCache = cacheFor(repo).fetch;
    const fetchHit = fetchCache.get(fetchKey);
    if (fetchHit) return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchHit };
    const parts: Buffer[] = [];
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length > 0) {
      for (const a of plan.acks) parts.push(pktLine(`ACK ${a}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktDelim());
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
      parts.push(pktDelim());
    }
    if (plan.objects.length > 0) {
      const pack = cachedPack(repo, plan.objects, plan.objectOids);
      parts.push(pktLine('packfile\n'));
      parts.push(...sidebandPack(pack));
    }
    parts.push(pktFlush());
    const body = Buffer.concat(parts);
    cachePut(fetchCache, fetchKey, body, 16);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
  }
  return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'unknown v2 command' })) };
}

function handleUploadPackV0(store: Store, repo: Repo, lines: string[]): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let seenFlush = false;
  void seenFlush;
  for (const a of lines) {
    const t = a.trim();
    if (t.startsWith('want ')) wants.push(t.slice(5).split(' ')[0]);
    else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) shallow.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) depth = parseInt(t.slice(7).trim(), 10);
  }
  const plan = planFetch(store, repo, wants, haves, depth, shallow);
  const fetchKey = `v0|${plan.objectOids.join(',')}|${plan.acks.join(',')}|${plan.shallow.join(',')}|${plan.unshallow.join(',')}`;
  const fetchCache = cacheFor(repo).fetch;
  const fetchHit = fetchCache.get(fetchKey);
  if (fetchHit) return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchHit };
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const a of plan.acks) parts.push(pktLine(`ACK ${a}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  if (plan.objects.length > 0) {
    const pack = cachedPack(repo, plan.objects, plan.objectOids);
    parts.push(...sidebandPack(pack));
  }
  parts.push(pktFlush());
  const body = Buffer.concat(parts);
  cachePut(fetchCache, fetchKey, body, 16);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

/** Is `ancestor` reachable from `tip` following parents? */
function isAncestor(store: Store, repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const c = store.parseCommit(repo, oid);
    if (!c) continue;
    for (const p of c.parents) {
      if (p === ancestor) return true;
      queue.push(p);
    }
  }
  return false;
}

export function handleReceivePack(store: Store, req: GitRequest): GitResponse {
  const repo = req.repo;
  const { packets, offset } = decodePackets(req.body);
  const lines = packetLines(packets);
  interface Cmd { oldOid: string; newOid: string; ref: string }
  const commands: Cmd[] = [];
  for (const line of lines) {
    const t = line.replace(/\n$/, '');
    if (!t) continue;
    const nul = t.indexOf('\0');
    const head = nul >= 0 ? t.slice(0, nul) : t;
    const parts = head.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  const packBytes = req.body.subarray(offset);
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  let packObjects: Map<string, GitObject> | null = null;
  let unpackError: string | null = null;
  if (hasUpdates) {
    if (packBytes.length === 0) unpackError = 'empty pack';
    else {
      try {
        const read = readPack(packBytes, (oid) => repo.objects.get(oid));
        packObjects = read.objects;
      } catch (err) {
        unpackError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  const report: { ref: string; ok: boolean; reason: string }[] = [];
  if (unpackError === null && packObjects) {
    for (const [oid, obj] of packObjects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }
  for (const cmd of commands) {
    if (unpackError !== null) { report.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' }); continue; }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (current === undefined) { report.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' }); continue; }
      if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) { report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
      repo.refs.delete(cmd.ref);
      report.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    // create / update: new object must be present (in pack or already in repo)
    if (!repo.objects.has(cmd.newOid)) { report.push({ ref: cmd.ref, ok: false, reason: 'object not found' }); continue; }
    if (current === undefined) {
      if (cmd.oldOid !== ZERO_OID) { report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
      repo.refs.set(cmd.ref, cmd.newOid);
      report.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (cmd.oldOid !== current) { report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
    if (!isAncestor(store, repo, current, cmd.newOid)) { report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
    repo.refs.set(cmd.ref, cmd.newOid);
    report.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  // Report: pkt-lines inside sideband band 1.
  const inner: (string | 'flush')[] = [];
  inner.push(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`);
  for (const r of report) inner.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  inner.push('flush');
  const innerBuf = pktLines(inner);
  const body = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), innerBuf])), pktFlush()]);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body };
}
