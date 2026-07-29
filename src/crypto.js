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
  PROTOCOL_VERSION,
  VaultCrypto,
  generateVaultKey,
  parseRecoveryCode,
  parseSecureInviteCode,
  recoveryCode,
  secureInviteCode,
};
