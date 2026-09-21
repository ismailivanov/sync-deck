const assert = require("assert");
const {
  ESCROW_KDF,
  ESCROW_MIN_ITERATIONS,
  VaultCrypto,
  assertPassphraseStrength,
  deriveEscrowKey,
  generateEscrowSalt,
  generateVaultKey,
  parseRecoveryCode,
  parseSecureInviteCode,
  recoveryCode,
  secureInviteCode,
  suggestPassphrase,
  unwrapVaultKey,
  wrapVaultKey,
} = require("./src/crypto");

// Flip the FIRST character, not the last. A base64url string's final character
// can carry unused low bits, so changing it may decode to identical bytes and
// the tamper test silently passes without testing anything.
function bend(value) {
  const first = value[0] === "A" ? "B" : "A";
  return `${first}${value.slice(1)}`;
}

(async () => {
  const key = generateVaultKey();
  const crypto = await VaultCrypto.create("vault-test", key);
  const plaintext = new TextEncoder().encode("# Private\nTop secret");
  const encrypted = await crypto.encryptFile("Projects/Secret.md", plaintext, {
    size: plaintext.length,
    mtime: 123,
    ctime: 100,
    type: "markdown",
    hash: "plain-hash",
  });

  assert.equal(encrypted.id.length, 43);
  assert(!JSON.stringify(encrypted).includes("Projects/Secret.md"));
  const metadata = await crypto.decryptFileMetadata(encrypted);
  assert.equal(metadata.path, "Projects/Secret.md");
  assert.equal(metadata.hash, "plain-hash");
  const decrypted = await crypto.decryptFileContent(encrypted, encrypted.contentBase64);
  assert.equal(new TextDecoder().decode(decrypted), "# Private\nTop secret");

  const folder = await crypto.encryptFolder("Projects");
  assert(!JSON.stringify(folder).includes("Projects"));
  assert.equal(await crypto.decryptFolder(folder), "Projects");

  const invite = secureInviteCode("A1B2C3D4E5F6", key);
  assert.deepEqual(parseSecureInviteCode(invite), { serverCode: "A1B2C3D4E5F6", key });
  assert.equal(parseRecoveryCode(recoveryCode(key)), key);

  const tampered = Object.assign({}, encrypted, { metaCipher: bend(encrypted.metaCipher) });
  await assert.rejects(() => crypto.decryptFileMetadata(tampered));
  await assert.rejects(() => crypto.encryptFile("../escape.md", plaintext));

  // ---- Vault password escrow ----------------------------------------------
  // The escrow layer must be able to hand a vault key to another device without
  // the server ever being able to read it, and without touching the formats
  // asserted above.
  const email = "owner@example.com";
  const params = { kdf: ESCROW_KDF, iterations: ESCROW_MIN_ITERATIONS, salt: generateEscrowSalt() };
  const wrappingKey = await deriveEscrowKey("a-good-vault-password", params);
  const envelope = await wrapVaultKey(wrappingKey, email, "vault-test", key, await crypto.keyCheck(), params);

  // The sealed record must not leak the key, the check, or the vault id.
  const sealed = JSON.stringify(envelope);
  assert(!sealed.includes(key));
  assert(!sealed.includes(await crypto.keyCheck()));
  assert(!sealed.includes("vault-test"));

  const unwrapped = await unwrapVaultKey(wrappingKey, email, "vault-test", envelope, params);
  assert.equal(unwrapped.key, key);
  assert.equal(unwrapped.keyCheck, await crypto.keyCheck());
  // The recovered key really does open the vault's existing ciphertext.
  const reopened = await VaultCrypto.create("vault-test", unwrapped.key);
  assert.equal((await reopened.decryptFileMetadata(encrypted)).path, "Projects/Secret.md");

  // Wrong password, wrong vault, wrong account, downgraded cost, tampered bytes.
  const wrongKey = await deriveEscrowKey("not-the-password", params);
  await assert.rejects(() => unwrapVaultKey(wrongKey, email, "vault-test", envelope, params));
  await assert.rejects(() => unwrapVaultKey(wrappingKey, email, "vault-other", envelope, params));
  await assert.rejects(() => unwrapVaultKey(wrappingKey, "someone@else.com", "vault-test", envelope, params));
  await assert.rejects(() => unwrapVaultKey(
    wrappingKey, email, "vault-test", envelope,
    Object.assign({}, params, { iterations: ESCROW_MIN_ITERATIONS + 1 })
  ));
  const bentEnvelope = Object.assign({}, envelope, { cipher: bend(envelope.cipher) });
  await assert.rejects(() => unwrapVaultKey(wrappingKey, email, "vault-test", bentEnvelope, params));

  // Cost parameters outside the accepted band are refused outright.
  await assert.rejects(() => deriveEscrowKey("x", Object.assign({}, params, { iterations: 199999 })));
  await assert.rejects(() => deriveEscrowKey("x", Object.assign({}, params, { iterations: 4000001 })));
  await assert.rejects(() => deriveEscrowKey("x", Object.assign({}, params, { kdf: "scrypt" })));
  await assert.rejects(() => deriveEscrowKey("x", Object.assign({}, params, { salt: "short" })));

  assert.throws(() => assertPassphraseStrength("too-short"));
  assert.equal(assertPassphraseStrength("  long-enough-password  "), "long-enough-password");
  // A suggested password must be real words, not "undefined" from a short list.
  const suggestion = suggestPassphrase(8);
  assert.equal(suggestion.split("-").length, 8);
  assert(!suggestion.includes("undefined"));

  console.log("e2ee crypto checks passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
