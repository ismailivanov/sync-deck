const assert = require("assert");
const crypto = require("crypto");
const Module = require("module");

class Base {}
class TFile {
  constructor(path, size = 1) {
    this.path = path;
    this.stat = { size, mtime: 1, ctime: 1 };
  }
}
class TFolder extends Base {}

const obsidian = {
  ItemView: Base,
  MarkdownView: Base,
  Modal: Base,
  Notice: class {},
  Plugin: Base,
  PluginSettingTab: Base,
  Setting: Base,
  TFile,
  TFolder,
  addIcon() {},
  normalizePath: (path) => path,
  requestUrl: async () => ({ status: 200, json: {} }),
  setIcon() {},
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") return obsidian;
  return originalLoad.call(this, request, parent, isMain);
};
const SyncDeckPlugin = require(process.env.SYNC_DECK_ENTRY || "./src/plugin");
Module._load = originalLoad;

async function main() {
  const plugin = Object.create(SyncDeckPlugin.prototype);
  plugin.app = { vault: { getName: () => "Test", getFiles: () => [] } };
  plugin.data = plugin.normalizeData({
    vaultId: "vault-test",
    pendingUploads: ["Board/card.md", "Board/card.md", ".obsidian/plugins/nope.js", null],
  });
  assert.deepStrictEqual(plugin.data.pendingUploads, ["Board/card.md"]);

  plugin.data.pendingUploads = [];
  plugin.dirtyUploadPaths = new Set();
  plugin.pendingUploadsAtOpen = new Set();
  plugin.pulledSinceOpen = false;
  let scheduled = false;
  plugin.scheduleAutoSync = () => { scheduled = true; };
  plugin.markPulledSinceOpen();
  assert(!scheduled, "opening a clean vault must not trigger a full upload");

  plugin.pulledSinceOpen = false;
  plugin.dirtyUploadPaths = new Set(["prior-session.md", "task-deck-startup.md"]);
  plugin.pendingUploadsAtOpen = new Set(["prior-session.md"]);
  let snapshot = plugin.pullDirtySnapshot();
  assert.deepStrictEqual(Array.from(snapshot.dirty), ["prior-session.md"]);
  assert.deepStrictEqual(Array.from(snapshot.startup), ["task-deck-startup.md"]);
  plugin.pulledSinceOpen = true;
  snapshot = plugin.pullDirtySnapshot();
  assert.deepStrictEqual(Array.from(snapshot.dirty), ["prior-session.md", "task-deck-startup.md"]);
  assert.strictEqual(snapshot.startup.size, 0);

  scheduled = false;
  plugin.data.syncEnabled = true;
  plugin.fileLimitBytes = () => 1024;
  plugin.scheduleAutoSync = () => { scheduled = true; };
  plugin.savePluginData = async () => assert(scheduled, "upload must be armed before data.json I/O");
  await plugin.handleVaultEvent("modify", new TFile("Board/next.md"));
  assert(plugin.dirtyUploadPaths.has("Board/next.md"));
  assert(plugin.data.pendingUploads.includes("Board/next.md"));

  scheduled = false;
  plugin.dirtyUploadPaths = new Set();
  Object.assign(plugin.data, {
    signedIn: true,
    syncEnabled: true,
    remoteUpdatedAt: "same",
    pendingUploads: [],
    pendingDeletes: ["Board/deleted.md"],
    pendingFolderDeletes: [],
  });
  plugin.hasAcceptedTerms = () => true;
  plugin.registerVault = async () => {};
  plugin.api = async () => ({ vaultId: "vault-test", updatedAt: "same", files: [] });
  plugin.applyStorageFromManifest = () => {};
  plugin.scheduleAutoSync = () => { scheduled = true; };
  plugin.pulledSinceOpen = false;
  await plugin.pollRemoteChanges();
  assert(scheduled, "durable deletes must re-arm auto-sync on a steady manifest");

  let pullCalled = false;
  scheduled = false;
  plugin.pulledSinceOpen = false;
  Object.assign(plugin.data, {
    remoteUpdatedAt: "old",
    pendingUploads: [],
    pendingDeletes: [],
    pendingFolderDeletes: [],
  });
  plugin.api = async () => ({ vaultId: "vault-test", updatedAt: "new", files: [] });
  plugin.pullLatest = async () => {
    pullCalled = true;
    assert(!plugin.pulledSinceOpen, "push gate must stay closed until changed remote content is pulled");
  };
  await plugin.pollRemoteChanges();
  assert(pullCalled);
  assert(!scheduled);

  // A same-open Task Deck rewrite is startup churn, not durable prior-session
  // work: the first pull must replace it with the newer server bytes.
  const remoteFirst = Object.create(SyncDeckPlugin.prototype);
  const file = new TFile("Board/card.md", 5);
  let localBytes = Buffer.from("stale");
  const oldHash = crypto.createHash("sha256").update(localBytes).digest("hex");
  const remoteBytes = Buffer.from("newer");
  const remoteHash = crypto.createHash("sha256").update(remoteBytes).digest("hex");
  remoteFirst.app = { vault: {
    getName: () => "Test",
    getFiles: () => [file],
    getAbstractFileByPath: (path) => path === file.path ? file : null,
    createFolder: async () => {},
    readBinary: async () => localBytes,
    modifyBinary: async (_file, content) => { localBytes = Buffer.from(content); file.stat.size = localBytes.length; },
  } };
  remoteFirst.data = remoteFirst.normalizeData({
    vaultId: "vault-test",
    signedIn: true,
    syncEnabled: true,
    syncedHashes: { [file.path]: oldHash },
  });
  remoteFirst.dirtyUploadPaths = new Set([file.path]);
  remoteFirst.pendingUploadsAtOpen = new Set();
  remoteFirst.pulledSinceOpen = false;
  remoteFirst.registerVault = async () => {};
  remoteFirst.applyStorageFromManifest = () => {};
  remoteFirst.scanVault = async () => true;
  remoteFirst.savePluginData = async () => {};
  remoteFirst.scheduleAutoSync = () => {};
  remoteFirst.api = async (path) => {
    assert(path.includes("/files/content"));
    return { contentBase64: remoteBytes.toString("base64"), file: { hash: remoteHash } };
  };
  await remoteFirst.pullLatest({
    silent: true,
    manifest: { vaultId: "vault-test", updatedAt: "new", files: [{ path: file.path, size: remoteBytes.length, hash: remoteHash }] },
  });
  assert.strictEqual(localBytes.toString(), "newer");
  assert(!remoteFirst.dirtyUploadPaths.has(file.path));
  assert(remoteFirst.pulledSinceOpen);

  console.log("sync retry checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
