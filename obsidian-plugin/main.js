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
    return p.split("/").filter((x) => x.length > 0);
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
    if (children.has(name)) return false;
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
function prefetchLLM(key, response) {
  _prefetched.set(key, response);
}
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
      v.setBigUint64(buf + 8, fd === 3 ? 0xFFFFFFFFFFFFFFFFn : BigInt(63), true);
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
      let content = _vfs.read(full);
      if (!content) {
        if (wantCreate) {
          _vfs.write(full, new Uint8Array(0));
          content = new Uint8Array(0);
        } else {
          return 44;
        }
      }
      if (wantTrunc) content = new Uint8Array(0);
      const fd = _nextFd++;
      _fds.set(fd, { path: full, content: content.slice(), offset: 0, writable: wantCreate || wantTrunc, ftype: FT_REG });
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
    this.inputEl = row.createEl("input", { cls: "nullclaw-input", attr: { type: "text", placeholder: 'version | help | agent -m "hello" | memory list ...' } });
    const st = c.createDiv({ cls: "nullclaw-status" });
    this.statusDot = st.createSpan({ cls: "nc-dot nc-dot-error" });
    this.statusText = st.createSpan({ text: "Loading nullclaw.wasm..." });
    await this.loadWasm();
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !this.running) this.exec(this.inputEl.value);
    });
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
        this.println("Welcome to NullClaw \u2014 AI agent with LLM bridge.", "nc-info");
      } else {
        this.statusText.textContent = `NullClaw ready (${sizeKB} KB, local mode \u2014 set API key in settings)`;
        this.println("Welcome to NullClaw \u2014 local agent (no LLM configured).", "nc-info");
        this.println("Go to Settings \u2192 NullClaw to set your API key for LLM mode.", "nc-info");
      }
      this.println('Commands: version, help, agent -m "message", memory add/list/search, identity show/set', "nc-info");
      this.println("", "nc-info");
    } catch (e) {
      this.statusDot.className = "nc-dot nc-dot-error";
      this.statusText.textContent = "Load failed";
      this.println(`Failed to load nullclaw.wasm: ${e.message}`, "nc-error");
    }
  }
  async exec(input) {
    if (!input.trim() || !this.wasmBytes) return;
    this.running = true;
    this.statusDot.className = "nc-dot nc-dot-running";
    this.statusText.textContent = "Running...";
    this.println(`\u276F ${input}`, "nc-prompt");
    this.inputEl.value = "";
    this.inputEl.disabled = true;
    try {
      const args = this.parseArgs(input);
      const isAgent = args[0] === "agent" && this.settings.apiKey;
      if (isAgent) {
        await this.prefetchAgentResponse(input, args);
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
  async prefetchAgentResponse(input, args) {
    let message = "";
    const mIdx = args.indexOf("-m");
    const mIdx2 = args.indexOf("--message");
    if (mIdx >= 0 && mIdx + 1 < args.length) message = args.slice(mIdx + 1).join(" ");
    else if (mIdx2 >= 0 && mIdx2 + 1 < args.length) message = args.slice(mIdx2 + 1).join(" ");
    if (!message) return;
    const body = JSON.stringify({
      model: this.settings.model,
      messages: [
        { role: "system", content: "You are NullClaw WASI, an AI assistant running inside Obsidian. Be concise and helpful. Answer in markdown." },
        { role: "user", content: message }
      ],
      max_tokens: 2048,
      temperature: 0.7
    });
    const url = `${this.settings.apiBase}/chat/completions`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.settings.apiKey}`,
          "Content-Type": "application/json"
        },
        body
      });
      if (!res.ok) {
        const errText = await res.text();
        this.println(`[LLM error: ${res.status} ${errText.slice(0, 200)}]`, "nc-error");
        return;
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content ?? "";
      if (content) {
        prefetchLLM(url + "||" + body, JSON.stringify(data));
      }
    } catch (e) {
      this.println(`[LLM fetch failed: ${e.message}]`, "nc-error");
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
  println(text, cls) {
    const line = this.outputEl.createDiv({ cls: `nc-line ${cls}` });
    line.textContent = text;
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }
  async onClose() {
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
