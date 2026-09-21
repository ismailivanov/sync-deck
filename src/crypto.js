const PROTOCOL_VERSION = 1;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function webCrypto() {
  const value = globalThis.crypto;
  if (!value || !value.subtle || !value.getRandomValues) {
    throw new Error("This device does not provide the Web Crypto API required for end-to-end encryption.");
  }
  return value;
}

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("Expected binary data.");
}

function bytesToBase64(value) {
  const input = bytes(value);
  if (typeof Buffer !== "undefined") return Buffer.from(input).toString("base64");
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < input.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, input.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  if (typeof value !== "string") throw new Error("Invalid encoded data.");
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
  const binary = atob(value);
  const output = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) output[i] = binary.charCodeAt(i);
  return output;
}

function bytesToBase64Url(value) {
  return bytesToBase64(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
}

function bytesToBase32(value) {
  const input = bytes(value);
  let bits = 0;
  let accumulator = 0;
  let output = "";
  for (const byte of input) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  return output;
}

function base32ToBytes(value) {
  const input = String(value || "").toUpperCase().replace(/[\s-]/g, "");
  let bits = 0;
  let accumulator = 0;
  const output = [];
  for (const char of input) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Invalid recovery key.");
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (bits > 0 && (accumulator & ((1 << bits) - 1)) !== 0) throw new Error("Invalid recovery key.");
  return new Uint8Array(output);
}

function randomBytes(length) {
  return webCrypto().getRandomValues(new Uint8Array(length));
}

function validateVaultPath(value) {
  const path = String(value || "");
  const parts = path.split("/");
  if (!path || path.length > 1000 || path.startsWith("/") || path.endsWith("/")
    || path.includes("\\") || /[\0-\x1f]/.test(path)
    || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Encrypted metadata contains an unsafe vault path.");
  }
  return path;
}

function generateVaultKey() {
  return bytesToBase64Url(randomBytes(32));
}

function recoveryCode(key) {
  const raw = base64UrlToBytes(key);
  if (raw.length !== 32) throw new Error("Invalid vault key.");
  return `SDK1-${bytesToBase32(raw)}`;
}

function parseRecoveryCode(value) {
  const compact = String(value || "").trim().toUpperCase().replace(/\s/g, "");
  const payload = compact.startsWith("SDK1-") ? compact.slice(5) : compact;
  const raw = base32ToBytes(payload);
  if (raw.length !== 32) throw new Error("Recovery key must contain 256 bits.");
  return bytesToBase64Url(raw);
}

function secureInviteCode(serverCode, key) {
  const code = String(serverCode || "").trim().toUpperCase();
  if (!/^[A-F0-9]{12}$/.test(code)) throw new Error("Invalid server invite code.");
  return `SD1-${code}-${bytesToBase32(base64UrlToBytes(key))}`;
}

function parseSecureInviteCode(value) {
  const input = String(value || "").trim().toUpperCase().replace(/\s/g, "");
  const match = input.match(/^SD1-([A-F0-9]{12})-([A-Z2-7]{52})$/);
  if (!match) throw new Error("This is not a valid encrypted Sync Deck invite.");
  const keyBytes = base32ToBytes(match[2]);
  if (keyBytes.length !== 32) throw new Error("The invite contains an invalid vault key.");
  return { serverCode: match[1], key: bytesToBase64Url(keyBytes) };
}

async function deriveBytes(masterKey, vaultId, label) {
  const subtle = webCrypto().subtle;
  const material = await subtle.importKey("raw", masterKey, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: textEncoder.encode(`syncdeck:e2ee:v1:${vaultId}`),
    info: textEncoder.encode(`syncdeck:${label}`),
  }, material, 256));
}

async function importAesKey(raw) {
  return webCrypto().subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function importHmacKey(raw) {
  return webCrypto().subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function aad(vaultId, id, purpose) {
  return textEncoder.encode(`syncdeck:e2ee:v1:${vaultId}:${id}:${purpose}`);
}

async function encryptJson(key, value, additionalData) {
  const nonce = randomBytes(12);
  const plaintext = textEncoder.encode(JSON.stringify(value));
  const ciphertext = await webCrypto().subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 },
    key,
    plaintext
  );
  return { nonce: bytesToBase64Url(nonce), cipher: bytesToBase64Url(ciphertext) };
}

async function decryptJson(key, nonce, cipher, additionalData) {
  const plaintext = await webCrypto().subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(nonce),
      additionalData,
      tagLength: 128,
    },
    key,
    base64UrlToBytes(cipher)
  );
  return JSON.parse(textDecoder.decode(plaintext));
}


// ---- Vault password escrow (v1) ---------------------------------------------
// A user-chosen vault password wraps the 256-bit vault keys so a NEW device can
// unlock them after signing in, without anyone typing an SDK1 recovery key. The
// wrapping happens on the device: the server only ever stores the sealed
// envelope and never sees the password or a raw vault key.
//
// The file/metadata/folder formats above are deliberately untouched — ciphertext
// already on the server keeps decrypting exactly as before.
const ESCROW_VERSION = 1;
const ESCROW_KDF = "PBKDF2-SHA256";
const ESCROW_MIN_ITERATIONS = 200000;
const ESCROW_MAX_ITERATIONS = 4000000;
const ESCROW_DEFAULT_ITERATIONS = 650000;
// Calibration never goes above this. A fast desktop would otherwise pick a cost
// that a phone — which must derive the SAME key to unlock — takes seconds to pay.
const ESCROW_CALIBRATION_CEILING = 1200000;
const ESCROW_MIN_PASSPHRASE_LENGTH = 12;

// Short, unambiguous words. Exactly 256 entries, so one random byte selects one
// word with no modulo bias: 8 words = 64 bits of entropy.
const PASSPHRASE_WORDS = ("able acid acorn actor adapt agent airy alarm album alert alley amber anchor angle ankle apple apron arbor arena armor arrow ashen aspen atlas attic audio autumn awake axis bacon badge bagel baker balmy banjo barge basil basin baton beach beacon beam bean bench berry birch bison blade blaze bloom blue board bolt bonus boost booth botany bottle boulder brave bread breeze brick bridge brisk broom brush bubble bucket buffalo bugle bunny bureau burrow butter cabin cable cactus camel candle canoe canvas canyon carbon cargo carpet carrot castle cedar cello census chalk charm cheese cherry chess chime chorus cider cinema circus citrus clamp clay clever cliff cloak clock cloud clover coast cobalt cocoa coffee comet compass copper coral cosmic cotton cougar county cover coyote crane crater crayon creek crest cricket crisp crown crystal cube cumin curve cyclone daisy dancer dapper dawn deacon deck delta denim desert diesel digit diner dinner ditch dive dock dolphin domino donor double dove dozen draft dragon drift drum duet dune dusk eagle earth easel east echo eclipse edge eight elbow elder electric elm ember emerald empty engine enter envoy equal era escape ether even exact exit fable fabric falcon fancy farm feather fennel fern ferry fiber fiddle field fig filter finch fjord flame flask fleet flint float flora flute foam focus foggy folk forest forge fossil fox frame free fresh frost fuel fungus funnel galaxy garden gecko ginger glacier glass globe glove golden goose grain granite grape gravel green grove guitar gulf gust hammer harbor harvest hazel heather helm heron hickory").split(/\s+/);

function normalizePassphrase(value) {
  // NFKC so a password typed on a phone keyboard matches one typed on a laptop.
  return String(value == null ? "" : value).normalize("NFKC").trim();
}

// Only called when SETTING a password, never when deriving — an existing short
// password must keep working after this threshold changes.
function assertPassphraseStrength(value) {
  const text = normalizePassphrase(value);
  if (text.length < ESCROW_MIN_PASSPHRASE_LENGTH) {
    throw new Error(`A vault password needs at least ${ESCROW_MIN_PASSPHRASE_LENGTH} characters.`);
  }
  return text;
}

function suggestPassphrase(words = 8) {
  const count = Math.max(4, Math.min(12, Number(words) || 8));
  const picks = randomBytes(count);
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(PASSPHRASE_WORDS[picks[i] & 255]);
  return out.join("-");
}

function generateEscrowSalt() {
  return bytesToBase64Url(randomBytes(16));
}

function normalizeEscrowParams(params) {
  const source = params || {};
  if (source.kdf !== ESCROW_KDF) throw new Error("Unsupported vault password format.");
  const iterations = Number(source.iterations);
  if (!Number.isInteger(iterations) || iterations < ESCROW_MIN_ITERATIONS || iterations > ESCROW_MAX_ITERATIONS) {
    throw new Error("Unsupported vault password settings.");
  }
  const salt = String(source.salt || "");
  if (base64UrlToBytes(salt).length !== 16) throw new Error("Unsupported vault password settings.");
  return { kdf: ESCROW_KDF, iterations, salt };
}

// Binds the envelope to the account, the vault and the exact KDF parameters, so
// a hostile server cannot move an envelope between vaults or users, and an
// envelope sealed under one cost cannot be opened under another. (Choosing which
// parameters this device SEALS with is enforced separately, in plugin.js: they
// are adopted only after they have opened a real record.)
function escrowAad(email, vaultId, params) {
  const safe = normalizeEscrowParams(params);
  return textEncoder.encode(
    `syncdeck:escrow:v${ESCROW_VERSION}:${String(email || "").toLowerCase()}:${String(vaultId)}:${safe.kdf}:${safe.iterations}:${safe.salt}`
  );
}

async function deriveEscrowKey(passphrase, params) {
  const safe = normalizeEscrowParams(params);
  const subtle = webCrypto().subtle;
  const material = await subtle.importKey(
    "raw",
    textEncoder.encode(normalizePassphrase(passphrase)),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derived = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: base64UrlToBytes(safe.salt), iterations: safe.iterations },
    material,
    256
  );
  // Not extractable: the wrapping key can never be written to disk.
  return subtle.importKey("raw", derived, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function wrapVaultKey(wrappingKey, email, vaultId, encodedKey, keyCheck, params) {
  if (base64UrlToBytes(encodedKey).length !== 32) throw new Error("Vault key must be 256 bits.");
  const sealed = await encryptJson(
    wrappingKey,
    { k: encodedKey, kc: String(keyCheck || ""), vid: String(vaultId) },
    escrowAad(email, vaultId, params)
  );
  return { v: ESCROW_VERSION, nonce: sealed.nonce, cipher: sealed.cipher };
}

async function unwrapVaultKey(wrappingKey, email, vaultId, envelope, params) {
  if (!envelope || Number(envelope.v) !== ESCROW_VERSION || !envelope.nonce || !envelope.cipher) {
    throw new Error("This vault password record is damaged.");
  }
  // A wrong password fails the GCM tag here — there is no separate verifier to
  // give anyone holding the envelope a cheaper guessing oracle.
  const payload = await decryptJson(wrappingKey, envelope.nonce, envelope.cipher, escrowAad(email, vaultId, params));
  if (!payload || payload.vid !== String(vaultId)) throw new Error("This vault password record is damaged.");
  if (base64UrlToBytes(payload.k).length !== 32) throw new Error("This vault password record is damaged.");
  return { key: payload.k, keyCheck: String(payload.kc || "") };
}

// PBKDF2 is the only password KDF available in Obsidian's runtime (no Argon2 in
// Web Crypto, and build.js cannot bundle WASM), so cost is bought with
// iterations. Measure this device and scale up from the floor, never below it.
async function calibrateEscrowIterations(budgetMs = 400) {
  const params = { kdf: ESCROW_KDF, iterations: ESCROW_MIN_ITERATIONS, salt: generateEscrowSalt() };
  let perIteration = 0;
  try {
    const started = Date.now();
    await deriveEscrowKey("calibration-probe-passphrase", params);
    perIteration = (Date.now() - started) / ESCROW_MIN_ITERATIONS;
  } catch (error) {
    return ESCROW_DEFAULT_ITERATIONS;
  }
  if (!(perIteration > 0)) return ESCROW_CALIBRATION_CEILING;
  const scaled = Math.round(Number(budgetMs) / perIteration / 50000) * 50000;
  return Math.min(ESCROW_CALIBRATION_CEILING, Math.max(ESCROW_DEFAULT_ITERATIONS, scaled));
}

class VaultCrypto {
  static async create(vaultId, encodedKey) {
    const masterKey = base64UrlToBytes(encodedKey);
    if (masterKey.length !== 32) throw new Error("Vault key must be 256 bits.");
    const [contentRaw, metadataRaw, indexRaw] = await Promise.all([
      deriveBytes(masterKey, vaultId, "content"),
      deriveBytes(masterKey, vaultId, "metadata"),
      deriveBytes(masterKey, vaultId, "index"),
    ]);
    return new VaultCrypto(
      String(vaultId),
      encodedKey,
      await importAesKey(contentRaw),
      await importAesKey(metadataRaw),
      await importHmacKey(indexRaw)
    );
  }

  constructor(vaultId, encodedKey, contentKey, metadataKey, indexKey) {
    this.vaultId = vaultId;
    this.encodedKey = encodedKey;
    this.contentKey = contentKey;
    this.metadataKey = metadataKey;
    this.indexKey = indexKey;
  }

  async blindId(kind, value) {
    const signed = await webCrypto().subtle.sign(
      "HMAC",
      this.indexKey,
      textEncoder.encode(`${kind}:${String(value)}`)
    );
    return bytesToBase64Url(signed);
  }

  async keyCheck() {
    return this.blindId("key-check", this.vaultId);
  }

  async encryptFile(path, content, metadata = {}) {
    path = validateVaultPath(path);
    const id = await this.blindId("file", path);
    const contentNonce = randomBytes(12);
    const cipherBuffer = await webCrypto().subtle.encrypt(
      {
        name: "AES-GCM",
        iv: contentNonce,
        additionalData: aad(this.vaultId, id, "content"),
        tagLength: 128,
      },
      this.contentKey,
      bytes(content)
    );
    const meta = await encryptJson(this.metadataKey, {
      path,
      size: Number(metadata.size) || bytes(content).byteLength,
      mtime: Number(metadata.mtime) || 0,
      ctime: Number(metadata.ctime) || 0,
      type: metadata.type || "file",
      hash: metadata.hash || "",
    }, aad(this.vaultId, id, "metadata"));
    return {
      id,
      contentBase64: bytesToBase64(cipherBuffer),
      contentNonce: bytesToBase64Url(contentNonce),
      metaNonce: meta.nonce,
      metaCipher: meta.cipher,
    };
  }

  async decryptFileMetadata(record) {
    if (!record || !record.id || !record.metaNonce || !record.metaCipher) {
      throw new Error("Encrypted file metadata is incomplete.");
    }
    const meta = await decryptJson(
      this.metadataKey,
      record.metaNonce,
      record.metaCipher,
      aad(this.vaultId, record.id, "metadata")
    );
    if (!meta || typeof meta.path !== "string") throw new Error("Encrypted file path is missing.");
    meta.path = validateVaultPath(meta.path);
    const expectedId = await this.blindId("file", meta.path);
    if (expectedId !== record.id) throw new Error("Encrypted file path authentication failed.");
    return Object.assign({}, record, meta);
  }

  async decryptFileContent(record, contentBase64) {
    if (!record || !record.id || !record.contentNonce) throw new Error("Encrypted file content metadata is incomplete.");
    return webCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(record.contentNonce),
        additionalData: aad(this.vaultId, record.id, "content"),
        tagLength: 128,
      },
      this.contentKey,
      base64ToBytes(contentBase64)
    );
  }

  async encryptFolder(path) {
    path = validateVaultPath(path);
    const id = await this.blindId("folder", path);
    const meta = await encryptJson(this.metadataKey, { path }, aad(this.vaultId, id, "folder"));
    return { id, metaNonce: meta.nonce, metaCipher: meta.cipher };
  }

  async decryptFolder(record) {
    if (!record || !record.id || !record.metaNonce || !record.metaCipher) {
      throw new Error("Encrypted folder metadata is incomplete.");
    }
    const meta = await decryptJson(
      this.metadataKey,
      record.metaNonce,
      record.metaCipher,
      aad(this.vaultId, record.id, "folder")
    );
    meta.path = validateVaultPath(meta.path);
    const expectedId = await this.blindId("folder", meta.path);
    if (expectedId !== record.id) throw new Error("Encrypted folder path authentication failed.");
    return meta.path;
  }
}

module.exports = {
  ESCROW_DEFAULT_ITERATIONS,
  ESCROW_KDF,
  ESCROW_MAX_ITERATIONS,
  ESCROW_MIN_ITERATIONS,
  ESCROW_MIN_PASSPHRASE_LENGTH,
  ESCROW_VERSION,
  PROTOCOL_VERSION,
  VaultCrypto,
  assertPassphraseStrength,
  calibrateEscrowIterations,
  deriveEscrowKey,
  generateEscrowSalt,
  generateVaultKey,
  normalizePassphrase,
  parseRecoveryCode,
  parseSecureInviteCode,
  recoveryCode,
  secureInviteCode,
  suggestPassphrase,
  unwrapVaultKey,
  wrapVaultKey,
};
