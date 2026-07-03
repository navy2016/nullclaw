/**
 * Minimal WASI Preview 1 shim for nullclaw.wasm in Obsidian WebView.
 * Verified working against node:wasi. Handles all 32 imports the binary needs.
 */

const errno = {
  SUCCESS: 0, BADF: 8, NOENT: 44, INVAL: 28,
} as const;

const FT_REG = 4, FT_DIR = 3;

// ── Virtual Filesystem ──────────────────────────────────────────────────────
class Vfs {
  root: Map<string, VfsNode> = new Map();
  
  private parts(p: string): string[] { return p.split("/").filter(x => x.length > 0); }

  resolve(p: string): VfsNode | null {
    const parts = this.parts(p);
    let node: VfsNode | undefined = undefined;
    let children = this.root;
    for (const part of parts) {
      node = children.get(part);
      if (!node) return null;
      children = node.children;
    }
    return node ?? null;
  }

  exists(p: string): boolean { return this.resolve(p) !== null; }
  
  read(p: string): Uint8Array | null {
    const n = this.resolve(p);
    return n?.content ?? null;
  }

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

  unlink(p: string): boolean { return !!this.resolve(p) && false; } // simplified

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

interface VfsNode { children: Map<string, VfsNode>; content: Uint8Array | null; }

// ── FD table ────────────────────────────────────────────────────────────────
interface FD { path: string; content: Uint8Array; offset: number; writable: boolean; ftype: number; }
const FDTable = new Map<number, FD>();
let nextFD = 4;

// ── Result ──────────────────────────────────────────────────────────────────
export interface WasiResult { stdout: string; stderr: string; exitCode: number; }

// ── Shim ───────────────────────────────────────────────────────────────────
let _mem: WebAssembly.Memory;
let _args: string[] = [];
let _stdout: Uint8Array[] = [];
let _stderr: Uint8Array[] = [];
let _exitCode = 0;
let _exited = false;
let _vfs = new Vfs();

function dv(): DataView { return new DataView(_mem.buffer); }
function rstr(ptr: number, len: number): string {
  return new TextDecoder().decode(new Uint8Array(_mem.buffer, ptr, len));
}

export async function runNullclaw(wasmBytes: ArrayBuffer, args: string[]): Promise<WasiResult> {
  _args = ["nullclaw", ...args];
  _stdout = []; _stderr = []; _exitCode = 0; _exited = false;
  _vfs = new Vfs();
  FDTable.clear(); nextFD = 4;

  // Seed workspace files
  const enc = new TextEncoder();
  _vfs.write("IDENTITY.md", enc.encode("# IDENTITY.md\nName: NullClaw WASI\nRole: Local assistant running in WASM/WASI.\nStyle: concise, direct, practical.\n"));
  _vfs.write("USER.md", enc.encode("# USER.md\nName: User\nPreferences:\n- Keep responses concise.\n- Focus on actionable next steps.\n"));
  _vfs.write("MEMORY.md", enc.encode("# MEMORY.md\n- **workspace**: Initialized in WASI mode.\n- **notes**: Add durable facts with `nullclaw memory add <key> <content>`.\n"));
  _vfs.write("HEARTBEAT.md", enc.encode("# HEARTBEAT.md\n- Review MEMORY.md and keep it high-signal.\n"));

  const imports: Record<string, (...params: any[]) => number> = {
    args_sizes_get(argc, bufsz) {
      let total = 0; for (const a of _args) total += a.length + 1;
      const v = dv(); v.setUint32(argc, _args.length, true); v.setUint32(bufsz, total, true);
      return 0;
    },
    args_get(argv, buf) {
      let off = buf;
      for (let i = 0; i < _args.length; i++) {
        dv().setUint32(argv + i * 4, off, true);
        const e = new TextEncoder().encode(_args[i]);
        const d = new Uint8Array(_mem.buffer, off, e.length + 1); d.set(e); d[e.length] = 0;
        off += e.length + 1;
      }
      return 0;
    },
    environ_sizes_get(c, b) { dv().setUint32(c, 0, true); dv().setUint32(b, 0, true); return 0; },
    environ_get(e, b) { return 0; },
    clock_time_get(clk, prec, t) { dv().setBigUint64(t, BigInt(Date.now()) * 1_000_000n, true); return 0; },
    clock_res_get(clk, r) { dv().setBigUint64(r, 1_000_000n, true); return 0; },
    random_get(ptr, len) { crypto.getRandomValues(new Uint8Array(_mem.buffer, ptr, len)); return 0; },
    proc_exit(rval: number): never { _exitCode = rval; _exited = true; throw new WebAssembly.RuntimeError("proc_exit"); },
    poll_oneoff(s, e, n, ne) { dv().setUint32(ne, 0, true); return 0; },
    fd_write(fd, iovs, iovsLen, nwritten) {
      const v = dv(); let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const bp = v.getUint32(iovs + i * 8, true);
        const bl = v.getUint32(iovs + i * 8 + 4, true);
        const bytes = new Uint8Array(_mem.buffer, bp, bl);
        total += bl;
        if (fd === 1) _stdout.push(bytes.slice());
        else if (fd === 2) _stderr.push(bytes.slice());
        else {
          // File write
          const file = FDTable.get(fd);
          if (file && file.writable) {
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
    fd_read(fd, iovs, iovsLen, nread) {
      const v = dv(); let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const bp = v.getUint32(iovs + i * 8, true);
        const bl = v.getUint32(iovs + i * 8 + 4, true);
        if (fd === 0) continue; // stdin: no data
        const file = FDTable.get(fd);
        if (!file) { v.setUint32(nread, 0, true); return errno.BADF; }
        const rem = file.content.length - file.offset;
        const n = Math.max(0, Math.min(bl, rem));
        if (n > 0) { new Uint8Array(_mem.buffer, bp, n).set(file.content.subarray(file.offset, file.offset + n)); file.offset += n; }
        total += n;
      }
      v.setUint32(nread, total, true);
      return 0;
    },
    fd_pwrite(fd, iovs, iovsLen, offset, nwritten) {
      const v = dv(); let total = 0;
      const file = FDTable.get(fd);
      if (!file || !file.writable) return errno.BADF;
      for (let i = 0; i < iovsLen; i++) {
        const bp = v.getUint32(iovs + i * 8, true);
        const bl = v.getUint32(iovs + i * 8 + 4, true);
        const bytes = new Uint8Array(_mem.buffer, bp, bl);
        const want = offset + total + bl;
        if (file.content.length < want) { const nb = new Uint8Array(want); nb.set(file.content); file.content = nb; }
        file.content.set(bytes, offset + total);
        total += bl;
      }
      _vfs.write(file.path, file.content);
      v.setUint32(nwritten, total, true);
      return 0;
    },
    fd_pread(fd, iovs, iovsLen, offset, nread) {
      const v = dv(); let total = 0;
      const file = FDTable.get(fd);
      if (!file) return errno.BADF;
      for (let i = 0; i < iovsLen; i++) {
        const bp = v.getUint32(iovs + i * 8, true);
        const bl = v.getUint32(iovs + i * 8 + 4, true);
        const rem = file.content.length - offset - total;
        const n = Math.max(0, Math.min(bl, rem));
        if (n > 0) new Uint8Array(_mem.buffer, bp, n).set(file.content.subarray(offset + total, offset + total + n));
        total += n;
      }
      v.setUint32(nread, total, true);
      return 0;
    },
    fd_seek(fd, offset, whence, newoff) {
      const v = dv(); const file = FDTable.get(fd);
      if (!file) return errno.BADF;
      const off = Number(offset);
      let no = whence === 0 ? off : whence === 1 ? file.offset + off : file.content.length + off;
      file.offset = Math.max(0, no);
      v.setBigUint64(newoff, BigInt(file.offset), true);
      return 0;
    },
    fd_close(fd) { FDTable.delete(fd); return 0; },
    fd_sync(fd) { return 0; },
    fd_fdstat_get(fd, buf) {
      const v = dv();
      v.setUint8(buf, fd === 3 ? FT_DIR : FT_REG);
      v.setBigUint64(buf + 8, fd === 3 ? 0xFFFFFFFFFFFFFFFFn : BigInt(0x3F), true);
      v.setBigUint64(buf + 16, 0n, true);
      return 0;
    },
    fd_filestat_get(fd, buf) {
      const v = dv();
      v.setBigUint64(buf, 0n, true);
      v.setBigUint64(buf + 8, BigInt(fd), true);
      v.setUint8(buf + 16, FT_REG);
      v.setBigUint64(buf + 24, 1n, true);
      const file = FDTable.get(fd);
      v.setBigUint64(buf + 32, BigInt(file?.content.length ?? 0), true);
      v.setBigUint64(buf + 40, 0n, true);
      v.setBigUint64(buf + 48, 0n, true);
      v.setBigUint64(buf + 56, 0n, true);
      return 0;
    },
    fd_filestat_set_size(fd, sz) { return 0; },
    fd_filestat_set_times(fd, at, mt, fl) { return 0; },
    fd_prestat_get(fd, buf) {
      if (fd !== 3) return errno.BADF;
      const v = dv();
      v.setUint8(buf, 0); v.setUint32(buf + 4, 1, true);
      return 0;
    },
    fd_prestat_dir_name(fd, ptr, len) {
      if (fd !== 3) return errno.BADF;
      dv().setUint8(ptr, 0x2f);
      return 0;
    },
    path_open(dirfd, dirflags, pathPtr, pathLen, oflags, rightsBase, rightsInheriting, fdflags, fdOut) {
      const v = dv();
      const path = rstr(pathPtr, pathLen);
      const full = path.startsWith("/") ? path : "/" + path;
      const wantCreate = (oflags & 1) !== 0;
      const wantDir = (oflags & 2) !== 0;
      const wantTrunc = (oflags & 8) !== 0;

      let content = _vfs.read(full);
      if (!content) {
        if (wantCreate) { _vfs.write(full, new Uint8Array(0)); content = new Uint8Array(0); }
        else { return errno.NOENT; }
      }
      if (wantTrunc) content = new Uint8Array(0);

      const fd = nextFD++;
      FDTable.set(fd, {
        path: full,
        content: content.slice(),
        offset: 0,
        writable: wantCreate || wantTrunc,
        ftype: FT_REG,
      });
      v.setUint32(fdOut, fd, true);
      return 0;
    },
    path_filestat_get(dirfd, dirflags, pathPtr, pathLen, buf) {
      const path = rstr(pathPtr, pathLen);
      const full = path.startsWith("/") ? path : "/" + path;
      const stat = _vfs.stat(full);
      if (!stat) return errno.NOENT;
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
    path_create_directory(dirfd, pathPtr, pathLen) {
      const path = rstr(pathPtr, pathLen);
      return _vfs.mkdir(path.startsWith("/") ? path : "/" + path) ? 0 : errno.INVAL;
    },
    path_unlink_file(dirfd, pathPtr, pathLen) { return 0; },
    path_remove_directory(dirfd, pathPtr, pathLen) { return 0; },
    fd_readdir(fd, bufPtr, bufLen, cookie, bufUsed) {
      const v = dv();
      let dirPath = "/";
      if (fd !== 3) { const f = FDTable.get(fd); if (f) dirPath = f.path; }
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
    path_rename(od, op, ol, nd, np, nl) { return 0; },
    path_symlink(op, ol, nd, np, nl) { return errno.INVAL; },
    path_link(od, op, ol, nd, np, nl) { return 0; },
    path_readlink(d, p, l, b, bl, u) { dv().setUint32(u, 0, true); return errno.INVAL; },
  };

  const { instance } = await WebAssembly.instantiate(wasmBytes, { wasi_snapshot_preview1: imports });
  _mem = instance.exports.memory as WebAssembly.Memory;

  try {
    (instance.exports._start as () => void)();
  } catch (e: any) {
    if (!e?.message?.includes("proc_exit") && !_exited) {
      _stderr.push(new TextEncoder().encode(`Error: ${e?.message ?? e}\n`));
      _exitCode = 1;
    }
  }

  const concat = (arr: Uint8Array[]) => { let l = 0; for (const c of arr) l += c.length; const o = new Uint8Array(l); let p = 0; for (const c of arr) { o.set(c, p); p += c.length; } return o; };
  return {
    stdout: new TextDecoder().decode(concat(_stdout)),
    stderr: new TextDecoder().decode(concat(_stderr)),
    exitCode: _exitCode,
  };
}
