const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAnXjojLpFurr7/cVuY7h8+6FStGHqyfkzSmb6S1Xgmi8=
-----END PUBLIC KEY-----
`;
function isE2EBuild(flag2) {
  return false;
}
function updatePublicKey(env = process.env, e2e = isE2EBuild()) {
  if (e2e) {
    const override = env.FLOWA_UPDATE_PUBLIC_KEY?.trim();
    if (override && override.includes("BEGIN PUBLIC KEY")) return override;
  }
  return UPDATE_PUBLIC_KEY.trim();
}
function e2eFeedUrl(env = process.env, e2e = isE2EBuild()) {
  if (!e2e) return null;
  const raw = env.FLOWA_UPDATE_FEED?.trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return null;
  return raw.endsWith("/") ? raw : `${raw}/`;
}
function e2eAllowsUnsigned(env = process.env, e2e = isE2EBuild()) {
  return e2e && env.FLOWA_E2E_ALLOW_UNSIGNED === "1";
}
function e2eAutoUpdate(env = process.env, e2e = isE2EBuild()) {
  return e2e && env.FLOWA_E2E_AUTO_UPDATE === "1";
}

  async prepare() {
    if (this.updater) return this.updater;
    const mod = await import("electron-updater");
    const updater = mod.autoUpdater ?? mod.default?.autoUpdater;
    if (!updater) throw new Error("electron-updater unavailable");
    updater.logger = log;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.disableWebInstaller = true;
    const feed = e2eFeedUrl();
    if (feed) {
      updater.setFeedURL({ provider: "generic", url: feed });
    } else {
      updater.setFeedURL({
        provider: "github",
        owner: UPDATE_REPOSITORY.owner,
        repo: UPDATE_REPOSITORY.repo
      });
    }
    updater.on("download-progress", (progress) => {
      this.state = noteDownloadProgress(this.state, {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total
      });
      this.onChange();
    });
    updater.on("update-downloaded", () => {
      if (this.state.kind !== "downloading" && this.state.kind !== "available") return;
      this.state = noteDownloadComplete(this.state);
      this.onChange();
    });
    updater.on("error", (err) => {
      if (this.state.kind !== "downloading" && this.state.kind !== "downloaded" && this.state.kind !== "installing") return;
      console.warn("[Flowa] updater error:", err instanceof Error ? err.message : err);
      this.failDownload(DOWNLOAD_FAILED);
    });
    this.updater = updater;
    return updater;
  }
  apply(next, previous) {
    if (sameUpdate(previous, next) && sameUpdate(this.state, next)) return;
    this.state = next;
    if (next.kind === "available") console.log(`[Flowa] update available: ${next.version} autoInstall=${next.autoInstall}`);
    this.onChange();
    if (next.kind === "available" && next.autoInstall && e2eAutoUpdate()) void this.download();
  }
}
