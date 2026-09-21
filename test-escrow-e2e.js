// End-to-end: device A seals its vault key under a vault password and uploads it
// to a REAL server process; device B, starting from nothing, signs in and opens
// the same encrypted vault over HTTP without ever seeing a recovery key.
// Run with: node test-escrow-e2e.js   (expects ../syncdeck-server/index.js)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { spawn } = require("child_process");

const SERVER_SOURCE = path.join(__dirname, "..", "syncdeck-server", "index.js");
if (!fs.existsSync(SERVER_SOURCE)) {
  console.log("escrow e2e skipped (server repo not next to this one)");
  process.exit(0);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "syncdeck-escrow-e2e-"));
const serverPath = path.join(temp, "index.js");
fs.copyFileSync(SERVER_SOURCE, serverPath);
const port = 17000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [serverPath], {
  cwd: temp,
  env: Object.assign({}, process.env, {
    PORT: String(port),
    ALLOW_DEV_AUTH: "1",
    ESCROW_ENABLED: "1",
  }),
  stdio: ["ignore", "pipe", "pipe"],
});

class Base {}
const obsidian = {
  ItemView: Base,
  MarkdownView: Base,
  Modal: Base,
  Notice: class {},
  Plugin: Base,
  PluginSettingTab: Base,
  Setting: Base,
  TFile: class {},
  TFolder: class {},
  addIcon() {},
  normalizePath: (p) => p,
  // The plugin talks through requestUrl; route it at the live test server.
  requestUrl: async (options) => {
    const response = await fetch(options.url, {
      method: options.method || "GET",
      headers: options.headers,
      body: options.body,
    });
    let json = {};
    try { json = await response.json(); } catch (error) { json = {}; }
    return { status: response.status, json };
  },
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
} = require("./src/crypto");

const EMAIL = "e2e@example.com";
const PASSWORD = "a-strong-vault-password";

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.status === 200) return;
    } catch (error) { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("server did not start");
}

async function signedInDevice(token, data = {}) {
  const plugin = Object.create(SyncDeckPlugin.prototype);
  plugin.app = { vault: { getName: () => "Test", getFiles: () => [] } };
  plugin.data = plugin.normalizeData(Object.assign({
    serverUrl: base,
    signedIn: true,
    authToken: token,
    user: { email: EMAIL, name: "E2E" },
  }, data));
  plugin.vaultCryptoCache = new Map();
  plugin.savePluginData = async () => {};
  plugin.refreshViews = () => {};
  plugin.getRemoteKnownPaths = () => new Set();
  plugin.promptForVaultKey = async () => {
    throw new Error("device B must not be asked for a recovery key");
  };
  return plugin;
}

(async () => {
  await waitForServer();
  const authResponse = await fetch(`${base}/auth/dev-google`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, name: "E2E" }),
  });
  const { token } = await authResponse.json();
  assert(token, "dev auth should return a token");

  // ---- Device A: create the vault key, set a vault password, upload ---------
  const deviceA = await signedInDevice(token, { vaultId: "vault-e2e" });
  await deviceA.createVaultKey("vault-e2e");
  const vaultKey = deviceA.data.vaultKeys["vault-e2e"];
  const keyCheck = deviceA.data.vaultKeyChecks["vault-e2e"];
  assert(vaultKey && keyCheck);

  const params = { kdf: ESCROW_KDF, iterations: ESCROW_MIN_ITERATIONS, salt: generateEscrowSalt() };
  // Mirrors what setUpVaultPassword() does, including the local opt-in record
  // that gates every seal.
  deviceA.data.escrowEnabled = true;
  deviceA.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
  deviceA.data.escrowKdf = params.kdf;
  deviceA.data.escrowIterations = params.iterations;
  deviceA.data.escrowSalt = params.salt;
  deviceA.escrowKey = await deriveEscrowKey(PASSWORD, params);
  deviceA.escrowKeySignature = deviceA.escrowParamsSignature(params);
  const published = await deviceA.publishEscrowBundle({ params, key: deviceA.escrowKey, setup: true });
  assert(published, "device A should have stored the sealed bundle");
  assert.equal(deviceA.data.escrowRev, 1);
  // The first publish reads the (empty) server bundle before writing. That read
  // must not clear the parameters this device just chose.
  assert.equal(deviceA.data.escrowSalt, params.salt, "set-up must survive its own pre-write read");
  assert.equal(deviceA.data.escrowIterations, params.iterations);
  assert(deviceA.escrowIsConfirmed(), "device A must stay confirmed after setting the password");

  // Register the vault so device B can see it in the account's vault list.
  await deviceA.registerVault();

  // The server must hold ciphertext only.
  const stored = fs.readFileSync(path.join(temp, "data.json"), "utf8");
  assert(!stored.includes(vaultKey), "the raw vault key must never reach the server");
  assert(!stored.includes(PASSWORD), "the vault password must never reach the server");
  assert(stored.includes("escrow"), "the sealed bundle should be stored");

  // ---- Device B: nothing local, unlocks over HTTP with the password only ----
  const deviceB = await signedInDevice(token, { vaultId: "vault-fresh" });
  assert.equal(deviceB.data.vaultKeys["vault-e2e"], undefined);

  await deviceB.fetchVaultList();
  const target = deviceB.pickVaultForSignIn({ lastVaultId: "vault-e2e" });
  assert(target, "device B should adopt the account's existing vault");
  assert.equal(target.vaultId, "vault-e2e");
  assert.equal(Number(target.encryptionVersion), 1);

  // Stand in for the one password prompt device B would show.
  let prompts = 0;
  deviceB.ensureEscrowKey = async (bundle) => {
    prompts += 1;
    return deriveEscrowKey(PASSWORD, {
      kdf: bundle.kdf,
      iterations: Number(bundle.iterations),
      salt: bundle.salt,
    });
  };

  const unlocked = await deviceB.ensureVaultKeyFor(target);
  assert(unlocked, "device B should have unlocked from the vault password");
  assert.equal(prompts, 1, "exactly one password prompt");
  assert.equal(deviceB.data.vaultKeys["vault-e2e"], vaultKey);
  assert.equal(deviceB.data.vaultLocked, false);
  // Unlocking proves the password, so this device may now seal new keys too —
  // and it adopted the parameters only because they actually opened a record.
  assert(deviceB.escrowIsConfirmed(), "a successful unlock is the local opt-in proof");
  assert.equal(deviceB.data.escrowSalt, params.salt);
  assert.equal(deviceB.data.escrowIterations, params.iterations);

  // The recovered key really opens this vault's ciphertext.
  const sample = new TextEncoder().encode("device A wrote this");
  const encrypted = await (await VaultCrypto.create("vault-e2e", vaultKey))
    .encryptFile("Notes/a.md", sample);
  const reopened = await VaultCrypto.create("vault-e2e", deviceB.data.vaultKeys["vault-e2e"]);
  assert.equal((await reopened.decryptFileMetadata(encrypted)).path, "Notes/a.md");
  assert.equal(
    new TextDecoder().decode(await reopened.decryptFileContent(encrypted, encrypted.contentBase64)),
    "device A wrote this"
  );

  // A wrong password must fail closed and leave device B's state untouched.
  const deviceC = await signedInDevice(token, { vaultId: "vault-fresh" });
  let sdk1Prompts = 0;
  deviceC.promptForVaultKey = async () => { sdk1Prompts += 1; return null; };
  deviceC.ensureEscrowKey = async (bundle) => deriveEscrowKey("the-wrong-password", {
    kdf: bundle.kdf,
    iterations: Number(bundle.iterations),
    salt: bundle.salt,
  });
  const failed = await deviceC.ensureVaultKeyFor(target);
  assert.equal(failed, null);
  assert.equal(sdk1Prompts, 1, "a wrong password must fall back to the recovery key");
  assert.equal(deviceC.data.vaultKeys["vault-e2e"], undefined);
  // A wrong password must leave no proof behind, so it can never seal anything.
  assert.equal(deviceC.escrowIsConfirmed(), false);

  // ---- Device B adds a vault of its own: A's record must survive -----------
  // The routine path (createVaultKey -> queueEscrowUpdate) passes no carry, so
  // publishEscrowBundle has to read the server's bundle itself. Against a real
  // server this is the scenario that silently deleted another device's record.
  deviceB.data.vaultList = [];
  // The stubbed prompt above returns a key without caching it the way the real
  // ensureEscrowKey does, so put the unlocked key in memory as it would be.
  deviceB.escrowKey = await deriveEscrowKey(PASSWORD, params);
  deviceB.escrowKeySignature = deviceB.escrowParamsSignature(params);
  deviceB.escrowKeyProven = true;
  await deviceB.createVaultKey("vault-made-on-b");
  const afterB = await fetch(`${base}/me/escrow`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  assert(afterB.escrow, "the bundle should still exist");
  assert(afterB.escrow.entries["vault-e2e"], "device A's record must survive device B's write");
  assert(afterB.escrow.entries["vault-made-on-b"], "device B's new key must be sealed");

  // Device A, which never saw vault-made-on-b, writes again: still no loss.
  deviceA.data.vaultList = [];
  deviceA.escrowKeyProven = true;
  await deviceA.createVaultKey("vault-made-on-a-later");
  const afterA = await fetch(`${base}/me/escrow`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  for (const id of ["vault-e2e", "vault-made-on-b", "vault-made-on-a-later"]) {
    assert(afterA.escrow.entries[id], `${id} must still be sealed after device A's write`);
  }

  // ---- An empty bundle must not be re-sealed on an unverifiable password ----
  await fetch(`${base}/me/escrow/delete`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const deviceD = await signedInDevice(token, { vaultId: "vault-e2e" });
  deviceD.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
  deviceD.data.escrowEnabled = true;
  deviceD.data.escrowKdf = params.kdf;
  deviceD.data.escrowIterations = params.iterations;
  deviceD.data.escrowSalt = params.salt;
  deviceD.data.vaultKeys["vault-e2e"] = vaultKey;
  deviceD.ensureEscrowKey = async () => { throw new Error("must not prompt when the bundle is gone"); };
  assert.equal(await deviceD.finishEscrowUpdate(), false);
  const afterGone = await fetch(`${base}/me/escrow`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  assert.equal(afterGone.escrow, null, "nothing may be written back from a cleared bundle");
  assert.equal(deviceD.escrowIsConfirmed(), false, "local state must be cleared, not left stale");

  // ---- The server can accept a write and store nothing ---------------------
  // Every record names a vault this account cannot reach, so nothing is kept.
  // The client must report that honestly instead of claiming success.
  const deviceE = await signedInDevice(token, { vaultId: "vault-e2e" });
  deviceE.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
  deviceE.data.escrowEnabled = true;
  deviceE.data.escrowKdf = params.kdf;
  deviceE.data.escrowIterations = params.iterations;
  deviceE.data.escrowSalt = params.salt;
  // A key left behind for a vault owned by somebody else entirely.
  const strangerAuth = await fetch(`${base}/auth/dev-google`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "stranger@example.com", name: "Stranger" }),
  }).then((r) => r.json());
  await fetch(`${base}/vaults/register`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${strangerAuth.token}`,
      "content-type": "application/json",
      "x-syncdeck-e2ee": "1",
    },
    body: JSON.stringify({ vaultId: "vault-not-ours", deviceId: "d", workspace: "Theirs" }),
  });
  deviceE.data.vaultKeys = { "vault-not-ours": vaultKey };
  deviceE.data.vaultKeyChecks = { "vault-not-ours": keyCheck };
  deviceE.setEscrowKey(await deriveEscrowKey(PASSWORD, params), params, true);
  const storedNothing = await deviceE.publishEscrowBundle({ carry: {} });
  assert.equal(storedNothing, false, "a write the server did not store must not report success");
  assert.equal(deviceE.data.escrowDirty, true);
  const nothingStored = await fetch(`${base}/me/escrow`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  assert.equal(nothingStored.escrow, null, "the server really stored nothing");

  // ---- A password turned off elsewhere must not come back ------------------
  // Re-establish a bundle, then delete it as another device would, then let a
  // device that still holds the password do a routine key event.
  const deviceF = await signedInDevice(token, { vaultId: "vault-e2e" });
  deviceF.data.escrowConfirmedAt = "2026-09-22T00:00:00.000Z";
  deviceF.data.escrowEnabled = true;
  deviceF.data.escrowKdf = params.kdf;
  deviceF.data.escrowIterations = params.iterations;
  deviceF.data.escrowSalt = params.salt;
  deviceF.data.vaultKeys["vault-e2e"] = vaultKey;
  deviceF.data.vaultKeyChecks["vault-e2e"] = keyCheck;
  deviceF.setEscrowKey(await deriveEscrowKey(PASSWORD, params), params, true);
  assert.equal(await deviceF.publishEscrowBundle({ carry: {}, setup: true }), true);

  await fetch(`${base}/me/escrow/delete`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });

  // deviceF still believes the password is on and holds the derived key.
  await deviceF.createVaultKey("vault-created-after-revoke");
  const afterRevoke = await fetch(`${base}/me/escrow`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  assert.equal(afterRevoke.escrow, null, "a revoked vault password must not be resurrected");
  assert.equal(deviceF.escrowIsConfirmed(), false, "the device releases the revoked password");
  // A second key event must not retry a clean create either.
  await deviceF.createVaultKey("vault-created-after-revoke-2");
  const afterSecond = await fetch(`${base}/me/escrow`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  assert.equal(afterSecond.escrow, null, "still no resurrection on the second attempt");
  assert(deviceF.data.vaultKeys["vault-e2e"], "local keys are never collateral");

  console.log("escrow end-to-end checks passed");
})().finally(() => {
  child.kill("SIGTERM");
  fs.rmSync(temp, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
