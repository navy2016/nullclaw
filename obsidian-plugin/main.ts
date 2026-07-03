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
      this.println('Slash commands: /help /version /status /memory list /memory add <key> <value> /identity show', 'nc-info');
      return;
    }

    // Compatibility: /agent -m hello still works, but we route it through direct chat.
    const args = this.parseArgs(command);
    if (args[0] === 'agent') {
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
    const body = JSON.stringify({
      model: this.settings.model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are NullClaw, an AI assistant running inside Obsidian Android. Be concise, practical, and answer in the user language. Use markdown when useful.' },
        { role: 'user', content: message },
      ],
      max_tokens: 2048,
      temperature: 0.7,
    });

    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.settings.apiKey}`,
          'Content-Type': 'application/json',
          // OpenRouter accepts these optional headers; other providers ignore them.
          'HTTP-Referer': 'app://obsidian-nullclaw',
          'X-Title': 'NullClaw Obsidian',
        },
        body,
      });
      const text = await res.text();
      if (!res.ok) {
        this.println(`[LLM ${res.status}] ${text.slice(0, 500)}`, 'nc-error');
        return null;
      }
      const data = JSON.parse(text);
      return data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? text;
    } catch (e: any) {
      this.println(`[LLM fetch failed] ${e.message}`, 'nc-error');
      return null;
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

  private println(text: string, cls: string) {
    const line = this.outputEl.createDiv({ cls: `nc-line ${cls}` });
    line.textContent = text;
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  async onClose() {}
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
