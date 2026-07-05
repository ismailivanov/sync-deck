const { MarkdownView, Modal, Notice, Plugin, TFile, addIcon } = require("obsidian");
const {
  DEFAULT_DATA,
  DEMO_MEMBER_EMAILS,
  ICON_ID,
  ICON_SVG,
  MAX_SYNC_FILE_SIZE,
  VIEW_TYPE,
  clone,
  isIgnoredPath,
  isMarkdownPath,
  uid,
} = require("./helpers");
const { SyncDeckView } = require("./view");
const { SyncDeckSettingTab } = require("./settings-tab");
const { EditorPresence } = require("./editor-presence");

const REMOTE_POLL_INTERVAL_MS = 1200; // idle poll (nobody else on the open file)
const REMOTE_POLL_ACTIVE_MS = 400; // fast poll while collaborating on the open file

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");

  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(value) {
  if (typeof Buffer !== "undefined") {
    const buffer = Buffer.from(value, "base64");
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// SHA-256 hex of a file's bytes, matching the server's per-file hash. Used to
// decide whether to pull, independent of unreliable cross-machine mtimes.
async function sha256Hex(buffer) {
  try {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (error) {
    return null;
  }
}

function isVaultAccessError(error) {
  return error && error.status === 403 && /vault access denied/i.test(error.message || "");
}

class InviteCodeModal extends Modal {
  constructor(app) {
    super(app);
    this.resolve = null;
  }

  openAndWait() {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  finish(value) {
    const resolve = this.resolve;
    this.resolve = null;
    this.close();
    if (resolve) resolve(value);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sd-invite-modal");
    contentEl.createEl("h2", { text: "Join vault" });
    contentEl.createEl("p", { text: "Paste the invite code from the vault owner." });

    const input = contentEl.createEl("input", {
      attr: {
        type: "text",
        placeholder: "Invite code",
        spellcheck: "false",
      },
    });
    input.addClass("sd-code-input");

    const actions = contentEl.createDiv({ cls: "sd-modal-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    const join = actions.createEl("button", { text: "Join" });
    join.addClass("mod-cta");

    const submit = () => {
      const code = input.value.trim().toUpperCase();
      if (!code) {
        input.focus();
        return;
      }
      this.finish(code);
    };

    cancel.addEventListener("click", () => this.finish(""));
    join.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
      if (event.key === "Escape") this.finish("");
    });
    input.addEventListener("input", () => {
      input.value = input.value.toUpperCase();
    });

    window.setTimeout(() => input.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
    if (this.resolve) this.finish("");
  }
}

module.exports = class SyncDeckPlugin extends Plugin {
  async onload() {
    this.data = this.normalizeData(Object.assign(clone(DEFAULT_DATA), await this.loadData() || {}));

    addIcon(ICON_ID, ICON_SVG);
    this.registerView(VIEW_TYPE, (leaf) => new SyncDeckView(leaf, this));
    this.addSettingTab(new SyncDeckSettingTab(this.app, this));
    this.registerVaultEvents();

    this.addRibbonIcon(ICON_ID, "Open SyncDeck", () => this.activateView());
    this.addCommand({
      id: "open-sync-deck",
      name: "Open SyncDeck",
      callback: () => this.activateView(),
    });
    this.startRemotePolling();
    this.editorPresence = new EditorPresence(this);
    this.editorPresence.start();
  }

  onunload() {
    this.unloaded = true;
    if (this.autoSyncTimer) window.clearTimeout(this.autoSyncTimer);
    if (this.remotePollTimer) window.clearTimeout(this.remotePollTimer);
    if (this.editorPresence) this.editorPresence.stop();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const leaf = leaves[0] || this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async savePluginData() {
    await this.saveData(this.data);
    this.refreshViews();
  }

  refreshViews() {
    // A deferred (not-yet-opened) leaf's view is a placeholder without render();
    // calling it throws and — because savePluginData() calls this — jammed the
    // whole sync loop. Guard against it and never let a view error break sync.
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      const view = leaf && leaf.view;
      if (view && typeof view.render === "function") {
        try { view.render(); } catch (error) { /* view render must not break sync */ }
      }
    });
  }

  normalizeData(data) {
    data.user = Object.assign(clone(DEFAULT_DATA.user), data.user || {});
    data.serverUrl = data.serverUrl || DEFAULT_DATA.serverUrl;
    data.authToken = data.authToken || "";
    data.serverStatus = data.serverStatus || "offline";
    data.remoteUpdatedAt = data.remoteUpdatedAt || "";
    data.vaultStats = Object.assign(clone(DEFAULT_DATA.vaultStats), data.vaultStats || {});
    data.members = Array.isArray(data.members)
      ? data.members.filter((member) => member && !DEMO_MEMBER_EMAILS.has(member.email))
      : clone(DEFAULT_DATA.members);
    data.activity = Array.isArray(data.activity) ? data.activity : clone(DEFAULT_DATA.activity);
    data.deviceId = data.deviceId || uid("device");
    data.vaultId = data.vaultId || uid("vault");
    data.syncQueue = this.compactQueue(Array.isArray(data.syncQueue) ? data.syncQueue : []);
    data.recentFiles = Array.isArray(data.recentFiles) ? data.recentFiles.slice(0, 20) : [];
    data.remoteKnownPaths = Array.isArray(data.remoteKnownPaths) ? data.remoteKnownPaths : [];
    data.remoteKnownVaultId = typeof data.remoteKnownVaultId === "string" ? data.remoteKnownVaultId : "";
    data.pendingDeletes = Array.isArray(data.pendingDeletes) ? data.pendingDeletes : [];
    data.syncedHashes = data.syncedHashes && typeof data.syncedHashes === "object" ? data.syncedHashes : {};
    data.deferredDeletePath = typeof data.deferredDeletePath === "string" ? data.deferredDeletePath : null;
    // Two roles only. Migrate legacy "Owner"/"User" records to "Admin"/"Worker".
    data.role = data.role === "Admin" || data.role === "Owner" ? "Admin" : "Worker";
    data.vaultOwner = typeof data.vaultOwner === "string" ? data.vaultOwner : "";
    data.members = data.members.map((member) => {
      if (!member) return member;
      const role = member.role === "Admin" || member.role === "Owner" ? "Admin" : "Worker";
      return Object.assign({}, member, { role });
    });
    if (data.signedIn && data.user.email && !DEMO_MEMBER_EMAILS.has(data.user.email)) {
      const current = {
        name: data.user.name || data.user.email,
        email: data.user.email,
        role: data.role,
        color: data.user.color || "#8b5cf6",
        picture: data.user.picture || "",
        status: "online",
      };
      const index = data.members.findIndex((member) => member.email === current.email);
      if (index >= 0) data.members[index] = Object.assign({}, data.members[index], current);
      else data.members.unshift(current);
    }
    return data;
  }

  upsertCurrentUserMember() {
    if (!this.data.user.email) return;

    const current = {
      name: this.data.user.name || this.data.user.email,
      email: this.data.user.email,
      role: this.data.role || "Worker",
      color: this.data.user.color || "#8b5cf6",
      picture: this.data.user.picture || "",
      status: "online",
    };
    const index = this.data.members.findIndex((member) => member.email === current.email);
    if (index >= 0) this.data.members[index] = Object.assign({}, this.data.members[index], current);
    else this.data.members.unshift(current);
  }

  async api(path, options = {}) {
    const baseUrl = String(this.data.serverUrl || DEFAULT_DATA.serverUrl).replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers: {
        "content-type": "application/json",
        ...(this.data.authToken ? { authorization: `Bearer ${this.data.authToken}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  async waitForGoogleSession(state) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 120000) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const session = await this.api(`/auth/google/session/${encodeURIComponent(state)}`);
      if (session.status === "complete") return session;
      if (session.status === "error") throw new Error(session.error || "Google sign in failed");
    }
    throw new Error("Google sign in timed out");
  }

  async pingServer() {
    await this.api("/health");
    this.data.serverStatus = "online";
    await this.savePluginData();
    return true;
  }

  async registerVault() {
    if (!this.data.authToken) return;
    await this.api("/vaults/register", {
      method: "POST",
      body: {
        vaultId: this.data.vaultId,
        deviceId: this.data.deviceId,
        workspace: this.data.workspace,
        stats: this.data.vaultStats,
      },
    });
  }

  async pushScanSummary() {
    if (!this.data.authToken) return;
    await this.api(`/vaults/${encodeURIComponent(this.data.vaultId)}/scan`, {
      method: "POST",
      body: {
        stats: this.data.vaultStats,
        queueLength: this.data.syncQueue.length,
      },
    });
    this.data.serverStatus = "online";
  }

  async markVaultAccessDenied(action) {
    // The server reports we are no longer a member of this vault (an admin
    // removed us, or we never had access). Leave it entirely: switch to a fresh
    // personal vault so the shared vault stops appearing as joined and can no
    // longer sync. Local files stay on disk but are detached from the cloud vault.
    this.data.serverStatus = "online";
    this.data.syncEnabled = false;
    this.data.syncProgress = 0;
    this.data.vaultStats.syncedFiles = 0;
    this.data.vaultId = uid("vault");
    this.data.role = "Admin";
    this.data.members = [];
    this.data.vaultOwner = this.data.user.email || "";
    this.data.remoteKnownPaths = [];
    this.data.remoteKnownVaultId = "";
    this.data.pendingDeletes = [];
    this.data.syncedHashes = {};
    this.data.remoteUpdatedAt = "";
    this.pushQueueItem(action, "Vault access", 0, "removed from vault");
    await this.savePluginData();
    new Notice("You no longer have access to this vault, so it has been removed. Ask an admin for a new invite to rejoin.");
  }

  async fetchVaultMembers() {
    if (!this.data.signedIn || !this.data.authToken || !this.data.vaultId) return;
    try {
      const result = await this.api(`/vaults/${encodeURIComponent(this.data.vaultId)}/members`);
      const members = Array.isArray(result.members) ? result.members : [];
      const role = (result.you && result.you.role) || this.data.role;
      const owner = result.owner || this.data.vaultOwner || "";
      const changed =
        JSON.stringify(members) !== JSON.stringify(this.data.members) ||
        role !== this.data.role ||
        owner !== this.data.vaultOwner;
      this.data.members = members;
      this.data.role = role;
      this.data.vaultOwner = owner;
      this.data.serverStatus = "online";
      if (changed) await this.savePluginData();
    } catch (error) {
      if (isVaultAccessError(error)) {
        await this.markVaultAccessDenied("members");
      }
      // Other errors (offline, vault not registered yet) are non-fatal here.
    }
  }

  async removeVaultMember(email) {
    if (!this.data.signedIn || !this.data.vaultId || !email) return;
    if ((this.data.role || "") !== "Admin") {
      new Notice("Only an admin can remove members.");
      return;
    }
    try {
      const result = await this.api(`/vaults/${encodeURIComponent(this.data.vaultId)}/members/remove`, {
        method: "POST",
        body: { email },
      });
      if (Array.isArray(result.members)) this.data.members = result.members;
      if (result.owner) this.data.vaultOwner = result.owner;
      await this.savePluginData();
      new Notice(`Removed ${email} from the vault.`);
    } catch (error) {
      new Notice(`Could not remove member: ${error.message}`);
    }
  }

  compactQueue(queue) {
    let keptScan = false;
    return queue.filter((item) => {
      if (item && item.action === "scan" && item.path === "Full vault") {
        if (keptScan) return false;
        keptScan = true;
      }
      return item && item.path;
    }).slice(0, 20);
  }

  registerVaultEvents() {
    this.registerEvent(this.app.vault.on("create", (file) => this.handleVaultEvent("create", file)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.handleVaultEvent("modify", file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.handleVaultEvent("delete", file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleVaultEvent("rename", file, oldPath)));
  }

  async isTaskDeckFile(file) {
    if (!(file instanceof TFile) || !isMarkdownPath(file.path)) return false;
    try {
      const text = await this.app.vault.cachedRead(file);
      return text.includes("kanban-card-id:") || text.includes("task-deck-board: true") || text.includes("kanban-board-id:");
    } catch (error) {
      // A file deleted/renamed mid-scan must not abort the whole sync.
      return false;
    }
  }

  async scanVault(options = {}) {
    const stats = clone(DEFAULT_DATA.vaultStats);
    const recentFiles = [];
    const syncableFiles = [];
    const files = this.app.vault.getFiles();

    for (const file of files) {
      const size = file.stat.size || 0;
      stats.totalFiles += 1;
      stats.totalBytes += size;

      if (isIgnoredPath(file.path)) {
        stats.ignoredFiles += 1;
        continue;
      }
      if (size > MAX_SYNC_FILE_SIZE) {
        stats.oversizedFiles += 1;
        continue;
      }

      stats.syncableFiles += 1;
      stats.syncableBytes += size;
      syncableFiles.push(file);
      if (isMarkdownPath(file.path)) stats.markdownFiles += 1;
      else stats.binaryFiles += 1;
      if (await this.isTaskDeckFile(file)) stats.taskDeckFiles += 1;

      recentFiles.push({
        path: file.path,
        size,
        mtime: file.stat.mtime || 0,
        type: isMarkdownPath(file.path) ? "markdown" : "file",
      });
    }

    recentFiles.sort((a, b) => b.mtime - a.mtime);
    this.data.vaultStats = stats;
    this.data.recentFiles = recentFiles.slice(0, 8);
    this.data.storageUsedMb = Math.round(stats.syncableBytes / 1024 / 1024);
    this.data.syncProgress = options.upload ? 0 : 100;
    this.data.lastSync = new Date().toLocaleString();
    this.pushQueueItem("scan", "Full vault", stats.syncableBytes, "done");
    if (options.upload) {
      // Serialize with pulls: wait out any in-flight pull, then claim the upload
      // slot so a concurrent poll cannot start a pull mid-upload. This is the
      // same mutual exclusion scheduleAutoSync already uses, extended to the
      // direct upload callers (toggleSync / finishScan / createInvite /
      // joinInvite) so upload and pull can never interleave and misread a
      // just-uploaded path as a remote deletion. Bounded so it can never hang.
      let waited = 0;
      while (this.remotePullRunning && waited < 5000) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        waited += 40;
      }
      this.autoSyncRunning = true;
    }
    try {
      await this.registerVault();
      await this.pushScanSummary();
      if (options.upload) await this.uploadVaultFiles(syncableFiles, { incremental: options.incremental });
    } catch (error) {
      if (isVaultAccessError(error)) {
        await this.markVaultAccessDenied("sync");
        return false;
      }
      this.data.serverStatus = "offline";
      this.pushQueueItem("sync", "Server sync", 0, `failed: ${error.message}`);
      new Notice(`Server sync failed: ${error.message}`);
      await this.savePluginData();
      return false;
    } finally {
      if (options.upload) this.autoSyncRunning = false;
    }
    await this.savePluginData();
    return true;
  }

  // The set of paths this device believes exist on the server. It is tagged with
  // the vaultId it was recorded for; if the active vault differs (e.g. after
  // joining another vault or switching accounts) it is treated as empty, so a
  // stale baseline can never drive a deletion against the new vault's files.
  getRemoteKnownPaths() {
    if (this.data.remoteKnownVaultId !== this.data.vaultId) return new Set();
    return new Set(this.data.remoteKnownPaths || []);
  }

  setRemoteKnownPaths(paths) {
    this.data.remoteKnownPaths = Array.isArray(paths) ? paths : Array.from(paths);
    this.data.remoteKnownVaultId = this.data.vaultId;
  }

  async uploadVaultFiles(files, options = {}) {
    if (!this.data.authToken) return;

    // Incremental uploads skip files whose content is unchanged since the last
    // sync, so a single card edit uploads one file instead of the whole vault.
    // A full (non-incremental) upload rebuilds the signature cache from scratch,
    // which is what manual / toggle / first-time sync uses as a safety net.
    const incremental = !!options.incremental;
    const previous = this.uploadedSignatures || {};
    const nextSignatures = {};
    // Paths that fired a local vault event since the last sync must upload even
    // if their signature looks unchanged. Snapshot so events during this run are
    // kept for the next sync rather than dropped.
    const dirty = new Set(this.dirtyUploadPaths || []);
    // Capture-and-clear: drop this snapshot from the LIVE set now. If the user
    // re-edits one of these files WHILE this upload is in flight, handleVaultEvent
    // re-adds it to dirtyUploadPaths and that re-add survives to the next run —
    // instead of being wiped by a blanket clear at the end (which could drop the
    // second edit whenever its mtime:size signature happens to match the first).
    if (this.dirtyUploadPaths) dirty.forEach((path) => this.dirtyUploadPaths.delete(path));

    let syncedFiles = 0;
    let syncedBytes = 0;
    const paths = [];
    const failed = new Set();

    for (const file of files) {
      const signature = `${file.stat.mtime || 0}:${file.stat.size || 0}`;
      if (incremental && previous[file.path] === signature && !dirty.has(file.path)) {
        paths.push(file.path); // unchanged -> already on the server
        nextSignatures[file.path] = signature;
        continue;
      }

      try {
        const buffer = await this.app.vault.readBinary(file);
        const contentBase64 = arrayBufferToBase64(buffer);
        await this.api(`/vaults/${encodeURIComponent(this.data.vaultId)}/files`, {
          method: "POST",
          body: {
            deviceId: this.data.deviceId,
            files: [{
              path: file.path,
              size: file.stat.size || 0,
              mtime: file.stat.mtime || 0,
              ctime: file.stat.ctime || 0,
              type: isMarkdownPath(file.path) ? "markdown" : "file",
              contentBase64,
            }],
          },
        });
        paths.push(file.path);
        nextSignatures[file.path] = signature;
        const hash = await sha256Hex(buffer);
        this.data.syncedHashes = this.data.syncedHashes || {};
        // If we can't hash locally, drop the entry (force a re-seed on next pull)
        // rather than leaving a stale hash that could wrongly skip a real edit.
        if (hash) this.data.syncedHashes[file.path] = hash;
        else delete this.data.syncedHashes[file.path];
        syncedFiles += 1;
        syncedBytes += file.stat.size || 0;
      } catch (error) {
        // One file failing must not abort the whole sync. Leave it un-synced: not
        // in `paths` (so it is never recorded as on-server, which would let the
        // pull trash it), no signature (retries next sync), and left dirty.
        failed.add(file.path);
      }
    }
    this.uploadedSignatures = nextSignatures;
    // Anything that failed to upload must stay dirty so it retries next run. The
    // snapshot was already cleared at entry; a file re-edited mid-run has re-added
    // itself and correctly survives.
    if (this.dirtyUploadPaths) failed.forEach((path) => this.dirtyUploadPaths.add(path));
    if (failed.size) this.pushQueueItem("upload", `${failed.size} file(s) will retry`, 0, "retry");

    // Explicitly delete only the files THIS device intentionally removed: paths
    // we knew were on the server, that fired a local delete/rename event, and that
    // are still gone now. This never touches another device's not-yet-synced files
    // (unlike a full prune), leaves oversized files (still present) alone, and
    // ignores an atomic-save remove/rewrite blip (no delete event for the path).
    const known = this.getRemoteKnownPaths();
    const sameVault = this.data.remoteKnownVaultId === this.data.vaultId;
    const pending = new Set(sameVault && Array.isArray(this.data.pendingDeletes) ? this.data.pendingDeletes : []);
    // Never delete a path that only differs in CASE from one we just uploaded. A
    // case-only rename (Note.md -> note.md) uploads note.md and would otherwise
    // delete "Note.md" — which on a case-insensitive server disk is the very file
    // we just wrote, destroying its bytes. Mirrors the pull-trash case guard.
    const uploadedLower = new Set(paths.map((p) => p.toLowerCase()));
    const toDelete = Array.from(known).filter(
      (path) => pending.has(path) && !this.app.vault.getAbstractFileByPath(path) && !uploadedLower.has(path.toLowerCase())
    );
    if (toDelete.length) {
      await this.api(`/vaults/${encodeURIComponent(this.data.vaultId)}/files/delete`, {
        method: "POST",
        body: { paths: toDelete },
      });
    }
    const deletedSet = new Set(toDelete);
    const nextKnown = new Set(known);
    paths.forEach((path) => nextKnown.add(path));
    deletedSet.forEach((path) => nextKnown.delete(path));
    if (this.data.syncedHashes) deletedSet.forEach((path) => delete this.data.syncedHashes[path]);
    this.setRemoteKnownPaths(Array.from(nextKnown));
    // Keep only intents that are still unresolved: path still gone locally and
    // still believed present on the server. Deleted, reappeared, or never-remote
    // paths drop out, so the set cannot grow without bound.
    if (sameVault) {
      this.data.pendingDeletes = Array.from(pending).filter(
        (path) => nextKnown.has(path) && !this.app.vault.getAbstractFileByPath(path)
      );
    }

    this.data.vaultStats.syncedFiles = syncedFiles;
    this.data.vaultStats.syncedBytes = syncedBytes;
    this.data.syncProgress = files.length ? Math.round((syncedFiles / files.length) * 100) : 100;
    this.data.serverStatus = "online";
    this.data.syncQueue = this.data.syncQueue.filter((item) => !(item.status === "pending" && paths.includes(item.path)));
    this.pushQueueItem("upload", "Vault files", syncedBytes, "done");
    await this.pushScanSummary();
  }

  async ensureParentFolder(filePath) {
    const parts = filePath.split("/").filter(Boolean);
    parts.pop();

    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }

  // A free path next to `path` for holding the incoming version of a sync
  // conflict, e.g. "notes/plan.md" -> "notes/plan (sync conflict).md". Never
  // collides with an existing file.
  conflictCopyPath(path) {
    const slash = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");
    const hasExt = dot > slash;
    const base = hasExt ? path.slice(0, dot) : path;
    const ext = hasExt ? path.slice(dot) : "";
    let candidate = `${base} (sync conflict)${ext}`;
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = `${base} (sync conflict ${n})${ext}`;
      n += 1;
    }
    return candidate;
  }

  startRemotePolling() {
    if (this.remotePollTimer) window.clearTimeout(this.remotePollTimer);
    const loop = async () => {
      try {
        await this.pollRemoteChanges();
      } catch (error) {
        // pollRemoteChanges handles its own errors; never let the loop die
      }
      if (this.unloaded) return; // do not re-arm after the plugin was unloaded
      // Poll fast while someone else is on the same file (active collaboration),
      // relaxed otherwise, so changes feel near-instant without constant load.
      const collaborating = this.editorPresence && this.editorPresence.peers && this.editorPresence.peers.size > 0;
      this.remotePollTimer = window.setTimeout(loop, collaborating ? REMOTE_POLL_ACTIVE_MS : REMOTE_POLL_INTERVAL_MS);
    };
    this.remotePollTimer = window.setTimeout(loop, REMOTE_POLL_ACTIVE_MS);
  }

  async pollRemoteChanges() {
    if (!this.data.signedIn || !this.data.syncEnabled) return;
    if (this.autoSyncRunning || this.remotePullRunning) return;

    try {
      await this.registerVault();
      const manifest = await this.api(`/vaults/${encodeURIComponent(this.data.vaultId)}/files`);
      if (!manifest.updatedAt || manifest.updatedAt === this.data.remoteUpdatedAt) return;
      await this.pullLatest({ manifest, silent: true });
    } catch (error) {
      if (isVaultAccessError(error)) {
        await this.markVaultAccessDenied("poll");
        return;
      }
      this.data.serverStatus = "offline";
      this.pushQueueItem("pull", "Remote vault", 0, `failed: ${error.message}`);
      await this.savePluginData();
    }
  }

  async pullLatest(options = {}) {
    if (!this.data.signedIn) {
      if (!options.silent) new Notice("Sign in first.");
      return;
    }
    if (this.remotePullRunning) return;

    this.remotePullRunning = true;
    try {
      await this.registerVault();
      const manifest = options.manifest || await this.api(`/vaults/${encodeURIComponent(this.data.vaultId)}/files`);
      let pulledFiles = 0;
      let pulledBytes = 0;
      let trashedFiles = 0;
      // Skip pulling/trashing a file that has un-uploaded LOCAL edits (dirty), so
      // we never clobber the user's own unsaved work — but DO sync a file the user
      // is only viewing, so others' edits and deletions show up live.
      const dirty = this.dirtyUploadPaths || new Set();
      // Snapshot the known-set at entry so a concurrent upload cannot make a
      // just-added path look like a remote deletion mid-pull.
      const known = this.getRemoteKnownPaths();

      // Paths this pull writes/trashes. Used to tell our own vault events apart
      // from a genuine user delete that races the pull (see handleVaultEvent).
      this.pullTouchedPaths = new Set();

      this.applyingRemoteChanges = true;
      try {
        this.data.syncedHashes = this.data.syncedHashes || {};
        for (const remoteFile of manifest.files || []) {
          if (!remoteFile.path || isIgnoredPath(remoteFile.path)) continue;
          if (dirty.has(remoteFile.path)) continue;

          const localFile = this.app.vault.getAbstractFileByPath(remoteFile.path);
          // Pull only when the content actually differs, decided by hash (NOT by
          // cross-machine mtime, which clock skew makes unreliable and which was
          // silently skipping real edits). Seed the local hash once so we don't
          // needlessly re-pull identical content on the first sync after an update.
          let hadPriorHash = false;
          let knownHash;
          if (remoteFile.hash) {
            hadPriorHash = this.data.syncedHashes[remoteFile.path] !== undefined;
            knownHash = this.data.syncedHashes[remoteFile.path];
            if (knownHash === undefined && localFile instanceof TFile) {
              try {
                knownHash = await sha256Hex(await this.app.vault.readBinary(localFile));
              } catch (error) {
                // file vanished mid-pull: treat as unknown and just pull it
                knownHash = undefined;
              }
              if (knownHash) this.data.syncedHashes[remoteFile.path] = knownHash;
            }
            if (knownHash === remoteFile.hash) continue;
          }

          // CONFLICT GUARD: a local file exists, its content differs from the
          // remote, and we have NO prior sync history for this path under this
          // vault (hadPriorHash === false). That means two independent versions
          // are meeting for the first time — typically the first pull right after
          // joining a vault that already has a file at the same path. Overwriting
          // would silently destroy the user's own content, so instead keep the
          // local file and save the incoming version alongside it. Both versions
          // then upload and coexist on every device; the user reconciles them.
          if (remoteFile.hash && !hadPriorHash && localFile instanceof TFile && knownHash !== undefined) {
            const remoteC = await this.api(`/vaults/${encodeURIComponent(this.data.vaultId)}/files/content?path=${encodeURIComponent(remoteFile.path)}`);
            const remoteContent = base64ToArrayBuffer(remoteC.contentBase64);
            const conflictPath = this.conflictCopyPath(remoteFile.path);
            await this.ensureParentFolder(conflictPath);
            this.pullTouchedPaths.add(conflictPath);
            await this.app.vault.createBinary(conflictPath, remoteContent);
            this.data.syncedHashes[conflictPath] = (remoteC.file && remoteC.file.hash) || (await sha256Hex(remoteContent)) || remoteFile.hash;
            // Keep our local hash for the original path so the following upload
            // pushes our version and it is not re-pulled as an echo.
            this.data.syncedHashes[remoteFile.path] = knownHash;
            pulledFiles += 1;
            pulledBytes += remoteFile.size || 0;
            if (!options.silent) new Notice(`Sync conflict on "${remoteFile.path}": kept your version, saved the incoming copy as "${conflictPath}".`);
            continue;
          }

          this.pullTouchedPaths.add(remoteFile.path);
          const remote = await this.api(`/vaults/${encodeURIComponent(this.data.vaultId)}/files/content?path=${encodeURIComponent(remoteFile.path)}`);
          const content = base64ToArrayBuffer(remote.contentBase64);
          await this.ensureParentFolder(remoteFile.path);

          if (localFile instanceof TFile) await this.app.vault.modifyBinary(localFile, content);
          else await this.app.vault.createBinary(remoteFile.path, content);

          // Record what we now have (hash + post-write signature) so the next
          // incremental upload does not echo this pulled file back to the server.
          // Use the CONTENT endpoint's hash (authoritative for the bytes we just
          // wrote), not the manifest hash which a concurrent upload can outdate.
          this.data.syncedHashes[remoteFile.path] = (remote.file && remote.file.hash) || (await sha256Hex(content)) || remoteFile.hash;
          const writtenFile = this.app.vault.getAbstractFileByPath(remoteFile.path);
          if (writtenFile instanceof TFile) {
            this.uploadedSignatures = this.uploadedSignatures || {};
            this.uploadedSignatures[remoteFile.path] = `${writtenFile.stat.mtime || 0}:${writtenFile.stat.size || 0}`;
          }

          pulledFiles += 1;
          pulledBytes += remoteFile.size || 0;
        }

        // Propagate remote deletions: a file we previously knew on the server but
        // that is gone from the manifest was deleted elsewhere -> trash ours too.
        // remoteKnownPaths distinguishes "deleted remotely" from "new locally".
        const remotePaths = new Set(
          (manifest.files || [])
            .filter((file) => file.path && !isIgnoredPath(file.path))
            .map((file) => file.path)
        );
        // Conservative trash: only remove a local file that is genuinely gone
        // from the server. Skip anything that (a) still exists on the server under
        // a different case (case-only rename on a case-insensitive filesystem) or
        // (b) the user has locally re-created/edited and not yet uploaded — either
        // would destroy content the user did not delete.
        const remotePathsLower = new Set(Array.from(remotePaths, (p) => p.toLowerCase()));
        for (const file of this.app.vault.getFiles()) {
          if (isIgnoredPath(file.path)) continue;
          if (remotePaths.has(file.path) || !known.has(file.path)) continue;
          if (remotePathsLower.has(file.path.toLowerCase())) continue;
          if (dirty.has(file.path)) continue;
          try {
            this.pullTouchedPaths.add(file.path);
            await this.app.vault.trash(file, false);
            if (this.uploadedSignatures) delete this.uploadedSignatures[file.path];
            if (this.data.syncedHashes) delete this.data.syncedHashes[file.path];
            trashedFiles += 1;
          } catch (error) {
            // ignore individual delete failures; a later pull retries
          }
        }
        // New baseline is the server truth (the manifest).
        this.setRemoteKnownPaths(Array.from(remotePaths));
      } finally {
        this.pullTouchedPaths = null;
        this.applyingRemoteChanges = false;
      }

      this.data.serverStatus = "online";
      this.data.remoteUpdatedAt = manifest.updatedAt || this.data.remoteUpdatedAt;
      this.data.lastSync = new Date().toLocaleString();
      this.pushQueueItem("pull", "Remote vault", pulledBytes, "done");
      await this.scanVault();
      if (!options.silent) {
        const summary = [
          pulledFiles ? `Pulled ${pulledFiles} files` : "",
          trashedFiles ? `removed ${trashedFiles}` : "",
        ].filter(Boolean).join(", ");
        new Notice(summary ? `${summary}.` : "Vault already up to date.");
      }
    } catch (error) {
      if (isVaultAccessError(error)) {
        await this.markVaultAccessDenied("pull");
        return;
      }
      this.data.serverStatus = "offline";
      this.pushQueueItem("pull", "Remote vault", 0, `failed: ${error.message}`);
      await this.savePluginData();
      if (!options.silent) new Notice(`Pull failed: ${error.message}`);
    } finally {
      this.remotePullRunning = false;
    }
  }

  pushQueueItem(action, path, size = 0, status = "pending", oldPath = "") {
    this.data.syncQueue = this.data.syncQueue.filter((item) => {
      if (action === "scan" && path === "Full vault") return !(item.action === "scan" && item.path === "Full vault");
      return !(item.action === action && item.path === path && item.status === status);
    });
    this.data.syncQueue.unshift({
      action,
      path,
      oldPath,
      size,
      status,
      time: new Date().toLocaleTimeString(),
    });
    this.data.syncQueue = this.compactQueue(this.data.syncQueue);
  }

  async handleVaultEvent(action, file, oldPath = "") {
    const path = file && file.path ? file.path : oldPath;
    if (this.applyingRemoteChanges) {
      // Our own pull fires create/modify/delete events. Ignore those (they are in
      // pullTouchedPaths), but still handle genuine USER changes racing the pull:
      const survivor = action !== "delete" && file && file.path ? file.path : null;
      // Protect a path the user created/renamed-INTO during the pull from the
      // trash loop, which would otherwise destroy that fresh content.
      if (survivor && !isIgnoredPath(survivor) && !(this.pullTouchedPaths && this.pullTouchedPaths.has(survivor))) {
        this.dirtyUploadPaths = this.dirtyUploadPaths || new Set();
        this.dirtyUploadPaths.add(survivor);
      }
      // Capture a user delete/rename so the removal is not silently swallowed.
      if (action === "delete" || action === "rename") {
        const gone = action === "rename" ? oldPath : path;
        if (gone && !isIgnoredPath(gone) && !(this.pullTouchedPaths && this.pullTouchedPaths.has(gone))) {
          this.data.pendingDeletes = Array.isArray(this.data.pendingDeletes) ? this.data.pendingDeletes : [];
          if (!this.data.pendingDeletes.includes(gone)) this.data.pendingDeletes.push(gone);
        }
      }
      return;
    }
    if (!this.data.syncEnabled) return;
    if (!path || isIgnoredPath(path)) return;

    // A locally-originated change is always uploaded on the next sync, even if
    // its mtime/size signature happens to match the cache (incremental guard).
    this.dirtyUploadPaths = this.dirtyUploadPaths || new Set();
    this.dirtyUploadPaths.add(path);

    // Record intentional local removals durably in this.data (survives reload)
    // so a genuine deletion still propagates after a restart, while a create/modify
    // for the same path cancels the intent — so an atomic-save remove/rewrite blip
    // never becomes a deletion.
    this.data.pendingDeletes = Array.isArray(this.data.pendingDeletes) ? this.data.pendingDeletes : [];
    const addPendingDelete = (p) => { if (p && !this.data.pendingDeletes.includes(p)) this.data.pendingDeletes.push(p); };
    const dropPendingDelete = (p) => { this.data.pendingDeletes = this.data.pendingDeletes.filter((x) => x !== p); };
    if (action === "delete") addPendingDelete(path);
    else if (action === "rename") { if (oldPath && !isIgnoredPath(oldPath)) addPendingDelete(oldPath); dropPendingDelete(path); }
    else dropPendingDelete(path); // create/modify => the file exists; cancel any stale delete intent

    const size = file instanceof TFile ? file.stat.size || 0 : 0;
    if (size > MAX_SYNC_FILE_SIZE) {
      this.pushQueueItem("skip", path, size, "too large", oldPath);
    } else {
      this.pushQueueItem(action, path, size, "pending", oldPath);
    }
    await this.savePluginData();
    this.scheduleAutoSync();
  }

  scheduleAutoSync() {
    if (this.autoSyncTimer) window.clearTimeout(this.autoSyncTimer);
    this.autoSyncTimer = window.setTimeout(async () => {
      this.autoSyncTimer = null;
      if (this.unloaded) return;
      if (!this.data.signedIn || !this.data.syncEnabled) return;
      // Never run an upload while a pull is in flight: both mutate remoteKnownPaths
      // and an interleave can misread a just-uploaded file as a remote deletion.
      if (this.autoSyncRunning || this.remotePullRunning) return this.scheduleAutoSync();

      this.autoSyncRunning = true;
      try {
        await this.scanVault({ upload: true, incremental: true });
      } catch (error) {
        // Never let an unexpected scan rejection silently kill auto-sync: mark
        // offline and let the next local edit re-arm the retry.
        this.data.serverStatus = "offline";
      } finally {
        this.autoSyncRunning = false;
      }
    }, 250);
  }

  async signIn() {
    try {
      const start = await this.api("/auth/google/start");
      if (!start.authUrl || !start.state) throw new Error("Google sign in did not start");

      window.open(start.authUrl);
      new Notice("Finish Google sign in in your browser.");

      const result = await this.waitForGoogleSession(start.state);
      const previousEmail = this.data.user.email;
      this.data.authToken = result.token;
      this.data.user = Object.assign(this.data.user, result.user || {});
      if (previousEmail && previousEmail !== this.data.user.email && !DEMO_MEMBER_EMAILS.has(previousEmail)) {
        this.data.vaultId = uid("vault");
        this.data.syncEnabled = false;
      }
      this.data.workspace = this.data.user.workspace || this.data.workspace;
      this.data.role = this.data.user.role || this.data.role;
      this.data.signedIn = true;
      this.data.serverStatus = "online";
      this.upsertCurrentUserMember();
      try {
        await this.registerVault();
      } catch (error) {
        if (error.status !== 403) throw error;
        this.data.vaultId = uid("vault");
        this.data.syncEnabled = false;
        await this.registerVault();
      }
      await this.fetchVaultMembers();
      await this.savePluginData();
      new Notice("Signed in with Google.");
    } catch (error) {
      this.data.serverStatus = "offline";
      await this.savePluginData();
      new Notice(`Could not sign in: ${error.message}`);
    }
  }

  async signOut() {
    this.data.signedIn = false;
    this.data.syncEnabled = false;
    this.data.authToken = "";
    await this.savePluginData();
    new Notice("Signed out.");
  }

  async toggleSync() {
    if (!this.data.signedIn) {
      new Notice("Sign in first.");
      return;
    }

    this.data.syncEnabled = !this.data.syncEnabled;
    if (this.data.syncEnabled) {
      const synced = await this.scanVault({ upload: true });
      new Notice(synced ? "Vault sync started." : "Vault sync failed.");
    } else {
      await this.savePluginData();
      new Notice("Vault sync paused.");
    }
  }

  async finishScan() {
    if (!this.data.signedIn) {
      new Notice("Sign in first.");
      return;
    }

    const synced = await this.scanVault({ upload: this.data.syncEnabled });
    new Notice(synced ? (this.data.syncEnabled ? "Vault sync complete." : "Vault scan complete.") : "Vault scanned, but server sync failed.");
  }

  async createInvite() {
    if (!this.data.signedIn) {
      new Notice("Sign in first.");
      return;
    }

    try {
      // Sharing implies syncing: push our files up before handing out a code, so
      // the joiner pulls real content instead of an empty vault, then enable
      // continuous sync. Upload with sync still off so the poll loop can't race
      // the upload; scanVault registers the vault as part of uploading.
      this.data.syncEnabled = false;
      await this.scanVault({ upload: true });
      this.data.syncEnabled = true;
      await this.savePluginData();
      const invite = await this.api(`/vaults/${encodeURIComponent(this.data.vaultId)}/invites`, { method: "POST" });
      if (navigator.clipboard) await navigator.clipboard.writeText(invite.code).catch(() => {});
      await this.fetchVaultMembers();
      new Notice(`Invite code copied: ${invite.code}`);
    } catch (error) {
      if (isVaultAccessError(error)) {
        await this.markVaultAccessDenied("invite");
        return;
      }
      new Notice(`Could not create invite: ${error.message}`);
    }
  }

  async joinInvite() {
    if (!this.data.signedIn) {
      new Notice("Sign in first.");
      return;
    }

    const code = await new InviteCodeModal(this.app).openAndWait();
    if (!code) return;

    try {
      const result = await this.api(`/invites/${encodeURIComponent(code.trim())}/accept`, { method: "POST" });
      this.data.vaultId = result.vaultId;
      this.data.workspace = result.workspace || this.data.workspace;
      this.data.role = result.role || "Worker";
      this.data.vaultOwner = result.owner || this.data.vaultOwner || "";
      this.data.members = Array.isArray(result.members) ? result.members : this.data.members;
      // Joining a vault means "sync me", with no extra step. Start from a clean
      // baseline: this is a fresh vault association, so any known-set / delete
      // intent / hash cache from our previous vault must not carry over and
      // drive a wrongful deletion against the new vault.
      this.data.remoteKnownPaths = [];
      this.data.remoteKnownVaultId = "";
      this.data.pendingDeletes = [];
      this.data.remoteUpdatedAt = "";
      this.data.syncedHashes = {};
      this.uploadedSignatures = {};
      this.dirtyUploadPaths = new Set();
      // Keep sync OFF during the initial two-way pass. The background poll loop
      // only runs when syncEnabled, so this guarantees it cannot race and
      // interleave an upload into our pull. We enable continuous sync only after
      // the merge pass has fully, sequentially completed.
      this.data.syncEnabled = false;
      await this.savePluginData();
      await this.fetchVaultMembers();
      // Two-way first pass so the vault is usable right away: pull the shared
      // files down (known-set is empty, so nothing local is trashed), then push
      // our own local files into the vault.
      await this.pullLatest();
      await this.scanVault({ upload: true });
      // Hand off to the continuous loops (poll pulls, auto-sync uploads).
      this.data.syncEnabled = true;
      await this.savePluginData();
      new Notice(`Joined ${this.data.workspace} as ${this.data.role}. Sync is on.`);
    } catch (error) {
      new Notice(`Could not join invite: ${error.message}`);
    }
  }

};
