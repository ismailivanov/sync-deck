# SyncDeck

SyncDeck is an Obsidian cloud sync plugin for team vaults.

The current build includes:

- Google sign-in
- Vault scan, upload, pull, and auto-sync on local file changes
- Invite codes for joining the same cloud vault
- A small Node API for auth, vault metadata, and file storage

Realtime presence, conflict handling, and billing will come later.

## Obsidian development install

Clone the repo directly into an Obsidian plugin folder:

```bash
git clone git@github.com:ismailivanov/SyncDeck.git "/path/to/vault/.obsidian/plugins/sync-deck"
```

Then enable **SyncDeck** from Obsidian's Community plugins screen.

## Local API

Run the development API:

```bash
GOOGLE_CLIENT_ID="your-client-id" \
GOOGLE_CLIENT_SECRET="your-client-secret" \
node server/index.js
```

The plugin uses `https://api.syncdeck.cloud` by default.

See [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md) for the current server and roadmap notes.

Create a Google OAuth web client and add this authorized redirect URI:

```text
https://api.syncdeck.cloud/auth/google/callback
```
