const assert = require("assert");
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
  plugin.app = { vault: { getName: () => "Test" } };
  plugin.data = plugin.normalizeData({
    vaultId: "vault-test",
    pendingUploads: ["Board/card.md", "Board/card.md", ".obsidian/plugins/nope.js", null],
  });
  assert.deepStrictEqual(plugin.data.pendingUploads, ["Board/card.md"]);

  let scheduled = false;
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
  plugin.markPulledSinceOpen = () => {};
  plugin.scheduleAutoSync = () => { scheduled = true; };
  await plugin.pollRemoteChanges();
  assert(scheduled, "durable deletes must re-arm auto-sync on a steady manifest");

  console.log("sync retry checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
