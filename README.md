# Sync Deck

Sync Deck is an Obsidian plugin that syncs your vault across devices and with
your team through a hosted cloud service.

Features:

- Google sign-in
- Vault scan, upload, pull, and auto-sync on local file changes
- File, folder (including empty folders), and card-order sync
- Invite codes to join a shared vault, with Admin / Worker roles
- Live presence and cursors while collaborating

## Install (development)

Clone directly into your Obsidian plugins folder:

```bash
git clone https://github.com/ismailivanov/SyncDeck.git "/path/to/vault/.obsidian/plugins/sync-deck"
```

Then enable **Sync Deck** from Obsidian's Community plugins screen.

## How it works

The plugin syncs through the hosted API at `https://api.syncdeck.cloud`. Open the
Sync Deck panel and sign in with Google to get started.
