/**
 * WASI Preview 1 shim for nullclaw.wasm in Obsidian WebView.
 * Provides 32 WASI imports + 3 custom host imports (env module).
 * host_fetch: retrieves pre-fetched LLM response (sync, from cache).
 * host_config_get: reads plugin settings (sync).
 * host_ui_write: streams text to Obsidian UI (sync).
 */

const FT_REG = 4, FT_DIR = 3;

interface VfsNode { children: Map<string, VfsNode>; content: Uint8Array | null; }

class Vfs {
  root = new Map<string, VfsNode>();
  private parts(p: string): string[] { return p.split("/").filter(x => x.length > 0); }
  resolve(p: string): VfsNode | null {
    const parts = this.parts(p);
    let children = this.root;
    let node: VfsNode | undefined;
    for (const part of parts) {
      node = children.get(part);
      if (!node) return null;
      children = node.children;
    }
    return node ?? null;
  }
  exists(p: string): boolean { return this.resolve(p) !== null; }
  read(p: string): Uint8Array | null { return this.resolve(p)?.content ?? null; }
  write(p: string, data: Uint8Array): boolean {
    const parts = this.parts(p);
    if (parts.length === 0) return false;
    const name = parts.pop()!;
    let children = this.root;
    for (const part of parts) {
      let n = children.get(part);
      if (!n) { n = { children: new Map(), content: null }; children.set(part, n); }
      children = n.children;
    }
    children.set(name, { children: new Map(), content: data });
    return true;
  }
  mkdir(p: string): boolean {
    const parts = this.parts(p);
    if (parts.length === 0) return false;
    const name = parts.pop()!;
    let children = this.root;
    for (const part of parts) {
      let n = children.get(part);
      if (!n) { n = { children: new Map(), content: null }; children.set(part, n); }
      children = n.children;
    }
    if (children.has(name)) return false;
    children.set(name, { children: new Map(), content: null });
    return true;
  }
  stat(p: string): { size: number; isDir: boolean } | null {
    const n = this.resolve(p);
    if (!n) return null;
    return { size: n.content?.length ?? 0, isDir: n.children.size > 0 && !n.content };
  }
  listDir(p: string): string[] {
    const n = this.resolve(p);
    if (!n) return [];
    return Array.from(n.children.keys());
  }
}

interface FD { path: string; content: Uint8Array; offset: number; writable: boolean; ftype: number; }

export interface NullclawConfig { apiKey: string; apiBase: string; model: string; }
export interface WasiResult { stdout: string; stderr: string; exitCode: number; }

// Per-run state
let _mem: WebAssembly.Memory;
let _args: string[] = [];
let _stdout: Uint8Array[] = [];
let _stderr: Uint8Array[] = [];
let _exitCode = 0;
let _exited = false;
let _vfs = new Vfs();
let _fds = new Map<number, FD>();
let _nextFd = 4;
let _config: NullclawConfig = { apiKey: '', apiBase: 'https://api.openai.com/v1', model: 'gpt-4o-mini' };
let _uiCallback: ((text: string) => void) | null = null;

// Pre-fetched LLM responses (keyed by url||body)
const _prefetched = new Map<string, string>();

export function prefetchLLM(key: string, response: string): void {
  _prefetched.set(key, response);
}

function dv(): DataView { return new DataView(_mem.buffer); }
function rstr(ptr: number, len: number): string {
  return new TextDecoder().decode(new Uint8Array(_mem.buffer, ptr, len));
}

export async function runNullclaw(
  wasmBytes: ArrayBuffer,
  args: string[],
  config?: Partial<NullclawConfig>,
  uiCallback?: (text: string) => void,
): Promise<WasiResult> {
  _args = ["nullclaw", ...args];
  _stdout = []; _stderr = []; _exitCode = 0; _exited = false;
  _vfs = new Vfs();
  _fds = new Map(); _nextFd = 4;
  _config = {
    apiKey: config?.apiKey ?? '',
    apiBase: config?.apiBase ?? 'https://api.openai.com/v1',
    model: config?.model ?? 'gpt-4o-mini',
  };
  _uiCallback = uiCallback ?? null;

  // Seed workspace files
  const enc = new TextEncoder();
  _vfs.write("IDENTITY.md", enc.encode("# IDENTITY.md\nName: NullClaw WASI\nRole: Local assistant running in WASM/WASI.\nStyle: concise, direct, practical.\n"));
  _vfs.write("USER.md", enc.encode("# USER.md\nName: User\nPreferences:\n- Keep responses concise.\n- Focus on actionable next steps.\n"));
  _vfs.write("MEMORY.md", enc.encode("# MEMORY.md\n- **workspace**: Initialized in WASI mode.\n- **notes**: Add durable facts with `nullclaw memory add <key> <content>`.\n"));
  _vfs.write("HEARTBEAT.md", enc.encode("# HEARTBEAT.md\n- Review MEMORY.md and keep it high-signal.\n"));

  // ── Build imports ──
  const env = {
    host_fetch(
      url_ptr: number, url_len: number,
      _mp: number, _ml: number,
      _hp: number, _hl: number,
      body_ptr: number, body_len: number,
      response_ptr: number, response_max_len: number,
    ): number {
      const url = rstr(url_ptr, url_len);
      const body = rstr(body_ptr, body_len);
      const key = url + '||' + body;
      const cached = _prefetched.get(key);
      if (cached) {
        const bytes = new TextEncoder().encode(cached);
        const len = Math.min(bytes.length, response_max_len);
        new Uint8Array(_mem.buffer, response_ptr, len).set(bytes.subarray(0, len));
        _prefetched.delete(key);
        return len;
      }
      return 0;
    },
    host_config_get(key_ptr: number, key_len: number, out_ptr: number, out_max_len: number): number {
      const key = rstr(key_ptr, key_len);
      let val = '';
      if (key === 'NULLCLAW_API_KEY') val = _config.apiKey;
      else if (key === 'NULLCLAW_API_BASE') val = _config.apiBase;
      else if (key === 'NULLCLAW_MODEL') val = _config.model;
      if (!val) return 0;
      const bytes = new TextEncoder().encode(val);
      const len = Math.min(bytes.length, out_max_len);
      new Uint8Array(_mem.buffer, out_ptr, len).set(bytes.subarray(0, len));
      return len;
    },
    host_ui_write(text_ptr: number, text_len: number): void {
      if (_uiCallback) _uiCallback(rstr(text_ptr, text_len));
    },
  };

  const wasi: Record<string, (...params: any[]) => number> = {
    args_sizes_get(argc: number, bufsz: number): number {
      let total = 0; for (const a of _args) total += a.length + 1;
      const v = dv(); v.setUint32(argc, _args.length, true); v.setUint32(bufsz, total, true);
      return 0;
    },
    args_get(argv: number, buf: number): number {
      let off = buf;
      for (let i = 0; i < _args.length; i++) {
        dv().setUint32(argv + i * 4, off, true);
        const e = new TextEncoder().encode(_args[i]);
        const d = new Uint8Array(_mem.buffer, off, e.length + 1); d.set(e); d[e.length] = 0;
        off += e.length + 1;
      }
      return 0;
    },
    environ_sizes_get(c: number, b: number): number { dv().setUint32(c, 0, true); dv().setUint32(b, 0, true); return 0; },
    environ_get(e: number, b: number): number { return 0; },
    clock_time_get(clk: number, prec: number, t: number): number { dv().setBigUint64(t, BigInt(Date.now()) * 1000000n, true); return 0; },
    clock_res_get(clk: number, r: number): number { dv().setBigUint64(r, 1000000n, true); return 0; },
    random_get(ptr: number, len: number): number { crypto.getRandomValues(new Uint8Array(_mem.buffer, ptr, len)); return 0; },
    proc_exit(rval: number): number { _exitCode = rval; _exited = true; throw new WebAssembly.RuntimeError("proc_exit"); },
    poll_oneoff(s: number, e: number, n: number, ne: number): number { dv().setUint32(ne, 0, true); return 0; },
    fd_write(fd: number, iovs: number, iovsLen: number, nwritten: number): number {
      const v = dv(); let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const bp = v.getUint32(iovs + i * 8, true);
        const bl = v.getUint32(iovs + i * 8 + 4, true);
        const bytes = new Uint8Array(_mem.buffer, bp, bl);
        total += bl;
        if (fd === 1) _stdout.push(bytes.slice());
        else if (fd === 2) _stderr.push(bytes.slice());
        else {
          const file = _fds.get(fd);
          if (file?.writable) {
            const want = file.offset + bl;
            if (file.content.length < want) { const nb = new Uint8Array(want); nb.set(file.content); file.content = nb; }
            file.content.set(bytes, file.offset);
            file.offset += bl;
            _vfs.write(file.path, file.content);
          }
        }
      }
      v.setUint32(nwritten, total, true);
      return 0;
    },
    fd_read(fd: number, iovs: number, iovsLen: number, nread: number): number {
      const v = dv(); let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const bp = v.getUint32(iovs + i * 8, true);
        const bl = v.getUint32(iovs + i * 8 + 4, true);
        if (fd === 0) continue;
        const file = _fds.get(fd);
        if (!file) { v.setUint32(nread, 0, true); return 8; }
        const rem = file.content.length - file.offset;
        const n = Math.max(0, Math.min(bl, rem));
        if (n > 0) { new Uint8Array(_mem.buffer, bp, n).set(file.content.subarray(file.offset, file.offset + n)); file.offset += n; }
        total += n;
      }
      v.setUint32(nread, total, true);
      return 0;
    },
    fd_pwrite(fd: number, iovs: number, iovsLen: number, offset: number, nwritten: number): number {
      const v = dv(); let total = 0;
      const file = _fds.get(fd);
      if (!file?.writable) return 8;
      for (let i = 0; i < iovsLen; i++) {
        const bp = v.getUint32(iovs + i * 8, true);
        const bl = v.getUint32(iovs + i * 8 + 4, true);
        const bytes = new Uint8Array(_mem.buffer, bp, bl);
        const want = Number(offset) + total + bl;
        if (file.content.length < want) { const nb = new Uint8Array(want); nb.set(file.content); file.content = nb; }
        file.content.set(bytes, Number(offset) + total);
        total += bl;
      }
      _vfs.write(file.path, file.content);
      v.setUint32(nwritten, total, true);
      return 0;
    },
    fd_pread(fd: number, iovs: number, iovsLen: number, offset: number, nread: number): number {
      const v = dv(); let total = 0;
      const file = _fds.get(fd);
      if (!file) return 8;
      for (let i = 0; i < iovsLen; i++) {
        const bp = v.getUint32(iovs + i * 8, true);
        const bl = v.getUint32(iovs + i * 8 + 4, true);
        const rem = file.content.length - Number(offset) - total;
        const n = Math.max(0, Math.min(bl, rem));
        if (n > 0) new Uint8Array(_mem.buffer, bp, n).set(file.content.subarray(Number(offset) + total, Number(offset) + total + n));
        total += n;
      }
      v.setUint32(nread, total, true);
      return 0;
    },
    fd_seek(fd: number, offset: number, whence: number, newoff: number): number {
      const v = dv(); const file = _fds.get(fd);
      if (!file) return 8;
      const off = Number(offset);
      let no = whence === 0 ? off : whence === 1 ? file.offset + off : file.content.length + off;
      file.offset = Math.max(0, no);
      v.setBigUint64(newoff, BigInt(file.offset), true);
      return 0;
    },
    fd_close(fd: number): number { _fds.delete(fd); return 0; },
    fd_sync(fd: number): number { return 0; },
    fd_fdstat_get(fd: number, buf: number): number {
      const v = dv();
      v.setUint8(buf, fd === 3 ? FT_DIR : FT_REG);
      v.setBigUint64(buf + 8, fd === 3 ? 0xFFFFFFFFFFFFFFFFn : BigInt(0x3F), true);
      v.setBigUint64(buf + 16, 0n, true);
      return 0;
    },
    fd_filestat_get(fd: number, buf: number): number {
      const v = dv();
      v.setBigUint64(buf, 0n, true);
      v.setBigUint64(buf + 8, BigInt(fd), true);
      v.setUint8(buf + 16, FT_REG);
      v.setBigUint64(buf + 24, 1n, true);
      v.setBigUint64(buf + 32, BigInt(_fds.get(fd)?.content.length ?? 0), true);
      v.setBigUint64(buf + 40, 0n, true);
      v.setBigUint64(buf + 48, 0n, true);
      v.setBigUint64(buf + 56, 0n, true);
      return 0;
    },
    fd_filestat_set_size(fd: number, sz: number): number { return 0; },
    fd_filestat_set_times(fd: number, at: number, mt: number, fl: number): number { return 0; },
    fd_prestat_get(fd: number, buf: number): number {
      if (fd !== 3) return 8;
      const v = dv();
      v.setUint8(buf, 0); v.setUint32(buf + 4, 1, true);
      return 0;
    },
    fd_prestat_dir_name(fd: number, ptr: number, len: number): number {
      if (fd !== 3) return 8;
      dv().setUint8(ptr, 0x2f);
      return 0;
    },
    path_open(dirfd: number, dirflags: number, pathPtr: number, pathLen: number, oflags: number, rightsBase: number, rightsInheriting: number, fdflags: number, fdOut: number): number {
      const v = dv();
      const path = rstr(pathPtr, pathLen);
      const full = path.startsWith("/") ? path : "/" + path;
      const wantCreate = (oflags & 1) !== 0;
      const wantTrunc = (oflags & 8) !== 0;
      let content = _vfs.read(full);
      if (!content) {
        if (wantCreate) { _vfs.write(full, new Uint8Array(0)); content = new Uint8Array(0); }
        else { return 44; }
      }
      if (wantTrunc) content = new Uint8Array(0);
      const fd = _nextFd++;
      _fds.set(fd, { path: full, content: content.slice(), offset: 0, writable: wantCreate || wantTrunc, ftype: FT_REG });
      v.setUint32(fdOut, fd, true);
      return 0;
    },
    path_filestat_get(dirfd: number, dirflags: number, pathPtr: number, pathLen: number, buf: number): number {
      const path = rstr(pathPtr, pathLen);
      const full = path.startsWith("/") ? path : "/" + path;
      const stat = _vfs.stat(full);
      if (!stat) return 44;
      const v = dv();
      v.setBigUint64(buf, 0n, true);
      v.setBigUint64(buf + 8, 1n, true);
      v.setUint8(buf + 16, stat.isDir ? FT_DIR : FT_REG);
      v.setBigUint64(buf + 24, 1n, true);
      v.setBigUint64(buf + 32, BigInt(stat.size), true);
      v.setBigUint64(buf + 40, 0n, true);
      v.setBigUint64(buf + 48, 0n, true);
      v.setBigUint64(buf + 56, 0n, true);
      return 0;
    },
    path_create_directory(dirfd: number, pathPtr: number, pathLen: number): number {
      const path = rstr(pathPtr, pathLen);
      return _vfs.mkdir(path.startsWith("/") ? path : "/" + path) ? 0 : 28;
    },
    path_unlink_file(dirfd: number, pathPtr: number, pathLen: number): number { return 0; },
    path_remove_directory(dirfd: number, pathPtr: number, pathLen: number): number { return 0; },
    fd_readdir(fd: number, bufPtr: number, bufLen: number, cookie: number, bufUsed: number): number {
      const v = dv();
      let dirPath = "/";
      if (fd !== 3) { const f = _fds.get(fd); if (f) dirPath = f.path; }
      const names = _vfs.listDir(dirPath);
      let off = 0;
      for (let i = 0; i < names.length; i++) {
        const nb = new TextEncoder().encode(names[i]);
        const sz = 8 + 8 + 4 + 1 + nb.length;
        if (off + sz > bufLen) break;
        const ep = bufPtr + off;
        v.setBigUint64(ep, BigInt(off + sz), true);
        v.setBigUint64(ep + 8, BigInt(i + 1), true);
        v.setUint32(ep + 16, nb.length, true);
        v.setUint8(ep + 20, FT_REG);
        new Uint8Array(_mem.buffer, ep + 21, nb.length).set(nb);
        off += sz;
      }
      v.setUint32(bufUsed, off, true);
      return 0;
    },
    path_rename(od: number, op: number, ol: number, nd: number, np: number, nl: number): number { return 0; },
    path_symlink(op: number, ol: number, nd: number, np: number, nl: number): number { return 28; },
    path_link(od: number, op: number, ol: number, nd: number, np: number, nl: number): number { return 0; },
    path_readlink(d: number, p: number, l: number, b: number, bl: number, u: number): number { dv().setUint32(u, 0, true); return 28; },
  };

  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    wasi_snapshot_preview1: wasi,
    env: env,
  });
  _mem = instance.exports.memory as WebAssembly.Memory;

  try {
    (instance.exports._start as () => void)();
  } catch (e: any) {
    if (!e?.message?.includes("proc_exit") && !_exited) {
      _stderr.push(new TextEncoder().encode("Error: " + (e?.message ?? e) + "\n"));
      _exitCode = 1;
    }
  }

  const concat = (arr: Uint8Array[]) => {
    let l = 0; for (const c of arr) l += c.length;
    const o = new Uint8Array(l); let p = 0;
    for (const c of arr) { o.set(c, p); p += c.length; }
    return o;
  };
  return {
    stdout: new TextDecoder().decode(concat(_stdout)),
    stderr: new TextDecoder().decode(concat(_stderr)),
    exitCode: _exitCode,
  };
}
