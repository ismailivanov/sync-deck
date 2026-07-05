const { PluginSettingTab, Setting } = require("obsidian");

class SyncDeskSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("sd-settings");

    containerEl.createEl("h2", { text: "Sync Desk" });
    containerEl.createEl("p", {
      text: "Realtime vault sync, team roles, and Task Deck collaboration.",
    });

    new Setting(containerEl)
      .setName("Dashboard")
      .setDesc("Open the Sync Desk control panel.")
      .addButton((button) => {
        button
          .setButtonText("Open")
          .setCta()
          .onClick(() => this.plugin.activateView());
      });

    new Setting(containerEl)
      .setName("Account")
      .setDesc(this.plugin.data.signedIn ? this.plugin.data.user.email : "Not signed in.")
      .addButton((button) => {
        button
          .setButtonText(this.plugin.data.signedIn ? "Sign out" : "Sign in")
          .onClick(() => this.plugin.data.signedIn ? this.plugin.signOut() : this.plugin.signIn());
      });

    new Setting(containerEl)
      .setName("API server")
      .setDesc("Cloud API server for auth and vault registration.")
      .addText((text) => {
        text
          .setPlaceholder("https://api.syncdeck.cloud")
          .setValue(this.plugin.data.serverUrl)
          .onChange(async (value) => {
            this.plugin.data.serverUrl = value.trim() || "https://api.syncdeck.cloud";
            await this.plugin.savePluginData();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Ping")
          .onClick(async () => {
            try {
              await this.plugin.pingServer();
            } catch (error) {
              this.plugin.data.serverStatus = "offline";
              await this.plugin.savePluginData();
            }
          });
      });

    new Setting(containerEl)
      .setName("Version")
      .setDesc(this.plugin.manifest.version || "0.1.0");
  }
}

module.exports = { SyncDeskSettingTab };
