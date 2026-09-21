// Behaviour tests for the sign-in unlock path. The thing these lock down is the
// user-visible promise: signing in with your account opens your vault, and a
// device that can reach the key must never be asked for a recovery key.
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

const notices = [];
const obsidian = {
  ItemView: Base,
  MarkdownView: Base,
  Modal: Base,
  Notice: class { constructor(message) { notices.push(String(message)); } },
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

const {
  ESCROW_KDF,
  ESCROW_MIN_ITERATIONS,
  VaultCrypto,
  deriveEscrowKey,
  generateEscrowSalt,
  generateVaultKey,
  wrapVaultKey,
} = require("./src/crypto");

const EMAIL = "owner@example.com";
const VAULT_ID = "vault-real";

function makePlugin(overrides = {}) {
  const plugin = Object.create(SyncDeckPlugin.prototype);
  plugin.app = { vault: { getName: () => "Test", getFiles: () => [] } };
  plugin.data = plugin.normalizeData(Object.assign({
    vaultId: VAULT_ID,
    signedIn: true,
    authToken: "token",
    user: { email: EMAIL, name: "Owner" },
  }, overrides.data || {}));
  plugin.vaultCryptoCache = new Map();
  plugin.savePluginData = async () => {};
  plugin.refreshViews = () => {};
  plugin.getRemoteKnownPaths = () => new Set(overrides.remoteKnownPaths || []);
  plugin.promptForVaultKey = async () => {
    throw new Error("promptForVaultKey must not be reached in this scenario");
  };
  return plugin;
}

async function buildBundle(vaultKey, keyCheck, passphrase, vaultId = VAULT_ID) {
  const params = { kdf: ESCROW_KDF, iterations: ESCROW_MIN_ITERATIONS, salt: generateEscrowSalt() };
  const wrappingKey = await deriveEscrowKey(passphrase, params);
  return {
    bundle: {
      v: 1,
      kdf: params.kdf,
      iterations: params.iterations,
      salt: params.salt,
      rev: 3,
      entries: { [vaultId]: await wrapVaultKey(wrappingKey, EMAIL, vaultId, vaultKey, keyCheck, params) },
    },
    params,
    wrappingKey,
  };
}

async function main() {
  const vaultKey = generateVaultKey();
  const vaultCrypto = await VaultCrypto.create(VAULT_ID, vaultKey);
  const keyCheck = await vaultCrypto.keyCheck();

  // 1) The vault password unlocks without the recovery-key prompt ever opening.
  {
    const { bundle } = await buildBundle(vaultKey, keyCheck, "a-good-vault-password");
    const plugin = makePlugin();
    plugin.api = async (path) => {
      if (path === "/me/escrow") return { escrow: bundle };
      throw new Error(`unexpected api call ${path}`);
    };
    let asked = 0;
    plugin.escrowPassphraseForTest = "a-good-vault-password";
    plugin.ensureEscrowKey = async (given) => {
      asked += 1;
      const params = { kdf: given.kdf, iterations: Number(given.iterations), salt: given.salt };
      return deriveEscrowKey(plugin.escrowPassphraseForTest, params);
    };
    const unlocked = await plugin.ensureVaultKeyFor({
      vaultId: VAULT_ID,
      encryptionVersion: 1,
      keyCheck,
    });
    assert(unlocked, "the vault password should have unlocked the vault");
    assert.equal(asked, 1);
    assert.equal(plugin.data.vaultKeys[VAULT_ID], vaultKey);
    assert.equal(plugin.data.vaultLocked, false);
    assert.equal(await unlocked.keyCheck(), keyCheck);
  }

  // 2) The opposite direction — proof the encryption is still doing its job.
  // With no entry for this vault, the recovery key is still required.
  {
    const { bundle } = await buildBundle(vaultKey, keyCheck, "a-good-vault-password", "vault-somewhere-else");
    const plugin = makePlugin();
    plugin.api = async () => ({ escrow: bundle });
    plugin.ensureEscrowKey = async () => { throw new Error("must not derive for a vault with no entry"); };
    let prompted = 0;
    plugin.promptForVaultKey = async () => { prompted += 1; return null; };
    const unlocked = await plugin.ensureVaultKeyFor({ vaultId: VAULT_ID, encryptionVersion: 1, keyCheck });
    assert.equal(unlocked, null);
    assert.equal(prompted, 1, "a vault the bundle does not cover must still ask for SDK1");
  }

  // 3) A keyCheck mismatch must NOT destroy the local key before prompting.
  // Cancelling the prompt used to leave the device with no copy at all.
  {
    const plugin = makePlugin({ data: { vaultKeys: { [VAULT_ID]: vaultKey } } });
    plugin.data.vaultKeys[VAULT_ID] = vaultKey;
    plugin.data.vaultEncryptionVersions[VAULT_ID] = 1;
    plugin.api = async () => { throw new Error("offline"); };
    let prompted = 0;
    plugin.promptForVaultKey = async () => { prompted += 1; return null; };
    const unlocked = await plugin.ensureVaultKeyFor({
      vaultId: VAULT_ID,
      encryptionVersion: 1,
      keyCheck: "a-different-key-check",
    });
    assert.equal(unlocked, null);
    assert.equal(prompted, 1);
    assert.equal(plugin.data.vaultKeys[VAULT_ID], vaultKey, "the local key must survive a cancelled prompt");
  }

  // 4) Offline must be silent: no prompt, no key loss.
  {
    const plugin = makePlugin({ data: { vaultKeys: { [VAULT_ID]: vaultKey } } });
    plugin.api = async () => { const error = new Error("network"); throw error; };
    const viaEscrow = await plugin.unlockFromEscrow(VAULT_ID, keyCheck);
    assert.equal(viaEscrow, null);
    assert.equal(plugin.data.vaultKeys[VAULT_ID], vaultKey);
  }

  // 5) Sign-in adopts the account's existing vault instead of minting a new one.
  {
    const plugin = makePlugin({ data: { vaultId: "vault-fresh-device" } });
    plugin.data.vaultList = [
      { vaultId: VAULT_ID, workspace: "Real", encryptionVersion: 1, keyCheck },
    ];
    const target = plugin.pickVaultForSignIn({ lastVaultId: VAULT_ID });
    assert(target, "a fresh device must adopt the account's vault");
    assert.equal(target.vaultId, VAULT_ID);
  }

  // 6) ...but never when adopting would trash synced files, and never when this
  // device is already on one of the account's vaults.
  {
    const plugin = makePlugin({
      data: { vaultId: "vault-fresh-device" },
      remoteKnownPaths: ["Notes/kept.md"],
    });
    plugin.data.vaultList = [{ vaultId: VAULT_ID, workspace: "Real" }];
    assert.equal(plugin.pickVaultForSignIn({ lastVaultId: VAULT_ID }), null);

    const onKnown = makePlugin();
    onKnown.data.vaultList = [{ vaultId: VAULT_ID, workspace: "Real" }];
    assert.equal(onKnown.pickVaultForSignIn({ lastVaultId: VAULT_ID }), null);

    const ambiguous = makePlugin({ data: { vaultId: "vault-fresh-device" } });
    ambiguous.data.vaultList = [{ vaultId: "vault-a" }, { vaultId: "vault-b" }];
    assert.equal(ambiguous.pickVaultForSignIn({}), null, "two candidates must not be picked blindly");
  }

  // 7) A new key is sealed under the vault password as soon as it exists, and
  // flagged for later when the password is not unlocked in memory.
  {
    const plugin = makePlugin({ data: { escrowEnabled: true } });
    plugin.data.escrowEnabled = true;
    plugin.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
    plugin.data.escrowKdf = ESCROW_KDF;
    plugin.data.escrowIterations = ESCROW_MIN_ITERATIONS;
    plugin.data.escrowSalt = generateEscrowSalt();
    plugin.escrowKey = await deriveEscrowKey("a-good-vault-password", {
      kdf: plugin.data.escrowKdf,
      iterations: plugin.data.escrowIterations,
      salt: plugin.data.escrowSalt,
    });
    let posted = null;
    plugin.api = async (path, options) => {
      if (path === "/me/escrow" && options && options.method === "POST") {
        posted = options.body;
        return { ok: true, rev: 1 };
      }
      // publishEscrowBundle reads the current bundle first so it never writes a
      // bundle built only from this device's keys.
      if (path === "/me/escrow") return { escrow: null };
      throw new Error(`unexpected api call ${path}`);
    };
    plugin.escrowKeyProven = true;
    await plugin.createVaultKey(VAULT_ID);
    assert(posted, "creating a key must seal it under the vault password");
    assert(posted.entries[VAULT_ID], "the new vault must be in the bundle");
    assert(!JSON.stringify(posted).includes(plugin.data.vaultKeys[VAULT_ID]), "the raw key must never be sent");
    assert.equal(plugin.data.escrowDirty, false);

    const locked = makePlugin({ data: { escrowEnabled: true } });
    locked.data.escrowEnabled = true;
    locked.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
    locked.data.escrowKdf = ESCROW_KDF;
    locked.data.escrowIterations = ESCROW_MIN_ITERATIONS;
    locked.data.escrowSalt = generateEscrowSalt();
    locked.escrowKey = null;
    locked.api = async (path, options) => {
      if (options && options.method === "POST") throw new Error("must not post while locked");
      return { escrow: null };
    };
    await locked.createVaultKey("vault-later");
    assert.equal(locked.data.escrowDirty, true, "a key made while locked must be flagged to save later");
  }

  // 8) A hostile server must not be able to dictate the KDF parameters this
  // device seals with, nor make a user who never set a password type one.
  {
    const plugin = makePlugin();
    const hostile = {
      v: 1,
      kdf: ESCROW_KDF,
      iterations: ESCROW_MIN_ITERATIONS,
      salt: generateEscrowSalt(),
      rev: 9,
      entries: {},
    };
    plugin.api = async () => ({ escrow: hostile });
    await plugin.fetchEscrowBundle();
    assert.equal(plugin.data.escrowKdf, "", "server parameters must not become this device's own");
    assert.equal(plugin.data.escrowSalt, "");
    assert.equal(plugin.data.escrowIterations, 0);
    assert.equal(plugin.escrowIsConfirmed(), false, "a server claim is not an opt-in");

    plugin.applyAccountHints({ hasEscrow: true });
    assert.equal(plugin.escrowIsConfirmed(), false, "/me must not switch the feature on");

    // ...and with no local proof, nothing may be sealed or uploaded. Give the
    // device everything ELSE it would need, so the only thing stopping it is the
    // missing opt-in — otherwise this would pass for the wrong reason.
    plugin.data.escrowEnabled = true;
    plugin.data.escrowKdf = hostile.kdf;
    plugin.data.escrowIterations = hostile.iterations;
    plugin.data.escrowSalt = hostile.salt;
    plugin.data.escrowConfirmedAt = "";
    plugin.data.vaultKeys[VAULT_ID] = vaultKey;
    const hostileParams = { kdf: hostile.kdf, iterations: hostile.iterations, salt: hostile.salt };
    plugin.setEscrowKey(await deriveEscrowKey("anything", hostileParams), hostileParams, true);
    let touchedServer = false;
    plugin.api = async (path, options) => {
      if (options && options.method === "POST") { touchedServer = true; return { ok: true, rev: 1 }; }
      return { escrow: hostile };
    };
    assert.equal(await plugin.publishEscrowBundle({ carry: {} }), false);
    assert.equal(touchedServer, false, "no local opt-in means nothing may be uploaded");
    await plugin.queueEscrowUpdate();
    assert.equal(touchedServer, false);
    assert.equal(plugin.data.escrowDirty, false);
  }

  // 9) A mistyped password must be rejected before it can re-seal anything.
  {
    const { bundle, wrappingKey } = await buildBundle(vaultKey, keyCheck, "the-real-password");
    const params = { kdf: bundle.kdf, iterations: Number(bundle.iterations), salt: bundle.salt };
    const plugin = makePlugin();

    // The verification primitive itself.
    assert.equal(await plugin.escrowKeyOpensBundle(wrappingKey, bundle, params), true);
    const wrongKey = await deriveEscrowKey("the-WRONG-password", params);
    assert.equal(await plugin.escrowKeyOpensBundle(wrongKey, bundle, params), false);

    // And a rejected password must stop the write, not seal everything with it.
    plugin.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
    plugin.data.escrowEnabled = true;
    plugin.data.escrowKdf = bundle.kdf;
    plugin.data.escrowIterations = bundle.iterations;
    plugin.data.escrowSalt = bundle.salt;
    plugin.api = async (path, options) => {
      if (options && options.method === "POST") throw new Error("a wrong password must never reach POST /me/escrow");
      return { escrow: bundle };
    };
    plugin.ensureEscrowKey = async () => null; // what a rejected password produces
    assert.equal(await plugin.finishEscrowUpdate(), false);
  }

  // 10) Re-sealing must carry forward records this device cannot open, instead
  // of deleting another device's entries.
  {
    const { bundle, wrappingKey } = await buildBundle(vaultKey, keyCheck, "shared-password");
    bundle.entries["vault-on-another-device"] = { v: 1, nonce: "N".repeat(16), cipher: "C".repeat(100) };
    const plugin = makePlugin();
    plugin.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
    plugin.data.escrowEnabled = true;
    plugin.data.escrowKdf = bundle.kdf;
    plugin.data.escrowIterations = bundle.iterations;
    plugin.data.escrowSalt = bundle.salt;
    plugin.data.vaultKeys[VAULT_ID] = vaultKey;
    plugin.escrowKey = wrappingKey;
    plugin.escrowKeySignature = plugin.escrowParamsSignature({
      kdf: bundle.kdf, iterations: bundle.iterations, salt: bundle.salt,
    });
    let posted = null;
    plugin.api = async (path, options) => {
      if (options && options.method === "POST") { posted = options.body; return { ok: true, rev: 4 }; }
      return { escrow: bundle };
    };
    const saved = await plugin.publishEscrowBundle({ key: wrappingKey, carry: bundle.entries });
    assert(saved);
    assert(posted.entries["vault-on-another-device"], "another device's record must survive");
    assert(posted.entries[VAULT_ID], "this device's key must be sealed");
  }

  // 11) A key derived under different parameters must never seal under these.
  {
    const plugin = makePlugin();
    plugin.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
    plugin.data.escrowEnabled = true;
    plugin.data.escrowKdf = ESCROW_KDF;
    plugin.data.escrowIterations = ESCROW_MIN_ITERATIONS;
    plugin.data.escrowSalt = generateEscrowSalt();
    plugin.escrowKey = await deriveEscrowKey("x", {
      kdf: ESCROW_KDF, iterations: ESCROW_MIN_ITERATIONS, salt: generateEscrowSalt(),
    });
    plugin.escrowKeySignature = "PBKDF2-SHA256:200000:some-other-salt";
    plugin.api = async () => { throw new Error("must not publish with mismatched parameters"); };
    assert.equal(await plugin.publishEscrowBundle({ key: plugin.escrowKey }), false);
    assert.equal(plugin.data.escrowDirty, true);
  }

  // 12) A stale vault list must never drive the destructive adoption path.
  {
    const plugin = makePlugin({ data: { vaultId: "vault-fresh-device" } });
    plugin.data.vaultList = [{ vaultId: VAULT_ID, workspace: "Left over from another account" }];
    plugin.api = async () => { throw new Error("offline"); };
    const listed = await plugin.fetchVaultList();
    assert.equal(listed, false, "a failed fetch must report failure");
  }

  // 13) An EMPTY bundle cannot prove a password, so a password typed against one
  // must never be used to re-seal anything. This is the gap that kept finding 7
  // open: every record can legitimately be dropped, and a hostile server can
  // simply serve {} to switch the check off.
  {
    const { bundle } = await buildBundle(vaultKey, keyCheck, "the-real-password");
    const empty = Object.assign({}, bundle, { entries: {} });
    const plugin = makePlugin();
    plugin.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
    plugin.data.escrowEnabled = true;
    plugin.data.escrowKdf = empty.kdf;
    plugin.data.escrowIterations = empty.iterations;
    plugin.data.escrowSalt = empty.salt;
    plugin.data.vaultKeys[VAULT_ID] = vaultKey;
    plugin.api = async (path, options) => {
      if (options && options.method === "POST") {
        throw new Error("an unprovable password must never re-seal the bundle");
      }
      return { escrow: empty };
    };
    assert.equal(await plugin.finishEscrowUpdate(), false, "an empty bundle must not be re-sealed blind");

    // And even if a key was cached from such a prompt, publishing must refuse it
    // BEFORE contacting the server — asserting only on the return value would
    // pass for the wrong reason, since a throwing stub also yields false.
    const emptyParams = { kdf: empty.kdf, iterations: empty.iterations, salt: empty.salt };
    plugin.setEscrowKey(await deriveEscrowKey("whatever-they-typed", emptyParams), emptyParams, false);
    let attemptedPost = false;
    plugin.api = async (path, options) => {
      if (options && options.method === "POST") { attemptedPost = true; return { ok: true, rev: 1 }; }
      return { escrow: empty };
    };
    assert.equal(await plugin.publishEscrowBundle({ key: plugin.escrowKey }), false);
    assert.equal(attemptedPost, false, "an unproven password must never reach the server");
    assert.equal(plugin.data.vaultKeys[VAULT_ID], vaultKey, "local keys must be untouched");
  }

  // 14) The ROUTINE path must carry the server's records too. queueEscrowUpdate
  // passes no carry, so publishEscrowBundle has to fetch them itself — otherwise
  // a device holding only some of the keys quietly deletes the rest.
  {
    const { bundle, wrappingKey } = await buildBundle(vaultKey, keyCheck, "shared-password");
    const otherRecord = { v: 1, nonce: "N".repeat(16), cipher: "C".repeat(90) };
    const remote = Object.assign({}, bundle, {
      entries: Object.assign({}, bundle.entries, { "vault-only-on-another-device": otherRecord }),
    });
    const plugin = makePlugin();
    plugin.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
    plugin.data.escrowEnabled = true;
    plugin.data.escrowKdf = remote.kdf;
    plugin.data.escrowIterations = remote.iterations;
    plugin.data.escrowSalt = remote.salt;
    plugin.data.vaultKeys[VAULT_ID] = vaultKey;
    plugin.escrowKey = wrappingKey;
    plugin.escrowKeyProven = true;
    plugin.escrowKeySignature = plugin.escrowParamsSignature({
      kdf: remote.kdf, iterations: remote.iterations, salt: remote.salt,
    });
    let posted = null;
    plugin.api = async (path, options) => {
      if (options && options.method === "POST") { posted = options.body; return { ok: true, rev: 12 }; }
      return { escrow: remote };
    };
    await plugin.queueEscrowUpdate();
    assert(posted, "the routine path must still publish");
    assert(posted.entries["vault-only-on-another-device"], "another device's record must survive the routine path");
    assert(posted.entries[VAULT_ID]);
  }

  // 15) Offline, the routine path must not write a bundle built from a partial
  // view of the account.
  {
    const plugin = makePlugin();
    plugin.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
    plugin.data.escrowEnabled = true;
    plugin.data.escrowKdf = ESCROW_KDF;
    plugin.data.escrowIterations = ESCROW_MIN_ITERATIONS;
    plugin.data.escrowSalt = generateEscrowSalt();
    plugin.data.vaultKeys[VAULT_ID] = vaultKey;
    plugin.escrowKey = await deriveEscrowKey("shared-password", {
      kdf: plugin.data.escrowKdf, iterations: plugin.data.escrowIterations, salt: plugin.data.escrowSalt,
    });
    plugin.escrowKeyProven = true;
    plugin.escrowKeySignature = plugin.escrowParamsSignature(plugin.escrowParams());
    plugin.api = async (path, options) => {
      if (options && options.method === "POST") throw new Error("must not publish while offline");
      throw new Error("network");
    };
    assert.equal(await plugin.publishEscrowBundle({ key: plugin.escrowKey }), false);
    assert.equal(plugin.data.escrowDirty, true);
  }

  // 16) Clearing the local state must survive a restart, or the dead end returns.
  {
    const plugin = makePlugin();
    let saves = 0;
    plugin.savePluginData = async () => { saves += 1; };
    plugin.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
    plugin.data.escrowEnabled = true;
    plugin.data.escrowKdf = ESCROW_KDF;
    plugin.data.escrowSalt = generateEscrowSalt();
    plugin.data.escrowIterations = ESCROW_MIN_ITERATIONS;
    plugin.data.escrowDirty = true;
    await plugin.forgetEscrowLocally();
    assert(saves > 0, "clearing the vault password state must be written to disk");
    assert.equal(plugin.data.escrowKdf, "");
    assert.equal(plugin.data.escrowConfirmedAt, "");
    assert.equal(plugin.data.escrowDirty, false);
    assert.equal(plugin.escrowIsConfirmed(), false);

    // normalizeData must not resurrect it either.
    const reloaded = plugin.normalizeData(JSON.parse(JSON.stringify(plugin.data)));
    assert.equal(reloaded.escrowEnabled, false);
  }

  // 17) A bundle that vanished server-side clears the local state instead of
  // prompting for a password that can no longer be checked.
  {
    const plugin = makePlugin();
    plugin.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
    plugin.data.escrowEnabled = true;
    plugin.data.escrowKdf = ESCROW_KDF;
    plugin.data.escrowIterations = ESCROW_MIN_ITERATIONS;
    plugin.data.escrowSalt = generateEscrowSalt();
    plugin.api = async () => ({ escrow: null });
    plugin.ensureEscrowKey = async () => { throw new Error("must not prompt when there is no bundle"); };
    assert.equal(await plugin.finishEscrowUpdate(), false);
    assert.equal(plugin.data.escrowKdf, "", "stale parameters must be cleared");
    assert.equal(plugin.escrowIsConfirmed(), false);
  }

  // 18) A device with no vault key must not create an empty bundle — that bundle
  // can prove no password, and it locks out the device that HAS the keys.
  {
    const plugin = makePlugin();
    let reachedServer = false;
    plugin.api = async () => { reachedServer = true; return { escrow: null }; };
    assert.equal(await plugin.setUpVaultPassword(), false);
    assert.equal(reachedServer, false, "with nothing to seal it must stop before the server");

    // And the publish path refuses one directly too.
    const armed = makePlugin();
    armed.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
    armed.data.escrowEnabled = true;
    armed.data.escrowKdf = ESCROW_KDF;
    armed.data.escrowIterations = ESCROW_MIN_ITERATIONS;
    armed.data.escrowSalt = generateEscrowSalt();
    armed.setEscrowKey(await deriveEscrowKey("a-good-vault-password", armed.escrowParams()), armed.escrowParams(), true);
    let armedPosted = false;
    armed.api = async (path, options) => {
      if (options && options.method === "POST") { armedPosted = true; return { ok: true, rev: 1 }; }
      return { escrow: null };
    };
    assert.equal(await armed.publishEscrowBundle({ carry: {} }), false);
    assert.equal(armedPosted, false, "an empty bundle must never reach the server");
  }

  // 19) Turning the password off on another device must not be silently undone.
  {
    const plugin = makePlugin();
    plugin.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
    plugin.data.escrowEnabled = true;
    plugin.data.escrowKdf = ESCROW_KDF;
    plugin.data.escrowIterations = ESCROW_MIN_ITERATIONS;
    plugin.data.escrowSalt = generateEscrowSalt();
    plugin.data.escrowRev = 5; // we have seen a bundle before
    plugin.data.vaultKeys[VAULT_ID] = vaultKey;
    plugin.setEscrowKey(await deriveEscrowKey("the-revoked-password", plugin.escrowParams()), plugin.escrowParams(), true);
    plugin.api = async (path, options) => {
      if (options && options.method === "POST") {
        throw new Error("a revoked vault password must never be put back in force");
      }
      return { escrow: null };
    };
    assert.equal(await plugin.publishEscrowBundle({}), false);
    assert.equal(plugin.escrowIsConfirmed(), false, "this device must release the revoked password");
    assert.equal(plugin.data.escrowRemote, false);
    assert.equal(plugin.data.vaultKeys[VAULT_ID], vaultKey, "local keys are never collateral");

    // A second key event in the same session must not retry a "clean create".
    let posted = false;
    plugin.api = async (path, options) => {
      if (options && options.method === "POST") { posted = true; return { ok: true, rev: 1 }; }
      return { escrow: null };
    };
    await plugin.queueEscrowUpdate();
    assert.equal(posted, false, "a released device must not recreate the bundle");
  }

  // 20) Setting or changing the password is itself the proof: the flag must not
  // stay false from an earlier unprovable prompt and reject the whole session.
  {
    const plugin = makePlugin();
    plugin.data.vaultKeys[VAULT_ID] = vaultKey;
    plugin.data.vaultKeyChecks[VAULT_ID] = keyCheck;
    plugin.escrowKeyProven = false; // left over from an earlier empty bundle
    let posted = null;
    plugin.api = async (path, options) => {
      if (options && options.method === "POST") { posted = options.body; return { ok: true, rev: 1 }; }
      return { escrow: null };
    };
    const params = { kdf: ESCROW_KDF, iterations: ESCROW_MIN_ITERATIONS, salt: generateEscrowSalt() };
    const key = await deriveEscrowKey("a-brand-new-password", params);
    plugin.data.escrowEnabled = true;
    plugin.data.escrowConfirmedAt = new Date().toISOString();
    plugin.data.escrowKdf = params.kdf;
    plugin.data.escrowIterations = params.iterations;
    plugin.data.escrowSalt = params.salt;
    plugin.setEscrowKey(key, params, true);
    assert.equal(plugin.escrowKeyProven, true, "setEscrowKey must carry the proof with the key");
    assert.equal(await plugin.publishEscrowBundle({ params, key, carry: {}, setup: true }), true);
    assert(posted.entries[VAULT_ID]);
  }

  // 21) Releasing this device must NOT claim the server copy is gone. That flag
  // is what keeps Turn off and Change reachable after a failed removal, and what
  // tells a device that never joined the account's password that one exists.
  {
    const plugin = makePlugin();
    plugin.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
    plugin.data.escrowEnabled = true;
    plugin.data.escrowKdf = ESCROW_KDF;
    plugin.data.escrowIterations = ESCROW_MIN_ITERATIONS;
    plugin.data.escrowSalt = generateEscrowSalt();
    plugin.data.escrowRemote = true;
    await plugin.forgetEscrowLocally();
    assert.equal(plugin.escrowIsConfirmed(), false, "this device is released");
    assert.equal(plugin.data.escrowRemote, true, "but the server copy must stay visible");

    // And a read that finds a bundle marks it, so a device that never set one up
    // still learns the account has one.
    const fresh = makePlugin();
    const { bundle } = await buildBundle(vaultKey, keyCheck, "someone-elses-setup");
    fresh.api = async () => ({ escrow: bundle });
    await fresh.fetchEscrowBundle();
    assert.equal(fresh.data.escrowRemote, true);
    assert.equal(fresh.escrowIsConfirmed(), false, "seeing a bundle is not joining it");
  }

  // 22) The server can accept a write and still store nothing (every record named
  // a vault this account lost access to). Reporting success there told people
  // their keys were protected when the server held none of them.
  {
    const plugin = makePlugin();
    plugin.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
    plugin.data.escrowEnabled = true;
    plugin.data.escrowKdf = ESCROW_KDF;
    plugin.data.escrowIterations = ESCROW_MIN_ITERATIONS;
    plugin.data.escrowSalt = generateEscrowSalt();
    plugin.data.vaultKeys["vault-lost-access"] = vaultKey;
    plugin.setEscrowKey(
      await deriveEscrowKey("a-good-vault-password", plugin.escrowParams()),
      plugin.escrowParams(),
      true
    );
    plugin.api = async (path, options) => {
      if (options && options.method === "POST") return { ok: true, stored: false, rev: 0, skipped: ["vault-lost-access"] };
      return { escrow: null };
    };
    const saved = await plugin.publishEscrowBundle({ carry: {} });
    assert.equal(saved, false, "a write the server did not store is not a success");
    assert.equal(plugin.data.escrowDirty, true);
    assert.equal(plugin.data.escrowRev, 0, "no success bookkeeping may be written");
  }

  // 23) The revocation guard must not depend on state the fetch itself rewrites.
  // Reading escrowRemote after fetchEscrowBundle always saw false, which left
  // escrowRev as the only signal — and that can legitimately be 0.
  {
    const plugin = makePlugin();
    plugin.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
    plugin.data.escrowEnabled = true;
    plugin.data.escrowKdf = ESCROW_KDF;
    plugin.data.escrowIterations = ESCROW_MIN_ITERATIONS;
    plugin.data.escrowSalt = generateEscrowSalt();
    plugin.data.escrowRev = 0;          // never got a revision back
    plugin.data.escrowRemote = true;    // but we know the account has a bundle
    plugin.data.vaultKeys[VAULT_ID] = vaultKey;
    plugin.setEscrowKey(
      await deriveEscrowKey("the-revoked-password", plugin.escrowParams()),
      plugin.escrowParams(),
      true
    );
    plugin.api = async (path, options) => {
      if (options && options.method === "POST") throw new Error("a revoked password must not be restored");
      return { escrow: null };
    };
    assert.equal(await plugin.publishEscrowBundle({}), false);
    assert.equal(plugin.escrowIsConfirmed(), false, "this device must release the revoked password");
  }

  // 24) A server with the feature switched off is NOT the user revoking their
  // password: the local state must survive so it still works elsewhere.
  {
    const plugin = makePlugin();
    plugin.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
    plugin.data.escrowEnabled = true;
    plugin.data.escrowKdf = ESCROW_KDF;
    plugin.data.escrowIterations = ESCROW_MIN_ITERATIONS;
    plugin.data.escrowSalt = generateEscrowSalt();
    plugin.data.escrowRev = 4;
    plugin.data.vaultKeys[VAULT_ID] = vaultKey;
    plugin.setEscrowKey(
      await deriveEscrowKey("a-good-vault-password", plugin.escrowParams()),
      plugin.escrowParams(),
      true
    );
    plugin.api = async () => { const error = new Error("not found"); error.status = 404; throw error; };
    assert.equal(await plugin.publishEscrowBundle({}), false);
    assert.equal(plugin.data.escrowAvailable, false);
    assert.equal(plugin.escrowIsConfirmed(), true, "a server-side switch must not revoke the user's password");
    assert.equal(plugin.data.escrowDirty, true);
  }

  // 25) A flag only held in memory was lost on restart, so the panel never
  // offered to finish saving the key.
  {
    const plugin = makePlugin();
    let saves = 0;
    plugin.savePluginData = async () => { saves += 1; };
    plugin.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
    plugin.data.escrowEnabled = true;
    plugin.data.escrowKdf = ESCROW_KDF;
    plugin.data.escrowIterations = ESCROW_MIN_ITERATIONS;
    plugin.data.escrowSalt = generateEscrowSalt();
    plugin.escrowKey = null;
    await plugin.queueEscrowUpdate();
    assert.equal(plugin.data.escrowDirty, true);
    assert(saves > 0, "the dirty flag must be written to disk");
  }

  // 26) A key cached while the bundle was empty is unproven. Once there is a
  // record to check it against it must be re-checked, not refused forever.
  {
    const { bundle, wrappingKey } = await buildBundle(vaultKey, keyCheck, "shared-password");
    const params = { kdf: bundle.kdf, iterations: Number(bundle.iterations), salt: bundle.salt };
    const plugin = makePlugin();
    plugin.data.escrowKdf = params.kdf;
    plugin.data.escrowIterations = params.iterations;
    plugin.data.escrowSalt = params.salt;
    plugin.setEscrowKey(wrappingKey, params, false); // cached against an empty bundle
    const key = await plugin.ensureEscrowKey(bundle);
    assert(key, "the right password must not stay locked out");
    assert.equal(plugin.escrowKeyProven, true, "it opens a record, so it is proven now");

    // ...and a cached key that does NOT open the records is dropped.
    const wrong = makePlugin();
    wrong.data.escrowKdf = params.kdf;
    wrong.data.escrowIterations = params.iterations;
    wrong.data.escrowSalt = params.salt;
    wrong.setEscrowKey(await deriveEscrowKey("not-it", params), params, false);
    wrong.ensureEscrowKeyPrompted = false;
    const dropped = await wrong.ensureEscrowKey(bundle, { silent: true });
    assert.equal(dropped, null);
    assert.equal(wrong.escrowKey, null, "a cached key that opens nothing must be dropped");
  }

  // 27) The post-prompt verification itself: a wrong password must be rejected
  // and must not be cached. (ensureEscrowKey opens a modal, so the part that
  // matters is exercised through acceptEscrowKey, which it delegates to.)
  {
    const { bundle, wrappingKey } = await buildBundle(vaultKey, keyCheck, "the-real-password");
    const params = { kdf: bundle.kdf, iterations: Number(bundle.iterations), salt: bundle.salt };

    const wrong = makePlugin();
    const wrongKey = await deriveEscrowKey("not-the-real-password", params);
    assert.equal(await wrong.acceptEscrowKey(wrongKey, bundle, params), null);
    assert.equal(wrong.escrowKey, null, "a wrong password must not be cached");
    assert.equal(wrong.escrowIsConfirmed(), false, "and must not count as an opt-in");

    const right = makePlugin();
    assert(await right.acceptEscrowKey(wrappingKey, bundle, params), "the real password is accepted");
    assert.equal(right.escrowKeyProven, true);
    assert.equal(right.data.escrowSalt, params.salt, "proven parameters are adopted");

    // An empty bundle proves nothing, so the key is accepted but stays unproven.
    const blind = makePlugin();
    const empty = Object.assign({}, bundle, { entries: {} });
    assert(await blind.acceptEscrowKey(wrongKey, empty, params));
    assert.equal(blind.escrowKeyProven, false);
    assert.equal(blind.data.escrowSalt, "", "an unprovable password adopts nothing");
  }

  // 28) Sign-in must not choose a vault from a list it could not refresh.
  {
    const stale = makePlugin({ data: { vaultId: "vault-fresh-device" } });
    stale.data.vaultList = [{ vaultId: VAULT_ID, workspace: "Left over from another account" }];
    stale.api = async () => { throw new Error("offline"); };
    assert.equal(await stale.chooseSignInVault({ lastVaultId: VAULT_ID }), null,
      "a failed refresh must never drive the destructive adoption path");

    // With a real answer it does choose, so the guard above is load-bearing.
    const fresh = makePlugin({ data: { vaultId: "vault-fresh-device" } });
    fresh.api = async () => ({ vaults: [{ vaultId: VAULT_ID, workspace: "Real", encryptionVersion: 1 }] });
    const chosen = await fresh.chooseSignInVault({ lastVaultId: VAULT_ID });
    assert(chosen && chosen.vaultId === VAULT_ID);
  }

  console.log("escrow behaviour checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
