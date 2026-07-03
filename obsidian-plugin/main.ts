import { Plugin, WorkspaceLeaf, ItemView, Notice } from 'obsidian';
import { runNullclaw, WasiResult } from './wasi-shim';

const VIEW_TYPE = 'nullclaw-agent-view';

class NullclawView extends ItemView {
  private outputEl!: HTMLDivElement;
  private inputEl!: HTMLInputElement;
  private statusDot!: HTMLSpanElement;
  private statusText!: HTMLSpanElement;
  private wasmBytes: ArrayBuffer | null = null;
  private running = false;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
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
    this.inputEl = row.createEl('input', { cls: 'nullclaw-input', attr: { type: 'text', placeholder: 'version | help | agent -m "hello" | memory list ...' } });
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
      // Try loading from plugin directory via vault adapter
      const adapter = this.app.vault.adapter;
      const pluginId = 'nullclaw-obsidian';
      // Get the plugin's resource path
      const basePath = (this.app as any).vault?.adapter?.basePath?.() || '';
      let wasmPath = `${pluginId}/nullclaw.wasm`;
      
      // On desktop, vault adapter can read files in .obsidian/plugins/
      // On mobile, same path structure works
      const fullPluginPath = `.obsidian/plugins/${pluginId}/nullclaw.wasm`;
      
      if (await adapter.exists(fullPluginPath)) {
        this.wasmBytes = await adapter.readBinary(fullPluginPath);
      } else {
        // Fallback: try fetching via resourceUrl
        const resourceUrl = (this.app as any).workspace?.component?.app?.localProtocolHandler?.getUri?.(this.app.vault, `${pluginId}/nullclaw.wasm`);
        if (resourceUrl) {
          const res = await fetch(resourceUrl);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          this.wasmBytes = await res.arrayBuffer();
        } else {
          throw new Error('Cannot locate nullclaw.wasm in plugin directory');
        }
      }

      this.statusDot.className = 'nc-dot nc-dot-ready';
      this.statusText.textContent = `NullClaw ready (${(this.wasmBytes.byteLength / 1024).toFixed(1)} KB)`;
      this.println('Welcome to NullClaw — embedded AI agent running entirely in your browser.', 'nc-info');
      this.println('Commands: version, help, status, agent -m "message", memory add/list/search, identity show/set', 'nc-info');
      this.println('', 'nc-info');
    } catch (e: any) {
      this.statusDot.className = 'nc-dot nc-dot-error';
      this.statusText.textContent = 'Load failed';
      this.println(`Failed to load nullclaw.wasm: ${e.message}`, 'nc-error');
    }
  }

  private async exec(input: string) {
    if (!input.trim() || !this.wasmBytes) return;
    this.running = true;
    this.statusDot.className = 'nc-dot nc-dot-running';
    this.statusText.textContent = 'Running...';
    this.println(`❯ ${input}`, 'nc-prompt');
    this.inputEl.value = '';
    this.inputEl.disabled = true;

    try {
      const args = this.parseArgs(input);
      const result = await runNullclaw(this.wasmBytes, args);
      if (result.stdout) this.println(result.stdout, 'nc-output');
      if (result.stderr) this.println(result.stderr, 'nc-error');
      if (!result.stdout && !result.stderr) this.println(`(exit: ${result.exitCode})`, 'nc-info');
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

export default class NullClawPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, (leaf) => new NullclawView(leaf));
    this.addRibbonIcon('bot', 'NullClaw', () => this.openView());
    this.addCommand({ id: 'open-nullclaw', name: 'Open NullClaw Agent', callback: () => this.openView() });
  }

  async openView() {
    const ws = this.app.workspace;
    const existing = ws.getLeavesOfType(VIEW_TYPE);
    const leaf = existing.length > 0 ? existing[0] : ws.getRightLeaf(false)!;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    ws.revealLeaf(leaf);
  }
}
