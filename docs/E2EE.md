# Sync Deck end-to-end encryption

## What is protected

For an E2EE vault, Sync Deck encrypts these values on the device before they
leave Obsidian:

- file contents;
- filenames and complete file paths;
- folder paths, including empty folders;
- file type, local timestamps, and plaintext content hash;
- editor file identifiers and Task Deck board/card identifiers used for live
  presence and locks.

The server stores opaque file identifiers, encrypted metadata, and authenticated
ciphertext. It cannot derive a plaintext path or decrypt a file without the
vault key.

## Protocol

Each vault uses a random 256-bit vault master key generated with the platform
cryptographic random-number generator.

The client derives independent content, metadata, and indexing keys with
HKDF-SHA-256. File content and metadata use AES-256-GCM with a fresh 96-bit nonce
and protocol/vault/record-specific additional authenticated data. File and folder
storage identifiers are HMAC-SHA-256 values over their full plaintext paths.
Changing a path creates a different opaque identifier.

The encrypted envelope is versioned as protocol `1`. The server refuses plaintext
file envelopes for a protocol-1 vault and refuses sync access from clients that do
not advertise E2EE support. This prevents an older client from interpreting an
encrypted manifest as an empty vault and deleting local files.

The design follows [RFC 5869 (HKDF)](https://www.rfc-editor.org/rfc/rfc5869.html),
[NIST SP 800-38D (GCM)](https://csrc.nist.gov/pubs/sp/800/38/d/final), and the
[Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API).

## Keys, invites, and recovery

The raw vault key is stored in Sync Deck's local plugin data on an authorized
device. This protects against the sync server reading vault data; it does not
protect a device on which another process or plugin can already read the local
plaintext Obsidian vault. Sync Deck excludes `.obsidian/plugins/` from its own
sync, but another backup or sync tool may copy that local key file; protect such
backups accordingly.

An `SDK1-…` recovery key contains the vault key. An encrypted `SD1-…` invite
contains a short-lived, single-use server membership code and the vault key. Only
the membership code is sent to the server. Treat both strings as secrets.

There is no server-side key escrow or reset. If every authorized device and every
recovery copy is lost, the encrypted server data cannot be recovered.

## Metadata and threat-model limits

E2EE protects vault content from a curious or compromised storage server. It does
not make the whole system anonymous or invulnerable. The server still sees:

- account identity, vault display name, members, and roles;
- IP address, device identifier, request timing, and authentication tokens;
- file counts, ciphertext sizes, server update timestamps, and which account
  updated an opaque record;
- presence identity, timing, and cursor coordinates (but not the protected
  file/board/card identifier).

E2EE also cannot protect content on a compromised endpoint, from a malicious
Obsidian plugin, from an invited collaborator, or after a recovery key is copied.
Removing a collaborator revokes future authenticated server access but cannot
erase content or keys already downloaded.

Authenticated encryption detects altered ciphertext, but it does not guarantee
service availability and does not give a brand-new device an independent way to
detect a server replaying an older, otherwise valid encrypted record. Keep normal
backups and do not treat Sync Deck as the only copy of a vault.

## Legacy-vault migration

Legacy vaults are never silently upgraded. The owner selects **Enable E2EE**.
Sync Deck pulls the latest state, creates a fresh encrypted vault and key, uploads
all local syncable files, decrypts the returned manifest locally, and verifies the
complete file and folder path sets. It also downloads every replacement
ciphertext, authenticates and decrypts it, and compares its plaintext hash to the
local source. It deletes the old plaintext server vault only after those checks
succeed. A failed migration restores the original local association and leaves
the old vault unchanged. Upload intent and cleanup state are persisted before the
copy begins; after an app or device interruption, the panel shows **Finish
migration** and does not resume normal sync until verification and old-vault
cleanup complete.

Because migration creates a new cryptographic vault, previous members must be
invited again with a new encrypted invite.

## Key rotation

The owner can select **Rotate key**. Sync Deck uses the same verified-replacement
flow with a newly generated vault key and deletes the old encrypted server vault
only after every replacement file has round-tripped successfully. The old
recovery key then stops working for future sync, and every intended member must be
invited again.
