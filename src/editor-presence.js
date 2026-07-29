const { MarkdownView } = require("obsidian");
const { isMarkdownPath, isIgnoredPath } = require("./helpers");

// Live editor presence: shows other members' cursors in the file you both have
// open, and a status-bar note that they are there. It is deliberately built as
// an absolutely-positioned overlay driven by the editor's read-only coordsAtPos
// API — it never mutates the editor, so a bug here cannot break typing.
const SEND_ACTIVE_MS = 180; // presence post interval while others are present
const SEND_IDLE_MS = 1500; // interval while alone (still refresh + detect peers)

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
    this.renderRaf = null;
    this.scrollEl = null;
    this.onMoveBound = null;
    this.scrollSettle = null;
    this.inFlight = false;
    this.disposed = false;
    this.tickBound = () => this.tick();
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
      // Re-place carets only when the view actually moves (scroll/resize), never
      // on a per-frame loop — the old per-frame coordsAtPos was what made the
      // editor jank. On scroll we drop the CSS transition so carets track exactly.
      const cm = this.editor && this.editor.cm;
      this.scrollEl = cm && cm.scrollDOM ? cm.scrollDOM : null;
      this.onMoveBound = () => {
        if (this.layer) {
          this.layer.classList.add("is-scrolling");
          if (this.scrollSettle) window.clearTimeout(this.scrollSettle);
          this.scrollSettle = window.setTimeout(() => {
            if (this.layer) this.layer.classList.remove("is-scrolling");
          }, 150);
        }
        this.scheduleRender();
      };
      if (this.scrollEl) this.scrollEl.addEventListener("scroll", this.onMoveBound, { passive: true });
      window.addEventListener("resize", this.onMoveBound, { passive: true });
    } catch (error) {
      this.layer = null;
    }
  }

  teardown() {
    if (this.timer) { window.clearTimeout(this.timer); this.timer = null; }
    if (this.renderRaf != null) { cancelAnimationFrame(this.renderRaf); this.renderRaf = null; }
    if (this.scrollSettle) { window.clearTimeout(this.scrollSettle); this.scrollSettle = null; }
    if (this.onMoveBound) {
      if (this.scrollEl) this.scrollEl.removeEventListener("scroll", this.onMoveBound);
      window.removeEventListener("resize", this.onMoveBound);
    }
    this.scrollEl = null;
    this.onMoveBound = null;
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
    const empty = { line: 0, ch: 0, fromLine: 0, fromCh: 0, toLine: 0, toCh: 0, editing: false };
    try {
      const editor = this.editor;
      if (!editor || !editor.getCursor) return empty;
      const head = editor.getCursor("head") || { line: 0, ch: 0 };
      const from = editor.getCursor("from") || head;
      const to = editor.getCursor("to") || head;
      const editing = this.currentView && this.currentView.getMode ? this.currentView.getMode() === "source" : true;
      return {
        line: head.line || 0, ch: head.ch || 0,
        fromLine: from.line || 0, fromCh: from.ch || 0,
        toLine: to.line || 0, toCh: to.ch || 0,
        editing,
      };
    } catch (error) {
      return empty;
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
      const encrypted = this.plugin.activeEncryptionVersion && this.plugin.activeEncryptionVersion() === 1;
      const presencePath = encrypted ? await this.plugin.blindPresenceId("file-presence", path) : path;
      const result = await this.plugin.api(`/vaults/${encodeURIComponent(this.plugin.data.vaultId)}/files/presence`, {
        method: "POST",
        body: {
          ...(encrypted ? { fileId: presencePath } : { path: presencePath }),
          color, editing: cur.editing,
          line: cur.line, ch: cur.ch,
          fromLine: cur.fromLine, fromCh: cur.fromCh, toLine: cur.toLine, toCh: cur.toCh,
        },
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
      const encrypted = this.plugin.activeEncryptionVersion && this.plugin.activeEncryptionVersion() === 1;
      const presencePath = encrypted ? await this.plugin.blindPresenceId("file-presence", path) : path;
      await this.plugin.api(`/vaults/${encodeURIComponent(this.plugin.data.vaultId)}/files/presence`, {
        method: "POST",
        body: { ...(encrypted ? { fileId: presencePath } : { path: presencePath }), leave: true },
      });
    } catch (error) {
      // best-effort; the server TTL expires us anyway
    }
  }

  applyPeers(peers) {
    if (!Array.isArray(peers)) return;
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
      const fin = (v) => (Number.isFinite(v) ? v : 0);
      entry.from = { line: fin(p.fromLine), ch: fin(p.fromCh) };
      entry.to = { line: fin(p.toLine), ch: fin(p.toCh) };
    });
    // The server returns all active peers, so anyone absent has left -> remove.
    this.peers.forEach((entry, email) => {
      if (seen.has(email)) return;
      if (entry.el && entry.el.parentElement) entry.el.remove();
      (entry.selEls || []).forEach((el) => el.parentElement && el.remove());
      this.peers.delete(email);
    });
    this.renderStatus();
    this.scheduleRender();
  }

  // Coalesce redraws into a single rAF. Called only on real changes (a presence
  // update, scroll, or resize) — NOT every frame — so there is no idle CPU cost.
  scheduleRender() {
    if (this.disposed || this.renderRaf != null || !this.layer) return;
    this.renderRaf = requestAnimationFrame(() => {
      this.renderRaf = null;
      this.renderCursors();
    });
  }

  renderCursors() {
    if (!this.layer || !this.editor || this.peers.size === 0) return;
    const cm = this.editor.cm;
    const scrollRect = cm && cm.scrollDOM ? cm.scrollDOM.getBoundingClientRect() : null;
    if (!scrollRect) return;
    this.peers.forEach((entry) => {
      const px = this.coordsFor(entry);
      const visible = !!(px
        && px.top >= scrollRect.top - 2 && px.top + px.h <= scrollRect.bottom + 2
        && px.left >= scrollRect.left - 2 && px.left <= scrollRect.right + 2);
      this.drawCaret(entry, px, visible);
      this.drawSelection(entry, scrollRect);
    });
  }

  // Per-line highlight rectangles for a peer's selection, clipped to the viewport.
  // Correct for non-wrapped lines; a heavily wrapped line is an approximate box.
  selectionRects(entry, scrollRect) {
    const out = [];
    const from = entry.from;
    const to = entry.to;
    if (!from || !to || (from.line === to.line && from.ch === to.ch)) return out;
    const editor = this.editor;
    const cm = editor.cm;
    if (!cm || typeof cm.coordsAtPos !== "function" || !editor.posToOffset) return out;

    // Clamp iteration to the VISIBLE line range up front, so coordsAtPos runs only
    // for on-screen lines — not the whole selection — keeping this cheap and
    // jank-free even for a huge selection scrolled mostly out of view.
    let startLine = from.line;
    let endLine = to.line;
    try {
      const x = scrollRect.left + 4;
      const topOff = typeof cm.posAtCoords === "function" ? cm.posAtCoords({ x, y: scrollRect.top + 2 }) : null;
      const botOff = typeof cm.posAtCoords === "function" ? cm.posAtCoords({ x, y: scrollRect.bottom - 2 }) : null;
      if (topOff != null && editor.offsetToPos) startLine = Math.max(startLine, editor.offsetToPos(topOff).line);
      if (botOff != null && editor.offsetToPos) endLine = Math.min(endLine, editor.offsetToPos(botOff).line);
    } catch (error) { /* fall back to the full range, still bounded by MAX_LINES */ }

    const MAX_LINES = 200;
    for (let line = startLine; line <= endLine && (line - startLine) < MAX_LINES; line++) {
      let lineText;
      try { lineText = editor.getLine(line); } catch (error) { continue; }
      if (lineText == null) continue;
      const sCh = line === from.line ? from.ch : 0;
      const eCh = line === to.line ? to.ch : lineText.length;
      let a;
      let b;
      try {
        const sOff = editor.posToOffset({ line, ch: sCh });
        const eOff = editor.posToOffset({ line, ch: eCh });
        if (sOff == null || eOff == null) continue;
        a = cm.coordsAtPos(sOff);
        b = cm.coordsAtPos(Math.max(sOff, eOff));
      } catch (error) { continue; }
      if (!a || !b) continue;

      const top = Math.min(a.top, b.top);
      const bottom = Math.max(a.bottom, b.bottom);
      if (top > scrollRect.bottom + 2) break; // past the viewport; later lines are only lower
      if (bottom < scrollRect.top - 2) continue; // above the viewport
      let width = b.left - a.left;
      if (line !== to.line) width = Math.max(width, scrollRect.right - a.left - 8); // spans to EOL
      if (width < 4) width = 6; // empty / single-char sliver
      out.push({ left: a.left, top, width, height: Math.max(12, bottom - top) });
    }
    return out;
  }

  drawSelection(entry, scrollRect) {
    const rects = this.selectionRects(entry, scrollRect);
    entry.selEls = entry.selEls || [];
    while (entry.selEls.length < rects.length) {
      const el = document.createElement("div");
      el.className = "sd-editor-sel";
      this.layer.append(el);
      entry.selEls.push(el);
    }
    // Reclaim surplus divs (with a little hysteresis) so a one-time huge selection
    // does not leave hundreds of hidden nodes for the peer's whole session.
    while (entry.selEls.length > rects.length + 8) {
      const el = entry.selEls.pop();
      if (el && el.parentElement) el.remove();
    }
    entry.selEls.forEach((el, i) => {
      if (i >= rects.length) { el.style.display = "none"; return; }
      const r = rects[i];
      el.style.setProperty("--sd-cursor-color", entry.color || "#8b5cf6");
      el.style.transform = `translate(${r.left.toFixed(1)}px, ${r.top.toFixed(1)}px)`;
      el.style.width = `${r.width.toFixed(1)}px`;
      el.style.height = `${r.height.toFixed(1)}px`;
      el.style.display = "";
    });
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
