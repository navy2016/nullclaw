import { Plugin, WorkspaceLeaf, ItemView, Setting, PluginSettingTab, MarkdownView, requestUrl } from 'obsidian';
import { runNullclaw } from './wasi-shim';

const VIEW_TYPE = 'nullclaw-agent-view';

interface NullClawSettings {
  apiKey: string;
  apiBase: string;
  model: string;
}

type ChatRole = 'system' | 'user' | 'assistant' | 'tool';
interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  createdAt?: number;
}
interface SessionData {
  version: 1;
  id: string;
  title: string;
  summary: string;
  messages: ChatMessage[];
  refs: string[];
  updatedAt: number;
}
interface StreamResult {
  response: any;
  streamed: boolean;
  renderedText: string;
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
  private messages: ChatMessage[] = [];
  private sessionId = 'current';
  private sessionSummary = '';
  private refsEl!: HTMLDivElement;
  private mentionEl!: HTMLDivElement;
  private mentionItems: string[] = [];
  private mentionIndex = 0;
  private mentionStart = -1;
  private responseWasStreamed = false;
  private viewportResizeHandler?: () => void;
  private mobileClosedComposerGap = 0;
  private mobileBottomChromeHeight = 0;
  private imeFocusShift = 0;
  private closedVisualHeight = 0;
  private attachedRefs: string[] = [];
  private attachedSelection = '';

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
    const inputWrap = c.createDiv({ cls: 'nullclaw-input-wrap' });
    this.refsEl = inputWrap.createDiv({ cls: 'nullclaw-refs' });
    this.refsEl.hide();
    this.mentionEl = inputWrap.createDiv({ cls: 'nullclaw-mention-menu' });
    this.mentionEl.hide();
    const row = inputWrap.createDiv({ cls: 'nullclaw-input-row' });
    row.createSpan({ cls: 'nullclaw-input-prompt', text: '❯' });
    this.inputEl = row.createEl('input', { cls: 'nullclaw-input', attr: { type: 'text', placeholder: '直接输入发给 AI；命令用 /help /version /memory list ...' } });
    const st = c.createDiv({ cls: 'nullclaw-status' });
    this.statusDot = st.createSpan({ cls: 'nc-dot nc-dot-error' });
    this.statusText = st.createSpan({ text: 'Loading nullclaw.wasm...' });

    await this.loadWasm();
    await this.restoreSession();

    this.inputEl.addEventListener('input', () => this.updateMentionMenu());
    this.inputEl.addEventListener('keydown', (e) => {
      if (!this.mentionEl.isShown()) {
        if (e.key === 'Enter' && !this.running) this.exec(this.inputEl.value);
        return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); this.moveMention(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.moveMention(-1); return; }
      if (e.key === 'Escape') { e.preventDefault(); this.closeMentionMenu(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.chooseMention(this.mentionIndex); }
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
    this.renderMessageCard('user', raw, true);
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
      await this.saveSession();
    }
  }

  private async execSlashCommand(command: string) {
    if (!command) {
      this.println('Slash commands: /help /version /status /compact /digest-current /review-inbox /apply-memory /vault-doctor /feedback good|bad <text> /current /selection /read /write /append /insert /search /list /clear', 'nc-info');
      return;
    }

    const args = this.parseArgs(command);
    const cmd = args[0];

    // Chat/session commands
    if (cmd === 'clear') {
      this.messages = [];
      this.sessionSummary = '';
      this.attachedRefs = [];
      this.attachedSelection = '';
      this.outputEl.empty();
      this.renderRefs();
      await this.saveSession();
      this.println('New empty session started.', 'nc-info');
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

    // Current editor context
    if (cmd === 'current') {
      const ctx = this.getActiveMarkdownContext();
      if (!ctx) return this.println('No active markdown note.', 'nc-error');
      if (!this.attachedRefs.includes(ctx.path)) this.attachedRefs.push(ctx.path);
      this.renderRefs(); await this.saveSession();
      this.println(`Attached current note: ${ctx.path}`, 'nc-info');
      return;
    }
    if (cmd === 'selection') {
      const ctx = this.getActiveMarkdownContext();
      if (!ctx?.selection) return this.println('No active selection.', 'nc-error');
      this.attachedSelection = ctx.selection.slice(0, 16000);
      this.println(`Attached current selection (${this.attachedSelection.length} chars).`, 'nc-info');
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
      const content = args.slice(2).join(' ');
      if (await this.confirmMutation('Write', args[1], content)) {
        await this.toolWrite(args[1], content);
        this.println(`Wrote ${args[1]}`, 'nc-output');
      }
      return;
    }
    if (cmd === 'append') {
      if (!args[1] || args.length < 3) return this.println('Usage: /append <path> <content>', 'nc-error');
      const content = args.slice(2).join(' ');
      if (await this.confirmMutation('Append', args[1], content)) {
        await this.toolAppend(args[1], content);
        this.println(`Appended to ${args[1]}`, 'nc-output');
      }
      return;
    }
    if (cmd === 'insert') {
      if (!args[1] || !args[2] || args.length < 4) return this.println('Usage: /insert <path> <marker> <content>', 'nc-error');
      const content = args.slice(3).join(' ');
      if (await this.confirmMutation('Insert', args[1], content, args[2])) {
        await this.toolInsert(args[1], args[2], content);
        this.println(`Inserted into ${args[1]}`, 'nc-output');
      }
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
        if (!this.responseWasStreamed) this.renderMessageCard('assistant', reply, true);
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
    if (result.stdout) {
      const reply = result.stdout.trim();
      this.renderMessageCard('assistant', reply, true);
      this.remember(message, reply);
    }
    if (result.stderr) this.println(result.stderr, 'nc-error');
    if (!result.stdout && !result.stderr) this.println(`(exit: ${result.exitCode})`, 'nc-info');
  }

  private async callLLM(message: string): Promise<string | null> {
    this.responseWasStreamed = false;
    const base = (this.settings.apiBase || 'https://api.openai.com/v1').replace(/\/$/, '');
    const system = {
      role: 'system' as const,
      content: 'You are NullClaw, an AI assistant embedded in Obsidian Android. Maintain context across turns. You can use tools to read, write, append, insert, list and search the current Obsidian vault. Use tools when the user asks about notes/files or wants modifications. Be concise and answer in the user language.'
    };

    await this.ensureMemoryScaffold();
    const palaceContext = await this.loadPalaceContext(message);
    const refContext = await this.resolveMessageReferences(message);
    const enriched = [this.sessionSummary ? `Compressed session context:
${this.sessionSummary}` : '', palaceContext, refContext, `User message:
${message}`].filter(Boolean).join('\n\n---\n\n');
    const history = this.messages.slice(-20);
    const requestMessages: any[] = [system, ...history, { role: 'user', content: enriched }];

    const tools = this.toolSchemas();

    try {
      const first = await this.chatCompletionStreaming(base, requestMessages, tools);
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
        const second = await this.chatCompletionStreaming(base, toolMessages, tools);
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

  private async chatCompletionStreaming(base: string, messages: any[], tools: any[]): Promise<any> {
    const body: any = {
      model: this.settings.model || 'gpt-4o-mini',
      messages,
      max_tokens: 2048,
      temperature: 0.7,
      stream: true,
    };
    if (tools.length) body.tools = tools;

    let card: { body: HTMLDivElement; details: HTMLDetailsElement } | null = null;
    let content = '';
    const toolCalls: any[] = [];
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.settings.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'app://obsidian-nullclaw',
          'X-Title': 'NullClaw Obsidian',
        },
        body: JSON.stringify(body),
      });
      if (!response.ok || !response.body) throw new Error(`stream HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let event: any;
          try { event = JSON.parse(payload); } catch { continue; }
          const delta = event.choices?.[0]?.delta ?? {};
          if (delta.content) {
            content += delta.content;
            if (!card) card = this.createStreamingCard();
            card.body.textContent = content;
            if (this.isNearBottom(160)) this.stickToBottom();
          }
          for (const tc of delta.tool_calls ?? []) {
            const i = tc.index ?? 0;
            toolCalls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
          }
        }
      }
      if (card) {
        card.details.open = true;
        card.body.classList.add('nc-stream-complete');
        this.responseWasStreamed = true;
      }
      return { choices: [{ message: { role: 'assistant', content, tool_calls: toolCalls.length ? toolCalls : undefined } }] };
    } catch (error) {
      if (card) card.details.remove();
      this.responseWasStreamed = false;
      this.println('Streaming unavailable; using mobile compatibility mode.', 'nc-info');
      return await this.chatCompletion(base, messages, tools);
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
    void this.saveSession();
  }

  private toolSchemas(): any[] {
    return [
      { type: 'function', function: { name: 'vault_current_context', description: 'Read the currently active Obsidian markdown note and current selection.', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'vault_search', description: 'Search markdown files in the Obsidian vault.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } } },
      { type: 'function', function: { name: 'vault_read', description: 'Read a file from the Obsidian vault.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
      { type: 'function', function: { name: 'vault_write', description: 'Overwrite/create a file in the Obsidian vault.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
      { type: 'function', function: { name: 'vault_append', description: 'Append content to a vault file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
      { type: 'function', function: { name: 'vault_insert', description: 'Insert content before/after a marker in a vault file.', parameters: { type: 'object', properties: { path: { type: 'string' }, marker: { type: 'string' }, content: { type: 'string' }, position: { type: 'string', enum: ['before', 'after'] } }, required: ['path', 'marker', 'content'] } } },
      { type: 'function', function: { name: 'vault_list', description: 'List files under a vault folder.', parameters: { type: 'object', properties: { folder: { type: 'string' }, limit: { type: 'number' } } } } },
    ];
  }

  private async executeTool(name: string, args: any): Promise<string> {
    const block = this.createToolBlock(name, args);
    try {
      let result = '';
      if (name === 'vault_current_context') {
        const ctx = this.getActiveMarkdownContext();
        result = ctx ? `Path: ${ctx.path}
Selection:
${ctx.selection}

Note:
${ctx.text.slice(0, 24000)}` : 'No active markdown note.';
      } else if (name === 'vault_search') result = await this.toolSearch(String(args.query ?? ''), Number(args.limit ?? 20));
      else if (name === 'vault_read') result = await this.toolRead(String(args.path ?? ''));
      else if (name === 'vault_list') result = await this.toolList(String(args.folder ?? ''), Number(args.limit ?? 100));
      else if (name === 'vault_write') {
        const path = String(args.path ?? ''); const content = String(args.content ?? '');
        if (!(await this.confirmMutation('Write', path, content))) result = 'User cancelled write.';
        else { await this.toolWrite(path, content); result = `Wrote ${path}`; }
      } else if (name === 'vault_append') {
        const path = String(args.path ?? ''); const content = String(args.content ?? '');
        if (!(await this.confirmMutation('Append', path, content))) result = 'User cancelled append.';
        else { await this.toolAppend(path, content); result = `Appended to ${path}`; }
      } else if (name === 'vault_insert') {
        const path = String(args.path ?? ''); const content = String(args.content ?? ''); const marker = String(args.marker ?? '');
        if (!(await this.confirmMutation('Insert', path, content, marker))) result = 'User cancelled insert.';
        else { await this.toolInsert(path, marker, content, String(args.position ?? 'after') as any); result = `Inserted into ${path}`; }
      } else result = `Unknown tool: ${name}`;
      block.result.textContent = result.slice(0, 12000);
      block.details.classList.add('nc-tool-success');
      return result;
    } catch (e: any) {
      const result = `Tool error (${name}): ${e.message}`;
      block.result.textContent = result;
      block.details.classList.add('nc-tool-error');
      return result;
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
    let imeActive = false;
    let closedVisualHeight = 0;
    let keyboardWasShrunk = false;
    let shift = 0;

    const currentVisualHeight = () => window.visualViewport?.height ?? window.innerHeight;

    const relaxAncestorOverflow = () => {
      let node: HTMLElement | null = container;
      for (let i = 0; node && i < 8; i++, node = node.parentElement as HTMLElement | null) {
        node.style.overflow = 'visible';
      }
    };

    const measureShift = () => {
      const inputRow = this.inputEl?.parentElement as HTMLElement | null;
      if (!inputRow) return 0;
      const r = inputRow.getBoundingClientRect();
      const gapBelow = Math.max(0, window.innerHeight - r.bottom - 4);
      // The full gap puts the input under the IME; subtract part of the row height.
      // 0.6 is the midpoint between the tested "too high" and "covered" states.
      return Math.max(0, gapBelow - r.height * 0.6 - 15);
    };

    const apply = () => {
      const rect = container.getBoundingClientRect();
      const parent = container.parentElement as HTMLElement | null;
      const paneBottom = parent ? parent.getBoundingClientRect().bottom : rect.bottom;
      const available = Math.max(220, paneBottom - rect.top);
      container.style.setProperty('--nullclaw-view-height', `${available}px`);
      container.style.setProperty('--nullclaw-ime-shift', `${imeActive ? shift : 0}px`);
      container.style.height = `${available}px`;
      container.style.maxHeight = `${available}px`;

      // Apply directly to elements too, bypassing CSS-variable/specificity issues.
      const statusEl = this.statusText?.parentElement as HTMLElement | null;
      const inputRow = this.inputEl?.parentElement as HTMLElement | null;
      const inputWrap = inputRow?.parentElement as HTMLElement | null;
      const transform = imeActive ? `translateY(${shift}px)` : '';
      if (statusEl) statusEl.style.setProperty('transform', transform, 'important');
      if (inputWrap) inputWrap.style.setProperty('transform', transform, 'important');

      // Keyboard state machine: do not immediately deactivate on focus. First observe a
      // meaningful viewport shrink; only a later recovery means the IME was collapsed.
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
      container.addClass('nullclaw-ime-active');
      relaxAncestorOverflow();
      apply();
      setTimeout(() => { if (imeActive) apply(); }, 80);
      setTimeout(() => { if (imeActive) apply(); }, 260);
    };

    const deactivateIme = () => {
      imeActive = false;
      keyboardWasShrunk = false;
      shift = 0;
      container.removeClass('nullclaw-ime-active');
      container.style.setProperty('--nullclaw-ime-shift', '0px');
      const statusEl = this.statusText?.parentElement as HTMLElement | null;
      const inputRow = this.inputEl?.parentElement as HTMLElement | null;
      const inputWrap = inputRow?.parentElement as HTMLElement | null;
      if (statusEl) statusEl.style.removeProperty('transform');
      if (inputWrap) inputWrap.style.removeProperty('transform');
      setTimeout(apply, 50);
    };

    this.viewportResizeHandler = apply;
    window.visualViewport?.addEventListener('resize', apply);
    window.visualViewport?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    this.inputEl.addEventListener('focus', activateIme);
    this.inputEl.addEventListener('blur', deactivateIme);
    setTimeout(apply, 50);
    setTimeout(apply, 300);
  }

  private async ensureMemoryScaffold() {
    const dirs = ['raw', 'sources', 'memory', 'memory/inbox', 'memory/feedback', 'people', 'projects', 'wiki', 'decisions', 'daily', 'palace', '.nullclaw', '.nullclaw/sessions', '.nullclaw/skills'];
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
    if (this.attachedSelection) chunks.push(`Current editor selection:
${this.attachedSelection}`);
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
      this.sessionSummary = this.messages.map(m => `${m.role}: ${m.content}`).join('\n').slice(-12000);
      await this.saveSession();
      this.println('Context compacted locally: kept last 8 messages.', 'nc-output');
      return;
    }
    const text = this.messages.map(m => `${m.role}: ${m.content}`).join('\n').slice(-24000);
    const summary = await this.callLLM(`请压缩下面会话上下文，保留用户偏好、待办、重要事实和未完成任务：\n\n${text}`);
    if (summary) {
      this.sessionSummary = summary;
      this.messages = [];
      await this.saveSession();
      this.println('Context compacted and persisted.\n' + summary, 'nc-output');
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
        this.renderRefs();
        void this.saveSession();
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

  private sessionPath(): string {
    return `.nullclaw/sessions/${this.sessionId}.json`;
  }

  private async restoreSession() {
    await this.ensureMemoryScaffold();
    const path = this.sessionPath();
    if (!(await this.app.vault.adapter.exists(path))) return;
    try {
      const data = JSON.parse(await this.app.vault.adapter.read(path)) as SessionData;
      this.messages = Array.isArray(data.messages) ? data.messages : [];
      this.sessionSummary = data.summary || '';
      this.attachedRefs = Array.isArray(data.refs) ? data.refs : [];
      if (this.messages.length) {
        this.outputEl.empty();
        this.println(`Restored session: ${data.title || 'Current session'}`, 'nc-info');
        for (const m of this.messages) {
          if (m.role === 'user' || m.role === 'assistant') this.renderMessageCard(m.role, m.content, false);
        }
      }
      this.renderRefs();
      this.stickToBottom();
    } catch (e: any) {
      this.println(`Session restore failed: ${e.message}`, 'nc-error');
    }
  }

  private async saveSession() {
    try {
      await this.ensureMemoryScaffold();
      const firstUser = this.messages.find(m => m.role === 'user')?.content || 'Current session';
      const data: SessionData = {
        version: 1,
        id: this.sessionId,
        title: firstUser.replace(/\s+/g, ' ').slice(0, 48),
        summary: this.sessionSummary,
        messages: this.messages.slice(-80),
        refs: [...this.attachedRefs],
        updatedAt: Date.now(),
      };
      await this.app.vault.adapter.write(this.sessionPath(), JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn('NullClaw session save failed', e);
    }
  }

  private renderMessageCard(role: 'user' | 'assistant', text: string, forceStick: boolean) {
    const shouldStick = forceStick || this.isNearBottom();
    const card = this.outputEl.createDiv({ cls: `nc-message nc-message-${role}` });
    const header = card.createDiv({ cls: 'nc-message-header' });
    header.createSpan({ text: role === 'user' ? 'You' : 'NullClaw' });
    const body = card.createDiv({ cls: 'nc-message-body' });
    body.textContent = text;
    if (role === 'assistant') {
      const actions = card.createDiv({ cls: 'nc-message-actions' });
      const copy = actions.createEl('button', { text: 'Copy' });
      copy.addEventListener('click', () => navigator.clipboard?.writeText(text));
      const good = actions.createEl('button', { text: '👍' });
      good.addEventListener('click', () => void this.writeFeedback('good', text.slice(0, 1000)));
      const bad = actions.createEl('button', { text: '👎' });
      bad.addEventListener('click', () => void this.writeFeedback('bad', text.slice(0, 1000)));
    }
    if (shouldStick) this.stickToBottom();
    return body;
  }

  private createStreamingCard() {
    const details = this.outputEl.createEl('details', { cls: 'nc-stream-card' });
    details.open = true;
    details.createEl('summary', { text: 'NullClaw · streaming' });
    const body = details.createDiv({ cls: 'nc-message-body nc-stream-body' });
    return { details, body };
  }

  private createToolBlock(name: string, args: any) {
    const details = this.outputEl.createEl('details', { cls: 'nc-tool-block' });
    details.createEl('summary', { text: `Tool · ${name}` });
    details.createEl('pre', { cls: 'nc-tool-args', text: JSON.stringify(args, null, 2) });
    const result = details.createEl('pre', { cls: 'nc-tool-result', text: 'Running…' });
    if (this.isNearBottom()) this.stickToBottom();
    return { details, result };
  }

  private async confirmMutation(action: string, path: string, content: string, marker = ''): Promise<boolean> {
    const p = this.normalizePath(path);
    let before = '';
    try { if (await this.app.vault.adapter.exists(p)) before = await this.app.vault.adapter.read(p); } catch {}
    let after = content;
    if (action === 'Append') after = before + (before && !before.endsWith('\n') ? '\n' : '') + content;
    if (action === 'Insert') {
      const pos = before.indexOf(marker);
      after = pos >= 0 ? before.slice(0, pos + marker.length) + content + before.slice(pos + marker.length) : before;
    }
    return await new Promise<boolean>((resolve) => {
      const card = this.outputEl.createDiv({ cls: 'nc-confirm-card' });
      card.createDiv({ cls: 'nc-confirm-title', text: `${action} · ${p}` });
      card.createEl('pre', { cls: 'nc-diff', text: this.simpleDiff(before, after) });
      const controls = card.createDiv({ cls: 'nc-confirm-actions' });
      const yes = controls.createEl('button', { cls: 'mod-cta', text: 'Confirm' });
      const no = controls.createEl('button', { text: 'Cancel' });
      const finish = (value: boolean) => { yes.disabled = true; no.disabled = true; card.addClass(value ? 'nc-confirmed' : 'nc-cancelled'); resolve(value); };
      yes.addEventListener('click', () => finish(true));
      no.addEventListener('click', () => finish(false));
      this.stickToBottom();
    });
  }

  private simpleDiff(before: string, after: string): string {
    if (!before) return after.split('\n').slice(0, 80).map(x => `+ ${x}`).join('\n');
    const a = before.split('\n'); const b = after.split('\n');
    let prefix = 0; while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    let suffix = 0; while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
    const removed = a.slice(prefix, a.length - suffix).slice(0, 60).map(x => `- ${x}`);
    const added = b.slice(prefix, b.length - suffix).slice(0, 60).map(x => `+ ${x}`);
    return [`@@ line ${prefix + 1} @@`, ...removed, ...added].join('\n');
  }

  private updateMentionMenu() {
    const value = this.inputEl.value;
    const cursor = this.inputEl.selectionStart ?? value.length;
    const left = value.slice(0, cursor);
    const match = left.match(/(?:^|\s)@([^\s@]*)$/);
    if (!match) { this.closeMentionMenu(); return; }
    this.mentionStart = cursor - match[1].length - 1;
    const query = match[1].toLowerCase();
    this.mentionItems = this.app.vault.getMarkdownFiles()
      .map((f: any) => f.path)
      .filter((path: string) => !query || path.toLowerCase().includes(query))
      .sort((a: string, b: string) => this.mentionScore(b, query) - this.mentionScore(a, query))
      .slice(0, 8);
    if (!this.mentionItems.length) { this.closeMentionMenu(); return; }
    this.mentionIndex = 0;
    this.renderMentionMenu();
  }

  private mentionScore(path: string, query: string): number {
    const lower = path.toLowerCase(); const name = lower.split('/').pop() || lower;
    if (name.startsWith(query)) return 100;
    if (name.includes(query)) return 70;
    if (lower.startsWith(query)) return 50;
    return 20;
  }

  private renderMentionMenu() {
    this.mentionEl.empty();
    this.mentionEl.show();
    this.mentionItems.forEach((path, i) => {
      const item = this.mentionEl.createDiv({ cls: `nc-mention-item${i === this.mentionIndex ? ' is-selected' : ''}`, text: path });
      item.addEventListener('mousedown', e => e.preventDefault());
      item.addEventListener('click', () => this.chooseMention(i));
    });
  }

  private moveMention(delta: number) {
    if (!this.mentionItems.length) return;
    this.mentionIndex = (this.mentionIndex + delta + this.mentionItems.length) % this.mentionItems.length;
    this.renderMentionMenu();
  }

  private chooseMention(index: number) {
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

  private closeMentionMenu() {
    this.mentionEl.hide(); this.mentionEl.empty(); this.mentionItems = []; this.mentionStart = -1;
  }

  private renderRefs() {
    this.refsEl.empty();
    if (!this.attachedRefs.length) { this.refsEl.hide(); return; }
    this.refsEl.show();
    for (const path of this.attachedRefs) {
      const chip = this.refsEl.createSpan({ cls: 'nc-ref-chip' });
      chip.createSpan({ text: `@ ${path}` });
      const remove = chip.createEl('button', { text: '×' });
      remove.addEventListener('click', () => { this.attachedRefs = this.attachedRefs.filter(x => x !== path); this.renderRefs(); void this.saveSession(); });
    }
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
