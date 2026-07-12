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
    this.sessionId = "current";
    this.sessionSummary = "";
    this.mentionItems = [];
    this.mentionIndex = 0;
    this.mentionStart = -1;
    this.skillItems = [];
    this.skillIndex = 0;
    this.selectedSkill = null;
    this.customSkills = [];
    this.customSkillSources = /* @__PURE__ */ new Map();
    this.responseWasStreamed = false;
    this.compatibilityNoticeShown = false;
    this.mobileClosedComposerGap = 0;
    this.mobileBottomChromeHeight = 0;
    this.imeFocusShift = 0;
    this.closedVisualHeight = 0;
    this.attachedRefs = [];
    this.attachedSelection = "";
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
    this.sessionEl = this.outputEl.createDiv({ cls: "nc-session-panel" });
    this.sessionEl.hidden = true;
    const inputWrap = c.createDiv({ cls: "nullclaw-input-wrap" });
    this.refsEl = inputWrap.createDiv({ cls: "nullclaw-refs" });
    this.refsEl.hidden = true;
    this.mentionEl = inputWrap.createDiv({ cls: "nullclaw-mention-menu" });
    this.mentionEl.hidden = true;
    this.skillEl = inputWrap.createDiv({ cls: "nullclaw-skill-menu" });
    this.skillEl.hidden = true;
    const row = inputWrap.createDiv({ cls: "nullclaw-input-row" });
    row.createSpan({ cls: "nullclaw-input-prompt", text: "\u276F" });
    this.inputEl = row.createEl("input", { cls: "nullclaw-input", attr: { type: "text", placeholder: "\u76F4\u63A5\u8F93\u5165\u53D1\u7ED9 AI\uFF1B\u547D\u4EE4\u7528 /help /version /memory list ..." } });
    const st = c.createDiv({ cls: "nullclaw-status" });
    this.statusDot = st.createSpan({ cls: "nc-dot nc-dot-error" });
    this.statusText = st.createSpan({ text: "Loading nullclaw.wasm..." });
    const sessionsButton = st.createEl("button", { cls: "nc-session-button", text: "Sessions" });
    sessionsButton.addEventListener("click", () => void this.toggleSessionPanel());
    await this.loadWasm();
    await this.restoreSession();
    await this.loadCustomSkills();
    this.inputEl.addEventListener("input", () => {
      this.updateMentionMenu();
      this.updateSkillMenu();
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (!this.skillEl.hidden) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this.moveSkill(1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          this.moveSkill(-1);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          this.closeSkillMenu();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          this.chooseSkill(this.skillIndex);
          return;
        }
      }
      if (!this.mentionEl.hidden) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this.moveMention(1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          this.moveMention(-1);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          this.closeMentionMenu();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          this.chooseMention(this.mentionIndex);
          return;
        }
      }
      if (e.key === "Backspace" && !this.inputEl.value && this.selectedSkill) {
        e.preventDefault();
        this.selectedSkill = null;
        this.renderRefs();
        return;
      }
      if (e.key === "Enter" && !this.running) this.exec(this.inputEl.value);
    });
    this.setupMobileViewport(c);
    this.setupFileDropAndPaste(c);
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
    let raw = input.trim();
    if (this.selectedSkill) raw = `${this.selectedSkill.command}${raw ? " " + raw : ""}`;
    if (!raw || !this.wasmBytes) return;
    this.running = true;
    this.statusDot.className = "nc-dot nc-dot-running";
    this.statusText.textContent = "Running...";
    this.renderMessageCard("user", raw, true);
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
      this.selectedSkill = null;
      this.renderRefs();
      await this.saveSession();
    }
  }
  async execSlashCommand(command) {
    if (!command) {
      this.println("Slash commands: /help /version /status /compact /digest-current /review-inbox /apply-memory /vault-doctor /feedback good|bad <text> /current /selection /read /write /append /insert /search /glob /move /delete /frontmatter /links /link /list /clear", "nc-info");
      return;
    }
    const args = this.parseArgs(command);
    const cmd = args[0];
    if (cmd === "skill-run") {
      if (!args[1]) return this.println("Usage: /skill-run <id> [input]", "nc-error");
      await this.executeCustomSkill(args[1], args.slice(2).join(" "));
      return;
    }
    if (cmd === "skills-reload") {
      await this.loadCustomSkills();
      this.println(`Loaded ${this.customSkills.length} custom skills.`, "nc-info");
      return;
    }
    if (cmd === "sessions") {
      await this.toggleSessionPanel(true);
      return;
    }
    if (cmd === "session-new") {
      await this.newSession(args.slice(1).join(" ") || void 0);
      return;
    }
    if (cmd === "session-switch") {
      if (!args[1]) return this.println("Usage: /session-switch <id>", "nc-error");
      await this.switchSession(args[1]);
      return;
    }
    if (cmd === "session-delete") {
      if (!args[1]) return this.println("Usage: /session-delete <id>", "nc-error");
      await this.deleteSession(args[1]);
      return;
    }
    if (cmd === "clear") {
      this.messages = [];
      this.sessionSummary = "";
      this.attachedRefs = [];
      this.attachedSelection = "";
      this.outputEl.empty();
      this.renderRefs();
      await this.saveSession();
      this.println("New empty session started.", "nc-info");
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
    if (cmd === "update-profile") {
      await this.skillUpdateProfile();
      return;
    }
    if (cmd === "create-skill") {
      await this.skillCreateSkill(args.slice(1).join(" "));
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
    if (cmd === "current") {
      const ctx = this.getActiveMarkdownContext();
      if (!ctx) return this.println("No active markdown note.", "nc-error");
      if (!this.attachedRefs.includes(ctx.path)) this.attachedRefs.push(ctx.path);
      this.renderRefs();
      await this.saveSession();
      this.println(`Attached current note: ${ctx.path}`, "nc-info");
      return;
    }
    if (cmd === "selection") {
      const ctx = this.getActiveMarkdownContext();
      if (!ctx?.selection) return this.println("No active selection.", "nc-error");
      this.attachedSelection = ctx.selection.slice(0, 16e3);
      this.println(`Attached current selection (${this.attachedSelection.length} chars).`, "nc-info");
      return;
    }
    if (cmd === "read") {
      if (!args[1]) return this.println("Usage: /read <path>", "nc-error");
      this.println(await this.toolRead(args[1]), "nc-output");
      return;
    }
    if (cmd === "write") {
      if (!args[1] || args.length < 3) return this.println("Usage: /write <path> <content>", "nc-error");
      const content = args.slice(2).join(" ");
      if (await this.confirmMutation("Write", args[1], content)) {
        await this.toolWrite(args[1], content);
        this.println(`Wrote ${args[1]}`, "nc-output");
      }
      return;
    }
    if (cmd === "append") {
      if (!args[1] || args.length < 3) return this.println("Usage: /append <path> <content>", "nc-error");
      const content = args.slice(2).join(" ");
      if (await this.confirmMutation("Append", args[1], content)) {
        await this.toolAppend(args[1], content);
        this.println(`Appended to ${args[1]}`, "nc-output");
      }
      return;
    }
    if (cmd === "insert") {
      if (!args[1] || !args[2] || args.length < 4) return this.println("Usage: /insert <path> <marker> <content>", "nc-error");
      const content = args.slice(3).join(" ");
      if (await this.confirmMutation("Insert", args[1], content, args[2])) {
        await this.toolInsert(args[1], args[2], content);
        this.println(`Inserted into ${args[1]}`, "nc-output");
      }
      return;
    }
    if (cmd === "retrieve") {
      if (args.length < 2) return this.println("Usage: /retrieve <query>", "nc-error");
      this.println(await this.toolRetrieve(args.slice(1).join(" ")), "nc-output");
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
    if (cmd === "glob") {
      if (!args[1]) return this.println("Usage: /glob <pattern>", "nc-error");
      this.println(this.toolGlob(args[1]), "nc-output");
      return;
    }
    if (cmd === "move" || cmd === "rename") {
      if (!args[1] || !args[2]) return this.println("Usage: /move <from> <to>", "nc-error");
      if (await this.confirmOperation("Move", `${args[1]} \u2192 ${args[2]}`, "Move/rename this path?")) {
        await this.toolMove(args[1], args[2]);
        this.println("Moved.", "nc-output");
      }
      return;
    }
    if (cmd === "delete") {
      if (!args[1]) return this.println("Usage: /delete <path>", "nc-error");
      if (await this.confirmOperation("Delete", args[1], "Permanently delete this file?")) {
        await this.toolDelete(args[1]);
        this.println("Deleted.", "nc-output");
      }
      return;
    }
    if (cmd === "frontmatter") {
      if (!args[1]) return this.println("Usage: /frontmatter <path> [key value]", "nc-error");
      if (!args[2]) this.println(JSON.stringify(await this.toolFrontmatterRead(args[1]), null, 2), "nc-output");
      else if (await this.confirmOperation("Frontmatter", args[1], `Set ${args[2]} = ${args.slice(3).join(" ")}`)) {
        await this.toolFrontmatterSet(args[1], args[2], args.slice(3).join(" "));
        this.println("Frontmatter updated.", "nc-output");
      }
      return;
    }
    if (cmd === "links") {
      if (!args[1]) return this.println("Usage: /links <path>", "nc-error");
      this.println(await this.toolLinks(args[1]), "nc-output");
      return;
    }
    if (cmd === "link") {
      if (!args[1] || !args[2]) return this.println("Usage: /link <path> <target> [alias]", "nc-error");
      const link = `[[${args[2]}${args[3] ? "|" + args[3] : ""}]]`;
      if (await this.confirmMutation("Append", args[1], link)) {
        await this.toolAppend(args[1], link);
        this.println(`Added ${link}`, "nc-output");
      }
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
    if (result.stdout) await this.streamPrint(result.stdout, "nc-output", true);
    if (result.stderr) await this.streamPrint(result.stderr, "nc-error", true);
    if (!result.stdout && !result.stderr) this.println(`(exit: ${result.exitCode})`, "nc-info");
  }
  async execChatMessage(message) {
    if (this.settings.apiKey) {
      const reply = await this.callLLM(message);
      if (reply) {
        if (!this.responseWasStreamed) this.renderMessageCard("assistant", reply, true);
        return;
      }
      this.println("[LLM call failed, falling back to local mode]", "nc-info");
    }
    const result = await runNullclaw(
      this.wasmBytes,
      ["agent", "-m", message],
      { ...this.settings, apiKey: "" },
      () => {
      }
    );
    if (result.stdout) {
      const reply = result.stdout.trim();
      this.renderMessageCard("assistant", reply, true);
      this.remember(message, reply);
    }
    if (result.stderr) this.println(result.stderr, "nc-error");
    if (!result.stdout && !result.stderr) this.println(`(exit: ${result.exitCode})`, "nc-info");
  }
  async callLLM(message) {
    this.responseWasStreamed = false;
    this.compatibilityNoticeShown = false;
    const base = (this.settings.apiBase || "https://api.openai.com/v1").replace(/\/$/, "");
    const system = {
      role: "system",
      content: "You are NullClaw, an AI assistant embedded in Obsidian Android. Maintain context across turns. You can use tools to read, write, append, insert, list and search the current Obsidian vault. Use tools when the user asks about notes/files or wants modifications. Continue calling tools until the task is actually complete, then provide a clear final response. Be concise and answer in the user language."
    };
    await this.ensureMemoryScaffold();
    const palaceContext = await this.loadPalaceContext(message);
    const refContext = await this.resolveMessageReferences(message);
    const retrievalContext = !this.attachedRefs.length && !this.attachedSelection ? await this.retrieveContext(message, 6) : "";
    const enriched = [this.sessionSummary ? `Compressed session context:
${this.sessionSummary}` : "", palaceContext, refContext, retrievalContext, `User message:
${message}`].filter(Boolean).join("\n\n---\n\n");
    const history = this.messages.slice(-20);
    const conversation = [system, ...history, { role: "user", content: enriched }];
    const tools = this.toolSchemas();
    try {
      for (let round = 0; round < 8; round++) {
        const response = await this.chatCompletionStreaming(base, conversation, tools);
        const assistant = response.choices?.[0]?.message;
        if (!assistant) throw new Error("Provider returned no assistant message.");
        conversation.push(assistant);
        const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
        if (!calls.length) {
          const text = assistant.content ?? response.choices?.[0]?.text ?? "";
          if (!text) throw new Error("Provider returned neither content nor tool calls.");
          this.remember(message, text);
          return text;
        }
        for (let i = 0; i < calls.length; i++) {
          const call = calls[i];
          const toolName = call.function?.name || "unknown_tool";
          const argsRaw = call.function?.arguments || "{}";
          let parsed = {};
          try {
            parsed = JSON.parse(argsRaw);
          } catch {
            parsed = { raw: argsRaw };
          }
          const result = await this.executeTool(toolName, parsed);
          conversation.push({
            role: "tool",
            tool_call_id: call.id || `tool-${round}-${i}`,
            name: toolName,
            content: result
          });
        }
      }
      throw new Error("Agent stopped after 8 tool rounds without a final response.");
    } catch (e) {
      this.println(`[LLM agent failed] ${e.message}`, "nc-error");
      return null;
    }
  }
  async chatCompletionStreaming(base, messages, tools) {
    const body = {
      model: this.settings.model || "gpt-4o-mini",
      messages,
      max_tokens: 2048,
      temperature: 0.7,
      stream: true
    };
    if (tools.length) body.tools = tools;
    let card = null;
    let content = "";
    const toolCalls = [];
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.settings.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "app://obsidian-nullclaw",
          "X-Title": "NullClaw Obsidian"
        },
        body: JSON.stringify(body)
      });
      if (!response.ok || !response.body) throw new Error(`stream HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let event;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = event.choices?.[0]?.delta ?? {};
          if (delta.content) {
            content += delta.content;
            if (!card) card = this.createStreamingCard();
            card.body.textContent = content;
            if (this.isNearBottom(160)) this.stickToBottom();
          }
          for (const tc of delta.tool_calls ?? []) {
            const i = tc.index ?? 0;
            toolCalls[i] ?? (toolCalls[i] = { id: "", type: "function", function: { name: "", arguments: "" } });
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
          }
        }
      }
      if (card) {
        card.details.open = true;
        card.body.classList.add("nc-stream-complete");
        this.responseWasStreamed = true;
      }
      return { choices: [{ message: { role: "assistant", content, tool_calls: toolCalls.length ? toolCalls : void 0 } }] };
    } catch (error) {
      if (card) card.details.remove();
      this.responseWasStreamed = false;
      if (!this.compatibilityNoticeShown) {
        this.compatibilityNoticeShown = true;
        this.println("Using mobile compatibility mode.", "nc-info");
      }
      return await this.chatCompletion(base, messages, tools);
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
    const resp = await (0, import_obsidian.requestUrl)({
      url: `${base}/chat/completions`,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.settings.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "app://obsidian-nullclaw",
        "X-Title": "NullClaw Obsidian"
      },
      body: JSON.stringify(body),
      throw: false
    });
    const status = resp.status;
    const text = resp.text ?? "";
    if (status < 200 || status >= 300) throw new Error(`${status} ${text.slice(0, 800)}`);
    return resp.json ?? JSON.parse(text);
  }
  remember(user, assistant) {
    this.messages.push({ role: "user", content: user });
    this.messages.push({ role: "assistant", content: assistant });
    if (this.messages.length > 40) this.messages = this.messages.slice(-40);
    void this.saveSession();
  }
  toolSchemas() {
    const f = (name, description, properties, required = []) => ({
      type: "function",
      function: { name, description, parameters: { type: "object", properties, ...required.length ? { required } : {} } }
    });
    return [
      f("vault_current_context", "Read current Obsidian note and selection.", {}),
      f("vault_retrieve", "Rank relevant notes using local title/path/content/recency scoring.", { query: { type: "string" }, limit: { type: "number" } }, ["query"]),
      f("vault_search", "Search markdown content and paths.", { query: { type: "string" }, limit: { type: "number" } }, ["query"]),
      f("vault_glob", "List paths matching a simple glob pattern.", { pattern: { type: "string" }, limit: { type: "number" } }, ["pattern"]),
      f("vault_read", "Read a vault file.", { path: { type: "string" } }, ["path"]),
      f("vault_list", "List files below a folder.", { folder: { type: "string" }, limit: { type: "number" } }),
      f("vault_write", "Create or overwrite a file. Requires confirmation.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
      f("vault_append", "Append file content. Requires confirmation.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
      f("vault_insert", "Insert around a marker. Requires confirmation.", { path: { type: "string" }, marker: { type: "string" }, content: { type: "string" }, position: { type: "string", enum: ["before", "after"] } }, ["path", "marker", "content"]),
      f("vault_move", "Move or rename a path. Requires confirmation.", { from: { type: "string" }, to: { type: "string" } }, ["from", "to"]),
      f("vault_delete", "Delete a file. Requires confirmation.", { path: { type: "string" } }, ["path"]),
      f("vault_frontmatter_read", "Read YAML frontmatter fields.", { path: { type: "string" } }, ["path"]),
      f("vault_frontmatter_set", "Set a frontmatter field. Requires confirmation.", { path: { type: "string" }, key: { type: "string" }, value: {} }, ["path", "key"]),
      f("vault_links", "Read outgoing and incoming links for a note.", { path: { type: "string" } }, ["path"]),
      f("vault_create_link", "Append a wikilink to a note. Requires confirmation.", { path: { type: "string" }, target: { type: "string" }, alias: { type: "string" } }, ["path", "target"]),
      f("editor_insert", "Insert content at current editor cursor. Requires confirmation.", { content: { type: "string" } }, ["content"]),
      f("editor_replace_selection", "Replace current editor selection. Requires confirmation.", { content: { type: "string" } }, ["content"])
    ];
  }
  async executeTool(name, args) {
    const block = this.createToolBlock(name, args);
    try {
      let result = "";
      if (name === "vault_current_context") {
        const ctx = this.getActiveMarkdownContext();
        result = ctx ? `Path: ${ctx.path}
Selection:
${ctx.selection}

Note:
${ctx.text.slice(0, 24e3)}` : "No active markdown note.";
      } else if (name === "vault_retrieve") result = await this.toolRetrieve(String(args.query ?? ""), Number(args.limit ?? 8));
      else if (name === "vault_search") result = await this.toolSearch(String(args.query ?? ""), Number(args.limit ?? 20));
      else if (name === "vault_read") result = await this.toolRead(String(args.path ?? ""));
      else if (name === "vault_list") result = await this.toolList(String(args.folder ?? ""), Number(args.limit ?? 100));
      else if (name === "vault_write") {
        const path = String(args.path ?? "");
        const content = String(args.content ?? "");
        if (!await this.confirmMutation("Write", path, content)) result = "User cancelled write.";
        else {
          await this.toolWrite(path, content);
          result = `Wrote ${path}`;
        }
      } else if (name === "vault_append") {
        const path = String(args.path ?? "");
        const content = String(args.content ?? "");
        if (!await this.confirmMutation("Append", path, content)) result = "User cancelled append.";
        else {
          await this.toolAppend(path, content);
          result = `Appended to ${path}`;
        }
      } else if (name === "vault_insert") {
        const path = String(args.path ?? "");
        const content = String(args.content ?? "");
        const marker = String(args.marker ?? "");
        if (!await this.confirmMutation("Insert", path, content, marker)) result = "User cancelled insert.";
        else {
          await this.toolInsert(path, marker, content, String(args.position ?? "after"));
          result = `Inserted into ${path}`;
        }
      } else if (name === "vault_glob") result = this.toolGlob(String(args.pattern ?? "*"), Number(args.limit ?? 100));
      else if (name === "vault_move") {
        const from = String(args.from ?? "");
        const to = String(args.to ?? "");
        if (!await this.confirmOperation("Move", `${from} \u2192 ${to}`, "Move/rename this path?")) result = "User cancelled move.";
        else {
          await this.toolMove(from, to);
          result = `Moved ${from} to ${to}`;
        }
      } else if (name === "vault_delete") {
        const path = String(args.path ?? "");
        if (!await this.confirmOperation("Delete", path, "This file will be permanently deleted.")) result = "User cancelled delete.";
        else {
          await this.toolDelete(path);
          result = `Deleted ${path}`;
        }
      } else if (name === "vault_frontmatter_read") result = JSON.stringify(await this.toolFrontmatterRead(String(args.path ?? "")), null, 2);
      else if (name === "vault_frontmatter_set") {
        const path = String(args.path ?? "");
        if (!await this.confirmOperation("Frontmatter", path, `Set ${String(args.key)} = ${JSON.stringify(args.value)}`)) result = "User cancelled frontmatter edit.";
        else {
          await this.toolFrontmatterSet(path, String(args.key ?? ""), args.value);
          result = `Updated frontmatter in ${path}`;
        }
      } else if (name === "vault_links") result = await this.toolLinks(String(args.path ?? ""));
      else if (name === "vault_create_link") {
        const path = String(args.path ?? "");
        const target = String(args.target ?? "");
        const alias = String(args.alias ?? "");
        const link = `[[${target}${alias ? "|" + alias : ""}]]`;
        if (!await this.confirmMutation("Append", path, link)) result = "User cancelled link creation.";
        else {
          await this.toolAppend(path, link);
          result = `Added ${link} to ${path}`;
        }
      } else if (name === "editor_insert") {
        const content = String(args.content ?? "");
        if (!await this.confirmOperation("Editor insert", "Current cursor", content)) result = "User cancelled editor insert.";
        else {
          const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
          if (!view) throw new Error("No active editor");
          view.editor.replaceSelection(content);
          result = "Inserted at cursor.";
        }
      } else if (name === "editor_replace_selection") {
        const content = String(args.content ?? "");
        if (!await this.confirmOperation("Replace selection", "Current selection", content)) result = "User cancelled selection replacement.";
        else {
          const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
          if (!view) throw new Error("No active editor");
          view.editor.replaceSelection(content);
          result = "Replaced selection.";
        }
      } else result = `Unknown tool: ${name}`;
      block.result.textContent = result.slice(0, 12e3);
      block.details.classList.add("nc-tool-success");
      return result;
    } catch (e) {
      const result = `Tool error (${name}): ${e.message}`;
      block.result.textContent = result;
      block.details.classList.add("nc-tool-error");
      return result;
    }
  }
  toolGlob(pattern, limit = 100) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\xA7\xA7").replace(/\*/g, "[^/]*").replace(/\?/g, ".").replace(/§§/g, ".*");
    const rx = new RegExp(`^${escaped}$`, "i");
    const paths = this.app.vault.getFiles().map((f) => f.path).filter((p) => rx.test(p));
    return paths.slice(0, limit).map((p) => `- ${p}`).join("\n") || "No matches.";
  }
  async toolMove(from, to) {
    const a = this.normalizePath(from), b = this.normalizePath(to);
    if (!a || !b) throw new Error("Missing path");
    await this.ensureParentFolder(b);
    await this.app.vault.adapter.rename(a, b);
  }
  async toolDelete(path) {
    const p = this.normalizePath(path);
    if (!p || p.startsWith("raw/")) throw new Error("Deleting raw evidence is prohibited.");
    await this.app.vault.adapter.remove(p);
  }
  async toolFrontmatterRead(path) {
    const text = await this.toolRead(path);
    const match = text.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    const out = {};
    for (const line of match[1].split("\n")) {
      const i = line.indexOf(":");
      if (i < 1) continue;
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  }
  async toolFrontmatterSet(path, key, value) {
    if (!key) throw new Error("Missing frontmatter key");
    const text = await this.toolRead(path);
    const encoded = typeof value === "string" ? value : JSON.stringify(value);
    const match = text.match(/^---\n([\s\S]*?)\n---/);
    let next;
    if (!match) next = `---
${key}: ${encoded}
---
${text}`;
    else {
      const lines = match[1].split("\n");
      const i = lines.findIndex((x) => x.split(":")[0].trim() === key);
      if (i >= 0) lines[i] = `${key}: ${encoded}`;
      else lines.push(`${key}: ${encoded}`);
      next = `---
${lines.join("\n")}
---${text.slice(match[0].length)}`;
    }
    await this.toolWrite(path, next);
  }
  async toolLinks(path) {
    const p = this.normalizePath(path);
    const file = this.app.vault.getAbstractFileByPath(p);
    if (!file) throw new Error(`File not found: ${p}`);
    const cache = this.app.metadataCache.getFileCache(file);
    const outgoing = (cache?.links ?? []).map((l) => `- [[${l.link}]]`).join("\n") || "None";
    const incoming = [];
    for (const source of this.app.vault.getMarkdownFiles()) {
      const links = this.app.metadataCache.getFileCache(source)?.links ?? [];
      if (links.some((l) => this.app.metadataCache.getFirstLinkpathDest(l.link, source.path)?.path === p)) incoming.push(`- [[${source.path}]]`);
    }
    return `Outgoing:
${outgoing}

Incoming:
${incoming.join("\n") || "None"}`;
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
  queryTerms(query) {
    const terms = (query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || []).filter((x) => !["the", "and", "with", "this", "that", "\u4E00\u4E2A", "\u4EC0\u4E48", "\u600E\u4E48", "\u53EF\u4EE5", "\u5E2E\u6211"].includes(x));
    return [...new Set(terms)].slice(0, 16);
  }
  async retrieveNotes(query, limit = 8) {
    const terms = this.queryTerms(query);
    if (!terms.length) return [];
    const now = Date.now();
    const hits = [];
    for (const file of this.app.vault.getMarkdownFiles().slice(0, 1500)) {
      try {
        const path = file.path.toLowerCase(), name = file.basename.toLowerCase();
        const text = await this.app.vault.cachedRead(file);
        const lower = text.toLowerCase();
        let score = 0;
        let first = -1;
        for (const term of terms) {
          if (name === term) score += 24;
          else if (name.includes(term)) score += 12;
          if (path.includes(term)) score += 6;
          const at = lower.indexOf(term);
          if (at >= 0) {
            score += 4;
            if (first < 0) first = at;
            score += Math.min(5, lower.split(term).length - 1) * 1.5;
          }
        }
        const age = Math.max(0, (now - (file.stat?.mtime || 0)) / 864e5);
        score += Math.max(0, 4 - Math.log2(age + 1));
        if (score > 4) {
          const at = first >= 0 ? first : 0;
          hits.push({ path: file.path, score, snippet: text.slice(Math.max(0, at - 100), Math.min(text.length, at + 360)).replace(/\s+/g, " ") });
        }
      } catch {
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
  async toolRetrieve(query, limit = 8) {
    const hits = await this.retrieveNotes(query, limit);
    return hits.length ? hits.map((h) => `- ${h.path} [${h.score.toFixed(1)}]: ${h.snippet}`).join("\n") : "No relevant notes.";
  }
  async retrieveContext(query, limit = 6) {
    const hits = await this.retrieveNotes(query, limit);
    return hits.length ? `Locally retrieved note candidates (use vault_read for precision):
${hits.map((h) => `- ${h.path} [score ${h.score.toFixed(1)}]: ${h.snippet}`).join("\n")}` : "";
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
    let imeActive = false;
    let closedVisualHeight = 0;
    let keyboardWasShrunk = false;
    let shift = 0;
    const currentVisualHeight = () => window.visualViewport?.height ?? window.innerHeight;
    const relaxAncestorOverflow = () => {
      let node = container;
      for (let i = 0; node && i < 8; i++, node = node.parentElement) {
        node.style.overflow = "visible";
      }
    };
    const measureShift = () => {
      const inputRow = this.inputEl?.parentElement;
      if (!inputRow) return 0;
      const r = inputRow.getBoundingClientRect();
      const gapBelow = Math.max(0, window.innerHeight - r.bottom - 4);
      return Math.max(0, gapBelow - r.height * 0.6 - 15);
    };
    const apply = () => {
      const rect = container.getBoundingClientRect();
      const parent = container.parentElement;
      const paneBottom = parent ? parent.getBoundingClientRect().bottom : rect.bottom;
      const available = Math.max(220, paneBottom - rect.top);
      container.style.setProperty("--nullclaw-view-height", `${available}px`);
      container.style.setProperty("--nullclaw-ime-shift", `${imeActive ? shift : 0}px`);
      container.style.height = `${available}px`;
      container.style.maxHeight = `${available}px`;
      const statusEl = this.statusText?.parentElement;
      const inputRow = this.inputEl?.parentElement;
      const inputWrap = inputRow?.parentElement;
      const transform = imeActive ? `translateY(${shift}px)` : "";
      if (statusEl) statusEl.style.setProperty("transform", transform, "important");
      if (inputWrap) inputWrap.style.setProperty("transform", transform, "important");
      const vh = currentVisualHeight();
      if (imeActive && closedVisualHeight > 0 && vh < closedVisualHeight - 100) {
        keyboardWasShrunk = true;
      }
      if (imeActive && keyboardWasShrunk && vh >= closedVisualHeight - 36) {
        deactivateIme();
      }
    };
    const activateIme = () => {
      closedVisualHeight = currentVisualHeight();
      keyboardWasShrunk = false;
      shift = measureShift();
      imeActive = true;
      container.addClass("nullclaw-ime-active");
      relaxAncestorOverflow();
      apply();
      setTimeout(() => {
        if (imeActive) apply();
      }, 80);
      setTimeout(() => {
        if (imeActive) apply();
      }, 260);
    };
    const deactivateIme = () => {
      imeActive = false;
      keyboardWasShrunk = false;
      shift = 0;
      container.removeClass("nullclaw-ime-active");
      container.style.setProperty("--nullclaw-ime-shift", "0px");
      const statusEl = this.statusText?.parentElement;
      const inputRow = this.inputEl?.parentElement;
      const inputWrap = inputRow?.parentElement;
      if (statusEl) statusEl.style.removeProperty("transform");
      if (inputWrap) inputWrap.style.removeProperty("transform");
      setTimeout(apply, 50);
    };
    this.viewportResizeHandler = apply;
    window.visualViewport?.addEventListener("resize", apply);
    window.visualViewport?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    this.inputEl.addEventListener("focus", activateIme);
    this.inputEl.addEventListener("blur", deactivateIme);
    setTimeout(apply, 50);
    setTimeout(apply, 300);
  }
  async ensureMemoryScaffold() {
    const dirs = ["raw", "sources", "memory", "memory/inbox", "memory/feedback", "memory/applied", "people", "projects", "wiki", "decisions", "daily", "palace", ".nullclaw", ".nullclaw/sessions", ".nullclaw/skills"];
    for (const d of dirs) {
      try {
        if (!await this.app.vault.adapter.exists(d)) await this.app.vault.adapter.mkdir(d);
      } catch (e) {
        if (!await this.app.vault.adapter.exists(d)) throw e;
      }
    }
    const defaults = {
      "profile.md": "# Profile\n\n\u7528\u6237\u753B\u50CF\uFF0C\u5F85\u6C89\u6DC0\u3002\n",
      "vault.md": "# Vault\n\n\u8FD9\u4E2A\u77E5\u8BC6\u5E93\u7684\u7528\u9014\u3001\u7ED3\u6784\u548C\u957F\u671F\u76EE\u6807\u3002\n",
      "style.md": "# Style\n\n\u8F93\u51FA\u98CE\u683C\u504F\u597D\u3002\n",
      "memory_policy.md": "# Memory Policy\n\n\u957F\u671F\u8BB0\u5FC6\u5199\u5165 people/projects/wiki/decisions/daily \u524D\u9700\u8981\u4EBA\u5DE5\u786E\u8BA4\u3002\n",
      "palace/digest_note_room.md": "# digest_note_room\n\n\u89E6\u53D1\uFF1A\u6D88\u5316\u5F53\u524D\u7B14\u8BB0\u6216\u9009\u533A\u3002\n\u5FC5\u8BFB\uFF1Aprofile.md \u2192 vault.md \u2192 style.md \u2192 memory_policy.md \u2192 \u5F53\u524D\u7B14\u8BB0\u3002\n\u8F93\u51FA\uFF1Amemory/inbox/YYYY-MM-DD.md\u3002\n\u9650\u5236\uFF1A\u4E0D\u76F4\u63A5\u5199\u5165\u957F\u671F\u8BB0\u5FC6\u3002\n",
      "palace/chat_room.md": "# chat_room\n\n\u89E6\u53D1\uFF1A\u666E\u901A\u5BF9\u8BDD\u3002\n\u5FC5\u8BFB\uFF1Aprofile.md \u2192 vault.md \u2192 style.md\u3002\n\u6761\u4EF6\u8BFB\u53D6\uFF1A\u7528\u6237\u660E\u786E\u5F15\u7528\u7684\u7B14\u8BB0\u3002\n\u9650\u5236\uFF1A\u5199\u5165\u5FC5\u987B\u8D70\u786E\u8BA4\u3002\n",
      "palace/review_inbox_room.md": "# review_inbox_room\n\n\u89E6\u53D1\uFF1A\u5BA1\u6838 inbox\u3002\n\u5FC5\u8BFB\uFF1Amemory_policy.md \u2192 memory/inbox/\u3002\n\u8F93\u51FA\uFF1Amemory/inbox/review-*.md\u3002\n\u9650\u5236\uFF1A\u4E0D\u5199\u957F\u671F\u8BB0\u5FC6\u3002\n",
      "palace/apply_memory_room.md": "# apply_memory_room\n\n\u89E6\u53D1\uFF1A\u5E94\u7528\u957F\u671F\u8BB0\u5FC6\u3002\n\u5FC5\u8BFB\uFF1Amemory_policy.md \u2192 approved review\u3002\n\u8F93\u51FA\uFF1Apeople/projects/wiki/decisions/daily\u3002\n\u9650\u5236\uFF1A\u9010\u6587\u4EF6\u786E\u8BA4\u3002\n",
      "palace/update_profile_room.md": "# update_profile_room\n\n\u89E6\u53D1\uFF1A\u6839\u636E\u53CD\u9988\u66F4\u65B0\u753B\u50CF\u3002\n\u5FC5\u8BFB\uFF1Aprofile.md \u2192 style.md \u2192 memory/feedback/\u3002\n\u9650\u5236\uFF1Aprofile/style \u5206\u522B\u786E\u8BA4\u3002\n",
      "palace/vault_doctor_room.md": "# vault_doctor_room\n\n\u89E6\u53D1\uFF1AVault \u4F53\u68C0\u3002\n\u5FC5\u8BFB\uFF1Avault.md \u2192 memory_policy.md\u3002\n\u8F93\u51FA\uFF1Amemory/vault-doctor-*.md\u3002\n\u9650\u5236\uFF1A\u53EA\u751F\u6210\u62A5\u544A\uFF0C\u4E0D\u81EA\u52A8\u4FEE\u590D\u3002\n"
    };
    for (const [path, content] of Object.entries(defaults)) {
      if (!await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.write(path, content);
    }
  }
  async loadPalaceContext(message) {
    const candidates = ["profile.md", "vault.md", "style.md", "memory_policy.md", "palace/chat_room.md"];
    const intent = `${this.selectedSkill?.id || ""} ${message}`;
    if (/digest|消化|整理|总结/.test(intent)) candidates.push("palace/digest_note_room.md");
    if (/review|审核.*inbox/.test(intent)) candidates.push("palace/review_inbox_room.md");
    if (/apply|应用.*记忆|沉淀.*长期/.test(intent)) candidates.push("palace/apply_memory_room.md");
    if (/profile|画像|风格/.test(intent)) candidates.push("palace/update_profile_room.md");
    if (/doctor|体检|断链|孤立/.test(intent)) candidates.push("palace/vault_doctor_room.md");
    const chunks = [];
    for (const p of candidates) {
      if (await this.app.vault.adapter.exists(p)) {
        const text = await this.app.vault.adapter.read(p);
        chunks.push(`Context file: ${p}
${text.slice(0, 6e3)}`);
      }
    }
    try {
      const listing = await this.app.vault.adapter.list("memory/applied");
      const latest = [...listing.files].filter((x) => x.endsWith(".json")).sort().slice(-2);
      for (const path of latest) {
        const raw = await this.app.vault.adapter.read(path);
        chunks.push(`Recent confirmed memory audit: ${path}
${raw.slice(0, 5e3)}`);
      }
    } catch {
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
    if (this.attachedSelection) chunks.push(`Current editor selection:
${this.attachedSelection}`);
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
      this.sessionSummary = this.messages.map((m) => `${m.role}: ${m.content}`).join("\n").slice(-12e3);
      await this.saveSession();
      this.println("Context compacted locally: kept last 8 messages.", "nc-output");
      return;
    }
    const text = this.messages.map((m) => `${m.role}: ${m.content}`).join("\n").slice(-24e3);
    const summary = await this.callLLM(`\u8BF7\u538B\u7F29\u4E0B\u9762\u4F1A\u8BDD\u4E0A\u4E0B\u6587\uFF0C\u4FDD\u7559\u7528\u6237\u504F\u597D\u3001\u5F85\u529E\u3001\u91CD\u8981\u4E8B\u5B9E\u548C\u672A\u5B8C\u6210\u4EFB\u52A1\uFF1A

${text}`);
    if (summary) {
      this.sessionSummary = summary;
      this.messages = [];
      await this.saveSession();
      this.println("Context compacted and persisted.\n" + summary, "nc-output");
    }
  }
  async skillDigestCurrent() {
    await this.runSkillFlow("obsidian-digest-note", async (flow) => {
      const ctx = this.getActiveMarkdownContext();
      if (!ctx) throw new Error("No active markdown note.");
      flow.step("Read current note", ctx.path, "done");
      const target = ctx.selection || ctx.text;
      flow.step("Analyze", "Extracting facts, links, memory candidates and tasks\u2026", "running");
      const prompt = `\u6D88\u5316\u5F53\u524D Obsidian \u7B14\u8BB0\uFF0C\u8F93\u51FA\u56DB\u90E8\u5206\uFF1A
1. \u8981\u70B9
2. \u5173\u8054\u4EBA\u7269/\u9879\u76EE/\u6982\u5FF5
3. \u53EF\u6C89\u6DC0\u957F\u671F\u8BB0\u5FC6\u5019\u9009\uFF08\u6807\u6CE8 people/projects/wiki/decisions/daily\uFF09
4. \u5F85\u529E
\u6240\u6709\u7ED3\u8BBA\u4FDD\u7559\u6765\u6E90 ${ctx.path}\u3002\u4E0D\u8981\u76F4\u63A5\u5199\u957F\u671F\u8BB0\u5FC6\u3002

${target.slice(0, 24e3)}`;
      const result = this.settings.apiKey ? await this.callLLM(prompt) : `# Digest: ${ctx.path}

${target.slice(0, 4e3)}`;
      if (!result) throw new Error("Digest produced no result.");
      const out = `memory/inbox/${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.md`;
      flow.step("Write inbox", out, "awaiting");
      const entry = `
## ${(/* @__PURE__ */ new Date()).toLocaleString()} \u2014 ${ctx.path}

${result}
`;
      if (!await this.confirmMutation("Append inbox", out, entry)) throw new Error("User cancelled inbox write.");
      await this.toolAppend(out, entry);
      flow.step("Write inbox", out, "done");
      return `Digest written to ${out}`;
    });
  }
  async skillReviewInbox() {
    await this.runSkillFlow("obsidian-review-inbox", async (flow) => {
      const inbox = await this.collectFolderText("memory/inbox");
      if (!inbox) throw new Error("memory/inbox is empty.");
      flow.step("Scan inbox", `${inbox.length} chars`, "done");
      const prompt = `\u5BA1\u6838 memory/inbox\uFF0C\u53BB\u91CD\u5F52\u7EB3\u4E3A\u4EBA\u5DE5\u786E\u8BA4\u6E05\u5355\u3002\u6BCF\u6761\u5FC5\u987B\u6807\u6CE8\u5F52\u5C5E people/projects/wiki/decisions/daily\u3001\u7F6E\u4FE1\u5EA6\u3001\u6765\u6E90\uFF1B\u4E0D\u8981\u6267\u884C\u957F\u671F\u5199\u5165\u3002

${inbox.slice(0, 3e4)}`;
      flow.step("Build review", "Deduplicating and classifying\u2026", "running");
      const result = this.settings.apiKey ? await this.callLLM(prompt) : inbox;
      if (!result) throw new Error("Review produced no result.");
      const out = `memory/inbox/review-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.md`;
      if (!await this.confirmMutation("Write review", out, result)) throw new Error("User cancelled review write.");
      await this.toolWrite(out, result);
      flow.step("Write review", out, "done");
      return `Review written to ${out}`;
    });
  }
  async skillApplyMemory(_yes) {
    await this.runSkillFlow("obsidian-apply-memory", async (flow) => {
      const inboxFiles = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith("memory/inbox/") && !/review-|apply-/.test(f.path));
      if (!inboxFiles.length) throw new Error("memory/inbox has no candidate files.");
      const chunks = [];
      for (const f of inboxFiles.slice(0, 60)) chunks.push(`SOURCE:${f.path}
${(await this.app.vault.cachedRead(f)).slice(0, 12e3)}`);
      const inbox = chunks.join("\n\n---\n\n");
      flow.step("Read inbox", `${inboxFiles.length} source files`, "done");
      if (!this.settings.apiKey) throw new Error("Structured memory application requires configured LLM.");
      const prompt = `Return ONLY valid JSON, no markdown fences. Build a conservative long-term memory merge plan from inbox. Schema: {"operations":[{"path":"projects/example.md","mode":"append","content":"...","sources":["memory/inbox/file.md"],"reason":"..."}]}. Allowed targets: people/, projects/, wiki/, decisions/, daily/, profile.md, style.md. mode is append or write. Prefer append. Preserve source wikilinks in content. Never target raw/, sources/, memory/, palace/, .nullclaw/. Omit uncertain claims.

${inbox.slice(0, 5e4)}`;
      flow.step("Build structured plan", "Requesting validated JSON operations\u2026", "running");
      const response = await this.chatCompletion((this.settings.apiBase || "https://api.openai.com/v1").replace(/\/$/, ""), [
        { role: "system", content: "You produce strict JSON memory migration plans. Output JSON only." },
        { role: "user", content: prompt }
      ], []);
      const raw = response.choices?.[0]?.message?.content || response.choices?.[0]?.text || "";
      const parsed = this.parseMemoryOperations(raw);
      const ops = parsed.operations;
      if (!ops.length) throw new Error("No valid memory operations were proposed.");
      flow.step("Validate plan", `${ops.length} valid operations`, "done");
      const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      const stamp = (/* @__PURE__ */ new Date()).toISOString();
      const audit = [];
      await this.toolWrite(`memory/apply-plan-${date}.json`, JSON.stringify({ createdAt: stamp, operations: ops }, null, 2));
      for (const op of ops) {
        flow.step(op.path, `${op.mode}: ${op.reason}`, "awaiting");
        const approved = await this.confirmMutation(op.mode === "append" ? "Append memory" : "Write memory", op.path, op.content);
        if (!approved) {
          audit.push({ ...op, status: "cancelled" });
          flow.step(op.path, "Cancelled", "cancelled");
          continue;
        }
        if (op.mode === "append") await this.toolAppend(op.path, op.content);
        else await this.toolWrite(op.path, op.content);
        audit.push({ ...op, status: "applied", appliedAt: (/* @__PURE__ */ new Date()).toISOString() });
        flow.step(op.path, "Applied", "done");
      }
      const log = `memory/applied/${date}-${Date.now()}.json`;
      await this.toolWrite(log, JSON.stringify({ createdAt: stamp, session: this.sessionId, operations: audit }, null, 2));
      const sourceStatus = [...new Set(audit.filter((x) => x.status === "applied").flatMap((x) => x.sources || []))];
      if (sourceStatus.length) await this.toolAppend(`memory/applied/index-${date}.md`, `
## ${stamp}
Audit: [[${log}]]
Sources:
${sourceStatus.map((x) => `- [[${x}]]`).join("\n")}
`);
      return `Applied ${audit.filter((x) => x.status === "applied").length}/${ops.length} operations. Audit: ${log}`;
    });
  }
  parseMemoryOperations(raw) {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let data;
    try {
      data = JSON.parse(cleaned);
    } catch {
      const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
      if (a < 0 || b <= a) throw new Error("Invalid JSON plan.");
      data = JSON.parse(cleaned.slice(a, b + 1));
    }
    const allowed = (p) => /^(people|projects|wiki|decisions|daily)\/.+\.md$/i.test(p) || /^(profile|style)\.md$/i.test(p);
    const operations = [];
    for (const x of Array.isArray(data.operations) ? data.operations : []) {
      const path = this.normalizePath(String(x.path || ""));
      const mode = x.mode === "write" ? "write" : "append";
      const content = String(x.content || "").trim();
      if (!allowed(path) || !content) continue;
      operations.push({ path, mode, content, sources: Array.isArray(x.sources) ? x.sources.map(String) : [], reason: String(x.reason || "Memory consolidation") });
    }
    return { operations: operations.slice(0, 40) };
  }
  async skillUpdateProfile() {
    await this.runSkillFlow("obsidian-update-profile", async (flow) => {
      const feedback = await this.collectFolderText("memory/feedback");
      if (!feedback) throw new Error("No feedback records.");
      const currentProfile = await this.toolRead("profile.md");
      const currentStyle = await this.toolRead("style.md");
      flow.step("Read feedback", `${feedback.length} chars`, "done");
      const prompt = `\u6839\u636E\u53CD\u9988\u5206\u522B\u8F93\u51FA profile.md \u548C style.md \u7684\u5B8C\u6574\u5EFA\u8BAE\u65B0\u5185\u5BB9\u3002\u683C\u5F0F\u5FC5\u987B\u4E3A\uFF1A
===PROFILE===
...
===STYLE===
...
\u4E0D\u5F97\u4FEE\u6539\u4E8B\u5B9E\uFF0C\u4EC5\u603B\u7ED3\u7A33\u5B9A\u504F\u597D\u3002

Current profile:
${currentProfile}

Current style:
${currentStyle}

Feedback:
${feedback.slice(0, 24e3)}`;
      const proposal = this.settings.apiKey ? await this.callLLM(prompt) : null;
      if (!proposal) throw new Error("Profile update requires configured LLM.");
      const p = proposal.match(/===PROFILE===([\s\S]*?)===STYLE===/)?.[1]?.trim();
      const st = proposal.match(/===STYLE===([\s\S]*)/)?.[1]?.trim();
      if (!p || !st) throw new Error("Model did not return structured PROFILE/STYLE sections.");
      if (await this.confirmMutation("Update profile", "profile.md", p)) {
        await this.toolWrite("profile.md", p);
        flow.step("profile.md", "Updated", "done");
      } else flow.step("profile.md", "Cancelled", "cancelled");
      if (await this.confirmMutation("Update style", "style.md", st)) {
        await this.toolWrite("style.md", st);
        flow.step("style.md", "Updated", "done");
      } else flow.step("style.md", "Cancelled", "cancelled");
      return "Profile workflow completed.";
    });
  }
  async skillVaultDoctor() {
    await this.runSkillFlow("obsidian-vault-doctor", async (flow) => {
      const files = this.app.vault.getFiles();
      const markdown = this.app.vault.getMarkdownFiles();
      const raw = files.filter((f) => f.path.startsWith("raw/"));
      const empty = [];
      const broken = [];
      for (const f of markdown.slice(0, 800)) {
        try {
          const text = await this.app.vault.cachedRead(f);
          if (text.trim().length < 20) empty.push(f.path);
          for (const l of this.app.metadataCache.getFileCache(f)?.links ?? []) if (!this.app.metadataCache.getFirstLinkpathDest(l.link, f.path)) broken.push(`${f.path} \u2192 ${l.link}`);
        } catch {
        }
      }
      flow.step("Scan vault", `${files.length} files`, "done");
      const report = `# Vault Doctor

- files: ${files.length}
- markdown: ${markdown.length}
- raw: ${raw.length}
- empty: ${empty.length}
- broken links: ${broken.length}

## Empty
${empty.slice(0, 80).map((x) => "- " + x).join("\n") || "None"}

## Broken links
${broken.slice(0, 120).map((x) => "- " + x).join("\n") || "None"}

## Raw
${raw.slice(0, 80).map((x) => "- " + x.path).join("\n") || "None"}
`;
      const out = `memory/vault-doctor-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.md`;
      if (!await this.confirmMutation("Write doctor report", out, report)) throw new Error("User cancelled report.");
      await this.toolWrite(out, report);
      flow.step("Write report", out, "done");
      return `Vault doctor report: ${out}`;
    });
  }
  async skillCreateSkill(description) {
    await this.runSkillFlow("obsidian-create-skill", async (flow) => {
      if (!description) throw new Error("Usage: /create-skill <description>");
      const slug = description.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || `skill-${Date.now()}`;
      const prompt = `Create a concise SKILL.md for a local Obsidian agent. Include YAML frontmatter name and description, triggers, required context, allowed tools, steps, output paths, confirmation policy, and forbidden actions. User request: ${description}`;
      const content = this.settings.apiKey ? await this.callLLM(prompt) : `---
name: ${slug}
description: ${description}
---

# Steps
1. Clarify input.
2. Read relevant notes.
3. Produce output with confirmation.
`;
      if (!content) throw new Error("Skill generation failed.");
      const out = `.nullclaw/skills/${slug}/SKILL.md`;
      flow.step("Generate skill", out, "awaiting");
      if (!await this.confirmMutation("Create skill", out, content)) throw new Error("User cancelled skill creation.");
      await this.toolWrite(out, content);
      await this.loadCustomSkills();
      flow.step("Create skill", out, "done");
      return `Created ${out}`;
    });
  }
  async runSkillFlow(name, runner) {
    const card = this.outputEl.createDiv({ cls: "nc-skill-flow" });
    card.createDiv({ cls: "nc-skill-flow-title", text: `Skill \xB7 ${name}` });
    const steps = card.createDiv({ cls: "nc-skill-steps" });
    const flow = { step: (label, detail, state) => {
      const row = steps.createDiv({ cls: `nc-skill-step is-${state}` });
      row.createSpan({ cls: "nc-skill-step-label", text: label });
      row.createSpan({ cls: "nc-skill-step-detail", text: detail });
      this.stickToBottom();
    } };
    try {
      const result = await runner(flow);
      card.addClass("is-complete");
      this.println(result, "nc-output");
    } catch (e) {
      card.addClass("is-error");
      this.println(`Skill failed: ${e.message}`, "nc-error");
    }
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
  async createSourceForAttachment(rawPath, file, buf) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const textTypes = ["txt", "md", "markdown", "json", "csv", "yaml", "yml", "html", "xml", "log"];
    const source = `sources/${rawPath.slice(4).replace(/\.[^.]+$/, "")}.md`;
    const meta = `---
raw: "[[${rawPath}]]"
name: ${JSON.stringify(file.name)}
mime: ${JSON.stringify(file.type || "application/octet-stream")}
size: ${file.size}
imported: ${(/* @__PURE__ */ new Date()).toISOString()}
---

`;
    if (textTypes.includes(ext) || file.type.startsWith("text/")) {
      const text = new TextDecoder().decode(buf).slice(0, 5e5);
      await this.toolWrite(source, `${meta}# Source: ${file.name}

${text}`);
      return source;
    }
    if (file.type.startsWith("image/")) {
      await this.toolWrite(source, `${meta}# Image source

![[${rawPath}]]

> OCR/description can be regenerated; raw evidence is immutable.`);
      return source;
    }
    if (ext === "pdf") {
      await this.toolWrite(source, `${meta}# PDF source

![[${rawPath}]]

> PDF text extraction is not available in the Android core yet. Keep this source note for later extraction.`);
      return source;
    }
    return null;
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
        const sourcePath = await this.createSourceForAttachment(path, file, buf);
        this.attachedRefs.push(sourcePath || path);
        this.renderRefs();
        void this.saveSession();
        this.println(`Saved attachment to ${path}${sourcePath ? `; source: ${sourcePath}` : ""}`, "nc-info");
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
  async loadCustomSkills() {
    await this.ensureMemoryScaffold();
    this.customSkills = [];
    this.customSkillSources.clear();
    const roots = [".nullclaw/skills"];
    for (const root of roots) {
      let listing;
      try {
        listing = await this.app.vault.adapter.list(root);
      } catch {
        continue;
      }
      const candidates = [...listing.files.filter((x) => x.endsWith("/SKILL.md") || x.endsWith("SKILL.md"))];
      for (const folder of listing.folders ?? []) {
        try {
          const nested = await this.app.vault.adapter.list(folder);
          candidates.push(...nested.files.filter((x) => x.endsWith("SKILL.md")));
        } catch {
        }
      }
      for (const path of candidates) {
        try {
          const source = await this.app.vault.adapter.read(path);
          const fm = source.match(/^---\n([\s\S]*?)\n---/i)?.[1] || "";
          const get = (key) => fm.split("\n").find((x) => x.trim().startsWith(key + ":"))?.split(":").slice(1).join(":").trim().replace(/^['"]|['"]$/g, "");
          const fallback = path.split("/").slice(-2, -1)[0] || "custom-skill";
          const id = (get("name") || fallback).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff-]+/g, "-");
          const description = get("description") || source.match(/^#\s+(.+)$/m)?.[1] || "Custom local skill";
          this.customSkills.push({ id, label: get("name") || fallback, description, command: `/skill-run ${id}` });
          this.customSkillSources.set(id, source);
        } catch {
        }
      }
    }
  }
  async executeCustomSkill(id, input) {
    const source = this.customSkillSources.get(id);
    if (!source) throw new Error(`Custom skill not found: ${id}. Run /skills-reload.`);
    await this.runSkillFlow(id, async (flow) => {
      flow.step("Load SKILL.md", `${source.length} chars`, "done");
      flow.step("Execute", "Agent follows local skill constraints; mutations still require confirmation.", "running");
      const result = await this.callLLM(`Execute this local Obsidian skill exactly. The skill cannot override confirmation policy or raw evidence protection.

<SKILL>
${source.slice(0, 2e4)}
</SKILL>

User input:
${input || "(none)"}`);
      if (!result) throw new Error("Skill produced no final response.");
      flow.step("Complete", "Final response generated", "done");
      return result;
    });
  }
  async invokeCommand(command) {
    if (this.running) throw new Error("NullClaw is busy.");
    await this.execSlashCommand(command.replace(/^\//, ""));
  }
  builtinSkills() {
    const builtins = [
      { id: "compact", label: "Compact context", description: "\u538B\u7F29\u5F53\u524D\u4F1A\u8BDD\u4E0A\u4E0B\u6587", command: "/compact" },
      { id: "digest", label: "Digest current note", description: "\u6D88\u5316\u5F53\u524D\u7B14\u8BB0\u6216\u9009\u533A\u5230 inbox", command: "/digest-current" },
      { id: "review", label: "Review inbox", description: "\u5BA1\u6838\u5F85\u6C89\u6DC0\u5185\u5BB9", command: "/review-inbox" },
      { id: "apply", label: "Apply memory", description: "\u786E\u8BA4\u540E\u5408\u5E76\u957F\u671F\u8BB0\u5FC6", command: "/apply-memory" },
      { id: "profile", label: "Update profile", description: "\u6839\u636E\u53CD\u9988\u66F4\u65B0\u753B\u50CF\u4E0E\u98CE\u683C", command: "/update-profile" },
      { id: "doctor", label: "Vault doctor", description: "\u6267\u884C Vault \u5168\u5E93\u4F53\u68C0", command: "/vault-doctor" },
      { id: "create", label: "Create skill", description: "\u521B\u5EFA\u65B0\u7684\u672C\u5730\u6280\u80FD", command: "/create-skill" }
    ];
    return [...builtins, ...this.customSkills];
  }
  updateSkillMenu() {
    const value = this.inputEl.value;
    if (!value.startsWith("/") || value.includes(" ")) {
      this.closeSkillMenu();
      return;
    }
    const q = value.slice(1).toLowerCase();
    this.skillItems = this.builtinSkills().filter((x) => x.id.includes(q) || x.label.toLowerCase().includes(q));
    if (!this.skillItems.length) {
      this.closeSkillMenu();
      return;
    }
    this.skillIndex = Math.min(this.skillIndex, this.skillItems.length - 1);
    this.renderSkillMenu();
  }
  renderSkillMenu() {
    this.skillEl.empty();
    this.skillEl.hidden = false;
    this.skillItems.forEach((skill, i) => {
      const item = this.skillEl.createDiv({ cls: `nc-skill-item${i === this.skillIndex ? " is-selected" : ""}` });
      item.createDiv({ cls: "nc-skill-label", text: `/${skill.id} \xB7 ${skill.label}` });
      item.createDiv({ cls: "nc-skill-desc", text: skill.description });
      item.addEventListener("mousedown", (e) => e.preventDefault());
      item.addEventListener("click", () => this.chooseSkill(i));
    });
  }
  moveSkill(delta) {
    if (!this.skillItems.length) return;
    this.skillIndex = (this.skillIndex + delta + this.skillItems.length) % this.skillItems.length;
    this.renderSkillMenu();
  }
  chooseSkill(index) {
    const skill = this.skillItems[index];
    if (!skill) return;
    this.selectedSkill = skill;
    this.inputEl.value = "";
    this.closeSkillMenu();
    this.renderRefs();
  }
  closeSkillMenu() {
    this.skillEl.hidden = true;
    this.skillEl.empty();
    this.skillItems = [];
    this.skillIndex = 0;
  }
  async loadSessionIndex() {
    await this.ensureMemoryScaffold();
    const listing = await this.app.vault.adapter.list(".nullclaw/sessions");
    const items = [];
    for (const path of listing.files.filter((x) => x.endsWith(".json"))) {
      try {
        const d = JSON.parse(await this.app.vault.adapter.read(path));
        items.push({ id: d.id || path.split("/").pop().replace(".json", ""), title: d.title || "Untitled", updatedAt: d.updatedAt || 0, messageCount: d.messages?.length || 0 });
      } catch {
      }
    }
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async toggleSessionPanel(forceOpen) {
    const open = forceOpen ?? this.sessionEl.hidden;
    if (!open) {
      this.sessionEl.hidden = true;
      this.sessionEl.empty();
      return;
    }
    this.sessionEl.empty();
    this.sessionEl.hidden = false;
    const head = this.sessionEl.createDiv({ cls: "nc-session-head" });
    head.createSpan({ text: "Sessions" });
    const create = head.createEl("button", { text: "+ New" });
    create.addEventListener("click", () => void this.newSession());
    const close = head.createEl("button", { text: "\xD7" });
    close.addEventListener("click", () => {
      this.sessionEl.hidden = true;
    });
    for (const item of await this.loadSessionIndex()) {
      const row = this.sessionEl.createDiv({ cls: `nc-session-row${item.id === this.sessionId ? " is-active" : ""}` });
      const main = row.createDiv({ cls: "nc-session-main" });
      main.createDiv({ cls: "nc-session-title", text: item.title });
      main.createDiv({ cls: "nc-session-meta", text: `${item.messageCount} messages \xB7 ${new Date(item.updatedAt).toLocaleString()}` });
      main.addEventListener("click", () => void this.switchSession(item.id));
      const del = row.createEl("button", { text: "Delete" });
      del.addEventListener("click", () => void this.deleteSession(item.id));
    }
  }
  async newSession(title) {
    await this.saveSession();
    this.sessionId = `session-${Date.now()}`;
    this.messages = [];
    this.sessionSummary = "";
    this.attachedRefs = [];
    this.attachedSelection = "";
    this.outputEl.empty();
    this.renderRefs();
    if (title) this.messages.push({ role: "system", content: `Session title: ${title}` });
    await this.saveSession();
    this.println(`New session: ${title || this.sessionId}`, "nc-info");
    this.sessionEl.hidden = true;
  }
  async switchSession(id) {
    await this.saveSession();
    this.sessionId = id;
    this.messages = [];
    this.sessionSummary = "";
    this.attachedRefs = [];
    this.attachedSelection = "";
    this.outputEl.empty();
    this.sessionEl.hidden = true;
    await this.restoreSession();
  }
  async deleteSession(id) {
    if (!await this.confirmOperation("Delete session", id, "Delete this saved conversation?")) return;
    const path = `.nullclaw/sessions/${id}.json`;
    if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
    if (id === this.sessionId) await this.newSession();
    else await this.toggleSessionPanel(true);
  }
  sessionPath() {
    return `.nullclaw/sessions/${this.sessionId}.json`;
  }
  async restoreSession() {
    await this.ensureMemoryScaffold();
    const path = this.sessionPath();
    if (!await this.app.vault.adapter.exists(path)) return;
    try {
      const data = JSON.parse(await this.app.vault.adapter.read(path));
      this.messages = Array.isArray(data.messages) ? data.messages : [];
      this.sessionSummary = data.summary || "";
      this.attachedRefs = Array.isArray(data.refs) ? data.refs : [];
      if (this.messages.length) {
        this.outputEl.empty();
        this.println(`Restored session: ${data.title || "Current session"}`, "nc-info");
        for (const m of this.messages) {
          if (m.role === "user" || m.role === "assistant") this.renderMessageCard(m.role, m.content, false);
        }
      }
      this.renderRefs();
      this.stickToBottom();
    } catch (e) {
      this.println(`Session restore failed: ${e.message}`, "nc-error");
    }
  }
  async saveSession() {
    try {
      await this.ensureMemoryScaffold();
      const firstUser = this.messages.find((m) => m.role === "user")?.content || "Current session";
      const data = {
        version: 1,
        id: this.sessionId,
        title: firstUser.replace(/\s+/g, " ").slice(0, 48),
        summary: this.sessionSummary,
        messages: this.messages.slice(-80),
        refs: [...this.attachedRefs],
        updatedAt: Date.now()
      };
      await this.app.vault.adapter.write(this.sessionPath(), JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn("NullClaw session save failed", e);
    }
  }
  renderMessageCard(role, text, forceStick) {
    const shouldStick = forceStick || this.isNearBottom();
    const card = this.outputEl.createDiv({ cls: `nc-message nc-message-${role}` });
    const header = card.createDiv({ cls: "nc-message-header" });
    header.createSpan({ text: role === "user" ? "You" : "NullClaw" });
    const body = card.createDiv({ cls: "nc-message-body" });
    body.textContent = text;
    if (role === "assistant") {
      const actions = card.createDiv({ cls: "nc-message-actions" });
      const copy = actions.createEl("button", { text: "Copy" });
      copy.addEventListener("click", async () => {
        try {
          if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
          else {
            const area = document.createElement("textarea");
            area.value = text;
            document.body.appendChild(area);
            area.select();
            document.execCommand("copy");
            area.remove();
          }
        } catch {
          this.println("Copy failed.", "nc-error");
        }
      });
      const good = actions.createEl("button", { text: "\u{1F44D}" });
      good.addEventListener("click", () => void this.writeFeedback("good", text.slice(0, 1e3)));
      const bad = actions.createEl("button", { text: "\u{1F44E}" });
      bad.addEventListener("click", () => void this.writeFeedback("bad", text.slice(0, 1e3)));
    }
    if (shouldStick) this.stickToBottom();
    return body;
  }
  createStreamingCard() {
    const details = this.outputEl.createEl("details", { cls: "nc-stream-card" });
    details.open = true;
    details.createEl("summary", { text: "NullClaw \xB7 streaming" });
    const body = details.createDiv({ cls: "nc-message-body nc-stream-body" });
    return { details, body };
  }
  createToolBlock(name, args) {
    const details = this.outputEl.createEl("details", { cls: "nc-tool-block" });
    details.createEl("summary", { text: `Tool \xB7 ${name}` });
    details.createEl("pre", { cls: "nc-tool-args", text: JSON.stringify(args, null, 2) });
    const result = details.createEl("pre", { cls: "nc-tool-result", text: "Running\u2026" });
    if (this.isNearBottom()) this.stickToBottom();
    return { details, result };
  }
  async confirmOperation(action, target, detail) {
    return await new Promise((resolve) => {
      const card = this.outputEl.createDiv({ cls: "nc-confirm-card" });
      card.createDiv({ cls: "nc-confirm-title", text: `${action} \xB7 ${target}` });
      card.createDiv({ cls: "nc-confirm-detail", text: detail });
      const controls = card.createDiv({ cls: "nc-confirm-actions" });
      const yes = controls.createEl("button", { cls: "mod-cta", text: "Confirm" });
      const no = controls.createEl("button", { text: "Cancel" });
      const finish = (value) => {
        yes.disabled = true;
        no.disabled = true;
        card.addClass(value ? "nc-confirmed" : "nc-cancelled");
        resolve(value);
      };
      yes.addEventListener("click", () => finish(true));
      no.addEventListener("click", () => finish(false));
      this.stickToBottom();
    });
  }
  async confirmMutation(action, path, content, marker = "") {
    const p = this.normalizePath(path);
    let before = "";
    try {
      if (await this.app.vault.adapter.exists(p)) before = await this.app.vault.adapter.read(p);
    } catch {
    }
    let after = content;
    if (action === "Append") after = before + (before && !before.endsWith("\n") ? "\n" : "") + content;
    if (action === "Insert") {
      const pos = before.indexOf(marker);
      after = pos >= 0 ? before.slice(0, pos + marker.length) + content + before.slice(pos + marker.length) : before;
    }
    return await new Promise((resolve) => {
      const card = this.outputEl.createDiv({ cls: "nc-confirm-card" });
      card.createDiv({ cls: "nc-confirm-title", text: `${action} \xB7 ${p}` });
      card.createEl("pre", { cls: "nc-diff", text: this.simpleDiff(before, after) });
      const controls = card.createDiv({ cls: "nc-confirm-actions" });
      const yes = controls.createEl("button", { cls: "mod-cta", text: "Confirm" });
      const no = controls.createEl("button", { text: "Cancel" });
      const finish = (value) => {
        yes.disabled = true;
        no.disabled = true;
        card.addClass(value ? "nc-confirmed" : "nc-cancelled");
        resolve(value);
      };
      yes.addEventListener("click", () => finish(true));
      no.addEventListener("click", () => finish(false));
      this.stickToBottom();
    });
  }
  simpleDiff(before, after) {
    const a = before.split("\n"), b = after.split("\n");
    if (a.length * b.length > 25e4) {
      let prefix = 0;
      while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
      let suffix = 0;
      while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
      return [`@@ line ${prefix + 1} (large-file diff) @@`, ...a.slice(prefix, a.length - suffix).slice(0, 100).map((x) => `- ${x}`), ...b.slice(prefix, b.length - suffix).slice(0, 100).map((x) => `+ ${x}`)].join("\n");
    }
    const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i2 = a.length - 1; i2 >= 0; i2--) for (let j2 = b.length - 1; j2 >= 0; j2--) dp[i2][j2] = a[i2] === b[j2] ? dp[i2 + 1][j2 + 1] + 1 : Math.max(dp[i2 + 1][j2], dp[i2][j2 + 1]);
    const lines = [];
    let i = 0, j = 0, shown = 0;
    while ((i < a.length || j < b.length) && shown < 240) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        if (lines.length && lines[lines.length - 1] !== "\u2026") lines.push(`  ${a[i]}`);
        i++;
        j++;
      } else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) {
        lines.push(`+ ${b[j++]}`);
        shown++;
      } else {
        lines.push(`- ${a[i++]}`);
        shown++;
      }
      if (lines.length > 300) break;
    }
    return lines.join("\n") || "(no changes)";
  }
  updateMentionMenu() {
    const value = this.inputEl.value;
    const cursor = this.inputEl.selectionStart ?? value.length;
    const left = value.slice(0, cursor);
    const match = left.match(/(?:^|\s)@([^\s@]*)$/);
    if (!match) {
      this.closeMentionMenu();
      return;
    }
    this.mentionStart = cursor - match[1].length - 1;
    const query = match[1].toLowerCase();
    this.mentionItems = this.app.vault.getMarkdownFiles().map((f) => f.path).filter((path) => !query || path.toLowerCase().includes(query)).sort((a, b) => this.mentionScore(b, query) - this.mentionScore(a, query)).slice(0, 8);
    if (!this.mentionItems.length) {
      this.closeMentionMenu();
      return;
    }
    this.mentionIndex = 0;
    this.renderMentionMenu();
  }
  mentionScore(path, query) {
    const lower = path.toLowerCase();
    const name = lower.split("/").pop() || lower;
    if (name.startsWith(query)) return 100;
    if (name.includes(query)) return 70;
    if (lower.startsWith(query)) return 50;
    return 20;
  }
  renderMentionMenu() {
    this.mentionEl.empty();
    this.mentionEl.hidden = false;
    this.mentionItems.forEach((path, i) => {
      const item = this.mentionEl.createDiv({ cls: `nc-mention-item${i === this.mentionIndex ? " is-selected" : ""}`, text: path });
      item.addEventListener("mousedown", (e) => e.preventDefault());
      item.addEventListener("click", () => this.chooseMention(i));
    });
  }
  moveMention(delta) {
    if (!this.mentionItems.length) return;
    this.mentionIndex = (this.mentionIndex + delta + this.mentionItems.length) % this.mentionItems.length;
    this.renderMentionMenu();
  }
  chooseMention(index) {
    const path = this.mentionItems[index];
    if (!path) return;
    if (!this.attachedRefs.includes(path)) this.attachedRefs.push(path);
    const value = this.inputEl.value;
    const cursor = this.inputEl.selectionStart ?? value.length;
    this.inputEl.value = value.slice(0, this.mentionStart) + value.slice(cursor);
    this.closeMentionMenu();
    this.renderRefs();
    void this.saveSession();
  }
  closeMentionMenu() {
    this.mentionEl.hidden = true;
    this.mentionEl.empty();
    this.mentionItems = [];
    this.mentionStart = -1;
  }
  renderRefs() {
    this.refsEl.empty();
    if (!this.attachedRefs.length && !this.selectedSkill) {
      this.refsEl.hidden = true;
      return;
    }
    this.refsEl.hidden = false;
    if (this.selectedSkill) {
      const pill = this.refsEl.createSpan({ cls: "nc-skill-pill" });
      pill.createSpan({ text: `/${this.selectedSkill.id} \xB7 ${this.selectedSkill.label}` });
      const remove = pill.createEl("button", { text: "\xD7" });
      remove.addEventListener("click", () => {
        this.selectedSkill = null;
        this.renderRefs();
      });
    }
    for (const path of this.attachedRefs) {
      const chip = this.refsEl.createSpan({ cls: "nc-ref-chip" });
      chip.createSpan({ text: `@ ${path}` });
      const remove = chip.createEl("button", { text: "\xD7" });
      remove.addEventListener("click", () => {
        this.attachedRefs = this.attachedRefs.filter((x) => x !== path);
        this.renderRefs();
        void this.saveSession();
      });
    }
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
  isNearBottom(threshold = 64) {
    const el = this.outputEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }
  stickToBottom() {
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }
  println(text, cls, forceStick = false) {
    const shouldStick = forceStick || this.isNearBottom();
    const line = this.outputEl.createDiv({ cls: `nc-line ${cls}` });
    line.textContent = text;
    if (shouldStick) this.stickToBottom();
    return line;
  }
  async streamPrint(text, cls, forceStick = false) {
    const shouldStickInitially = forceStick || this.isNearBottom();
    const line = this.outputEl.createDiv({ cls: `nc-line ${cls}` });
    const chunks = text.length > 600 ? text.match(/[\s\S]{1,24}/g) ?? [text] : text.split(/(?<=\n)/g);
    let acc = "";
    for (const chunk of chunks) {
      acc += chunk;
      line.textContent = acc;
      if (shouldStickInitially && this.isNearBottom(180)) this.stickToBottom();
      await new Promise((resolve) => setTimeout(resolve, text.length > 600 ? 8 : 12));
    }
    if (shouldStickInitially) this.stickToBottom();
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
    const command = (id, name, text) => this.addCommand({ id, name, callback: async () => {
      await this.openView();
      await this.view?.invokeCommand(text);
    } });
    command("digest-current-note", "Digest current note", "digest-current");
    command("attach-current-note", "Attach current note", "current");
    command("review-memory-inbox", "Review memory inbox", "review-inbox");
    command("apply-memory-plan", "Apply memory plan", "apply-memory");
    command("update-user-profile", "Update user profile", "update-profile");
    command("run-vault-doctor", "Run Vault doctor", "vault-doctor");
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
