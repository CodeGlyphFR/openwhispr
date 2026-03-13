const { autoUpdater } = require("electron-updater");

class UpdateManager {
  constructor() {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.updateAvailable = false;
    this.updateDownloaded = false;
    this.lastUpdateInfo = null;
    this.isInstalling = false;
    this.isDownloading = false;
    this.eventListeners = [];

    this.setupAutoUpdater();
  }

  setWindows(mainWindow, controlPanelWindow) {
    this.mainWindow = mainWindow;
    this.controlPanelWindow = controlPanelWindow;
  }

  setupAutoUpdater() {
    // Only configure auto-updater in production
    if (process.env.NODE_ENV === "development") {
      // Auto-updater disabled in development mode
      return;
    }

    // Configure auto-updater for GitHub releases
    autoUpdater.setFeedURL({
      provider: "github",
      owner: "CodeGlyphFR",
      repo: "openwhispr",
      private: false,
    });

    // Use arch-specific update channel on macOS to prevent arm64/x64
    // from downloading mismatched artifacts. Both builds publish to the
    // same GitHub release, so without this they race on latest-mac.yml.
    // Setting channel to e.g. 'latest-arm64' makes the updater look for
    // 'latest-arm64-mac.yml' instead of the shared 'latest-mac.yml'.
    if (process.platform === "darwin") {
      let nativeArch = process.arch;

      // Detect Rosetta: if an x64 build is running on Apple Silicon,
      // sysctl.proc_translated returns "1". This self-heals users who
      // got stuck on the x64 build from older releases.
      if (process.arch === "x64") {
        try {
          const { execSync } = require("child_process");
          const translated = execSync("sysctl -n sysctl.proc_translated", {
            encoding: "utf8",
            timeout: 3000,
          }).trim();
          if (translated === "1") {
            console.log("🔄 Rosetta detected — switching update channel to arm64");
            nativeArch = "arm64";
          }
        } catch {
          // sysctl.proc_translated doesn't exist on real Intel Macs — ignore
        }
      }

      autoUpdater.channel = nativeArch === "arm64" ? "latest-arm64" : "latest-x64";

      // On macOS, electron-updater's MacUpdater delegates installation to
      // Squirrel.Mac (Electron's native autoUpdater) which REQUIRES the app
      // to be code-signed. Since this fork's builds are unsigned, we must
      // prevent Squirrel.Mac from being triggered during download.
      // Setting autoInstallOnAppQuit=false prevents MacUpdater from calling
      // nativeUpdater.checkForUpdates() after the zip is downloaded.
      // We handle installation ourselves in installMacUpdate().
      autoUpdater.autoInstallOnAppQuit = false;
    } else {
      // Enable auto-install on quit for signed platforms (Windows/Linux)
      autoUpdater.autoInstallOnAppQuit = true;
    }

    // Disable auto-download - let user control when to download
    autoUpdater.autoDownload = false;

    // Enable logging in production for debugging (logs are user-accessible)
    autoUpdater.logger = console;

    // Set up event handlers
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    const handlers = {
      "checking-for-update": () => {
        this.notifyRenderers("checking-for-update");
      },
      "update-available": (info) => {
        this.updateAvailable = true;
        if (info) {
          this.lastUpdateInfo = {
            version: info.version,
            releaseDate: info.releaseDate,
            releaseNotes: info.releaseNotes,
            files: info.files,
          };
        }
        this.notifyRenderers("update-available", info);
      },
      "update-not-available": (info) => {
        this.updateAvailable = false;
        this.updateDownloaded = false;
        this.isDownloading = false;
        this.lastUpdateInfo = null;
        this.notifyRenderers("update-not-available", info);
      },
      error: (err) => {
        console.error("❌ Auto-updater error:", err?.message || err, err?.stack || "");
        this.isDownloading = false;
        this.notifyRenderers("update-error", err?.message || String(err));
      },
      "download-progress": (progressObj) => {
        console.log(
          `📥 Download progress: ${progressObj.percent.toFixed(2)}% (${(progressObj.transferred / 1024 / 1024).toFixed(2)}MB / ${(progressObj.total / 1024 / 1024).toFixed(2)}MB)`
        );
        this.notifyRenderers("update-download-progress", progressObj);
      },
      "update-downloaded": (info) => {
        console.log("✅ Update downloaded successfully:", info?.version);
        this.updateDownloaded = true;
        this.isDownloading = false;
        if (info) {
          this.lastUpdateInfo = {
            version: info.version,
            releaseDate: info.releaseDate,
            releaseNotes: info.releaseNotes,
            files: info.files,
          };
        }
        this.notifyRenderers("update-downloaded", info);
      },
    };

    // Register and track event listeners for cleanup
    Object.entries(handlers).forEach(([event, handler]) => {
      autoUpdater.on(event, handler);
      this.eventListeners.push({ event, handler });
    });
  }

  notifyRenderers(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.webContents) {
      this.mainWindow.webContents.send(channel, data);
    }
    if (
      this.controlPanelWindow &&
      !this.controlPanelWindow.isDestroyed() &&
      this.controlPanelWindow.webContents
    ) {
      this.controlPanelWindow.webContents.send(channel, data);
    }
  }

  async checkForUpdates() {
    try {
      if (process.env.NODE_ENV === "development") {
        return {
          updateAvailable: false,
          message: "Update checks are disabled in development mode",
        };
      }

      console.log("🔍 Checking for updates...");
      const result = await autoUpdater.checkForUpdates();

      if (result?.isUpdateAvailable && result?.updateInfo) {
        console.log("📋 Update available:", result.updateInfo.version);
        console.log(
          "📦 Download size:",
          result.updateInfo.files?.map((f) => `${(f.size / 1024 / 1024).toFixed(2)}MB`).join(", ")
        );
        return {
          updateAvailable: true,
          version: result.updateInfo.version,
          releaseDate: result.updateInfo.releaseDate,
          files: result.updateInfo.files,
          releaseNotes: result.updateInfo.releaseNotes,
        };
      } else {
        console.log("✅ Already on latest version");
        return {
          updateAvailable: false,
          message: "You are running the latest version",
        };
      }
    } catch (error) {
      console.error("❌ Update check error:", error);
      throw error;
    }
  }

  async downloadUpdate() {
    try {
      if (process.env.NODE_ENV === "development") {
        return {
          success: false,
          message: "Update downloads are disabled in development mode",
        };
      }

      if (this.isDownloading) {
        return {
          success: true,
          message: "Download already in progress",
        };
      }

      if (this.updateDownloaded) {
        return {
          success: true,
          message: "Update already downloaded. Ready to install.",
        };
      }

      this.isDownloading = true;
      console.log("📥 Starting update download...");
      await autoUpdater.downloadUpdate();
      console.log("📥 Download initiated successfully");

      return { success: true, message: "Update download started" };
    } catch (error) {
      this.isDownloading = false;
      console.error("❌ Update download error:", error);
      throw error;
    }
  }

  /**
   * Find the downloaded update zip in electron-updater's cache directory.
   * electron-updater stores it at: ~/Library/Caches/{updaterCacheDirName}/pending/{file}.zip
   * The cacheDir name comes from app-update.yml (updaterCacheDirName) or app.getName().
   */
  findDownloadedZip() {
    const { app } = require("electron");
    const path = require("path");
    const fs = require("fs");
    const os = require("os");

    const baseCacheDir = path.join(os.homedir(), "Library", "Caches");
    const appName = app.getName(); // "OpenWhispr" (productName)

    // Candidates for the cache directory name
    const candidates = [appName, appName.toLowerCase(), appName.replace(/\s/g, "-").toLowerCase()];

    for (const name of candidates) {
      const pendingDir = path.join(baseCacheDir, name, "pending");
      if (fs.existsSync(pendingDir)) {
        const zips = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".zip"));
        if (zips.length > 0) {
          const zipPath = path.join(pendingDir, zips[0]);
          console.log("📦 Found update zip:", zipPath);
          return zipPath;
        }
      }
      // Also check for update.zip in the cache root
      const rootZip = path.join(baseCacheDir, name, "update.zip");
      if (fs.existsSync(rootZip)) {
        console.log("📦 Found cached update.zip:", rootZip);
        return rootZip;
      }
    }

    // Last resort: try via autoUpdater's internal helper
    try {
      const helper = autoUpdater.downloadedUpdateHelper;
      if (helper) {
        const pendingDir = helper.cacheDirForPendingUpdate;
        if (fs.existsSync(pendingDir)) {
          const zips = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".zip"));
          if (zips.length > 0) {
            const zipPath = path.join(pendingDir, zips[0]);
            console.log("📦 Found update zip via helper:", zipPath);
            return zipPath;
          }
        }
        const rootZip = path.join(helper.cacheDir, "update.zip");
        if (fs.existsSync(rootZip)) {
          console.log("📦 Found cached update.zip via helper:", rootZip);
          return rootZip;
        }
      }
    } catch (e) {
      console.warn("⚠️ Could not access downloadedUpdateHelper:", e.message);
    }

    return null;
  }

  /**
   * macOS-specific update installation that bypasses Squirrel.Mac.
   * Extracts the downloaded zip and replaces the current .app bundle
   * using a detached shell script that runs after the app quits.
   */
  async installMacUpdate() {
    const { app, BrowserWindow } = require("electron");
    const { spawn } = require("child_process");
    const path = require("path");
    const fs = require("fs");

    const zipFile = this.findDownloadedZip();
    if (!zipFile) {
      throw new Error("Downloaded update zip not found in cache");
    }

    // Resolve the .app bundle path from the executable path
    // e.g. /Applications/OpenWhispr.app/Contents/MacOS/OpenWhispr
    //   → /Applications/OpenWhispr.app
    const exePath = app.getPath("exe");
    const appBundle = exePath.replace(/\/Contents\/MacOS\/.*$/, "");
    console.log("📍 Current app bundle:", appBundle);

    if (!appBundle.endsWith(".app")) {
      throw new Error(`Unexpected app path: ${appBundle}`);
    }

    const tempDir = path.join(app.getPath("temp"), "openwhispr-update");

    // Shell script that waits for this process to exit, then extracts and replaces.
    // IMPORTANT: we only replace Contents/ inside the existing .app bundle
    // so that macOS TCC permissions (accessibility, microphone) are preserved.
    // Deleting the .app directory itself would make macOS treat it as a new app.
    const script = `#!/bin/bash
set -e

APP_PID=${process.pid}
ZIP_FILE="${zipFile}"
APP_BUNDLE="${appBundle}"
TEMP_DIR="${tempDir}"

# Wait for the current process to exit
while kill -0 "$APP_PID" 2>/dev/null; do
  sleep 0.5
done

# Extract update
rm -rf "$TEMP_DIR"
mkdir -p "$TEMP_DIR"
ditto -x -k "$ZIP_FILE" "$TEMP_DIR"

# Find the extracted .app
EXTRACTED_APP=$(find "$TEMP_DIR" -maxdepth 1 -name "*.app" -type d | head -1)

if [ -z "$EXTRACTED_APP" ]; then
  echo "Error: No .app found in extracted zip"
  rm -rf "$TEMP_DIR"
  exit 1
fi

# Replace only the Contents directory inside the existing .app bundle
# to preserve macOS TCC permissions (accessibility, microphone, etc.)
rm -rf "$APP_BUNDLE/Contents"
mv "$EXTRACTED_APP/Contents" "$APP_BUNDLE/Contents"

# Remove quarantine attribute
xattr -cr "$APP_BUNDLE" 2>/dev/null || true

# Relaunch
open "$APP_BUNDLE"

# Cleanup
rm -rf "$TEMP_DIR"
rm -f "$0"
`;

    const scriptPath = path.join(app.getPath("temp"), "openwhispr-updater.sh");
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });
    console.log("📝 Updater script written to:", scriptPath);

    // Spawn the updater script detached so it survives our exit
    const child = spawn("bash", [scriptPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    // Close all windows and quit
    app.removeAllListeners("window-all-closed");
    BrowserWindow.getAllWindows().forEach((win) => {
      win.removeAllListeners("close");
    });
    app.quit();

    return { success: true, message: "Update installation started" };
  }

  async installUpdate() {
    try {
      if (process.env.NODE_ENV === "development") {
        return {
          success: false,
          message: "Update installation is disabled in development mode",
        };
      }

      if (!this.updateDownloaded) {
        return {
          success: false,
          message: "No update available to install",
        };
      }

      if (this.isInstalling) {
        return {
          success: false,
          message: "Update installation already in progress",
        };
      }

      this.isInstalling = true;
      console.log("🔄 Installing update and restarting...");

      // On macOS, bypass Squirrel.Mac (requires code signing) and
      // extract the zip ourselves
      if (process.platform === "darwin") {
        return await this.installMacUpdate();
      }

      const { app, BrowserWindow } = require("electron");

      // Remove listeners that prevent windows from closing
      // so quitAndInstall can shut down cleanly
      app.removeAllListeners("window-all-closed");
      BrowserWindow.getAllWindows().forEach((win) => {
        win.removeAllListeners("close");
      });

      const isSilent = process.platform === "win32";
      autoUpdater.quitAndInstall(isSilent, true);

      return { success: true, message: "Update installation started" };
    } catch (error) {
      this.isInstalling = false;
      console.error("❌ Update installation error:", error);
      throw error;
    }
  }

  async getAppVersion() {
    try {
      const { app } = require("electron");
      return { version: app.getVersion() };
    } catch (error) {
      console.error("❌ Error getting app version:", error);
      throw error;
    }
  }

  async getUpdateStatus() {
    try {
      return {
        updateAvailable: this.updateAvailable,
        updateDownloaded: this.updateDownloaded,
        isDevelopment: process.env.NODE_ENV === "development",
      };
    } catch (error) {
      console.error("❌ Error getting update status:", error);
      throw error;
    }
  }

  async getUpdateInfo() {
    try {
      return this.lastUpdateInfo;
    } catch (error) {
      console.error("❌ Error getting update info:", error);
      throw error;
    }
  }

  checkForUpdatesOnStartup() {
    if (process.env.NODE_ENV !== "development") {
      setTimeout(() => {
        console.log("🔄 Checking for updates on startup...");
        autoUpdater.checkForUpdates().catch((err) => {
          console.error("Startup update check failed:", err);
        });
      }, 3000);
    }
  }

  cleanup() {
    this.eventListeners.forEach(({ event, handler }) => {
      autoUpdater.removeListener(event, handler);
    });
    this.eventListeners = [];
  }
}

module.exports = UpdateManager;
