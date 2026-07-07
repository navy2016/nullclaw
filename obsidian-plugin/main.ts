import { Plugin, WorkspaceLeaf, ItemView, Setting, PluginSettingTab, MarkdownView, requestUrl } from 'obsidian';
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
  private mobileBottomChromeHeight = 0;
  private attachedRefs: string[] = [];

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
    const st = c.createDiv({ cls: 'nullclaw-status' });
    this.statusDot = st.createSpan({ cls: 'nc-dot nc-dot-error' });
    this.statusText = st.createSpan({ text: 'Loading nullclaw.wasm...' });
    const row = c.createDiv({ cls: 'nullclaw-input-row' });
    row.createSpan({ cls: 'nullclaw-input-prompt', text: '❯' });
    this.inputEl = row.createEl('input', { cls: 'nullclaw-input', attr: { type: 'text', placeholder: '直接输入发给 AI；命令用 /help /version /memory list ...' } });

    await this.loadWasm();

    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !this.running) this.exec(this.inputEl.value);
    });
    this.setupMobileViewport(c);
    this.setupFileDropAndPaste(c);
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
    this.println(`❯ ${raw}`, 'nc-prompt', true);
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
    }
  }

  private async execSlashCommand(command: string) {
    if (!command) {
      this.println('Slash commands: /help /version /status /compact /digest-current /review-inbox /apply-memory /vault-doctor /feedback good|bad <text> /read /write /append /insert /search /list /clear', 'nc-info');
      return;
    }

    const args = this.parseArgs(command);
    const cmd = args[0];

    // Chat/session commands
    if (cmd === 'clear') {
      this.messages = [];
      this.attachedRefs = [];
      this.println('Context cleared.', 'nc-info');
      return;
    }
    if (cmd === 'compact') { await this.skillCompact(); return; }
    if (cmd === 'digest-current') { await this.skillDigestCurrent(); return; }
    if (cmd === 'review-inbox') { await this.skillReviewInbox(); return; }
    if (cmd === 'apply-memory') { await this.skillApplyMemory(args.slice(1).includes('--yes')); return; }
    if (cmd === 'vault-doctor') { await this.skillVaultDoctor(); return; }
    if (cmd === 'feedback') {
      if (!args[1] || args.length < 3) return this.println('Usage: /feedback good|bad <text>', 'nc-error');
      await this.writeFeedback(args[1], args.slice(2).join(' '));
      this.println('Feedback saved.', 'nc-output');
      return;
    }
    if (cmd === 'init-memory') { await this.ensureMemoryScaffold(); this.println('Memory scaffold initialized.', 'nc-output'); return; }

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
    if (result.stdout) await this.streamPrint(result.stdout, 'nc-output', true);
    if (result.stderr) await this.streamPrint(result.stderr, 'nc-error', true);
    if (!result.stdout && !result.stderr) this.println(`(exit: ${result.exitCode})`, 'nc-info');
  }

  private async execChatMessage(message: string) {
    if (this.settings.apiKey) {
      const reply = await this.callLLM(message);
      if (reply) {
        await this.streamPrint(reply, 'nc-output', true);
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
    if (result.stdout) await this.streamPrint(result.stdout, 'nc-output', true);
    if (result.stderr) await this.streamPrint(result.stderr, 'nc-error', true);
    if (!result.stdout && !result.stderr) this.println(`(exit: ${result.exitCode})`, 'nc-info');
  }

  private async callLLM(message: string): Promise<string | null> {
    const base = (this.settings.apiBase || 'https://api.openai.com/v1').replace(/\/$/, '');
    const system = {
      role: 'system' as const,
      content: 'You are NullClaw, an AI assistant embedded in Obsidian Android. Maintain context across turns. You can use tools to read, write, append, insert, list and search the current Obsidian vault. Use tools when the user asks about notes/files or wants modifications. Be concise and answer in the user language.'
    };

    await this.ensureMemoryScaffold();
    const palaceContext = await this.loadPalaceContext(message);
    const refContext = await this.resolveMessageReferences(message);
    const enriched = [palaceContext, refContext, `User message:
${message}`].filter(Boolean).join('\n\n---\n\n');
    const history = this.messages.slice(-20);
    const requestMessages: any[] = [system, ...history, { role: 'user', content: enriched }];

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

    // Use Obsidian's native requestUrl instead of browser fetch.
    // Android WebView fetch is frequently blocked by CORS / network policy and reports only "Failed to fetch".
    const resp = await requestUrl({
      url: `${base}/chat/completions`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.settings.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'app://obsidian-nullclaw',
        'X-Title': 'NullClaw Obsidian',
      },
      body: JSON.stringify(body),
      throw: false,
    });
    const status = resp.status;
    const text = resp.text ?? '';
    if (status < 200 || status >= 300) throw new Error(`${status} ${text.slice(0, 800)}`);
    return resp.json ?? JSON.parse(text);
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
      const rect = container.getBoundingClientRect();
      const parent = container.parentElement as HTMLElement | null;
      const statusHeight = this.statusText?.parentElement?.getBoundingClientRect().height ?? 22;
      const inputHeight = this.inputEl?.parentElement?.getBoundingClientRect().height ?? 48;
      const composerHeight = statusHeight + inputHeight;
      container.style.setProperty('--nullclaw-composer-height', `${composerHeight}px`);

      const visualBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      const paneBottom = parent ? parent.getBoundingClientRect().bottom : rect.bottom;
      const keyboardInset = Math.max(0, window.innerHeight - visualBottom);
      const keyboardOpen = keyboardInset > 80;

      // Obsidian Mobile has its own bottom chrome/card below the plugin pane.
      // When IME is closed, measure that chrome height once:
      //   bottomChrome = viewport bottom - pane bottom.
      // When IME opens, the pane bottom remains at the old top of Obsidian chrome,
      // so the composer floats above the keyboard by exactly that chrome height.
      // Fix: only while keyboard is open, allow the pane target bottom to descend
      // by the measured chrome height, but never past the visual viewport bottom.
      if (!keyboardOpen) {
        this.mobileBottomChromeHeight = Math.max(0, window.innerHeight - paneBottom);
      }
      const correctedPaneBottom = keyboardOpen ? paneBottom + this.mobileBottomChromeHeight : paneBottom;
      const effectiveBottom = Math.min(visualBottom, correctedPaneBottom);
      const available = Math.max(220, effectiveBottom - rect.top);
      container.style.setProperty('--nullclaw-view-height', `${available}px`);
      container.style.height = `${available}px`;
      container.style.maxHeight = `${available}px`;
      if (parent) {
        parent.style.height = `${available}px`;
        parent.style.maxHeight = `${available}px`;
        parent.style.overflow = 'hidden';
      }
    };
    this.viewportResizeHandler = apply;
    window.visualViewport?.addEventListener('resize', apply);
    window.visualViewport?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    this.inputEl.addEventListener('focus', () => setTimeout(apply, 80));
    this.inputEl.addEventListener('focus', () => setTimeout(apply, 260));
    this.inputEl.addEventListener('blur', () => setTimeout(apply, 80));
    setTimeout(apply, 50);
    setTimeout(apply, 300);
  }

  private async ensureMemoryScaffold() {
    const dirs = ['raw', 'sources', 'memory', 'memory/inbox', 'memory/feedback', 'people', 'projects', 'wiki', 'decisions', 'daily', 'palace'];
    for (const d of dirs) if (!(await this.app.vault.adapter.exists(d))) await this.app.vault.adapter.mkdir(d);
    const defaults: Record<string, string> = {
      'profile.md': '# Profile\n\n用户画像，待沉淀。\n',
      'vault.md': '# Vault\n\n这个知识库的用途、结构和长期目标。\n',
      'style.md': '# Style\n\n输出风格偏好。\n',
      'memory_policy.md': '# Memory Policy\n\n长期记忆写入 people/projects/wiki/decisions/daily 前需要人工确认。\n',
      'palace/digest_note_room.md': '# digest_note_room\n\n触发：消化当前笔记或选区。\n必读：profile.md → vault.md → style.md → memory_policy.md → 当前笔记。\n输出：memory/inbox/YYYY-MM-DD.md。\n限制：不直接写入长期记忆。\n',
    };
    for (const [path, content] of Object.entries(defaults)) {
      if (!(await this.app.vault.adapter.exists(path))) await this.app.vault.adapter.write(path, content);
    }
  }

  private async loadPalaceContext(message: string): Promise<string> {
    const candidates = ['profile.md', 'vault.md', 'style.md', 'memory_policy.md'];
    if (/digest|消化|整理|总结/.test(message)) candidates.push('palace/digest_note_room.md');
    const chunks: string[] = [];
    for (const p of candidates) {
      if (await this.app.vault.adapter.exists(p)) {
        const text = await this.app.vault.adapter.read(p);
        chunks.push(`Context file: ${p}\n${text.slice(0, 6000)}`);
      }
    }
    return chunks.length ? `Memory Palace Context:\n\n${chunks.join('\n\n')}` : '';
  }

  private async resolveMessageReferences(message: string): Promise<string> {
    const refs = new Set<string>();
    for (const m of message.matchAll(/@([^\s]+\.md)/g)) refs.add(m[1]);
    for (const m of message.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = m[1].split('|')[0].trim();
      const found = this.app.metadataCache.getFirstLinkpathDest(target, '');
      if (found) refs.add(found.path);
      else if (target.endsWith('.md')) refs.add(target);
    }
    for (const r of this.attachedRefs) refs.add(r);
    const chunks: string[] = [];
    for (const ref of refs) {
      try {
        if (await this.app.vault.adapter.exists(ref)) chunks.push(`Referenced note: ${ref}\n${(await this.app.vault.adapter.read(ref)).slice(0, 12000)}`);
      } catch {}
    }
    return chunks.length ? `Explicit References:\n\n${chunks.join('\n\n')}` : '';
  }

  private getActiveMarkdownContext(): { path: string; text: string; selection: string } | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file;
    if (!view || !file) return null;
    let selection = '';
    try { selection = view.editor.getSelection(); } catch {}
    let text = '';
    try { text = view.editor.getValue(); } catch {}
    return { path: file.path, text, selection };
  }

  private async skillCompact() {
    if (!this.settings.apiKey) {
      this.messages = this.messages.slice(-8);
      this.println('Context compacted locally: kept last 8 messages.', 'nc-output');
      return;
    }
    const text = this.messages.map(m => `${m.role}: ${m.content}`).join('\n').slice(-24000);
    const summary = await this.callLLM(`请压缩下面会话上下文，保留用户偏好、待办、重要事实和未完成任务：\n\n${text}`);
    if (summary) {
      this.messages = [{ role: 'system', content: `Compressed context:\n${summary}` }];
      this.println('Context compacted.\n' + summary, 'nc-output');
    }
  }

  private async skillDigestCurrent() {
    await this.ensureMemoryScaffold();
    const ctx = this.getActiveMarkdownContext();
    if (!ctx) return this.println('No active markdown note.', 'nc-error');
    const target = ctx.selection || ctx.text;
    const prompt = `消化当前 Obsidian 笔记，输出四部分：\n1. 要点\n2. 关联人物/项目/概念\n3. 可沉淀长期记忆候选（标注 people/projects/wiki/decisions/daily）\n4. 待办\n\n来源：${ctx.path}\n\n内容：\n${target.slice(0, 24000)}`;
    const result = this.settings.apiKey ? await this.callLLM(prompt) : `# Digest: ${ctx.path}\n\n${target.slice(0, 4000)}`;
    if (!result) return;
    const today = new Date().toISOString().slice(0, 10);
    const out = `memory/inbox/${today}.md`;
    await this.toolAppend(out, `\n## ${new Date().toLocaleString()} — ${ctx.path}\n\n${result}\n`);
    this.println(`Digest written to ${out}\n\n${result}`, 'nc-output');
  }

  private async skillReviewInbox() {
    await this.ensureMemoryScaffold();
    const inbox = await this.collectFolderText('memory/inbox');
    if (!inbox) return this.println('memory/inbox is empty.', 'nc-info');
    const prompt = `审核 memory/inbox 待沉淀内容，去重归纳为可人工确认清单。每条标注建议归属 people/projects/wiki/decisions/daily、置信度、来源。\n\n${inbox.slice(0, 30000)}`;
    const result = this.settings.apiKey ? await this.callLLM(prompt) : inbox;
    if (!result) return;
    const out = `memory/inbox/review-${new Date().toISOString().slice(0,10)}.md`;
    await this.toolWrite(out, result);
    this.println(`Review written to ${out}\n\n${result}`, 'nc-output');
  }

  private async skillApplyMemory(yes: boolean) {
    await this.ensureMemoryScaffold();
    const inbox = await this.collectFolderText('memory/inbox');
    if (!inbox) return this.println('memory/inbox is empty.', 'nc-info');
    const prompt = `基于下面 inbox，生成长期记忆合并方案。不要直接写入，输出要写入哪些文件和具体内容。目标目录：people/projects/wiki/decisions/daily/profile.md/style.md。\n\n${inbox.slice(0, 30000)}`;
    const plan = this.settings.apiKey ? await this.callLLM(prompt) : inbox;
    if (!plan) return;
    const out = `memory/apply-plan-${new Date().toISOString().slice(0,10)}.md`;
    await this.toolWrite(out, plan);
    this.println(`Apply plan written to ${out}. Review manually before applying.\n\n${plan}`, 'nc-output');
  }

  private async skillVaultDoctor() {
    await this.ensureMemoryScaffold();
    const files = this.app.vault.getFiles();
    const markdown = this.app.vault.getMarkdownFiles();
    const rawFiles = files.filter((f: any) => f.path.startsWith('raw/'));
    const emptyMd: string[] = [];
    for (const f of markdown.slice(0, 500)) {
      try { if ((await this.app.vault.cachedRead(f)).trim().length < 20) emptyMd.push(f.path); } catch {}
    }
    const report = `# Vault Doctor\n\n- total files: ${files.length}\n- markdown files: ${markdown.length}\n- raw files: ${rawFiles.length}\n- empty/near-empty notes: ${emptyMd.length}\n\n## Empty notes\n${emptyMd.slice(0,50).map(p=>`- ${p}`).join('\n') || 'None'}\n\n## Raw files\n${rawFiles.slice(0,80).map((f:any)=>`- ${f.path}`).join('\n') || 'None'}\n`;
    const out = `memory/vault-doctor-${new Date().toISOString().slice(0,10)}.md`;
    await this.toolWrite(out, report);
    this.println(`Vault doctor report written to ${out}\n\n${report}`, 'nc-output');
  }

  private async writeFeedback(kind: string, text: string) {
    await this.ensureMemoryScaffold();
    const today = new Date().toISOString().slice(0,10);
    await this.toolAppend(`memory/feedback/${today}.md`, `- ${new Date().toLocaleString()} [${kind}]: ${text}`);
  }

  private async collectFolderText(folder: string): Promise<string> {
    const files = this.app.vault.getMarkdownFiles().filter((f: any) => f.path.startsWith(folder + '/'));
    const chunks: string[] = [];
    for (const f of files.slice(0, 100)) {
      try { chunks.push(`## ${f.path}\n${(await this.app.vault.cachedRead(f)).slice(0, 12000)}`); } catch {}
    }
    return chunks.join('\n\n');
  }

  private setupFileDropAndPaste(container: HTMLElement) {
    const saveFiles = async (files: FileList | File[]) => {
      await this.ensureMemoryScaffold();
      for (const file of Array.from(files)) {
        const safe = file.name.replace(/[\\/:*?"<>|]/g, '_');
        let path = `raw/${safe}`;
        let i = 1;
        while (await this.app.vault.adapter.exists(path)) {
          const dot = safe.lastIndexOf('.');
          path = dot > 0 ? `raw/${safe.slice(0,dot)}-${i}${safe.slice(dot)}` : `raw/${safe}-${i}`;
          i++;
        }
        const buf = await file.arrayBuffer();
        await this.app.vault.adapter.writeBinary(path, buf);
        this.attachedRefs.push(path);
        this.inputEl.value = (this.inputEl.value + ` @${path}`).trim();
        this.println(`Saved attachment to ${path}`, 'nc-info');
      }
    };
    container.addEventListener('dragover', (e) => { e.preventDefault(); });
    container.addEventListener('drop', async (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer?.files?.length) await saveFiles(e.dataTransfer.files);
    });
    this.inputEl.addEventListener('paste', async (e: ClipboardEvent) => {
      if (e.clipboardData?.files?.length) await saveFiles(e.clipboardData.files);
    });
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

  private isNearBottom(threshold = 64): boolean {
    const el = this.outputEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }

  private stickToBottom() {
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  private println(text: string, cls: string, forceStick = false) {
    const shouldStick = forceStick || this.isNearBottom();
    const line = this.outputEl.createDiv({ cls: `nc-line ${cls}` });
    line.textContent = text;
    if (shouldStick) this.stickToBottom();
    return line;
  }

  private async streamPrint(text: string, cls: string, forceStick = false) {
    const shouldStickInitially = forceStick || this.isNearBottom();
    const line = this.outputEl.createDiv({ cls: `nc-line ${cls}` });
    // For short command outputs, stream by line; for long LLM text, stream in chunks.
    const chunks = text.length > 600 ? text.match(/[\s\S]{1,24}/g) ?? [text] : text.split(/(?<=\n)/g);
    let acc = '';
    for (const chunk of chunks) {
      acc += chunk;
      line.textContent = acc;
      if (shouldStickInitially && this.isNearBottom(180)) this.stickToBottom();
      await new Promise(resolve => setTimeout(resolve, text.length > 600 ? 8 : 12));
    }
    if (shouldStickInitially) this.stickToBottom();
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
