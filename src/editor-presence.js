const { MarkdownView } = require("obsidian");
const { isMarkdownPath, isIgnoredPath } = require("./helpers");

// Live editor presence: shows other members' cursors in the file you both have
// open, and a status-bar note that they are there. It is deliberately built as
// an absolutely-positioned overlay driven by the editor's read-only coordsAtPos
// API — it never mutates the editor, so a bug here cannot break typing.
const SEND_ACTIVE_MS = 250; // presence post interval while others are present
const SEND_IDLE_MS = 1500; // interval while alone (still refresh + detect peers)
const PEER_TTL_MS = 12000; // drop a peer we have not heard about in this long

class EditorPresence {
  constructor(plugin) {
    this.plugin = plugin;
    this.currentPath = null;
    this.currentView = null;
    this.editor = null;
    this.peers = new Map();
    this.layer = null;
    this.statusEl = null;
    this.timer = null;
    this.rafId = null;
    this.inFlight = false;
    this.disposed = false;
    this.tickBound = () => this.tick();
    this.frameBound = () => this.frame();
  }

  start() {
    try {
      this.statusEl = this.plugin.addStatusBarItem();
      this.statusEl.addClass("sd-presence-status");
      this.renderStatus();
      this.plugin.registerEvent(this.plugin.app.workspace.on("active-leaf-change", () => this.onActiveChange()));
      this.plugin.registerEvent(this.plugin.app.workspace.on("layout-change", () => this.onActiveChange()));
      this.onActiveChange();
    } catch (error) {
      // presence is best-effort; never let it break plugin load
    }
  }

  stop() {
    this.disposed = true;
    if (this.currentPath && this.isEnabled()) this.sendLeave(this.currentPath);
    this.teardown();
    if (this.statusEl && this.statusEl.parentElement) this.statusEl.remove();
    this.statusEl = null;
    this.currentPath = null;
    this.currentView = null;
    this.peers = new Map();
  }

  isEnabled() {
    const d = this.plugin.data;
    return !!(d && d.signedIn && d.authToken && d.vaultId && typeof this.plugin.api === "function");
  }

  getActive() {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) return null;
    const path = view.file.path;
    if (isIgnoredPath(path) || !isMarkdownPath(path)) return null;
    return { view, path, editor: view.editor };
  }

  onActiveChange() {
    const active = this.getActive();
    const path = active ? active.path : null;
    if (path === this.currentPath) {
      if (active) { this.currentView = active.view; this.editor = active.editor; }
      return;
    }
    if (this.currentPath && this.isEnabled()) this.sendLeave(this.currentPath);
    this.teardown();
    this.currentPath = path;
    this.currentView = active ? active.view : null;
    this.editor = active ? active.editor : null;
    this.peers = new Map();
    if (path && this.isEnabled()) {
      this.setupLayer();
      this.scheduleTick(0);
    }
    this.renderStatus();
  }

  setupLayer() {
    try {
      this.layer = document.createElement("div");
      this.layer.className = "sd-editor-cursors";
      document.body.appendChild(this.layer);
    } catch (error) {
      this.layer = null;
    }
  }

  teardown() {
    if (this.timer) { window.clearTimeout(this.timer); this.timer = null; }
    if (this.rafId != null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.layer && this.layer.parentElement) this.layer.remove();
    this.layer = null;
    this.editor = null;
    this.inFlight = false;
  }

  scheduleTick(delay) {
    if (this.disposed) return;
    if (this.timer) window.clearTimeout(this.timer);
    const d = typeof delay === "number" ? delay : (this.peers.size ? SEND_ACTIVE_MS : SEND_IDLE_MS);
    this.timer = window.setTimeout(this.tickBound, d);
  }

  readCursor() {
    try {
      const c = this.editor && this.editor.getCursor ? this.editor.getCursor() : null;
      const editing = this.currentView && this.currentView.getMode ? this.currentView.getMode() === "source" : true;
      return { line: (c && c.line) || 0, ch: (c && c.ch) || 0, editing };
    } catch (error) {
      return { line: 0, ch: 0, editing: false };
    }
  }

  async tick() {
    this.timer = null;
    // No file / torn down: stop the chain (do NOT self-reschedule, or a settled
    // in-flight request could keep this timer alive forever after teardown).
    if (this.disposed || !this.currentPath) return;
    if (!this.isEnabled()) { this.scheduleTick(SEND_IDLE_MS); return; }
    if (this.inFlight) { this.scheduleTick(); return; }

    const path = this.currentPath;
    const cur = this.readCursor();
    const color = (this.plugin.data.user && this.plugin.data.user.color) || "#8b5cf6";
    this.inFlight = true;
    try {
      const result = await this.plugin.api(`/vaults/${encodeURIComponent(this.plugin.data.vaultId)}/files/presence`, {
        method: "POST",
        body: { path, line: cur.line, ch: cur.ch, editing: cur.editing, color },
      });
      if (!this.disposed && this.currentPath === path) this.applyPeers(result && result.peers);
    } catch (error) {
      // offline / server hiccup: keep the last known peers rather than clearing
    } finally {
      this.inFlight = false;
      if (!this.disposed && this.currentPath) this.scheduleTick();
    }
  }

  async sendLeave(path) {
    try {
      await this.plugin.api(`/vaults/${encodeURIComponent(this.plugin.data.vaultId)}/files/presence`, {
        method: "POST",
        body: { path, leave: true },
      });
    } catch (error) {
      // best-effort; the server TTL expires us anyway
    }
  }

  applyPeers(peers) {
    if (!Array.isArray(peers)) return;
    const now = Date.now();
    const seen = new Set();
    peers.forEach((p) => {
      if (!p || !p.email || !Number.isFinite(p.line) || !Number.isFinite(p.ch)) return;
      seen.add(p.email);
      let entry = this.peers.get(p.email);
      if (!entry) { entry = {}; this.peers.set(p.email, entry); }
      entry.name = p.name || p.email;
      entry.color = p.color || "#8b5cf6";
      entry.editing = !!p.editing;
      entry.line = p.line;
      entry.ch = p.ch;
      entry.lastSeen = now;
    });
    this.peers.forEach((entry, email) => {
      if (seen.has(email)) return;
      if (entry.el && entry.el.parentElement) entry.el.remove();
      this.peers.delete(email);
    });
    this.renderStatus();
    this.ensureFrame();
  }

  ensureFrame() {
    if (this.rafId != null) return;
    if (!this.layer || this.peers.size === 0) return;
    this.rafId = requestAnimationFrame(this.frameBound);
  }

  frame() {
    this.rafId = null;
    if (!this.layer || !this.editor || this.peers.size === 0) return;

    // Drop peers we have not heard about within the TTL (e.g. during an outage
    // that keeps failing ticks) so this loop can settle instead of spinning.
    const cutoff = Date.now() - PEER_TTL_MS;
    this.peers.forEach((entry, email) => {
      if ((entry.lastSeen || 0) < cutoff) {
        if (entry.el && entry.el.parentElement) entry.el.remove();
        this.peers.delete(email);
      }
    });
    if (this.peers.size === 0) { this.renderStatus(); return; }

    const cm = this.editor.cm;
    const scrollRect = cm && cm.scrollDOM ? cm.scrollDOM.getBoundingClientRect() : null;
    this.peers.forEach((entry) => {
      const px = this.coordsFor(entry);
      const visible = !!(px && scrollRect
        && px.top >= scrollRect.top - 2 && px.top + px.h <= scrollRect.bottom + 2
        && px.left >= scrollRect.left - 2 && px.left <= scrollRect.right + 2);
      this.drawCaret(entry, px, visible);
    });
    // Recompute every frame so carets track scrolling; peers are rare so this is cheap.
    this.rafId = requestAnimationFrame(this.frameBound);
  }

  coordsFor(entry) {
    try {
      const cm = this.editor.cm;
      if (!cm || typeof cm.coordsAtPos !== "function" || !this.editor.posToOffset) return null;
      const offset = this.editor.posToOffset({ line: entry.line, ch: entry.ch });
      if (offset == null) return null;
      const c = cm.coordsAtPos(offset);
      if (!c) return null;
      return { left: c.left, top: c.top, h: Math.max(12, c.bottom - c.top) };
    } catch (error) {
      return null;
    }
  }

  drawCaret(entry, px, visible) {
    if (!visible) {
      if (entry.el) entry.el.style.display = "none";
      return;
    }
    if (!entry.el) {
      entry.el = document.createElement("div");
      entry.el.className = "sd-editor-cursor";
      entry.caret = document.createElement("span");
      entry.caret.className = "sd-editor-caret";
      entry.label = document.createElement("span");
      entry.label.className = "sd-editor-name";
      entry.el.append(entry.caret, entry.label);
      this.layer.append(entry.el);
    }
    if (entry.label.textContent !== entry.name) entry.label.textContent = entry.name;
    entry.el.style.setProperty("--sd-cursor-color", entry.color || "#8b5cf6");
    entry.el.style.height = `${px.h.toFixed(0)}px`;
    entry.el.style.display = "";
    entry.el.style.transform = `translate(${px.left.toFixed(1)}px, ${px.top.toFixed(1)}px)`;
  }

  renderStatus() {
    if (!this.statusEl) return;
    const count = this.peers.size;
    if (!this.currentPath || count === 0) {
      this.statusEl.setText("");
      this.statusEl.style.display = "none";
      return;
    }
    const editing = Array.from(this.peers.values()).filter((p) => p.editing).map((p) => p.name);
    this.statusEl.style.display = "";
    this.statusEl.setText(editing.length ? `✍ ${editing.join(", ")} editing` : `\u{1F441} ${count} here`);
  }
}

module.exports = { EditorPresence };
