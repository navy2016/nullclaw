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
interface SessionIndexItem { id: string; title: string; updatedAt: number; messageCount: number; }
interface BuiltinSkill { id: string; label: string; description: string; command: string; }
interface MemoryOperation { path: string; mode: 'append' | 'write'; content: string; sources: string[]; reason: string; }
interface MemoryCandidate { id: string; category: 'people'|'projects'|'wiki'|'decisions'|'daily'|'profile'|'style'; content: string; sources: string[]; confidence: number; reason: string; status: 'pending'|'approved'|'rejected'|'applied'; createdAt: string; }

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
  private skillEl!: HTMLDivElement;
  private skillItems: BuiltinSkill[] = [];
  private skillIndex = 0;
  private selectedSkill: BuiltinSkill | null = null;
  private customSkills: BuiltinSkill[] = [];
  private customSkillSources = new Map<string, string>();
  private sessionEl!: HTMLDivElement;
  private responseWasStreamed = false;
  private compatibilityNoticeShown = false;
  private viewportResizeHandler?: () => void;
  private mobileClosedComposerGap = 0;
  private mobileBottomChromeHeight = 0;
  private imeFocusShift = 0;
  private closedVisualHeight = 0;
  private attachedRefs: string[] = [];
  private attachedSelection = '';
  private contextStats: Record<string, number> = {};

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
    this.sessionEl = c.createDiv({ cls: 'nc-session-panel' });
    this.sessionEl.hidden = true;
    const inputWrap = c.createDiv({ cls: 'nullclaw-input-wrap' });
    this.refsEl = inputWrap.createDiv({ cls: 'nullclaw-refs' });
    this.refsEl.hidden = true;
    this.mentionEl = inputWrap.createDiv({ cls: 'nullclaw-mention-menu' });
    this.mentionEl.hidden = true;
    this.skillEl = inputWrap.createDiv({ cls: 'nullclaw-skill-menu' });
    this.skillEl.hidden = true;
    const row = inputWrap.createDiv({ cls: 'nullclaw-input-row' });
    row.createSpan({ cls: 'nullclaw-input-prompt', text: '❯' });
    this.inputEl = row.createEl('input', { cls: 'nullclaw-input', attr: { type: 'text', placeholder: '直接输入发给 AI；命令用 /help /version /memory list ...' } });
    const st = c.createDiv({ cls: 'nullclaw-status' });
    this.statusDot = st.createSpan({ cls: 'nc-dot nc-dot-error' });
    this.statusText = st.createSpan({ text: 'Loading nullclaw.wasm...' });
    const sessionsButton = st.createEl('button', { cls: 'nc-session-button', text: 'Sessions' });
    sessionsButton.addEventListener('click', () => { void this.toggleSessionPanel().catch((e:any)=>this.println(`Sessions error: ${e.message}`,'nc-error')); });

    await this.loadWasm();
    await this.restoreSession();
    await this.loadCustomSkills();

    this.inputEl.addEventListener('input', () => { this.updateMentionMenu(); this.updateSkillMenu(); });
    this.inputEl.addEventListener('keydown', (e) => {
      if (!this.skillEl.hidden) {
        if (e.key === 'ArrowDown') { e.preventDefault(); this.moveSkill(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); this.moveSkill(-1); return; }
        if (e.key === 'Escape') { e.preventDefault(); this.closeSkillMenu(); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.chooseSkill(this.skillIndex); return; }
      }
      if (!this.mentionEl.hidden) {
        if (e.key === 'ArrowDown') { e.preventDefault(); this.moveMention(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); this.moveMention(-1); return; }
        if (e.key === 'Escape') { e.preventDefault(); this.closeMentionMenu(); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.chooseMention(this.mentionIndex); return; }
      }
      if (e.key === 'Backspace' && !this.inputEl.value && this.selectedSkill) { e.preventDefault(); this.selectedSkill = null; this.renderRefs(); return; }
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
    let raw = input.trim();
    if (this.selectedSkill) raw = `${this.selectedSkill.command}${raw ? ' ' + raw : ''}`;
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
      this.selectedSkill = null;
      this.renderRefs();
      await this.saveSession();
    }
  }

  private async execSlashCommand(command: string) {
    if (!command) {
      this.println('Slash commands: /help /version /status /compact /digest-current /review-inbox /apply-memory /vault-doctor /feedback good|bad <text> /current /selection /read /write /append /insert /search /glob /move /delete /frontmatter /links /link /list /clear', 'nc-info');
      return;
    }

    const args = this.parseArgs(command);
    const cmd = args[0];

    if (cmd === 'skill-run') {
      if (!args[1]) return this.println('Usage: /skill-run <id> [input]', 'nc-error');
      await this.executeCustomSkill(args[1], args.slice(2).join(' ')); return;
    }
    if (cmd === 'skills-reload') { await this.loadCustomSkills(); this.println(`Loaded ${this.customSkills.length} custom skills.`, 'nc-info'); return; }

    // Chat/session commands
    if (cmd === 'sessions') { await this.toggleSessionPanel(true); return; }
    if (cmd === 'session-new') { await this.newSession(args.slice(1).join(' ') || undefined); return; }
    if (cmd === 'session-switch') { if (!args[1]) return this.println('Usage: /session-switch <id>', 'nc-error'); await this.switchSession(args[1]); return; }
    if (cmd === 'session-delete') { if (!args[1]) return this.println('Usage: /session-delete <id>', 'nc-error'); await this.deleteSession(args[1]); return; }
    if (cmd === 'session-rename') { if (!args[1] || args.length < 3) return this.println('Usage: /session-rename <id> <title>', 'nc-error'); await this.renameSession(args[1], args.slice(2).join(' ')); return; }
    if (cmd === 'session-export') { if (!args[1]) return this.println('Usage: /session-export <id>', 'nc-error'); await this.exportSession(args[1]); return; }
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
    if (cmd === 'context') { this.showContextStats(); return; }
    if (cmd === 'digest-current') { await this.skillDigestCurrent(); return; }
    if (cmd === 'review-inbox') { await this.skillReviewInbox(); return; }
    if (cmd === 'apply-memory') { await this.skillApplyMemory(args.slice(1).includes('--yes')); return; }
    if (cmd === 'vault-doctor') { await this.skillVaultDoctor(); return; }
    if (cmd === 'update-profile') { await this.skillUpdateProfile(); return; }
    if (cmd === 'create-skill') { await this.skillCreateSkill(args.slice(1).join(' ')); return; }
    if (cmd === 'feedback') {
      if (!args[1] || args.length < 3) return this.println('Usage: /feedback good|bad <text>', 'nc-error');
      await this.writeFeedback(args[1], args.slice(2).join(' '));
      this.println('Feedback saved.', 'nc-output');
      return;
    }
    if (cmd === 'init-memory') { await this.ensureMemoryScaffold(); this.println('Memory scaffold initialized.', 'nc-output'); return; }
    if (cmd === 'remember') { await this.skillRemember(args.slice(1).join(' ')); return; }
    if (cmd === 'memory-candidates') { await this.showMemoryCandidates(args[1] || 'pending'); return; }
    if (cmd === 'memory-approve') { if (!args[1]) return this.println('Usage: /memory-approve <id>', 'nc-error'); await this.setCandidateStatus(args[1], 'approved'); return; }
    if (cmd === 'memory-reject') { if (!args[1]) return this.println('Usage: /memory-reject <id>', 'nc-error'); await this.setCandidateStatus(args[1], 'rejected'); return; }

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
    if (cmd === 'retrieve') {
      if (args.length < 2) return this.println('Usage: /retrieve <query>', 'nc-error');
      this.println(await this.toolRetrieve(args.slice(1).join(' ')), 'nc-output'); return;
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
    if (cmd === 'glob') {
      if (!args[1]) return this.println('Usage: /glob <pattern>', 'nc-error');
      this.println(this.toolGlob(args[1]), 'nc-output'); return;
    }
    if (cmd === 'move' || cmd === 'rename') {
      if (!args[1] || !args[2]) return this.println('Usage: /move <from> <to>', 'nc-error');
      if (await this.confirmOperation('Move', `${args[1]} → ${args[2]}`, 'Move/rename this path?')) { await this.toolMove(args[1],args[2]); this.println('Moved.', 'nc-output'); }
      return;
    }
    if (cmd === 'delete') {
      if (!args[1]) return this.println('Usage: /delete <path>', 'nc-error');
      if (await this.confirmOperation('Delete',args[1],'Permanently delete this file?')) { await this.toolDelete(args[1]); this.println('Deleted.', 'nc-output'); }
      return;
    }
    if (cmd === 'frontmatter') {
      if (!args[1]) return this.println('Usage: /frontmatter <path> [key value]', 'nc-error');
      if (!args[2]) this.println(JSON.stringify(await this.toolFrontmatterRead(args[1]),null,2),'nc-output');
      else if (await this.confirmOperation('Frontmatter',args[1],`Set ${args[2]} = ${args.slice(3).join(' ')}`)) { await this.toolFrontmatterSet(args[1],args[2],args.slice(3).join(' ')); this.println('Frontmatter updated.','nc-output'); }
      return;
    }
    if (cmd === 'links') {
      if (!args[1]) return this.println('Usage: /links <path>', 'nc-error');
      this.println(await this.toolLinks(args[1]),'nc-output'); return;
    }
    if (cmd === 'link') {
      if (!args[1] || !args[2]) return this.println('Usage: /link <path> <target> [alias]', 'nc-error');
      const link=`[[${args[2]}${args[3]?'|'+args[3]:''}]]`;
      if (await this.confirmMutation('Append',args[1],link)) { await this.toolAppend(args[1],link); this.println(`Added ${link}`,'nc-output'); }
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
      { ...this.settings, apiKey: '' },
      () => {},
    );
    if (result.stdout) {
      const reply = result.stdout.trim();
      this.renderMessageCard('assistant', reply, true);
      this.remember(message, reply);
    }
    if (result.stderr) this.println(result.stderr, 'nc-error');
    if (!result.stdout && !result.stderr) this.println(`(exit: ${result.exitCode})`, 'nc-info');
  }

  private limitText(text:string,max:number):string {
    if(text.length<=max)return text;const half=Math.floor((max-80)/2);return `${text.slice(0,half)}\n\n… [${text.length-max} chars omitted] …\n\n${text.slice(-half)}`;
  }

  private budgetHistory(messages:ChatMessage[],maxChars:number):ChatMessage[] {
    const selected:ChatMessage[]=[];let used=0;
    for(let i=messages.length-1;i>=0;i--){const m=messages[i];const size=m.content.length+32;if(selected.length>=24||used+size>maxChars)break;selected.unshift(m);used+=size;}
    return selected;
  }

  private showContextStats(){const total=Object.values(this.contextStats).reduce((a,b)=>a+b,0);this.println(`Context budget (~${Math.ceil(total/4)} tokens / ${total} chars):\n${Object.entries(this.contextStats).map(([k,v])=>`- ${k}: ${v} chars`).join('\n')}`,'nc-info');}

  private updateContextStatus(){const chars=Object.values(this.contextStats).reduce((a,b)=>a+b,0);if(this.running)this.statusText.textContent=`Running · ~${Math.ceil(chars/4)} ctx tokens`;}

  private async callLLM(message: string): Promise<string | null> {
    this.responseWasStreamed = false;
    this.compatibilityNoticeShown = false;
    const base = (this.settings.apiBase || 'https://api.openai.com/v1').replace(/\/$/, '');
    const system = {
      role: 'system' as const,
      content: 'You are NullClaw, an AI assistant embedded in Obsidian Android. Maintain context across turns. You can use tools to read, write, append, insert, list and search the current Obsidian vault. Use tools when the user asks about notes/files or wants modifications. Continue calling tools until the task is actually complete, then provide a clear final response. Be concise and answer in the user language.'
    };

    await this.ensureMemoryScaffold();
    const palaceContext = this.limitText(await this.loadPalaceContext(message), 18000);
    const refContext = this.limitText(await this.resolveMessageReferences(message), 30000);
    const retrievalContext = (!this.attachedRefs.length && !this.attachedSelection) ? this.limitText(await this.retrieveContext(message, 6), 10000) : '';
    const summaryContext = this.limitText(this.sessionSummary ? `Compressed session context:\n${this.sessionSummary}` : '', 10000);
    const history = this.budgetHistory(this.messages, 28000);
    const enriched = [summaryContext, palaceContext, refContext, retrievalContext, `User message:\n${message}`].filter(Boolean).join('\n\n---\n\n');
    this.contextStats={summary:summaryContext.length,palace:palaceContext.length,references:refContext.length,retrieval:retrievalContext.length,history:history.reduce((n,m)=>n+m.content.length,0),user:message.length};
    this.updateContextStatus();
    const conversation: any[] = [system, ...history, { role: 'user', content: enriched }];
    const tools = this.toolSchemas();

    try {
      for (let round = 0; round < 8; round++) {
        const response = await this.chatCompletionStreaming(base, conversation, tools);
        const assistant = response.choices?.[0]?.message;
        if (!assistant) throw new Error('Provider returned no assistant message.');
        conversation.push(assistant);

        const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
        if (!calls.length) {
          const text = assistant.content ?? response.choices?.[0]?.text ?? '';
          if (!text) throw new Error('Provider returned neither content nor tool calls.');
          this.remember(message, text);
          return text;
        }

        for (let i = 0; i < calls.length; i++) {
          const call = calls[i];
          const toolName = call.function?.name || 'unknown_tool';
          const argsRaw = call.function?.arguments || '{}';
          let parsed: any = {};
          try { parsed = JSON.parse(argsRaw); }
          catch { parsed = { raw: argsRaw }; }
          const result = await this.executeTool(toolName, parsed);
          conversation.push({
            role: 'tool',
            tool_call_id: call.id || `tool-${round}-${i}`,
            name: toolName,
            content: result,
          });
        }
      }
      throw new Error('Agent stopped after 8 tool rounds without a final response.');
    } catch (e: any) {
      this.println(`[LLM agent failed] ${e.message}`, 'nc-error');
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
      if (!this.compatibilityNoticeShown) {
        this.compatibilityNoticeShown = true;
        this.println('Using mobile compatibility mode.', 'nc-info');
      }
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
    const f = (name: string, description: string, properties: any, required: string[] = []) => ({
      type: 'function', function: { name, description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) } }
    });
    return [
      f('memory_candidate_create', 'Create a pending structured memory candidate in inbox. This never writes long-term memory.', { category: { type: 'string', enum: ['people','projects','wiki','decisions','daily','profile','style'] }, content: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } }, confidence: { type: 'number' }, reason: { type: 'string' } }, ['category','content','reason']),
      f('memory_candidate_list', 'List structured memory candidates by status.', { status: { type: 'string', enum: ['pending','approved','rejected','all'] } }),
      f('vault_current_context', 'Read current Obsidian note and selection.', {}),
      f('vault_retrieve', 'Rank relevant notes using local title/path/content/recency scoring.', { query: { type: 'string' }, limit: { type: 'number' } }, ['query']),
      f('vault_search', 'Search markdown content and paths.', { query: { type: 'string' }, limit: { type: 'number' } }, ['query']),
      f('vault_glob', 'List paths matching a simple glob pattern.', { pattern: { type: 'string' }, limit: { type: 'number' } }, ['pattern']),
      f('vault_read', 'Read a vault file.', { path: { type: 'string' } }, ['path']),
      f('vault_list', 'List files below a folder.', { folder: { type: 'string' }, limit: { type: 'number' } }),
      f('vault_write', 'Create or overwrite a file. Requires confirmation.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
      f('vault_append', 'Append file content. Requires confirmation.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
      f('vault_insert', 'Insert around a marker. Requires confirmation.', { path: { type: 'string' }, marker: { type: 'string' }, content: { type: 'string' }, position: { type: 'string', enum: ['before','after'] } }, ['path','marker','content']),
      f('vault_move', 'Move or rename a path. Requires confirmation.', { from: { type: 'string' }, to: { type: 'string' } }, ['from','to']),
      f('vault_delete', 'Delete a file. Requires confirmation.', { path: { type: 'string' } }, ['path']),
      f('vault_frontmatter_read', 'Read YAML frontmatter fields.', { path: { type: 'string' } }, ['path']),
      f('vault_frontmatter_set', 'Set a frontmatter field. Requires confirmation.', { path: { type: 'string' }, key: { type: 'string' }, value: {} }, ['path','key']),
      f('vault_links', 'Read outgoing and incoming links for a note.', { path: { type: 'string' } }, ['path']),
      f('vault_create_link', 'Append a wikilink to a note. Requires confirmation.', { path: { type: 'string' }, target: { type: 'string' }, alias: { type: 'string' } }, ['path','target']),
      f('editor_insert', 'Insert content at current editor cursor. Requires confirmation.', { content: { type: 'string' } }, ['content']),
      f('editor_replace_selection', 'Replace current editor selection. Requires confirmation.', { content: { type: 'string' } }, ['content']),
    ];
  }

  private async executeTool(name: string, args: any): Promise<string> {
    const block = this.createToolBlock(name, args);
    try {
      let result = '';
      if (name === 'memory_candidate_create') {
        const c = this.normalizeCandidate(args); await this.saveMemoryCandidate(c); result = `Created pending candidate ${c.id}`;
      } else if (name === 'memory_candidate_list') result = await this.listMemoryCandidates(String(args.status || 'pending'));
      else if (name === 'vault_current_context') {
        const ctx = this.getActiveMarkdownContext();
        result = ctx ? `Path: ${ctx.path}
Selection:
${ctx.selection}

Note:
${ctx.text.slice(0, 24000)}` : 'No active markdown note.';
      } else if (name === 'vault_retrieve') result = await this.toolRetrieve(String(args.query ?? ''), Number(args.limit ?? 8));
      else if (name === 'vault_search') result = await this.toolSearch(String(args.query ?? ''), Number(args.limit ?? 20));
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
      } else if (name === 'vault_glob') result = this.toolGlob(String(args.pattern ?? '*'), Number(args.limit ?? 100));
      else if (name === 'vault_move') {
        const from = String(args.from ?? ''); const to = String(args.to ?? '');
        if (!(await this.confirmOperation('Move', `${from} → ${to}`, 'Move/rename this path?'))) result = 'User cancelled move.';
        else { await this.toolMove(from, to); result = `Moved ${from} to ${to}`; }
      } else if (name === 'vault_delete') {
        const path = String(args.path ?? '');
        if (!(await this.confirmOperation('Delete', path, 'This file will be permanently deleted.'))) result = 'User cancelled delete.';
        else { await this.toolDelete(path); result = `Deleted ${path}`; }
      } else if (name === 'vault_frontmatter_read') result = JSON.stringify(await this.toolFrontmatterRead(String(args.path ?? '')), null, 2);
      else if (name === 'vault_frontmatter_set') {
        const path = String(args.path ?? '');
        if (!(await this.confirmOperation('Frontmatter', path, `Set ${String(args.key)} = ${JSON.stringify(args.value)}`))) result = 'User cancelled frontmatter edit.';
        else { await this.toolFrontmatterSet(path, String(args.key ?? ''), args.value); result = `Updated frontmatter in ${path}`; }
      } else if (name === 'vault_links') result = await this.toolLinks(String(args.path ?? ''));
      else if (name === 'vault_create_link') {
        const path = String(args.path ?? ''); const target = String(args.target ?? ''); const alias = String(args.alias ?? '');
        const link = `[[${target}${alias ? '|' + alias : ''}]]`;
        if (!(await this.confirmMutation('Append', path, link))) result = 'User cancelled link creation.';
        else { await this.toolAppend(path, link); result = `Added ${link} to ${path}`; }
      } else if (name === 'editor_insert') {
        const content = String(args.content ?? '');
        if (!(await this.confirmOperation('Editor insert', 'Current cursor', content))) result = 'User cancelled editor insert.';
        else { const view = this.app.workspace.getActiveViewOfType(MarkdownView); if (!view) throw new Error('No active editor'); view.editor.replaceSelection(content); result = 'Inserted at cursor.'; }
      } else if (name === 'editor_replace_selection') {
        const content = String(args.content ?? '');
        if (!(await this.confirmOperation('Replace selection', 'Current selection', content))) result = 'User cancelled selection replacement.';
        else { const view = this.app.workspace.getActiveViewOfType(MarkdownView); if (!view) throw new Error('No active editor'); view.editor.replaceSelection(content); result = 'Replaced selection.'; }
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

  private toolGlob(pattern: string, limit = 100): string {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/\?/g, '.').replace(/§§/g, '.*');
    const rx = new RegExp(`^${escaped}$`, 'i');
    const paths = this.app.vault.getFiles().map((f: any) => f.path).filter((p: string) => rx.test(p));
    return paths.slice(0, limit).map((p: string) => `- ${p}`).join('\n') || 'No matches.';
  }

  private async toolMove(from: string, to: string) {
    const a = this.normalizePath(from), b = this.normalizePath(to);
    if (!a || !b) throw new Error('Missing path');
    await this.ensureParentFolder(b);
    await this.app.vault.adapter.rename(a, b);
  }

  private async toolDelete(path: string) {
    const p = this.normalizePath(path);
    if (!p || p.startsWith('raw/')) throw new Error('Deleting raw evidence is prohibited.');
    await this.app.vault.adapter.remove(p);
  }

  private async toolFrontmatterRead(path: string): Promise<Record<string, any>> {
    const text = await this.toolRead(path);
    const match = text.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    const out: Record<string, any> = {};
    for (const line of match[1].split('\n')) {
      const i = line.indexOf(':'); if (i < 1) continue;
      out[line.slice(0,i).trim()] = line.slice(i+1).trim();
    }
    return out;
  }

  private async toolFrontmatterSet(path: string, key: string, value: any) {
    if (!key) throw new Error('Missing frontmatter key');
    const text = await this.toolRead(path);
    const encoded = typeof value === 'string' ? value : JSON.stringify(value);
    const match = text.match(/^---\n([\s\S]*?)\n---/);
    let next: string;
    if (!match) next = `---\n${key}: ${encoded}\n---\n${text}`;
    else {
      const lines = match[1].split('\n'); const i = lines.findIndex(x => x.split(':')[0].trim() === key);
      if (i >= 0) lines[i] = `${key}: ${encoded}`; else lines.push(`${key}: ${encoded}`);
      next = `---\n${lines.join('\n')}\n---${text.slice(match[0].length)}`;
    }
    await this.toolWrite(path, next);
  }

  private async toolLinks(path: string): Promise<string> {
    const p = this.normalizePath(path);
    const file = this.app.vault.getAbstractFileByPath(p) as any;
    if (!file) throw new Error(`File not found: ${p}`);
    const cache = this.app.metadataCache.getFileCache(file);
    const outgoing = (cache?.links ?? []).map((l: any) => `- [[${l.link}]]`).join('\n') || 'None';
    const incoming: string[] = [];
    for (const source of this.app.vault.getMarkdownFiles()) {
      const links = this.app.metadataCache.getFileCache(source)?.links ?? [];
      if (links.some((l: any) => this.app.metadataCache.getFirstLinkpathDest(l.link, source.path)?.path === p)) incoming.push(`- [[${source.path}]]`);
    }
    return `Outgoing:\n${outgoing}\n\nIncoming:\n${incoming.join('\n') || 'None'}`;
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

  private queryTerms(query:string):string[] {
    const terms=(query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu)||[]).filter(x=>!['the','and','with','this','that','一个','什么','怎么','可以','帮我'].includes(x));
    return [...new Set(terms)].slice(0,16);
  }

  private async retrieveNotes(query:string,limit=8):Promise<Array<{path:string;score:number;snippet:string}>> {
    const terms=this.queryTerms(query); if(!terms.length) return [];
    const now=Date.now(); const hits:Array<{path:string;score:number;snippet:string}>=[];
    for(const file of this.app.vault.getMarkdownFiles().filter((f:any)=>! /^(memory\/applied|memory\/inbox\/candidates|\.nullclaw|palace)\//.test(f.path)).slice(0,1500)) {
      try {
        const path=file.path.toLowerCase(), name=file.basename.toLowerCase();
        const text=await this.app.vault.cachedRead(file); const lower=text.toLowerCase(); let score=0; let first=-1;
        for(const term of terms){
          if(name===term) score+=24; else if(name.includes(term)) score+=12;
          if(path.includes(term)) score+=6;
          const at=lower.indexOf(term); if(at>=0){score+=4; if(first<0)first=at; score+=Math.min(5,lower.split(term).length-1)*1.5;}
        }
        const age=Math.max(0,(now-(file.stat?.mtime||0))/86400000); score+=Math.max(0,4-Math.log2(age+1));
        if(score>4){const at=first>=0?first:0;hits.push({path:file.path,score,snippet:text.slice(Math.max(0,at-100),Math.min(text.length,at+360)).replace(/\s+/g,' ')});}
      }catch{}
    }
    return hits.sort((a,b)=>b.score-a.score).slice(0,limit);
  }

  private async toolRetrieve(query:string,limit=8):Promise<string>{
    const hits=await this.retrieveNotes(query,limit);return hits.length?hits.map(h=>`- ${h.path} [${h.score.toFixed(1)}]: ${h.snippet}`).join('\n'):'No relevant notes.';
  }

  private async retrieveContext(query:string,limit=6):Promise<string>{
    const hits=await this.retrieveNotes(query,limit);return hits.length?`Locally retrieved note candidates (use vault_read for precision):\n${hits.map(h=>`- ${h.path} [score ${h.score.toFixed(1)}]: ${h.snippet}`).join('\n')}`:'';
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
    const dirs = ['raw', 'sources', 'memory', 'memory/inbox', 'memory/inbox/candidates', 'memory/feedback', 'memory/applied', 'people', 'projects', 'wiki', 'decisions', 'daily', 'palace', '.nullclaw', '.nullclaw/sessions', '.nullclaw/sessions/exports', '.nullclaw/skills'];
    for (const d of dirs) {
      try {
        if (!(await this.app.vault.adapter.exists(d))) await this.app.vault.adapter.mkdir(d);
      } catch (e) {
        if (!(await this.app.vault.adapter.exists(d))) throw e;
      }
    }
    const defaults: Record<string, string> = {
      'profile.md': '# Profile\n\n用户画像，待沉淀。\n',
      'vault.md': '# Vault\n\n这个知识库的用途、结构和长期目标。\n',
      'style.md': '# Style\n\n输出风格偏好。\n',
      'memory_policy.md': '# Memory Policy\n\n长期记忆写入 people/projects/wiki/decisions/daily 前需要人工确认。\n',
      'palace/digest_note_room.md': '# digest_note_room\n\n触发：消化当前笔记或选区。\n必读：profile.md → vault.md → style.md → memory_policy.md → 当前笔记。\n输出：memory/inbox/YYYY-MM-DD.md。\n限制：不直接写入长期记忆。\n',
      'palace/chat_room.md': '# chat_room\n\n触发：普通对话。\n必读：profile.md → vault.md → style.md。\n条件读取：用户明确引用的笔记。\n限制：写入必须走确认。\n',
      'palace/review_inbox_room.md': '# review_inbox_room\n\n触发：审核 inbox。\n必读：memory_policy.md → memory/inbox/。\n输出：memory/inbox/review-*.md。\n限制：不写长期记忆。\n',
      'palace/apply_memory_room.md': '# apply_memory_room\n\n触发：应用长期记忆。\n必读：memory_policy.md → approved review。\n输出：people/projects/wiki/decisions/daily。\n限制：逐文件确认。\n',
      'palace/update_profile_room.md': '# update_profile_room\n\n触发：根据反馈更新画像。\n必读：profile.md → style.md → memory/feedback/。\n限制：profile/style 分别确认。\n',
      'palace/vault_doctor_room.md': '# vault_doctor_room\n\n触发：Vault 体检。\n必读：vault.md → memory_policy.md。\n输出：memory/vault-doctor-*.md。\n限制：只生成报告，不自动修复。\n',
    };
    for (const [path, content] of Object.entries(defaults)) {
      if (!(await this.app.vault.adapter.exists(path))) await this.app.vault.adapter.write(path, content);
    }
  }

  private async loadPalaceContext(message: string): Promise<string> {
    const candidates = ['profile.md', 'vault.md', 'style.md', 'memory_policy.md', 'palace/chat_room.md'];
    const intent = `${this.selectedSkill?.id || ''} ${message}`;
    if (/digest|消化|整理|总结/.test(intent)) candidates.push('palace/digest_note_room.md');
    if (/review|审核.*inbox/.test(intent)) candidates.push('palace/review_inbox_room.md');
    if (/apply|应用.*记忆|沉淀.*长期/.test(intent)) candidates.push('palace/apply_memory_room.md');
    if (/profile|画像|风格/.test(intent)) candidates.push('palace/update_profile_room.md');
    if (/doctor|体检|断链|孤立/.test(intent)) candidates.push('palace/vault_doctor_room.md');
    const chunks: string[] = [];
    for (const p of candidates) {
      if (await this.app.vault.adapter.exists(p)) {
        const text = await this.app.vault.adapter.read(p);
        chunks.push(`Context file: ${p}\n${text.slice(0, 6000)}`);
      }
    }
    try {
      const listing=await this.app.vault.adapter.list('memory/applied');
      const latest=[...listing.files].filter((x:string)=>x.endsWith('.json')).sort().slice(-2);
      for(const path of latest){const raw=await this.app.vault.adapter.read(path);chunks.push(`Recent confirmed memory audit: ${path}\n${raw.slice(0,5000)}`);}
    } catch {}
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

  private candidatePath(id:string):string { return `memory/inbox/candidates/${id}.json`; }

  private normalizeCandidate(input:any):MemoryCandidate {
    const categories=['people','projects','wiki','decisions','daily','profile','style'];
    const category=categories.includes(String(input.category))?String(input.category) as MemoryCandidate['category']:'wiki';
    const content=String(input.content||'').trim(); if(!content) throw new Error('Memory candidate content is empty.');
    const sources=Array.isArray(input.sources)?input.sources.map(String).filter(Boolean).slice(0,20):[];
    const confidence=Math.max(0,Math.min(1,Number(input.confidence??0.6)));
    const hash=this.fastHash(`${category}|${content.toLowerCase().replace(/\s+/g,' ')}`);
    return {id:`mc-${hash}`,category,content,sources,confidence,reason:String(input.reason||'Conversation memory candidate'),status:'pending',createdAt:new Date().toISOString()};
  }

  private fastHash(text:string):string { let h=2166136261; for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);} return (h>>>0).toString(36); }

  private async saveMemoryCandidate(candidate:MemoryCandidate) {
    await this.ensureMemoryScaffold(); const path=this.candidatePath(candidate.id);
    if(await this.app.vault.adapter.exists(path)) {
      const old=JSON.parse(await this.app.vault.adapter.read(path)) as MemoryCandidate;
      if(old.status!=='rejected') candidate.status=old.status;
      candidate.sources=[...new Set([...(old.sources||[]),...candidate.sources])]; candidate.createdAt=old.createdAt||candidate.createdAt;
    }
    await this.toolWrite(path,JSON.stringify(candidate,null,2));
  }

  private async loadMemoryCandidates(status='all'):Promise<MemoryCandidate[]> {
    await this.ensureMemoryScaffold(); const listing=await this.app.vault.adapter.list('memory/inbox/candidates'); const out:MemoryCandidate[]=[];
    for(const path of listing.files.filter((x:string)=>x.endsWith('.json'))){try{const c=JSON.parse(await this.app.vault.adapter.read(path));if(status==='all'||c.status===status)out.push(c);}catch{}}
    return out.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }

  private async listMemoryCandidates(status='pending'):Promise<string> {
    const items=await this.loadMemoryCandidates(status);return items.length?items.slice(0,100).map(c=>`- ${c.id} [${c.status}] ${c.category} ${(c.confidence*100).toFixed(0)}%: ${c.content}\n  sources: ${c.sources.join(', ')||'conversation'}`).join('\n'):'No candidates.';
  }

  private async showMemoryCandidates(status='pending') {
    const items=await this.loadMemoryCandidates(status);if(!items.length){this.println('No candidates.','nc-info');return;}
    const panel=this.outputEl.createDiv({cls:'nc-memory-candidates'});panel.createDiv({cls:'nc-memory-head',text:`Memory candidates · ${status} (${items.length})`});
    for(const c of items.slice(0,100)){
      const card=panel.createDiv({cls:`nc-memory-card is-${c.status}`});
      const head=card.createDiv({cls:'nc-memory-card-head'});head.createSpan({text:`${c.category} · ${(c.confidence*100).toFixed(0)}%`});head.createSpan({text:c.id});
      card.createDiv({cls:'nc-memory-content',text:c.content});
      card.createDiv({cls:'nc-memory-reason',text:c.reason});
      if(c.sources.length)card.createDiv({cls:'nc-memory-sources',text:`Sources: ${c.sources.join(', ')}`});
      if(c.status==='pending'){
        const actions=card.createDiv({cls:'nc-memory-actions'});const yes=actions.createEl('button',{cls:'mod-cta',text:'Approve'});const no=actions.createEl('button',{text:'Reject'});
        yes.addEventListener('click',async()=>{await this.setCandidateStatus(c.id,'approved');card.addClass('is-approved');yes.disabled=true;no.disabled=true;});
        no.addEventListener('click',async()=>{await this.setCandidateStatus(c.id,'rejected');card.addClass('is-rejected');yes.disabled=true;no.disabled=true;});
      }
    }
    this.stickToBottom();
  }

  private async setCandidateStatus(id:string,status:'approved'|'rejected') {
    const path=this.candidatePath(id);if(!(await this.app.vault.adapter.exists(path)))throw new Error(`Candidate not found: ${id}`);
    const c=JSON.parse(await this.app.vault.adapter.read(path)) as MemoryCandidate;
    if(!(await this.confirmOperation(`${status==='approved'?'Approve':'Reject'} candidate`,id,`${c.category} ${(c.confidence*100).toFixed(0)}%\n${c.content}`)))return;
    c.status=status;await this.toolWrite(path,JSON.stringify(c,null,2));this.println(`Candidate ${id} marked ${status}.`,'nc-output');
  }

  private async skillRemember(note='') {
    await this.runSkillFlow('obsidian-remember',async flow=>{
      if(!this.settings.apiKey)throw new Error('Memory extraction requires configured LLM.');
      const transcript=this.messages.slice(-30).map(m=>`${m.role}: ${m.content}`).join('\n');if(!transcript.trim())throw new Error('Current session has no messages.');
      flow.step('Read conversation',`${this.messages.length} messages`,'done');
      const prompt=`Extract only durable, useful memory candidates from this conversation. Return ONLY JSON: {"candidates":[{"category":"people|projects|wiki|decisions|daily|profile|style","content":"atomic fact","sources":["session:${this.sessionId}"],"confidence":0.0,"reason":"why durable"}]}. Omit transient chat, uncertain facts, generic knowledge and duplicates. User note: ${note||'(none)'}\n\n${transcript.slice(-40000)}`;
      const response=await this.chatCompletion((this.settings.apiBase||'https://api.openai.com/v1').replace(/\/$/,''),[{role:'system',content:'You extract conservative structured memory candidates. JSON only.'},{role:'user',content:prompt}],[]);
      const raw=response.choices?.[0]?.message?.content||response.choices?.[0]?.text||'';const clean=raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');let data:any;try{data=JSON.parse(clean);}catch{throw new Error('Invalid candidate JSON.');}
      const candidates:MemoryCandidate[]=[];for(const x of Array.isArray(data.candidates)?data.candidates:[]){try{const c=this.normalizeCandidate(x);if(c.confidence>=0.45)candidates.push(c);}catch{}}
      flow.step('Validate',`${candidates.length} candidates`,'done');
      for(const c of candidates){await this.saveMemoryCandidate(c);flow.step(c.id,`${c.category} ${(c.confidence*100).toFixed(0)}%`,'done');}
      return `Saved ${candidates.length} pending candidates. Review with /memory-candidates.`;
    });
  }

  private async skillDigestCurrent() {
    await this.runSkillFlow('obsidian-digest-note', async (flow) => {
      const ctx = this.getActiveMarkdownContext();
      if (!ctx) throw new Error('No active markdown note.');
      flow.step('Read current note', ctx.path, 'done');
      const target = ctx.selection || ctx.text;
      flow.step('Analyze', 'Extracting facts, links, memory candidates and tasks…', 'running');
      const prompt = `消化当前 Obsidian 笔记，输出四部分：\n1. 要点\n2. 关联人物/项目/概念\n3. 可沉淀长期记忆候选（标注 people/projects/wiki/decisions/daily）\n4. 待办\n所有结论保留来源 ${ctx.path}。不要直接写长期记忆。\n\n${target.slice(0,24000)}`;
      const result = this.settings.apiKey ? await this.callLLM(prompt) : `# Digest: ${ctx.path}\n\n${target.slice(0,4000)}`;
      if (!result) throw new Error('Digest produced no result.');
      const out = `memory/inbox/${new Date().toISOString().slice(0,10)}.md`;
      flow.step('Write inbox', out, 'awaiting');
      const entry = `\n## ${new Date().toLocaleString()} — ${ctx.path}\n\n${result}\n`;
      if (!(await this.confirmMutation('Append inbox', out, entry))) throw new Error('User cancelled inbox write.');
      await this.toolAppend(out, entry);
      flow.step('Write inbox', out, 'done');
      return `Digest written to ${out}`;
    });
  }

  private async skillReviewInbox() {
    await this.runSkillFlow('obsidian-review-inbox', async (flow) => {
      const inbox = await this.collectFolderText('memory/inbox');
      if (!inbox) throw new Error('memory/inbox is empty.');
      flow.step('Scan inbox', `${inbox.length} chars`, 'done');
      const prompt = `审核 memory/inbox，去重归纳为人工确认清单。每条必须标注归属 people/projects/wiki/decisions/daily、置信度、来源；不要执行长期写入。\n\n${inbox.slice(0,30000)}`;
      flow.step('Build review', 'Deduplicating and classifying…', 'running');
      const result = this.settings.apiKey ? await this.callLLM(prompt) : inbox;
      if (!result) throw new Error('Review produced no result.');
      const out = `memory/inbox/review-${new Date().toISOString().slice(0,10)}.md`;
      if (!(await this.confirmMutation('Write review', out, result))) throw new Error('User cancelled review write.');
      await this.toolWrite(out, result); flow.step('Write review', out, 'done');
      return `Review written to ${out}`;
    });
  }

  private async skillApplyMemory(_yes: boolean) {
    await this.runSkillFlow('obsidian-apply-memory', async (flow) => {
      const approved=await this.loadMemoryCandidates('approved');
      const inboxFiles=this.app.vault.getMarkdownFiles().filter((f:any)=>f.path.startsWith('memory/inbox/')&&!f.path.startsWith('memory/inbox/candidates/')&&!/review-|apply-/.test(f.path));
      if(!approved.length&&!inboxFiles.length) throw new Error('No approved candidates or legacy inbox files.');
      const chunks:string[]=approved.map(c=>`APPROVED:${c.id} category=${c.category} confidence=${c.confidence} sources=${c.sources.join(',')}\n${c.content}`);
      for(const f of inboxFiles.slice(0,40)) chunks.push(`SOURCE:${f.path}\n${(await this.app.vault.cachedRead(f)).slice(0,10000)}`);
      const inbox=chunks.join('\n\n---\n\n'); flow.step('Read inbox',`${approved.length} approved candidates, ${inboxFiles.length} legacy files`,'done');
      if(!this.settings.apiKey) throw new Error('Structured memory application requires configured LLM.');
      const prompt=`Return ONLY valid JSON, no markdown fences. Build a conservative long-term memory merge plan from inbox. Schema: {"operations":[{"path":"projects/example.md","mode":"append","content":"...","sources":["memory/inbox/file.md"],"reason":"..."}]}. Allowed targets: people/, projects/, wiki/, decisions/, daily/, profile.md, style.md. mode is append or write. Prefer append. Preserve source wikilinks in content. Never target raw/, sources/, memory/, palace/, .nullclaw/. Omit uncertain claims.\n\n${inbox.slice(0,50000)}`;
      flow.step('Build structured plan','Requesting validated JSON operations…','running');
      const response=await this.chatCompletion((this.settings.apiBase||'https://api.openai.com/v1').replace(/\/$/,''),[
        {role:'system',content:'You produce strict JSON memory migration plans. Output JSON only.'},
        {role:'user',content:prompt}
      ],[]);
      const raw=response.choices?.[0]?.message?.content||response.choices?.[0]?.text||'';
      const parsed=this.parseMemoryOperations(raw); const ops=parsed.operations;
      if(!ops.length) throw new Error('No valid memory operations were proposed.');
      flow.step('Validate plan',`${ops.length} valid operations`,'done');
      const date=new Date().toISOString().slice(0,10); const stamp=new Date().toISOString(); const audit:any[]=[];
      await this.toolWrite(`memory/apply-plan-${date}.json`,JSON.stringify({createdAt:stamp,operations:ops},null,2));
      for(const op of ops){
        flow.step(op.path,`${op.mode}: ${op.reason}`,'awaiting');
        const approved=await this.confirmMutation(op.mode==='append'?'Append memory':'Write memory',op.path,op.content);
        if(!approved){audit.push({...op,status:'cancelled'});flow.step(op.path,'Cancelled','cancelled');continue;}
        if(op.mode==='append') await this.toolAppend(op.path,op.content); else await this.toolWrite(op.path,op.content);
        audit.push({...op,status:'applied',appliedAt:new Date().toISOString()});flow.step(op.path,'Applied','done');
      }
      const log=`memory/applied/${date}-${Date.now()}.json`; await this.toolWrite(log,JSON.stringify({createdAt:stamp,session:this.sessionId,operations:audit},null,2));
      if(audit.some(x=>x.status==='applied')) for(const candidate of approved){candidate.status='applied';await this.toolWrite(this.candidatePath(candidate.id),JSON.stringify(candidate,null,2));}
      const sourceStatus=[...new Set(audit.filter(x=>x.status==='applied').flatMap(x=>x.sources||[]))];
      if(sourceStatus.length) await this.toolAppend(`memory/applied/index-${date}.md`,`\n## ${stamp}\nAudit: [[${log}]]\nSources:\n${sourceStatus.map(x=>`- [[${x}]]`).join('\n')}\n`);
      return `Applied ${audit.filter(x=>x.status==='applied').length}/${ops.length} operations. Audit: ${log}`;
    });
  }

  private parseMemoryOperations(raw:string):{operations:MemoryOperation[]} {
    const cleaned=raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
    let data:any; try{data=JSON.parse(cleaned);}catch{const a=cleaned.indexOf('{'),b=cleaned.lastIndexOf('}');if(a<0||b<=a)throw new Error('Invalid JSON plan.');data=JSON.parse(cleaned.slice(a,b+1));}
    const allowed=(p:string)=>/^(people|projects|wiki|decisions|daily)\/.+\.md$/i.test(p)||/^(profile|style)\.md$/i.test(p);
    const operations:MemoryOperation[]=[];
    for(const x of Array.isArray(data.operations)?data.operations:[]){
      const path=this.normalizePath(String(x.path||''));const mode=x.mode==='write'?'write':'append';const content=String(x.content||'').trim();
      if(!allowed(path)||!content)continue;
      operations.push({path,mode,content,sources:Array.isArray(x.sources)?x.sources.map(String):[],reason:String(x.reason||'Memory consolidation')});
    }
    return {operations:operations.slice(0,40)};
  }

  private async skillUpdateProfile() {
    await this.runSkillFlow('obsidian-update-profile', async (flow) => {
      const feedback = await this.collectFolderText('memory/feedback');
      if (!feedback) throw new Error('No feedback records.');
      const currentProfile = await this.toolRead('profile.md');
      const currentStyle = await this.toolRead('style.md');
      flow.step('Read feedback', `${feedback.length} chars`, 'done');
      const prompt = `根据反馈分别输出 profile.md 和 style.md 的完整建议新内容。格式必须为：\n===PROFILE===\n...\n===STYLE===\n...\n不得修改事实，仅总结稳定偏好。\n\nCurrent profile:\n${currentProfile}\n\nCurrent style:\n${currentStyle}\n\nFeedback:\n${feedback.slice(0,24000)}`;
      const proposal = this.settings.apiKey ? await this.callLLM(prompt) : null;
      if (!proposal) throw new Error('Profile update requires configured LLM.');
      const p = proposal.match(/===PROFILE===([\s\S]*?)===STYLE===/)?.[1]?.trim();
      const st = proposal.match(/===STYLE===([\s\S]*)/)?.[1]?.trim();
      if (!p || !st) throw new Error('Model did not return structured PROFILE/STYLE sections.');
      if (await this.confirmMutation('Update profile', 'profile.md', p)) { await this.toolWrite('profile.md', p); flow.step('profile.md', 'Updated', 'done'); }
      else flow.step('profile.md', 'Cancelled', 'cancelled');
      if (await this.confirmMutation('Update style', 'style.md', st)) { await this.toolWrite('style.md', st); flow.step('style.md', 'Updated', 'done'); }
      else flow.step('style.md', 'Cancelled', 'cancelled');
      return 'Profile workflow completed.';
    });
  }

  private async skillVaultDoctor() {
    await this.runSkillFlow('obsidian-vault-doctor', async (flow) => {
      const files = this.app.vault.getFiles(); const markdown = this.app.vault.getMarkdownFiles();
      const raw = files.filter((f:any)=>f.path.startsWith('raw/')); const empty:string[]=[]; const broken:string[]=[];
      for (const f of markdown.slice(0,800)) {
        try {
          const text = await this.app.vault.cachedRead(f); if (text.trim().length < 20) empty.push(f.path);
          for (const l of this.app.metadataCache.getFileCache(f)?.links ?? []) if (!this.app.metadataCache.getFirstLinkpathDest(l.link,f.path)) broken.push(`${f.path} → ${l.link}`);
        } catch {}
      }
      flow.step('Scan vault', `${files.length} files`, 'done');
      const report = `# Vault Doctor\n\n- files: ${files.length}\n- markdown: ${markdown.length}\n- raw: ${raw.length}\n- empty: ${empty.length}\n- broken links: ${broken.length}\n\n## Empty\n${empty.slice(0,80).map(x=>'- '+x).join('\n')||'None'}\n\n## Broken links\n${broken.slice(0,120).map(x=>'- '+x).join('\n')||'None'}\n\n## Raw\n${raw.slice(0,80).map((x:any)=>'- '+x.path).join('\n')||'None'}\n`;
      const out=`memory/vault-doctor-${new Date().toISOString().slice(0,10)}.md`;
      if (!(await this.confirmMutation('Write doctor report',out,report))) throw new Error('User cancelled report.');
      await this.toolWrite(out,report); flow.step('Write report',out,'done'); return `Vault doctor report: ${out}`;
    });
  }

  private async skillCreateSkill(description: string) {
    await this.runSkillFlow('obsidian-create-skill', async (flow) => {
      if (!description) throw new Error('Usage: /create-skill <description>');
      const slug = description.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g,'-').replace(/^-|-$/g,'').slice(0,40) || `skill-${Date.now()}`;
      const prompt = `Create a concise SKILL.md for a local Obsidian agent. Include YAML frontmatter name and description, triggers, required context, allowed tools, steps, output paths, confirmation policy, and forbidden actions. User request: ${description}`;
      const content = this.settings.apiKey ? await this.callLLM(prompt) : `---\nname: ${slug}\ndescription: ${description}\n---\n\n# Steps\n1. Clarify input.\n2. Read relevant notes.\n3. Produce output with confirmation.\n`;
      if (!content) throw new Error('Skill generation failed.');
      const out=`.nullclaw/skills/${slug}/SKILL.md`; flow.step('Generate skill',out,'awaiting');
      if (!(await this.confirmMutation('Create skill',out,content))) throw new Error('User cancelled skill creation.');
      await this.toolWrite(out,content); await this.loadCustomSkills(); flow.step('Create skill',out,'done'); return `Created ${out}`;
    });
  }

  private async runSkillFlow(name: string, runner: (flow: { step: (label:string,detail:string,state:string)=>void }) => Promise<string>) {
    const card=this.outputEl.createDiv({cls:'nc-skill-flow'}); card.createDiv({cls:'nc-skill-flow-title',text:`Skill · ${name}`});
    const steps=card.createDiv({cls:'nc-skill-steps'});
    const flow={step:(label:string,detail:string,state:string)=>{const row=steps.createDiv({cls:`nc-skill-step is-${state}`}); row.createSpan({cls:'nc-skill-step-label',text:label}); row.createSpan({cls:'nc-skill-step-detail',text:detail}); this.stickToBottom();}};
    try { const result=await runner(flow); card.addClass('is-complete'); this.println(result,'nc-output'); }
    catch(e:any){ card.addClass('is-error'); this.println(`Skill failed: ${e.message}`,'nc-error'); }
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

  private async createSourceForAttachment(rawPath:string,file:File,buf:ArrayBuffer):Promise<string|null> {
    const ext=(file.name.split('.').pop()||'').toLowerCase();
    const textTypes=['txt','md','markdown','json','csv','yaml','yml','html','xml','log'];
    const source=`sources/${rawPath.slice(4).replace(/\.[^.]+$/, '')}.md`;
    const meta=`---\nraw: "[[${rawPath}]]"\nname: ${JSON.stringify(file.name)}\nmime: ${JSON.stringify(file.type||'application/octet-stream')}\nsize: ${file.size}\nimported: ${new Date().toISOString()}\n---\n\n`;
    if(textTypes.includes(ext)||file.type.startsWith('text/')) {
      const text=new TextDecoder().decode(buf).slice(0,500000);
      await this.toolWrite(source,`${meta}# Source: ${file.name}\n\n${text}`); return source;
    }
    if(file.type.startsWith('image/')) {
      await this.toolWrite(source,`${meta}# Image source\n\n![[${rawPath}]]\n\n> OCR/description can be regenerated; raw evidence is immutable.`); return source;
    }
    if(ext==='pdf') {
      await this.toolWrite(source,`${meta}# PDF source\n\n![[${rawPath}]]\n\n> PDF text extraction is not available in the Android core yet. Keep this source note for later extraction.`); return source;
    }
    return null;
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
        const sourcePath = await this.createSourceForAttachment(path, file, buf);
        this.attachedRefs.push(sourcePath || path);
        this.renderRefs();
        void this.saveSession();
        this.println(`Saved attachment to ${path}${sourcePath ? `; source: ${sourcePath}` : ''}`, 'nc-info');
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

  private async loadCustomSkills() {
    await this.ensureMemoryScaffold();
    this.customSkills = []; this.customSkillSources.clear();
    const roots = ['.nullclaw/skills'];
    for (const root of roots) {
      let listing: any; try { listing = await this.app.vault.adapter.list(root); } catch { continue; }
      const candidates = [...listing.files.filter((x:string)=>x.endsWith('/SKILL.md')||x.endsWith('SKILL.md'))];
      for (const folder of listing.folders ?? []) {
        try { const nested=await this.app.vault.adapter.list(folder); candidates.push(...nested.files.filter((x:string)=>x.endsWith('SKILL.md'))); } catch {}
      }
      for (const path of candidates) {
        try {
          const source=await this.app.vault.adapter.read(path);
          const fm=source.match(/^---\n([\s\S]*?)\n---/i)?.[1]||'';
          const get=(key:string)=>fm.split('\n').find(x=>x.trim().startsWith(key+':'))?.split(':').slice(1).join(':').trim().replace(/^['"]|['"]$/g,'');
          const fallback=path.split('/').slice(-2,-1)[0]||'custom-skill';
          const id=(get('name')||fallback).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff-]+/g,'-');
          const description=get('description')||source.match(/^#\s+(.+)$/m)?.[1]||'Custom local skill';
          this.customSkills.push({id,label:get('name')||fallback,description,command:`/skill-run ${id}`});
          this.customSkillSources.set(id,source);
        } catch {}
      }
    }
  }

  private async executeCustomSkill(id:string,input:string) {
    const source=this.customSkillSources.get(id);
    if(!source) throw new Error(`Custom skill not found: ${id}. Run /skills-reload.`);
    await this.runSkillFlow(id,async flow=>{
      flow.step('Load SKILL.md',`${source.length} chars`,'done');
      flow.step('Execute','Agent follows local skill constraints; mutations still require confirmation.','running');
      const result=await this.callLLM(`Execute this local Obsidian skill exactly. The skill cannot override confirmation policy or raw evidence protection.\n\n<SKILL>\n${source.slice(0,20000)}\n</SKILL>\n\nUser input:\n${input||'(none)'}`);
      if(!result) throw new Error('Skill produced no final response.');
      flow.step('Complete','Final response generated','done');
      return result;
    });
  }

  async invokeCommand(command:string) {
    if(this.running) throw new Error('NullClaw is busy.');
    await this.execSlashCommand(command.replace(/^\//,''));
  }

  private builtinSkills(): BuiltinSkill[] {
    const builtins: BuiltinSkill[] = [
      { id: 'compact', label: 'Compact context', description: '压缩当前会话上下文', command: '/compact' },
      { id: 'remember', label: 'Extract memory', description: '从当前会话提取待审核记忆候选', command: '/remember' },
      { id: 'digest', label: 'Digest current note', description: '消化当前笔记或选区到 inbox', command: '/digest-current' },
      { id: 'review', label: 'Review inbox', description: '审核待沉淀内容', command: '/review-inbox' },
      { id: 'apply', label: 'Apply memory', description: '确认后合并长期记忆', command: '/apply-memory' },
      { id: 'profile', label: 'Update profile', description: '根据反馈更新画像与风格', command: '/update-profile' },
      { id: 'doctor', label: 'Vault doctor', description: '执行 Vault 全库体检', command: '/vault-doctor' },
      { id: 'create', label: 'Create skill', description: '创建新的本地技能', command: '/create-skill' },
    ];
    return [...builtins, ...this.customSkills];
  }

  private updateSkillMenu() {
    const value = this.inputEl.value;
    if (!value.startsWith('/') || value.includes(' ')) { this.closeSkillMenu(); return; }
    const q = value.slice(1).toLowerCase();
    this.skillItems = this.builtinSkills().filter(x => x.id.includes(q) || x.label.toLowerCase().includes(q));
    if (!this.skillItems.length) { this.closeSkillMenu(); return; }
    this.skillIndex = Math.min(this.skillIndex, this.skillItems.length - 1);
    this.renderSkillMenu();
  }

  private renderSkillMenu() {
    this.skillEl.empty(); this.skillEl.hidden = false;
    this.skillItems.forEach((skill, i) => {
      const item = this.skillEl.createDiv({ cls: `nc-skill-item${i === this.skillIndex ? ' is-selected' : ''}` });
      item.createDiv({ cls: 'nc-skill-label', text: `/${skill.id} · ${skill.label}` });
      item.createDiv({ cls: 'nc-skill-desc', text: skill.description });
      item.addEventListener('mousedown', e => e.preventDefault());
      item.addEventListener('click', () => this.chooseSkill(i));
    });
  }

  private moveSkill(delta: number) {
    if (!this.skillItems.length) return;
    this.skillIndex = (this.skillIndex + delta + this.skillItems.length) % this.skillItems.length;
    this.renderSkillMenu();
  }

  private chooseSkill(index: number) {
    const skill = this.skillItems[index]; if (!skill) return;
    this.selectedSkill = skill; this.inputEl.value = ''; this.closeSkillMenu(); this.renderRefs();
  }

  private closeSkillMenu() { this.skillEl.hidden = true; this.skillEl.empty(); this.skillItems = []; this.skillIndex = 0; }

  private async loadSessionIndex(): Promise<SessionIndexItem[]> {
    await this.ensureMemoryScaffold();
    const listing = await this.app.vault.adapter.list('.nullclaw/sessions');
    const items: SessionIndexItem[] = [];
    for (const path of listing.files.filter((x: string) => x.endsWith('.json'))) {
      try {
        const d = JSON.parse(await this.app.vault.adapter.read(path)) as SessionData;
        items.push({ id: d.id || path.split('/').pop()!.replace('.json',''), title: d.title || 'Untitled', updatedAt: d.updatedAt || 0, messageCount: d.messages?.length || 0 });
      } catch {}
    }
    return items.sort((a,b) => b.updatedAt - a.updatedAt);
  }

  private ensureSessionPanelMounted() {
    const root=this.containerEl.children[1] as HTMLElement;
    if(!this.sessionEl?.isConnected || this.sessionEl.parentElement!==root) {
      this.sessionEl=root.createDiv({cls:'nc-session-panel'}); this.sessionEl.hidden=true;
    }
  }

  private async toggleSessionPanel(forceOpen?: boolean) {
    this.ensureSessionPanelMounted();
    const open = forceOpen ?? this.sessionEl.hidden;
    if (!open) { this.sessionEl.hidden = true; this.sessionEl.empty(); return; }
    this.sessionEl.empty(); this.sessionEl.hidden = false;
    const head = this.sessionEl.createDiv({ cls: 'nc-session-head' });
    head.createSpan({ text: 'Sessions' });
    const create = head.createEl('button', { text: '+ New' }); create.addEventListener('click', () => void this.newSession());
    const close = head.createEl('button', { text: '×' }); close.addEventListener('click', () => { this.sessionEl.hidden = true; });
    const search=this.sessionEl.createEl('input',{cls:'nc-session-search',attr:{type:'search',placeholder:'Search sessions…'}});
    const list=this.sessionEl.createDiv({cls:'nc-session-list'});
    let items:SessionIndexItem[]=[];
    try { items=await this.loadSessionIndex(); }
    catch(e:any) { list.createDiv({cls:'nc-session-empty',text:`Failed to load sessions: ${e.message}`}); return; }
    const render=(query='')=>{
      list.empty();const q=query.toLowerCase().trim();
      for (const item of items.filter(x=>!q||x.title.toLowerCase().includes(q)||x.id.toLowerCase().includes(q))) {
        const row = list.createDiv({ cls: `nc-session-row${item.id === this.sessionId ? ' is-active' : ''}` });
        const main = row.createDiv({ cls: 'nc-session-main' });
        main.createDiv({ cls: 'nc-session-title', text: item.title });
        main.createDiv({ cls: 'nc-session-meta', text: `${item.messageCount} messages · ${new Date(item.updatedAt).toLocaleString()}` });
        main.addEventListener('click', () => void this.switchSession(item.id));
        const more=row.createEl('button',{text:'⋮'});
        more.addEventListener('click',()=>this.showSessionActions(row,item));
      }
      if(!list.children.length)list.createDiv({cls:'nc-session-empty',text:'No sessions.'});
    };
    search.addEventListener('input',()=>render(search.value));render();
  }

  private showSessionActions(row:HTMLElement,item:SessionIndexItem) {
    row.querySelector('.nc-session-actions')?.remove();
    const actions=row.createDiv({cls:'nc-session-actions'});
    const rename=actions.createEl('button',{text:'Rename'});
    const exp=actions.createEl('button',{text:'Export'});
    const del=actions.createEl('button',{text:'Delete'});
    rename.addEventListener('click',()=>{
      actions.empty();const input=actions.createEl('input',{attr:{value:item.title}});const save=actions.createEl('button',{text:'Save'});
      save.addEventListener('click',()=>void this.renameSession(item.id,input.value));
    });
    exp.addEventListener('click',()=>void this.exportSession(item.id));
    del.addEventListener('click',()=>void this.deleteSession(item.id));
  }

  private async newSession(title?: string) {
    await this.saveSession();
    this.sessionId = `session-${Date.now()}`;
    this.messages = []; this.sessionSummary = ''; this.attachedRefs = []; this.attachedSelection = '';
    this.outputEl.empty(); this.ensureSessionPanelMounted(); this.renderRefs();
    if (title) this.messages.push({ role: 'system', content: `Session title: ${title}` });
    await this.saveSession();
    this.println(`New session: ${title || this.sessionId}`, 'nc-info');
    this.sessionEl.hidden = true;
  }

  private async switchSession(id: string) {
    await this.saveSession();
    this.sessionId = id; this.messages = []; this.sessionSummary = ''; this.attachedRefs = []; this.attachedSelection = '';
    this.outputEl.empty(); this.ensureSessionPanelMounted(); this.sessionEl.hidden = true;
    await this.restoreSession();
  }

  private async renameSession(id:string,title:string) {
    const path=`.nullclaw/sessions/${id}.json`;if(!(await this.app.vault.adapter.exists(path)))throw new Error(`Session not found: ${id}`);
    const data=JSON.parse(await this.app.vault.adapter.read(path)) as SessionData;data.title=title.trim()||data.title;data.updatedAt=Date.now();await this.toolWrite(path,JSON.stringify(data,null,2));
    if(id===this.sessionId) this.messages=this.messages.filter(m=>!(m.role==='system'&&m.content.startsWith('Session title:')));
    this.println(`Renamed session to ${data.title}.`,'nc-info');await this.toggleSessionPanel(true);
  }

  private async exportSession(id:string) {
    const path=`.nullclaw/sessions/${id}.json`;if(!(await this.app.vault.adapter.exists(path)))throw new Error(`Session not found: ${id}`);
    const data=JSON.parse(await this.app.vault.adapter.read(path)) as SessionData;
    const safe=(data.title||id).replace(/[\\/:*?"<>|]/g,'_').slice(0,80);const out=`.nullclaw/sessions/exports/${safe}-${id}.md`;
    const body=[`# ${data.title||id}`,``, `- Session: ${id}`,`- Updated: ${new Date(data.updatedAt).toISOString()}`,data.summary?`\n## Summary\n\n${data.summary}`:'',...data.messages.filter(m=>m.role==='user'||m.role==='assistant').map(m=>`\n## ${m.role==='user'?'You':'NullClaw'}\n\n${m.content}`)].join('\n');
    await this.toolWrite(out,body);this.println(`Session exported to ${out}`,'nc-output');
  }

  private async deleteSession(id: string) {
    if (!(await this.confirmOperation('Delete session', id, 'Delete this saved conversation?'))) return;
    const path = `.nullclaw/sessions/${id}.json`;
    if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
    if (id === this.sessionId) await this.newSession(); else await this.toggleSessionPanel(true);
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
      copy.addEventListener('click', async () => {
        try {
          if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
          else {
            const area = document.createElement('textarea'); area.value = text; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove();
          }
        } catch { this.println('Copy failed.', 'nc-error'); }
      });
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

  private async confirmOperation(action: string, target: string, detail: string): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const card = this.outputEl.createDiv({ cls: 'nc-confirm-card' });
      card.createDiv({ cls: 'nc-confirm-title', text: `${action} · ${target}` });
      card.createDiv({ cls: 'nc-confirm-detail', text: detail });
      const controls = card.createDiv({ cls: 'nc-confirm-actions' });
      const yes = controls.createEl('button', { cls: 'mod-cta', text: 'Confirm' });
      const no = controls.createEl('button', { text: 'Cancel' });
      const finish = (value: boolean) => { yes.disabled = true; no.disabled = true; card.addClass(value ? 'nc-confirmed' : 'nc-cancelled'); resolve(value); };
      yes.addEventListener('click', () => finish(true)); no.addEventListener('click', () => finish(false));
      this.stickToBottom();
    });
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
    const a = before.split('\n'), b = after.split('\n');
    // Exact LCS for normal notes; bounded fallback for very large files.
    if (a.length * b.length > 250000) {
      let prefix=0; while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix]) prefix++;
      let suffix=0; while(suffix<a.length-prefix&&suffix<b.length-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix]) suffix++;
      return [`@@ line ${prefix+1} (large-file diff) @@`, ...a.slice(prefix,a.length-suffix).slice(0,100).map(x=>`- ${x}`), ...b.slice(prefix,b.length-suffix).slice(0,100).map(x=>`+ ${x}`)].join('\n');
    }
    const dp = Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
    for(let i=a.length-1;i>=0;i--) for(let j=b.length-1;j>=0;j--) dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
    const lines:string[]=[]; let i=0,j=0,shown=0;
    while((i<a.length||j<b.length)&&shown<240){
      if(i<a.length&&j<b.length&&a[i]===b[j]){ if(lines.length&&lines[lines.length-1]!== '…') lines.push(`  ${a[i]}`); i++;j++; }
      else if(j<b.length&&(i>=a.length||dp[i][j+1]>=dp[i+1][j])){ lines.push(`+ ${b[j++]}`); shown++; }
      else { lines.push(`- ${a[i++]}`); shown++; }
      if(lines.length>300) break;
    }
    return lines.join('\n') || '(no changes)';
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
    this.mentionEl.hidden = false;
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
    this.mentionEl.hidden = true; this.mentionEl.empty(); this.mentionItems = []; this.mentionStart = -1;
  }

  private renderRefs() {
    this.refsEl.empty();
    if (!this.attachedRefs.length && !this.selectedSkill) { this.refsEl.hidden = true; return; }
    this.refsEl.hidden = false;
    if (this.selectedSkill) {
      const pill = this.refsEl.createSpan({ cls: 'nc-skill-pill' });
      pill.createSpan({ text: `/${this.selectedSkill.id} · ${this.selectedSkill.label}` });
      const remove = pill.createEl('button', { text: '×' });
      remove.addEventListener('click', () => { this.selectedSkill = null; this.renderRefs(); });
    }
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
    const command = (id: string, name: string, text: string) => this.addCommand({ id, name, callback: async () => { await this.openView(); await this.view?.invokeCommand(text); } });
    command('digest-current-note', 'Digest current note', 'digest-current');
    command('attach-current-note', 'Attach current note', 'current');
    command('review-memory-inbox', 'Review memory inbox', 'review-inbox');
    command('apply-memory-plan', 'Apply memory plan', 'apply-memory');
    command('update-user-profile', 'Update user profile', 'update-profile');
    command('run-vault-doctor', 'Run Vault doctor', 'vault-doctor');
    command('extract-memory-candidates', 'Extract memory candidates from conversation', 'remember');
    command('review-memory-candidates', 'Review pending memory candidates', 'memory-candidates');
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
