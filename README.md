# Sync Deck

[![Obsidian](https://img.shields.io/badge/Obsidian-1.5%2B-7c3aed?logo=obsidian&logoColor=white)](https://obsidian.md)
[![Release](https://img.shields.io/github/v/release/ismailivanov/sync-deck?label=release)](https://github.com/ismailivanov/sync-deck/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-f1c40f.svg)](LICENSE)
[![Support](https://img.shields.io/badge/support-Buy%20Me%20a%20Coffee-ffdd00.svg)](https://buymeacoffee.com/carbon06)

Sync Deck keeps your Obsidian vault in sync across your devices — and, when you want, with your team. Sign in with Google, choose what to sync, and your notes stay up to date everywhere, with live presence while you collaborate.

It's the cloud companion to [**Task Deck**](https://github.com/ismailivanov/task-deck): because Task Deck's boards are plain Markdown notes, Sync Deck keeps them in sync and shows who's on which card.

## Features

- **Google sign-in** — nothing new to set up.
- **Vault sync** — files and folders (empty folders included), with automatic background sync as you edit, and one-tap pull.
- **A vault system, not a black box** — keep several synced vaults, open one at a time, and inspect, rename, switch, or close any of them. Vaults never mix.
- **You choose what goes in** — nothing syncs until you say so. When you create a vault, decide whether to bring your existing files along or start clean.
- **Teams** — share a vault with an invite code, with Admin and Worker roles, and see live presence while editing together.
- **Your files stay yours** — leaving a vault drops the shared files (to Obsidian trash, recoverable) and hands you back your own local notes. Deletes are recoverable, never silent.
- **Live storage view** — see exactly what you're using against your plan.

## Plans

| | Free | Pro |
|---|---|---|
| Storage | 250 MB | 5 GB |
| Max file size (images, video) | 10 MB | 250 MB |
| Synced [Task Deck](https://github.com/ismailivanov/task-deck) boards | 1 | Unlimited |
| Real-time sync, presence, invites, roles | ✓ | ✓ |

Pro is **$4 / month** or **$39 / year**. Upgrade any time from the Sync Deck panel — cancel whenever.

## Account, network use & privacy

Sync Deck is a hosted cloud service, so a few things to know up front:

- **An account is required.** You sign in with your Google account; syncing does not work without signing in.
- **Payment is required for Pro.** The free plan works without paying. **Pro** is a paid subscription (see *Plans*), billed through Stripe.
- **Network use.** Sync Deck sends data over HTTPS to:
  - **`api.syncdeck.cloud`** — the Sync Deck backend (hosted in Germany, EU) that stores and delivers the files you choose to sync and powers presence, invites, and roles.
  - **Google** — to sign you in (Sync Deck receives your email, name, and profile picture).
  - **Stripe** — to process Pro payments (your full card details are never sent to Sync Deck).
- **No end-to-end encryption.** Your files travel over an encrypted connection but are stored on the server in a form the operator can technically access. Don't sync passwords, secrets, other people's personal data, or anything you're required to keep confidential.
- **Privacy & terms.** What is collected and your rights (including GDPR and CCPA) are set out in the [Terms of Service & Privacy Notice](TERMS.md). You accept these in the plugin before syncing begins.

## Install

Until Sync Deck lands in the community plugins list, install it manually:

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/ismailivanov/sync-deck/releases).
2. Put them in your vault under `.obsidian/plugins/sync-deck/`.
3. Enable **Sync Deck** in Obsidian's *Community plugins* settings.

Or clone straight into your plugins folder for the latest source:

```bash
git clone https://github.com/ismailivanov/sync-deck.git "/path/to/vault/.obsidian/plugins/sync-deck"
```

## How it works

Open Sync Deck from the ribbon and sign in with Google. Nothing syncs on its own — you create or open a vault first, and choose whether to include your existing notes. From then on, changes sync in the background over HTTPS to the hosted API at `https://api.syncdeck.cloud`. Your files are stored per account; you can switch between vaults, share them, or leave them at any time.

## Works with Task Deck

[**Task Deck**](https://github.com/ismailivanov/task-deck) is a Trello-style kanban board for Obsidian where every card is a real Markdown note. Since those notes live in your vault, Sync Deck carries your boards across devices and adds live presence — you'll see who's editing which card in real time. Install both for a synced, collaborative task board. There's a **Sync your boards & vaults** button inside Task Deck that opens Sync Deck.

## Support

Sync Deck is built and maintained by one developer. If it's useful to you, you can support the work: [Buy me a coffee](https://buymeacoffee.com/carbon06).

## License

[MIT](LICENSE) © Ismail Ivanov
