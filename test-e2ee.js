const assert = require("assert");
const {
  VaultCrypto,
  generateVaultKey,
  parseRecoveryCode,
  parseSecureInviteCode,
  recoveryCode,
  secureInviteCode,
} = require("./src/crypto");

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

  const tampered = Object.assign({}, encrypted, {
    metaCipher: `${encrypted.metaCipher.slice(0, -1)}${encrypted.metaCipher.endsWith("A") ? "B" : "A"}`,
  });
  await assert.rejects(() => crypto.decryptFileMetadata(tampered));
  await assert.rejects(() => crypto.encryptFile("../escape.md", plaintext));
  console.log("e2ee crypto checks passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
