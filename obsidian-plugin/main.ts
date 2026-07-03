import { Plugin, WorkspaceLeaf, ItemView, Setting, PluginSettingTab } from 'obsidian';
import { runNullclaw } from './wasi-shim';

const VIEW_TYPE = 'nullclaw-agent-view';

interface NullClawSettings {
  apiKey: string;
  apiBase: string;
  model: string;
}

const DEFAULT_SETTINGS: NullClawSettings = {
  apiKey: '',
  apiBase: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
};

class NullclawView extends ItemView {
  private outputEl!: HTMLDivElement;
  private inputEl!: HTMLInputElement;
  private statusDot!: HTMLSpanElement;
  private statusText!: HTMLSpanElement;
  private wasmBytes: ArrayBuffer | null = null;
  private running = false;
  private settings: NullClawSettings;
  private messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; name?: string; tool_call_id?: string }> = [];
  private viewportResizeHandler?: () => void;

  constructor(leaf: WorkspaceLeaf, settings: NullClawSettings) {
    super(leaf);
    this.settings = settings;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'NullClaw'; }
  getIcon() { return 'bot'; }

  async onOpen() {
    const c = this.containerEl.children[1] as HTMLElement;
    c.empty();
    c.addClass('nullclaw-terminal');
    this.outputEl = c.createDiv({ cls: 'nullclaw-output' });
    const row = c.createDiv({ cls: 'nullclaw-input-row' });
    row.createSpan({ cls: 'nullclaw-input-prompt', text: '❯' });
    this.inputEl = row.createEl('input', { cls: 'nullclaw-input', attr: { type: 'text', placeholder: '直接输入发给 AI；命令用 /help /version /memory list ...' } });
    const st = c.createDiv({ cls: 'nullclaw-status' });
    this.statusDot = st.createSpan({ cls: 'nc-dot nc-dot-error' });
    this.statusText = st.createSpan({ text: 'Loading nullclaw.wasm...' });

    await this.loadWasm();

    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !this.running) this.exec(this.inputEl.value);
    });
    this.setupMobileViewport(c);
    setTimeout(() => this.inputEl.focus(), 200);
  }

  private async loadWasm() {
    try {
      const adapter = this.app.vault.adapter;
      const wasmPath = `.obsidian/plugins/nullclaw-obsidian/nullclaw.wasm`;
      if (await adapter.exists(wasmPath)) {
        this.wasmBytes = await adapter.readBinary(wasmPath);
      } else {
        throw new Error('nullclaw.wasm not found in plugin directory');
      }
      const sizeKB = (this.wasmBytes.byteLength / 1024).toFixed(1);
      this.statusDot.className = 'nc-dot nc-dot-ready';
      if (this.settings.apiKey) {
        this.statusText.textContent = `NullClaw ready (${sizeKB} KB, LLM: ${this.settings.model})`;
        this.println('Welcome to NullClaw — direct chat mode. Type messages directly; use / for commands.', 'nc-info');
      } else {
        this.statusText.textContent = `NullClaw ready (${sizeKB} KB, local mode — set API key in settings)`;
        this.println('Welcome to NullClaw — local mode. Type messages directly; use / for commands.', 'nc-info');
        this.println('Go to Settings → NullClaw to set your API key for LLM mode.', 'nc-info');
      }
      this.println('Commands: /version, /help, /status, /memory list, /memory add key value, /identity show', 'nc-info');
      this.println('', 'nc-info');
    } catch (e: any) {
      this.statusDot.className = 'nc-dot nc-dot-error';
      this.statusText.textContent = 'Load failed';
      this.println(`Failed to load nullclaw.wasm: ${e.message}`, 'nc-error');
    }
  }

  private async exec(input: string) {
    const raw = input.trim();
    if (!raw || !this.wasmBytes) return;
    this.running = true;
    this.statusDot.className = 'nc-dot nc-dot-running';
    this.statusText.textContent = 'Running...';
    this.println(`❯ ${raw}`, 'nc-prompt');
    this.inputEl.value = '';
    this.inputEl.disabled = true;

    try {
      if (raw.startsWith('/')) {
        await this.execSlashCommand(raw.slice(1).trim());
      } else {
        await this.execChatMessage(raw);
      }
    } catch (e: any) {
      this.println(`Error: ${e.message}`, 'nc-error');
    } finally {
      this.running = false;
      this.statusDot.className = 'nc-dot nc-dot-ready';
      this.statusText.textContent = 'Ready';
      this.inputEl.disabled = false;
      this.inputEl.focus();
    }
  }

  private async execSlashCommand(command: string) {
    if (!command) {
      this.println('Slash commands: /help /version /status /memory list /read <path> /write <path> <content> /append <path> <content> /insert <path> <marker> <content> /search <query> /list [folder] /clear', 'nc-info');
      return;
    }

    const args = this.parseArgs(command);
    const cmd = args[0];

    // Chat/session commands
    if (cmd === 'clear') {
      this.messages = [];
      this.println('Context cleared.', 'nc-info');
      return;
    }

    // Vault tools as slash commands
    if (cmd === 'read') {
      if (!args[1]) return this.println('Usage: /read <path>', 'nc-error');
      this.println(await this.toolRead(args[1]), 'nc-output');
      return;
    }
    if (cmd === 'write') {
      if (!args[1] || args.length < 3) return this.println('Usage: /write <path> <content>', 'nc-error');
      await this.toolWrite(args[1], args.slice(2).join(' '));
      this.println(`Wrote ${args[1]}`, 'nc-output');
      return;
    }
    if (cmd === 'append') {
      if (!args[1] || args.length < 3) return this.println('Usage: /append <path> <content>', 'nc-error');
      await this.toolAppend(args[1], args.slice(2).join(' '));
      this.println(`Appended to ${args[1]}`, 'nc-output');
      return;
    }
    if (cmd === 'insert') {
      if (!args[1] || !args[2] || args.length < 4) return this.println('Usage: /insert <path> <marker> <content>', 'nc-error');
      await this.toolInsert(args[1], args[2], args.slice(3).join(' '));
      this.println(`Inserted into ${args[1]}`, 'nc-output');
      return;
    }
    if (cmd === 'search') {
      if (args.length < 2) return this.println('Usage: /search <query>', 'nc-error');
      this.println(await this.toolSearch(args.slice(1).join(' ')), 'nc-output');
      return;
    }
    if (cmd === 'list') {
      this.println(await this.toolList(args[1] ?? ''), 'nc-output');
      return;
    }

    // Compatibility: /agent -m hello still works, routed through direct chat.
    if (cmd === 'agent') {
      let message = '';
      const mIdx = args.indexOf('-m');
      const mIdx2 = args.indexOf('--message');
      if (mIdx >= 0 && mIdx + 1 < args.length) message = args.slice(mIdx + 1).join(' ');
      else if (mIdx2 >= 0 && mIdx2 + 1 < args.length) message = args.slice(mIdx2 + 1).join(' ');
      else message = args.slice(1).join(' ');
      if (!message) {
        this.println('Usage: /agent -m "message" 或直接输入 message', 'nc-error');
        return;
      }
      await this.execChatMessage(message);
      return;
    }

    // Local WASI commands: /version /help /status /memory ... /identity ...
    const result = await runNullclaw(
      this.wasmBytes!,
      args,
      this.settings,
      (text: string) => this.println(text, 'nc-info'),
    );
    if (result.stdout) this.println(result.stdout, 'nc-output');
    if (result.stderr) this.println(result.stderr, 'nc-error');
    if (!result.stdout && !result.stderr) this.println(`(exit: ${result.exitCode})`, 'nc-info');
  }

  private async execChatMessage(message: string) {
    if (this.settings.apiKey) {
      const reply = await this.callLLM(message);
      if (reply) {
        this.println(reply, 'nc-output');
        return;
      }
      this.println('[LLM call failed, falling back to local mode]', 'nc-info');
    }

    // No API key or LLM failure: use local WASI agent fallback.
    const result = await runNullclaw(
      this.wasmBytes!,
      ['agent', '-m', message],
      this.settings,
      (text: string) => this.println(text, 'nc-info'),
    );
    if (result.stdout) this.println(result.stdout, 'nc-output');
    if (result.stderr) this.println(result.stderr, 'nc-error');
    if (!result.stdout && !result.stderr) this.println(`(exit: ${result.exitCode})`, 'nc-info');
  }

  private async callLLM(message: string): Promise<string | null> {
    const base = (this.settings.apiBase || 'https://api.openai.com/v1').replace(/\/$/, '');
    const system = {
      role: 'system' as const,
      content: 'You are NullClaw, an AI assistant embedded in Obsidian Android. Maintain context across turns. You can use tools to read, write, append, insert, list and search the current Obsidian vault. Use tools when the user asks about notes/files or wants modifications. Be concise and answer in the user language.'
    };

    const history = this.messages.slice(-20);
    const requestMessages: any[] = [system, ...history, { role: 'user', content: message }];

    const tools = this.toolSchemas();

    try {
      const first = await this.chatCompletion(base, requestMessages, tools);
      const msg = first.choices?.[0]?.message;
      if (!msg) return null;

      // Tool calling path. Supports OpenAI/OpenRouter-compatible tool_calls.
      if (msg.tool_calls?.length) {
        const toolMessages: any[] = [...requestMessages, msg];
        for (const call of msg.tool_calls) {
          const toolName = call.function?.name;
          const argsRaw = call.function?.arguments || '{}';
          let parsed: any = {};
          try { parsed = JSON.parse(argsRaw); } catch { parsed = {}; }
          const result = await this.executeTool(toolName, parsed);
          toolMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: toolName,
            content: result,
          });
        }
        const second = await this.chatCompletion(base, toolMessages, tools);
        const finalText = second.choices?.[0]?.message?.content ?? '';
        this.remember(message, finalText);
        return finalText || null;
      }

      const text = msg.content ?? first.choices?.[0]?.text ?? '';
      this.remember(message, text);
      return text || null;
    } catch (e: any) {
      this.println(`[LLM fetch failed] ${e.message}`, 'nc-error');
      return null;
    }
  }

  private async chatCompletion(base: string, messages: any[], tools: any[]): Promise<any> {
    const body: any = {
      model: this.settings.model || 'gpt-4o-mini',
      messages,
      max_tokens: 2048,
      temperature: 0.7,
    };
    if (tools.length) body.tools = tools;

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.settings.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'app://obsidian-nullclaw',
        'X-Title': 'NullClaw Obsidian',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 500)}`);
    return JSON.parse(text);
  }

  private remember(user: string, assistant: string) {
    this.messages.push({ role: 'user', content: user });
    this.messages.push({ role: 'assistant', content: assistant });
    if (this.messages.length > 40) this.messages = this.messages.slice(-40);
  }

  private toolSchemas(): any[] {
    return [
      { type: 'function', function: { name: 'vault_search', description: 'Search markdown files in the Obsidian vault.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } } },
      { type: 'function', function: { name: 'vault_read', description: 'Read a file from the Obsidian vault.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
      { type: 'function', function: { name: 'vault_write', description: 'Overwrite/create a file in the Obsidian vault.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
      { type: 'function', function: { name: 'vault_append', description: 'Append content to a vault file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
      { type: 'function', function: { name: 'vault_insert', description: 'Insert content before/after a marker in a vault file.', parameters: { type: 'object', properties: { path: { type: 'string' }, marker: { type: 'string' }, content: { type: 'string' }, position: { type: 'string', enum: ['before', 'after'] } }, required: ['path', 'marker', 'content'] } } },
      { type: 'function', function: { name: 'vault_list', description: 'List files under a vault folder.', parameters: { type: 'object', properties: { folder: { type: 'string' }, limit: { type: 'number' } } } } },
    ];
  }

  private async executeTool(name: string, args: any): Promise<string> {
    try {
      if (name === 'vault_search') return await this.toolSearch(String(args.query ?? ''), Number(args.limit ?? 20));
      if (name === 'vault_read') return await this.toolRead(String(args.path ?? ''));
      if (name === 'vault_write') { await this.toolWrite(String(args.path ?? ''), String(args.content ?? '')); return `Wrote ${args.path}`; }
      if (name === 'vault_append') { await this.toolAppend(String(args.path ?? ''), String(args.content ?? '')); return `Appended to ${args.path}`; }
      if (name === 'vault_insert') { await this.toolInsert(String(args.path ?? ''), String(args.marker ?? ''), String(args.content ?? ''), String(args.position ?? 'after') as any); return `Inserted into ${args.path}`; }
      if (name === 'vault_list') return await this.toolList(String(args.folder ?? ''), Number(args.limit ?? 100));
      return `Unknown tool: ${name}`;
    } catch (e: any) {
      return `Tool error (${name}): ${e.message}`;
    }
  }

  private normalizePath(path: string): string {
    return path.replace(/^\/+/, '').trim();
  }

  private async toolRead(path: string): Promise<string> {
    const p = this.normalizePath(path);
    if (!p) throw new Error('Missing path');
    return await this.app.vault.adapter.read(p);
  }

  private async toolWrite(path: string, content: string) {
    const p = this.normalizePath(path);
    if (!p) throw new Error('Missing path');
    await this.ensureParentFolder(p);
    await this.app.vault.adapter.write(p, content);
  }

  private async toolAppend(path: string, content: string) {
    const p = this.normalizePath(path);
    if (!p) throw new Error('Missing path');
    let old = '';
    if (await this.app.vault.adapter.exists(p)) old = await this.app.vault.adapter.read(p);
    await this.toolWrite(p, old + (old.endsWith('\n') || old.length === 0 ? '' : '\n') + content);
  }

  private async toolInsert(path: string, marker: string, content: string, position: 'before' | 'after' = 'after') {
    const p = this.normalizePath(path);
    const old = await this.toolRead(p);
    const idx = old.indexOf(marker);
    if (idx < 0) throw new Error(`Marker not found: ${marker}`);
    const insertAt = position === 'before' ? idx : idx + marker.length;
    await this.toolWrite(p, old.slice(0, insertAt) + content + old.slice(insertAt));
  }

  private async toolSearch(query: string, limit = 20): Promise<string> {
    const q = query.toLowerCase();
    if (!q) throw new Error('Missing query');
    const files = this.app.vault.getMarkdownFiles();
    const hits: string[] = [];
    for (const file of files) {
      if (hits.length >= limit) break;
      const text = await this.app.vault.cachedRead(file);
      const lower = text.toLowerCase();
      const idx = lower.indexOf(q);
      if (idx >= 0 || file.path.toLowerCase().includes(q)) {
        const start = Math.max(0, idx - 80);
        const end = idx >= 0 ? Math.min(text.length, idx + q.length + 160) : 160;
        const snippet = idx >= 0 ? text.slice(start, end).replace(/\s+/g, ' ') : '(path match)';
        hits.push(`- ${file.path}: ${snippet}`);
      }
    }
    return hits.length ? hits.join('\n') : 'No matches.';
  }

  private async toolList(folder = '', limit = 100): Promise<string> {
    const prefix = this.normalizePath(folder);
    const files = this.app.vault.getFiles().filter((f: any) => !prefix || f.path.startsWith(prefix));
    return files.slice(0, limit).map((f: any) => `- ${f.path}`).join('\n') || 'No files.';
  }

  private async ensureParentFolder(path: string) {
    const parts = path.split('/');
    parts.pop();
    let cur = '';
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(cur))) await this.app.vault.adapter.mkdir(cur);
    }
  }

  private setupMobileViewport(container: HTMLElement) {
    const apply = () => {
      const vv = window.visualViewport;
      if (vv) {
        container.style.height = Math.max(260, vv.height - container.getBoundingClientRect().top - 4) + 'px';
      } else {
        container.style.height = '100%';
      }
    };
    this.viewportResizeHandler = apply;
    window.visualViewport?.addEventListener('resize', apply);
    window.visualViewport?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    setTimeout(apply, 50);
  }

  private parseArgs(input: string): string[] {
    const args: string[] = []; let cur = ''; let inQ = false;
    for (const ch of input) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ' ' && !inQ) { if (cur) { args.push(cur); cur = ''; } }
      else cur += ch;
    }
    if (cur) args.push(cur);
    return args;
  }

  private println(text: string, cls: string) {
    const line = this.outputEl.createDiv({ cls: `nc-line ${cls}` });
    line.textContent = text;
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  async onClose() {
    if (this.viewportResizeHandler) {
      window.visualViewport?.removeEventListener('resize', this.viewportResizeHandler);
      window.visualViewport?.removeEventListener('scroll', this.viewportResizeHandler);
      window.removeEventListener('resize', this.viewportResizeHandler);
    }
  }
}

class NullClawSettingTab extends PluginSettingTab {
  plugin: NullClawPlugin;
  constructor(app: any, plugin: NullClawPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h3', { text: 'NullClaw LLM Configuration' });
    containerEl.createEl('p', { text: 'Configure your LLM provider to enable AI responses. Uses OpenAI-compatible chat completions API.' });

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('Your API key (e.g. sk-... for OpenAI, or your provider key)')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder('sk-...')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => { this.plugin.settings.apiKey = value; await this.plugin.saveSettings(); });
      });

    new Setting(containerEl)
      .setName('API Base URL')
      .setDesc('OpenAI-compatible endpoint (default: OpenAI)')
      .addText((text) => {
        text.setPlaceholder('https://api.openai.com/v1')
          .setValue(this.plugin.settings.apiBase)
          .onChange(async (value) => { this.plugin.settings.apiBase = value; await this.plugin.saveSettings(); });
      });

    new Setting(containerEl)
      .setName('Model')
      .setDesc('Model name (default: gpt-4o-mini)')
      .addText((text) => {
        text.setPlaceholder('gpt-4o-mini')
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => { this.plugin.settings.model = value; await this.plugin.saveSettings(); });
      });

    containerEl.createEl('h3', { text: 'Supported providers' });
    const providers = [
      ['OpenAI', 'https://api.openai.com/v1', 'gpt-4o-mini'],
      ['OpenRouter', 'https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-4-20250514'],
      ['Groq', 'https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile'],
      ['DeepSeek', 'https://api.deepseek.com/v1', 'deepseek-chat'],
      ['Ollama (local)', 'http://localhost:11434/v1', 'llama3.2'],
    ];
    for (const [name, base, model] of providers) {
      containerEl.createEl('p', { text: `${name}: ${base} / ${model}` });
    }
  }
}


export default class NullClawPlugin extends Plugin {
  settings: NullClawSettings = DEFAULT_SETTINGS;
  private view: NullclawView | null = null;

  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => {
      this.view = new NullclawView(leaf, this.settings);
      return this.view;
    });
    this.addRibbonIcon('bot', 'NullClaw', () => this.openView());
    this.addCommand({ id: 'open-nullclaw', name: 'Open NullClaw Agent', callback: () => this.openView() });
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
    const leaf = existing.length > 0 ? existing[0] : ws.getRightLeaf(false)!;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    ws.revealLeaf(leaf);
  }
}
