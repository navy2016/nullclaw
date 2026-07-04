var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => NullClawPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");

// wasi-shim.ts
var FT_REG = 4;
var FT_DIR = 3;
var Vfs = class {
  constructor() {
    this.root = /* @__PURE__ */ new Map();
  }
  parts(p) {
    return p.split("/").filter((x) => x.length > 0 && x !== ".");
  }
  resolve(p) {
    const parts = this.parts(p);
    let children = this.root;
    let node;
    for (const part of parts) {
      node = children.get(part);
      if (!node) return null;
      children = node.children;
    }
    return node ?? null;
  }
  exists(p) {
    return this.resolve(p) !== null;
  }
  read(p) {
    return this.resolve(p)?.content ?? null;
  }
  write(p, data) {
    const parts = this.parts(p);
    if (parts.length === 0) return false;
    const name = parts.pop();
    let children = this.root;
    for (const part of parts) {
      let n = children.get(part);
      if (!n) {
        n = { children: /* @__PURE__ */ new Map(), content: null };
        children.set(part, n);
      }
      children = n.children;
    }
    children.set(name, { children: /* @__PURE__ */ new Map(), content: data });
    return true;
  }
  mkdir(p) {
    const parts = this.parts(p);
    if (parts.length === 0) return true;
    const name = parts.pop();
    let children = this.root;
    for (const part of parts) {
      let n = children.get(part);
      if (!n) {
        n = { children: /* @__PURE__ */ new Map(), content: null };
        children.set(part, n);
      }
      children = n.children;
    }
    if (children.has(name)) {
      const existing = children.get(name);
      return existing.content === null;
    }
    children.set(name, { children: /* @__PURE__ */ new Map(), content: null });
    return true;
  }
  stat(p) {
    const n = this.resolve(p);
    if (!n) return null;
    return { size: n.content?.length ?? 0, isDir: n.children.size > 0 && !n.content };
  }
  listDir(p) {
    const n = this.resolve(p);
    if (!n) return [];
    return Array.from(n.children.keys());
  }
};
var _mem;
var _args = [];
var _stdout = [];
var _stderr = [];
var _exitCode = 0;
var _exited = false;
var _vfs = new Vfs();
var _fds = /* @__PURE__ */ new Map();
var _nextFd = 4;
var _config = { apiKey: "", apiBase: "https://api.openai.com/v1", model: "gpt-4o-mini" };
var _uiCallback = null;
var _prefetched = /* @__PURE__ */ new Map();
function dv() {
  return new DataView(_mem.buffer);
}
function rstr(ptr, len) {
  return new TextDecoder().decode(new Uint8Array(_mem.buffer, ptr, len));
}
async function runNullclaw(wasmBytes, args, config, uiCallback) {
  _args = ["nullclaw", ...args];
  _stdout = [];
  _stderr = [];
  _exitCode = 0;
  _exited = false;
  _vfs = new Vfs();
  _fds = /* @__PURE__ */ new Map();
  _nextFd = 4;
  _config = {
    apiKey: config?.apiKey ?? "",
    apiBase: config?.apiBase ?? "https://api.openai.com/v1",
    model: config?.model ?? "gpt-4o-mini"
  };
  _uiCallback = uiCallback ?? null;
  const enc = new TextEncoder();
  _vfs.write("IDENTITY.md", enc.encode("# IDENTITY.md\nName: NullClaw WASI\nRole: Local assistant running in WASM/WASI.\nStyle: concise, direct, practical.\n"));
  _vfs.write("USER.md", enc.encode("# USER.md\nName: User\nPreferences:\n- Keep responses concise.\n- Focus on actionable next steps.\n"));
  _vfs.write("MEMORY.md", enc.encode("# MEMORY.md\n- **workspace**: Initialized in WASI mode.\n- **notes**: Add durable facts with `nullclaw memory add <key> <content>`.\n"));
  _vfs.write("HEARTBEAT.md", enc.encode("# HEARTBEAT.md\n- Review MEMORY.md and keep it high-signal.\n"));
  const env = {
    host_fetch(url_ptr, url_len, _mp, _ml, _hp, _hl, body_ptr, body_len, response_ptr, response_max_len) {
      const url = rstr(url_ptr, url_len);
      const body = rstr(body_ptr, body_len);
      const key = url + "||" + body;
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
    host_config_get(key_ptr, key_len, out_ptr, out_max_len) {
      const key = rstr(key_ptr, key_len);
      let val = "";
      if (key === "NULLCLAW_API_KEY") val = _config.apiKey;
      else if (key === "NULLCLAW_API_BASE") val = _config.apiBase;
      else if (key === "NULLCLAW_MODEL") val = _config.model;
      if (!val) return 0;
      const bytes = new TextEncoder().encode(val);
      const len = Math.min(bytes.length, out_max_len);
      new Uint8Array(_mem.buffer, out_ptr, len).set(bytes.subarray(0, len));
      return len;
    },
    host_ui_write(text_ptr, text_len) {
      if (_uiCallback) _uiCallback(rstr(text_ptr, text_len));
    }
  };
  const wasi = {
    args_sizes_get(argc, bufsz) {
      let total = 0;
      for (const a of _args) total += a.length + 1;
      const v = dv();
      v.setUint32(argc, _args.length, true);
      v.setUint32(bufsz, total, true);
      return 0;
    },
    args_get(argv, buf) {
      let off = buf;
      for (let i = 0; i < _args.length; i++) {
        dv().setUint32(argv + i * 4, off, true);
        const e = new TextEncoder().encode(_args[i]);
        const d = new Uint8Array(_mem.buffer, off, e.length + 1);
        d.set(e);
        d[e.length] = 0;
        off += e.length + 1;
      }
      return 0;
    },
    environ_sizes_get(c, b) {
      dv().setUint32(c, 0, true);
      dv().setUint32(b, 0, true);
      return 0;
    },
    environ_get(e, b) {
      return 0;
    },
    clock_time_get(clk, prec, t) {
      dv().setBigUint64(t, BigInt(Date.now()) * 1000000n, true);
      return 0;
    },
    clock_res_get(clk, r) {
      dv().setBigUint64(r, 1000000n, true);
      return 0;
    },
    random_get(ptr, len) {
      crypto.getRandomValues(new Uint8Array(_mem.buffer, ptr, len));
      return 0;
    },
    proc_exit(rval) {
      _exitCode = rval;
      _exited = true;
      throw new WebAssembly.RuntimeError("proc_exit");
    },
    poll_oneoff(s, e, n, ne) {
      dv().setUint32(ne, 0, true);
      return 0;
    },
    fd_write(fd, iovs, iovsLen, nwritten) {
      const v = dv();
      let total = 0;
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
            if (file.content.length < want) {
              const nb = new Uint8Array(want);
              nb.set(file.content);
              file.content = nb;
            }
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
      const v = dv();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const bp = v.getUint32(iovs + i * 8, true);
        const bl = v.getUint32(iovs + i * 8 + 4, true);
        if (fd === 0) continue;
        const file = _fds.get(fd);
        if (!file) {
          v.setUint32(nread, 0, true);
          return 8;
        }
        const rem = file.content.length - file.offset;
        const n = Math.max(0, Math.min(bl, rem));
        if (n > 0) {
          new Uint8Array(_mem.buffer, bp, n).set(file.content.subarray(file.offset, file.offset + n));
          file.offset += n;
        }
        total += n;
      }
      v.setUint32(nread, total, true);
      return 0;
    },
    fd_pwrite(fd, iovs, iovsLen, offset, nwritten) {
      const v = dv();
      let total = 0;
      if (fd === 1 || fd === 2) {
        for (let i = 0; i < iovsLen; i++) {
          const bp = v.getUint32(iovs + i * 8, true);
          const bl = v.getUint32(iovs + i * 8 + 4, true);
          const bytes = new Uint8Array(_mem.buffer, bp, bl);
          total += bl;
          if (fd === 1) _stdout.push(bytes.slice());
          else _stderr.push(bytes.slice());
        }
        v.setUint32(nwritten, total, true);
        return 0;
      }
      const file = _fds.get(fd);
      if (!file?.writable) return 8;
      for (let i = 0; i < iovsLen; i++) {
        const bp = v.getUint32(iovs + i * 8, true);
        const bl = v.getUint32(iovs + i * 8 + 4, true);
        const bytes = new Uint8Array(_mem.buffer, bp, bl);
        const want = Number(offset) + total + bl;
        if (file.content.length < want) {
          const nb = new Uint8Array(want);
          nb.set(file.content);
          file.content = nb;
        }
        file.content.set(bytes, Number(offset) + total);
        total += bl;
      }
      _vfs.write(file.path, file.content);
      v.setUint32(nwritten, total, true);
      return 0;
    },
    fd_pread(fd, iovs, iovsLen, offset, nread) {
      const v = dv();
      let total = 0;
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
    fd_seek(fd, offset, whence, newoff) {
      const v = dv();
      const file = _fds.get(fd);
      if (!file) return 8;
      const off = Number(offset);
      let no = whence === 0 ? off : whence === 1 ? file.offset + off : file.content.length + off;
      file.offset = Math.max(0, no);
      v.setBigUint64(newoff, BigInt(file.offset), true);
      return 0;
    },
    fd_close(fd) {
      _fds.delete(fd);
      return 0;
    },
    fd_sync(fd) {
      return 0;
    },
    fd_fdstat_get(fd, buf) {
      const v = dv();
      v.setUint8(buf, fd === 3 ? FT_DIR : FT_REG);
      v.setBigUint64(buf + 8, 0xFFFFFFFFFFFFFFFFn, true);
      v.setBigUint64(buf + 16, 0n, true);
      return 0;
    },
    fd_filestat_get(fd, buf) {
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
    fd_filestat_set_size(fd, sz) {
      return 0;
    },
    fd_filestat_set_times(fd, at, mt, fl) {
      return 0;
    },
    fd_prestat_get(fd, buf) {
      if (fd !== 3) return 8;
      const v = dv();
      v.setUint8(buf, 0);
      v.setUint32(buf + 4, 1, true);
      return 0;
    },
    fd_prestat_dir_name(fd, ptr, len) {
      if (fd !== 3) return 8;
      dv().setUint8(ptr, 47);
      return 0;
    },
    path_open(dirfd, dirflags, pathPtr, pathLen, oflags, rightsBase, rightsInheriting, fdflags, fdOut) {
      const v = dv();
      const path = rstr(pathPtr, pathLen);
      const full = path.startsWith("/") ? path : "/" + path;
      const wantCreate = (oflags & 1) !== 0;
      const wantTrunc = (oflags & 8) !== 0;
      const rights = BigInt(rightsBase);
      const wantsWrite = (rights & 1n << 6n) !== 0n || (rights & 1n << 8n) !== 0n || (rights & 1n << 19n) !== 0n || (rights & 1n << 22n) !== 0n;
      let content = _vfs.read(full);
      if (!content) {
        if (wantCreate || wantsWrite) {
          _vfs.write(full, new Uint8Array(0));
          content = new Uint8Array(0);
        } else {
          return 44;
        }
      }
      if (wantTrunc) content = new Uint8Array(0);
      const fd = _nextFd++;
      _fds.set(fd, { path: full, content: content.slice(), offset: 0, writable: wantCreate || wantTrunc || wantsWrite, ftype: FT_REG });
      v.setUint32(fdOut, fd, true);
      return 0;
    },
    path_filestat_get(dirfd, dirflags, pathPtr, pathLen, buf) {
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
    path_create_directory(dirfd, pathPtr, pathLen) {
      const path = rstr(pathPtr, pathLen);
      return _vfs.mkdir(path.startsWith("/") ? path : "/" + path) ? 0 : 28;
    },
    path_unlink_file(dirfd, pathPtr, pathLen) {
      return 0;
    },
    path_remove_directory(dirfd, pathPtr, pathLen) {
      return 0;
    },
    fd_readdir(fd, bufPtr, bufLen, cookie, bufUsed) {
      const v = dv();
      let dirPath = "/";
      if (fd !== 3) {
        const f = _fds.get(fd);
        if (f) dirPath = f.path;
      }
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
    path_rename(od, op, ol, nd, np, nl) {
      return 0;
    },
    path_symlink(op, ol, nd, np, nl) {
      return 28;
    },
    path_link(od, op, ol, nd, np, nl) {
      return 0;
    },
    path_readlink(d, p, l, b, bl, u) {
      dv().setUint32(u, 0, true);
      return 28;
    }
  };
  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    wasi_snapshot_preview1: wasi,
    env
  });
  _mem = instance.exports.memory;
  try {
    instance.exports._start();
  } catch (e) {
    if (!e?.message?.includes("proc_exit") && !_exited) {
      _stderr.push(new TextEncoder().encode("Error: " + (e?.message ?? e) + "\n"));
      _exitCode = 1;
    }
  }
  const concat = (arr) => {
    let l = 0;
    for (const c of arr) l += c.length;
    const o = new Uint8Array(l);
    let p = 0;
    for (const c of arr) {
      o.set(c, p);
      p += c.length;
    }
    return o;
  };
  return {
    stdout: new TextDecoder().decode(concat(_stdout)),
    stderr: new TextDecoder().decode(concat(_stderr)),
    exitCode: _exitCode
  };
}

// main.ts
var VIEW_TYPE = "nullclaw-agent-view";
var DEFAULT_SETTINGS = {
  apiKey: "",
  apiBase: "https://api.openai.com/v1",
  model: "gpt-4o-mini"
};
var NullclawView = class extends import_obsidian.ItemView {
  constructor(leaf, settings) {
    super(leaf);
    this.wasmBytes = null;
    this.running = false;
    this.messages = [];
    this.attachedRefs = [];
    this.settings = settings;
  }
  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "NullClaw";
  }
  getIcon() {
    return "bot";
  }
  async onOpen() {
    const c = this.containerEl.children[1];
    c.empty();
    c.addClass("nullclaw-terminal");
    this.outputEl = c.createDiv({ cls: "nullclaw-output" });
    const row = c.createDiv({ cls: "nullclaw-input-row" });
    row.createSpan({ cls: "nullclaw-input-prompt", text: "\u276F" });
    this.inputEl = row.createEl("input", { cls: "nullclaw-input", attr: { type: "text", placeholder: "\u76F4\u63A5\u8F93\u5165\u53D1\u7ED9 AI\uFF1B\u547D\u4EE4\u7528 /help /version /memory list ..." } });
    const st = c.createDiv({ cls: "nullclaw-status" });
    this.statusDot = st.createSpan({ cls: "nc-dot nc-dot-error" });
    this.statusText = st.createSpan({ text: "Loading nullclaw.wasm..." });
    await this.loadWasm();
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !this.running) this.exec(this.inputEl.value);
    });
    this.setupMobileViewport(c);
    this.setupFileDropAndPaste(c);
    setTimeout(() => this.inputEl.focus(), 200);
  }
  async loadWasm() {
    try {
      const adapter = this.app.vault.adapter;
      const wasmPath = `.obsidian/plugins/nullclaw-obsidian/nullclaw.wasm`;
      if (await adapter.exists(wasmPath)) {
        this.wasmBytes = await adapter.readBinary(wasmPath);
      } else {
        throw new Error("nullclaw.wasm not found in plugin directory");
      }
      const sizeKB = (this.wasmBytes.byteLength / 1024).toFixed(1);
      this.statusDot.className = "nc-dot nc-dot-ready";
      if (this.settings.apiKey) {
        this.statusText.textContent = `NullClaw ready (${sizeKB} KB, LLM: ${this.settings.model})`;
        this.println("Welcome to NullClaw \u2014 direct chat mode. Type messages directly; use / for commands.", "nc-info");
      } else {
        this.statusText.textContent = `NullClaw ready (${sizeKB} KB, local mode \u2014 set API key in settings)`;
        this.println("Welcome to NullClaw \u2014 local mode. Type messages directly; use / for commands.", "nc-info");
        this.println("Go to Settings \u2192 NullClaw to set your API key for LLM mode.", "nc-info");
      }
      this.println("Commands: /version, /help, /status, /memory list, /memory add key value, /identity show", "nc-info");
      this.println("", "nc-info");
    } catch (e) {
      this.statusDot.className = "nc-dot nc-dot-error";
      this.statusText.textContent = "Load failed";
      this.println(`Failed to load nullclaw.wasm: ${e.message}`, "nc-error");
    }
  }
  async exec(input) {
    const raw = input.trim();
    if (!raw || !this.wasmBytes) return;
    this.running = true;
    this.statusDot.className = "nc-dot nc-dot-running";
    this.statusText.textContent = "Running...";
    this.println(`\u276F ${raw}`, "nc-prompt");
    this.inputEl.value = "";
    this.inputEl.disabled = true;
    try {
      if (raw.startsWith("/")) {
        await this.execSlashCommand(raw.slice(1).trim());
      } else {
        await this.execChatMessage(raw);
      }
    } catch (e) {
      this.println(`Error: ${e.message}`, "nc-error");
    } finally {
      this.running = false;
      this.statusDot.className = "nc-dot nc-dot-ready";
      this.statusText.textContent = "Ready";
      this.inputEl.disabled = false;
      this.inputEl.focus();
    }
  }
  async execSlashCommand(command) {
    if (!command) {
      this.println("Slash commands: /help /version /status /compact /digest-current /review-inbox /apply-memory /vault-doctor /feedback good|bad <text> /read /write /append /insert /search /list /clear", "nc-info");
      return;
    }
    const args = this.parseArgs(command);
    const cmd = args[0];
    if (cmd === "clear") {
      this.messages = [];
      this.attachedRefs = [];
      this.println("Context cleared.", "nc-info");
      return;
    }
    if (cmd === "compact") {
      await this.skillCompact();
      return;
    }
    if (cmd === "digest-current") {
      await this.skillDigestCurrent();
      return;
    }
    if (cmd === "review-inbox") {
      await this.skillReviewInbox();
      return;
    }
    if (cmd === "apply-memory") {
      await this.skillApplyMemory(args.slice(1).includes("--yes"));
      return;
    }
    if (cmd === "vault-doctor") {
      await this.skillVaultDoctor();
      return;
    }
    if (cmd === "feedback") {
      if (!args[1] || args.length < 3) return this.println("Usage: /feedback good|bad <text>", "nc-error");
      await this.writeFeedback(args[1], args.slice(2).join(" "));
      this.println("Feedback saved.", "nc-output");
      return;
    }
    if (cmd === "init-memory") {
      await this.ensureMemoryScaffold();
      this.println("Memory scaffold initialized.", "nc-output");
      return;
    }
    if (cmd === "read") {
      if (!args[1]) return this.println("Usage: /read <path>", "nc-error");
      this.println(await this.toolRead(args[1]), "nc-output");
      return;
    }
    if (cmd === "write") {
      if (!args[1] || args.length < 3) return this.println("Usage: /write <path> <content>", "nc-error");
      await this.toolWrite(args[1], args.slice(2).join(" "));
      this.println(`Wrote ${args[1]}`, "nc-output");
      return;
    }
    if (cmd === "append") {
      if (!args[1] || args.length < 3) return this.println("Usage: /append <path> <content>", "nc-error");
      await this.toolAppend(args[1], args.slice(2).join(" "));
      this.println(`Appended to ${args[1]}`, "nc-output");
      return;
    }
    if (cmd === "insert") {
      if (!args[1] || !args[2] || args.length < 4) return this.println("Usage: /insert <path> <marker> <content>", "nc-error");
      await this.toolInsert(args[1], args[2], args.slice(3).join(" "));
      this.println(`Inserted into ${args[1]}`, "nc-output");
      return;
    }
    if (cmd === "search") {
      if (args.length < 2) return this.println("Usage: /search <query>", "nc-error");
      this.println(await this.toolSearch(args.slice(1).join(" ")), "nc-output");
      return;
    }
    if (cmd === "list") {
      this.println(await this.toolList(args[1] ?? ""), "nc-output");
      return;
    }
    if (cmd === "agent") {
      let message = "";
      const mIdx = args.indexOf("-m");
      const mIdx2 = args.indexOf("--message");
      if (mIdx >= 0 && mIdx + 1 < args.length) message = args.slice(mIdx + 1).join(" ");
      else if (mIdx2 >= 0 && mIdx2 + 1 < args.length) message = args.slice(mIdx2 + 1).join(" ");
      else message = args.slice(1).join(" ");
      if (!message) {
        this.println('Usage: /agent -m "message" \u6216\u76F4\u63A5\u8F93\u5165 message', "nc-error");
        return;
      }
      await this.execChatMessage(message);
      return;
    }
    const result = await runNullclaw(
      this.wasmBytes,
      args,
      this.settings,
      (text) => this.println(text, "nc-info")
    );
    if (result.stdout) this.println(result.stdout, "nc-output");
    if (result.stderr) this.println(result.stderr, "nc-error");
    if (!result.stdout && !result.stderr) this.println(`(exit: ${result.exitCode})`, "nc-info");
  }
  async execChatMessage(message) {
    if (this.settings.apiKey) {
      const reply = await this.callLLM(message);
      if (reply) {
        this.println(reply, "nc-output");
        return;
      }
      this.println("[LLM call failed, falling back to local mode]", "nc-info");
    }
    const result = await runNullclaw(
      this.wasmBytes,
      ["agent", "-m", message],
      this.settings,
      (text) => this.println(text, "nc-info")
    );
    if (result.stdout) this.println(result.stdout, "nc-output");
    if (result.stderr) this.println(result.stderr, "nc-error");
    if (!result.stdout && !result.stderr) this.println(`(exit: ${result.exitCode})`, "nc-info");
  }
  async callLLM(message) {
    const base = (this.settings.apiBase || "https://api.openai.com/v1").replace(/\/$/, "");
    const system = {
      role: "system",
      content: "You are NullClaw, an AI assistant embedded in Obsidian Android. Maintain context across turns. You can use tools to read, write, append, insert, list and search the current Obsidian vault. Use tools when the user asks about notes/files or wants modifications. Be concise and answer in the user language."
    };
    await this.ensureMemoryScaffold();
    const palaceContext = await this.loadPalaceContext(message);
    const refContext = await this.resolveMessageReferences(message);
    const enriched = [palaceContext, refContext, `User message:
${message}`].filter(Boolean).join("\n\n---\n\n");
    const history = this.messages.slice(-20);
    const requestMessages = [system, ...history, { role: "user", content: enriched }];
    const tools = this.toolSchemas();
    try {
      const first = await this.chatCompletion(base, requestMessages, tools);
      const msg = first.choices?.[0]?.message;
      if (!msg) return null;
      if (msg.tool_calls?.length) {
        const toolMessages = [...requestMessages, msg];
        for (const call of msg.tool_calls) {
          const toolName = call.function?.name;
          const argsRaw = call.function?.arguments || "{}";
          let parsed = {};
          try {
            parsed = JSON.parse(argsRaw);
          } catch {
            parsed = {};
          }
          const result = await this.executeTool(toolName, parsed);
          toolMessages.push({
            role: "tool",
            tool_call_id: call.id,
            name: toolName,
            content: result
          });
        }
        const second = await this.chatCompletion(base, toolMessages, tools);
        const finalText = second.choices?.[0]?.message?.content ?? "";
        this.remember(message, finalText);
        return finalText || null;
      }
      const text = msg.content ?? first.choices?.[0]?.text ?? "";
      this.remember(message, text);
      return text || null;
    } catch (e) {
      this.println(`[LLM fetch failed] ${e.message}`, "nc-error");
      return null;
    }
  }
  async chatCompletion(base, messages, tools) {
    const body = {
      model: this.settings.model || "gpt-4o-mini",
      messages,
      max_tokens: 2048,
      temperature: 0.7
    };
    if (tools.length) body.tools = tools;
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.settings.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "app://obsidian-nullclaw",
        "X-Title": "NullClaw Obsidian"
      },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 500)}`);
    return JSON.parse(text);
  }
  remember(user, assistant) {
    this.messages.push({ role: "user", content: user });
    this.messages.push({ role: "assistant", content: assistant });
    if (this.messages.length > 40) this.messages = this.messages.slice(-40);
  }
  toolSchemas() {
    return [
      { type: "function", function: { name: "vault_search", description: "Search markdown files in the Obsidian vault.", parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] } } },
      { type: "function", function: { name: "vault_read", description: "Read a file from the Obsidian vault.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
      { type: "function", function: { name: "vault_write", description: "Overwrite/create a file in the Obsidian vault.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
      { type: "function", function: { name: "vault_append", description: "Append content to a vault file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
      { type: "function", function: { name: "vault_insert", description: "Insert content before/after a marker in a vault file.", parameters: { type: "object", properties: { path: { type: "string" }, marker: { type: "string" }, content: { type: "string" }, position: { type: "string", enum: ["before", "after"] } }, required: ["path", "marker", "content"] } } },
      { type: "function", function: { name: "vault_list", description: "List files under a vault folder.", parameters: { type: "object", properties: { folder: { type: "string" }, limit: { type: "number" } } } } }
    ];
  }
  async executeTool(name, args) {
    try {
      if (name === "vault_search") return await this.toolSearch(String(args.query ?? ""), Number(args.limit ?? 20));
      if (name === "vault_read") return await this.toolRead(String(args.path ?? ""));
      if (name === "vault_write") {
        await this.toolWrite(String(args.path ?? ""), String(args.content ?? ""));
        return `Wrote ${args.path}`;
      }
      if (name === "vault_append") {
        await this.toolAppend(String(args.path ?? ""), String(args.content ?? ""));
        return `Appended to ${args.path}`;
      }
      if (name === "vault_insert") {
        await this.toolInsert(String(args.path ?? ""), String(args.marker ?? ""), String(args.content ?? ""), String(args.position ?? "after"));
        return `Inserted into ${args.path}`;
      }
      if (name === "vault_list") return await this.toolList(String(args.folder ?? ""), Number(args.limit ?? 100));
      return `Unknown tool: ${name}`;
    } catch (e) {
      return `Tool error (${name}): ${e.message}`;
    }
  }
  normalizePath(path) {
    return path.replace(/^\/+/, "").trim();
  }
  async toolRead(path) {
    const p = this.normalizePath(path);
    if (!p) throw new Error("Missing path");
    return await this.app.vault.adapter.read(p);
  }
  async toolWrite(path, content) {
    const p = this.normalizePath(path);
    if (!p) throw new Error("Missing path");
    await this.ensureParentFolder(p);
    await this.app.vault.adapter.write(p, content);
  }
  async toolAppend(path, content) {
    const p = this.normalizePath(path);
    if (!p) throw new Error("Missing path");
    let old = "";
    if (await this.app.vault.adapter.exists(p)) old = await this.app.vault.adapter.read(p);
    await this.toolWrite(p, old + (old.endsWith("\n") || old.length === 0 ? "" : "\n") + content);
  }
  async toolInsert(path, marker, content, position = "after") {
    const p = this.normalizePath(path);
    const old = await this.toolRead(p);
    const idx = old.indexOf(marker);
    if (idx < 0) throw new Error(`Marker not found: ${marker}`);
    const insertAt = position === "before" ? idx : idx + marker.length;
    await this.toolWrite(p, old.slice(0, insertAt) + content + old.slice(insertAt));
  }
  async toolSearch(query, limit = 20) {
    const q = query.toLowerCase();
    if (!q) throw new Error("Missing query");
    const files = this.app.vault.getMarkdownFiles();
    const hits = [];
    for (const file of files) {
      if (hits.length >= limit) break;
      const text = await this.app.vault.cachedRead(file);
      const lower = text.toLowerCase();
      const idx = lower.indexOf(q);
      if (idx >= 0 || file.path.toLowerCase().includes(q)) {
        const start = Math.max(0, idx - 80);
        const end = idx >= 0 ? Math.min(text.length, idx + q.length + 160) : 160;
        const snippet = idx >= 0 ? text.slice(start, end).replace(/\s+/g, " ") : "(path match)";
        hits.push(`- ${file.path}: ${snippet}`);
      }
    }
    return hits.length ? hits.join("\n") : "No matches.";
  }
  async toolList(folder = "", limit = 100) {
    const prefix = this.normalizePath(folder);
    const files = this.app.vault.getFiles().filter((f) => !prefix || f.path.startsWith(prefix));
    return files.slice(0, limit).map((f) => `- ${f.path}`).join("\n") || "No files.";
  }
  async ensureParentFolder(path) {
    const parts = path.split("/");
    parts.pop();
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!await this.app.vault.adapter.exists(cur)) await this.app.vault.adapter.mkdir(cur);
    }
  }
  setupMobileViewport(container) {
    const apply = () => {
      const vv = window.visualViewport;
      if (vv) {
        container.style.height = Math.max(260, vv.height - container.getBoundingClientRect().top - 4) + "px";
      } else {
        container.style.height = "100%";
      }
    };
    this.viewportResizeHandler = apply;
    window.visualViewport?.addEventListener("resize", apply);
    window.visualViewport?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    setTimeout(apply, 50);
  }
  async ensureMemoryScaffold() {
    const dirs = ["raw", "sources", "memory", "memory/inbox", "memory/feedback", "people", "projects", "wiki", "decisions", "daily", "palace"];
    for (const d of dirs) if (!await this.app.vault.adapter.exists(d)) await this.app.vault.adapter.mkdir(d);
    const defaults = {
      "profile.md": "# Profile\n\n\u7528\u6237\u753B\u50CF\uFF0C\u5F85\u6C89\u6DC0\u3002\n",
      "vault.md": "# Vault\n\n\u8FD9\u4E2A\u77E5\u8BC6\u5E93\u7684\u7528\u9014\u3001\u7ED3\u6784\u548C\u957F\u671F\u76EE\u6807\u3002\n",
      "style.md": "# Style\n\n\u8F93\u51FA\u98CE\u683C\u504F\u597D\u3002\n",
      "memory_policy.md": "# Memory Policy\n\n\u957F\u671F\u8BB0\u5FC6\u5199\u5165 people/projects/wiki/decisions/daily \u524D\u9700\u8981\u4EBA\u5DE5\u786E\u8BA4\u3002\n",
      "palace/digest_note_room.md": "# digest_note_room\n\n\u89E6\u53D1\uFF1A\u6D88\u5316\u5F53\u524D\u7B14\u8BB0\u6216\u9009\u533A\u3002\n\u5FC5\u8BFB\uFF1Aprofile.md \u2192 vault.md \u2192 style.md \u2192 memory_policy.md \u2192 \u5F53\u524D\u7B14\u8BB0\u3002\n\u8F93\u51FA\uFF1Amemory/inbox/YYYY-MM-DD.md\u3002\n\u9650\u5236\uFF1A\u4E0D\u76F4\u63A5\u5199\u5165\u957F\u671F\u8BB0\u5FC6\u3002\n"
    };
    for (const [path, content] of Object.entries(defaults)) {
      if (!await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.write(path, content);
    }
  }
  async loadPalaceContext(message) {
    const candidates = ["profile.md", "vault.md", "style.md", "memory_policy.md"];
    if (/digest|消化|整理|总结/.test(message)) candidates.push("palace/digest_note_room.md");
    const chunks = [];
    for (const p of candidates) {
      if (await this.app.vault.adapter.exists(p)) {
        const text = await this.app.vault.adapter.read(p);
        chunks.push(`Context file: ${p}
${text.slice(0, 6e3)}`);
      }
    }
    return chunks.length ? `Memory Palace Context:

${chunks.join("\n\n")}` : "";
  }
  async resolveMessageReferences(message) {
    const refs = /* @__PURE__ */ new Set();
    for (const m of message.matchAll(/@([^\s]+\.md)/g)) refs.add(m[1]);
    for (const m of message.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = m[1].split("|")[0].trim();
      const found = this.app.metadataCache.getFirstLinkpathDest(target, "");
      if (found) refs.add(found.path);
      else if (target.endsWith(".md")) refs.add(target);
    }
    for (const r of this.attachedRefs) refs.add(r);
    const chunks = [];
    for (const ref of refs) {
      try {
        if (await this.app.vault.adapter.exists(ref)) chunks.push(`Referenced note: ${ref}
${(await this.app.vault.adapter.read(ref)).slice(0, 12e3)}`);
      } catch {
      }
    }
    return chunks.length ? `Explicit References:

${chunks.join("\n\n")}` : "";
  }
  getActiveMarkdownContext() {
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    const file = view?.file;
    if (!view || !file) return null;
    let selection = "";
    try {
      selection = view.editor.getSelection();
    } catch {
    }
    let text = "";
    try {
      text = view.editor.getValue();
    } catch {
    }
    return { path: file.path, text, selection };
  }
  async skillCompact() {
    if (!this.settings.apiKey) {
      this.messages = this.messages.slice(-8);
      this.println("Context compacted locally: kept last 8 messages.", "nc-output");
      return;
    }
    const text = this.messages.map((m) => `${m.role}: ${m.content}`).join("\n").slice(-24e3);
    const summary = await this.callLLM(`\u8BF7\u538B\u7F29\u4E0B\u9762\u4F1A\u8BDD\u4E0A\u4E0B\u6587\uFF0C\u4FDD\u7559\u7528\u6237\u504F\u597D\u3001\u5F85\u529E\u3001\u91CD\u8981\u4E8B\u5B9E\u548C\u672A\u5B8C\u6210\u4EFB\u52A1\uFF1A

${text}`);
    if (summary) {
      this.messages = [{ role: "system", content: `Compressed context:
${summary}` }];
      this.println("Context compacted.\n" + summary, "nc-output");
    }
  }
  async skillDigestCurrent() {
    await this.ensureMemoryScaffold();
    const ctx = this.getActiveMarkdownContext();
    if (!ctx) return this.println("No active markdown note.", "nc-error");
    const target = ctx.selection || ctx.text;
    const prompt = `\u6D88\u5316\u5F53\u524D Obsidian \u7B14\u8BB0\uFF0C\u8F93\u51FA\u56DB\u90E8\u5206\uFF1A
1. \u8981\u70B9
2. \u5173\u8054\u4EBA\u7269/\u9879\u76EE/\u6982\u5FF5
3. \u53EF\u6C89\u6DC0\u957F\u671F\u8BB0\u5FC6\u5019\u9009\uFF08\u6807\u6CE8 people/projects/wiki/decisions/daily\uFF09
4. \u5F85\u529E

\u6765\u6E90\uFF1A${ctx.path}

\u5185\u5BB9\uFF1A
${target.slice(0, 24e3)}`;
    const result = this.settings.apiKey ? await this.callLLM(prompt) : `# Digest: ${ctx.path}

${target.slice(0, 4e3)}`;
    if (!result) return;
    const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const out = `memory/inbox/${today}.md`;
    await this.toolAppend(out, `
## ${(/* @__PURE__ */ new Date()).toLocaleString()} \u2014 ${ctx.path}

${result}
`);
    this.println(`Digest written to ${out}

${result}`, "nc-output");
  }
  async skillReviewInbox() {
    await this.ensureMemoryScaffold();
    const inbox = await this.collectFolderText("memory/inbox");
    if (!inbox) return this.println("memory/inbox is empty.", "nc-info");
    const prompt = `\u5BA1\u6838 memory/inbox \u5F85\u6C89\u6DC0\u5185\u5BB9\uFF0C\u53BB\u91CD\u5F52\u7EB3\u4E3A\u53EF\u4EBA\u5DE5\u786E\u8BA4\u6E05\u5355\u3002\u6BCF\u6761\u6807\u6CE8\u5EFA\u8BAE\u5F52\u5C5E people/projects/wiki/decisions/daily\u3001\u7F6E\u4FE1\u5EA6\u3001\u6765\u6E90\u3002

${inbox.slice(0, 3e4)}`;
    const result = this.settings.apiKey ? await this.callLLM(prompt) : inbox;
    if (!result) return;
    const out = `memory/inbox/review-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.md`;
    await this.toolWrite(out, result);
    this.println(`Review written to ${out}

${result}`, "nc-output");
  }
  async skillApplyMemory(yes) {
    await this.ensureMemoryScaffold();
    const inbox = await this.collectFolderText("memory/inbox");
    if (!inbox) return this.println("memory/inbox is empty.", "nc-info");
    const prompt = `\u57FA\u4E8E\u4E0B\u9762 inbox\uFF0C\u751F\u6210\u957F\u671F\u8BB0\u5FC6\u5408\u5E76\u65B9\u6848\u3002\u4E0D\u8981\u76F4\u63A5\u5199\u5165\uFF0C\u8F93\u51FA\u8981\u5199\u5165\u54EA\u4E9B\u6587\u4EF6\u548C\u5177\u4F53\u5185\u5BB9\u3002\u76EE\u6807\u76EE\u5F55\uFF1Apeople/projects/wiki/decisions/daily/profile.md/style.md\u3002

${inbox.slice(0, 3e4)}`;
    const plan = this.settings.apiKey ? await this.callLLM(prompt) : inbox;
    if (!plan) return;
    const out = `memory/apply-plan-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.md`;
    await this.toolWrite(out, plan);
    this.println(`Apply plan written to ${out}. Review manually before applying.

${plan}`, "nc-output");
  }
  async skillVaultDoctor() {
    await this.ensureMemoryScaffold();
    const files = this.app.vault.getFiles();
    const markdown = this.app.vault.getMarkdownFiles();
    const rawFiles = files.filter((f) => f.path.startsWith("raw/"));
    const emptyMd = [];
    for (const f of markdown.slice(0, 500)) {
      try {
        if ((await this.app.vault.cachedRead(f)).trim().length < 20) emptyMd.push(f.path);
      } catch {
      }
    }
    const report = `# Vault Doctor

- total files: ${files.length}
- markdown files: ${markdown.length}
- raw files: ${rawFiles.length}
- empty/near-empty notes: ${emptyMd.length}

## Empty notes
${emptyMd.slice(0, 50).map((p) => `- ${p}`).join("\n") || "None"}

## Raw files
${rawFiles.slice(0, 80).map((f) => `- ${f.path}`).join("\n") || "None"}
`;
    const out = `memory/vault-doctor-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.md`;
    await this.toolWrite(out, report);
    this.println(`Vault doctor report written to ${out}

${report}`, "nc-output");
  }
  async writeFeedback(kind, text) {
    await this.ensureMemoryScaffold();
    const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    await this.toolAppend(`memory/feedback/${today}.md`, `- ${(/* @__PURE__ */ new Date()).toLocaleString()} [${kind}]: ${text}`);
  }
  async collectFolderText(folder) {
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(folder + "/"));
    const chunks = [];
    for (const f of files.slice(0, 100)) {
      try {
        chunks.push(`## ${f.path}
${(await this.app.vault.cachedRead(f)).slice(0, 12e3)}`);
      } catch {
      }
    }
    return chunks.join("\n\n");
  }
  setupFileDropAndPaste(container) {
    const saveFiles = async (files) => {
      await this.ensureMemoryScaffold();
      for (const file of Array.from(files)) {
        const safe = file.name.replace(/[\\/:*?"<>|]/g, "_");
        let path = `raw/${safe}`;
        let i = 1;
        while (await this.app.vault.adapter.exists(path)) {
          const dot = safe.lastIndexOf(".");
          path = dot > 0 ? `raw/${safe.slice(0, dot)}-${i}${safe.slice(dot)}` : `raw/${safe}-${i}`;
          i++;
        }
        const buf = await file.arrayBuffer();
        await this.app.vault.adapter.writeBinary(path, buf);
        this.attachedRefs.push(path);
        this.inputEl.value = (this.inputEl.value + ` @${path}`).trim();
        this.println(`Saved attachment to ${path}`, "nc-info");
      }
    };
    container.addEventListener("dragover", (e) => {
      e.preventDefault();
    });
    container.addEventListener("drop", async (e) => {
      e.preventDefault();
      if (e.dataTransfer?.files?.length) await saveFiles(e.dataTransfer.files);
    });
    this.inputEl.addEventListener("paste", async (e) => {
      if (e.clipboardData?.files?.length) await saveFiles(e.clipboardData.files);
    });
  }
  parseArgs(input) {
    const args = [];
    let cur = "";
    let inQ = false;
    for (const ch of input) {
      if (ch === '"') inQ = !inQ;
      else if (ch === " " && !inQ) {
        if (cur) {
          args.push(cur);
          cur = "";
        }
      } else cur += ch;
    }
    if (cur) args.push(cur);
    return args;
  }
  println(text, cls) {
    const line = this.outputEl.createDiv({ cls: `nc-line ${cls}` });
    line.textContent = text;
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }
  async onClose() {
    if (this.viewportResizeHandler) {
      window.visualViewport?.removeEventListener("resize", this.viewportResizeHandler);
      window.visualViewport?.removeEventListener("scroll", this.viewportResizeHandler);
      window.removeEventListener("resize", this.viewportResizeHandler);
    }
  }
};
var NullClawSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "NullClaw LLM Configuration" });
    containerEl.createEl("p", { text: "Configure your LLM provider to enable AI responses. Uses OpenAI-compatible chat completions API." });
    new import_obsidian.Setting(containerEl).setName("API Key").setDesc("Your API key (e.g. sk-... for OpenAI, or your provider key)").addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder("sk-...").setValue(this.plugin.settings.apiKey).onChange(async (value) => {
        this.plugin.settings.apiKey = value;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian.Setting(containerEl).setName("API Base URL").setDesc("OpenAI-compatible endpoint (default: OpenAI)").addText((text) => {
      text.setPlaceholder("https://api.openai.com/v1").setValue(this.plugin.settings.apiBase).onChange(async (value) => {
        this.plugin.settings.apiBase = value;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian.Setting(containerEl).setName("Model").setDesc("Model name (default: gpt-4o-mini)").addText((text) => {
      text.setPlaceholder("gpt-4o-mini").setValue(this.plugin.settings.model).onChange(async (value) => {
        this.plugin.settings.model = value;
        await this.plugin.saveSettings();
      });
    });
    containerEl.createEl("h3", { text: "Supported providers" });
    const providers = [
      ["OpenAI", "https://api.openai.com/v1", "gpt-4o-mini"],
      ["OpenRouter", "https://openrouter.ai/api/v1", "anthropic/claude-sonnet-4-20250514"],
      ["Groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"],
      ["DeepSeek", "https://api.deepseek.com/v1", "deepseek-chat"],
      ["Ollama (local)", "http://localhost:11434/v1", "llama3.2"]
    ];
    for (const [name, base, model] of providers) {
      containerEl.createEl("p", { text: `${name}: ${base} / ${model}` });
    }
  }
};
var NullClawPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.view = null;
  }
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => {
      this.view = new NullclawView(leaf, this.settings);
      return this.view;
    });
    this.addRibbonIcon("bot", "NullClaw", () => this.openView());
    this.addCommand({ id: "open-nullclaw", name: "Open NullClaw Agent", callback: () => this.openView() });
    this.addSettingTab(new NullClawSettingTab(this.app, this));
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  async openView() {
    const ws = this.app.workspace;
    const existing = ws.getLeavesOfType(VIEW_TYPE);
    const leaf = existing.length > 0 ? existing[0] : ws.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    ws.revealLeaf(leaf);
  }
};
