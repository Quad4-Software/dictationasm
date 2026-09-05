const DEFAULT_SITE = "https://dictationasm.quad4.io";
const $ = (id) => document.getElementById(id);

async function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

function normalizeOrigin(value, fallback) {
  const raw = String(value || "").trim() || fallback;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
    return u.origin;
  } catch {
    throw new Error("Enter a valid http(s) origin");
  }
}

const settings = await send({ type: "get-settings" });
const localVersion = chrome.runtime.getManifest().version;
$("local-version").textContent = localVersion;
$("site").value = settings?.siteOrigin || DEFAULT_SITE;
$("bridge").value = settings?.bridgeOrigin || settings?.siteOrigin || DEFAULT_SITE;
$("sync-bridge").checked = settings?.syncBridge !== false;
$("auto-update").checked = settings?.autoUpdateCheck !== false;
if (settings?.remoteVersion) $("remote-version").textContent = settings.remoteVersion;

$("sync-bridge").addEventListener("change", () => {
  if ($("sync-bridge").checked) $("bridge").value = $("site").value.trim() || DEFAULT_SITE;
});
$("site").addEventListener("input", () => {
  if ($("sync-bridge").checked) $("bridge").value = $("site").value;
});

$("btn-save").addEventListener("click", async () => {
  try {
    const siteOrigin = normalizeOrigin($("site").value, DEFAULT_SITE);
    const syncBridge = $("sync-bridge").checked;
    const bridgeOrigin = syncBridge ? siteOrigin : normalizeOrigin($("bridge").value, siteOrigin);
    const autoUpdateCheck = $("auto-update").checked;
    const res = await send({
      type: "save-settings",
      settings: { siteOrigin, bridgeOrigin, syncBridge, autoUpdateCheck },
    });
    if (!res?.ok) throw new Error(res?.error || "Save failed");
    $("site").value = siteOrigin;
    $("bridge").value = bridgeOrigin;
    $("save-status").textContent = "Saved.";
  } catch (err) {
    $("save-status").textContent = String(err?.message || err);
  }
});

$("btn-reset").addEventListener("click", async () => {
  await send({
    type: "save-settings",
    settings: {
      siteOrigin: DEFAULT_SITE,
      bridgeOrigin: DEFAULT_SITE,
      syncBridge: true,
      autoUpdateCheck: true,
    },
  });
  $("site").value = DEFAULT_SITE;
  $("bridge").value = DEFAULT_SITE;
  $("sync-bridge").checked = true;
  $("auto-update").checked = true;
  $("save-status").textContent = "Defaults restored.";
});

$("btn-check").addEventListener("click", async () => {
  $("update-status").textContent = "Checking…";
  try {
    const siteOrigin = normalizeOrigin($("site").value, DEFAULT_SITE);
    await send({
      type: "save-settings",
      settings: {
        siteOrigin,
        bridgeOrigin: $("sync-bridge").checked ? siteOrigin : normalizeOrigin($("bridge").value, siteOrigin),
        syncBridge: $("sync-bridge").checked,
        autoUpdateCheck: $("auto-update").checked,
      },
    });
  } catch (err) {
    $("update-status").textContent = String(err?.message || err);
    return;
  }
  const res = await send({ type: "check-updates", force: true });
  if (!res?.ok) {
    $("update-status").textContent = res?.error || "Update check failed";
    return;
  }
  if (res.remoteVersion) $("remote-version").textContent = res.remoteVersion;
  if (res.updateAvailable) {
    $("update-status").textContent = `Update available: ${res.remoteVersion}. Open /build/ to install.`;
  } else {
    $("update-status").textContent = res.message || "You are up to date.";
  }
});

$("btn-open-build").addEventListener("click", async () => {
  const siteOrigin = ($("site").value || DEFAULT_SITE).replace(/\/$/, "");
  await chrome.tabs.create({ url: `${siteOrigin}/build/` });
});
