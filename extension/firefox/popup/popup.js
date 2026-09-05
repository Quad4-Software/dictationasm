const $ = (id) => document.getElementById(id);
const status = $("status");
const meter = $("meter");
const meterBar = meter.querySelector("span");
let recording = false;

function setStatus(msg) { status.textContent = msg || ""; }
function setBusy(on) {
  meter.classList.toggle("on", on);
  meterBar.style.width = on ? "70%" : "0%";
}
async function send(msg) { return chrome.runtime.sendMessage(msg); }

const settings = await send({ type: "get-settings" });
if (settings?.updateAvailable && settings?.remoteVersion) {
  setStatus(`Update ${settings.remoteVersion} available in Settings`);
}

async function persist() {
  await send({
    type: "save-settings",
    settings: {
      modelId: $("model").value || undefined,
    },
  });
}

$("btn-bridge").addEventListener("click", async () => {
  await persist();
  setStatus("Opening bridge…");
  const res = await send({ type: "ensure-bridge", focus: false });
  setStatus(res?.ok ? "Bridge ready. Allow mic when prompted." : (res?.error || "Failed"));
});

setStatus("Loading models…");
await send({ type: "ensure-bridge" });
const modelsRes = await send({ type: "list-models" });
const models = modelsRes?.result?.models || [];
const sel = $("model");
for (const m of models) {
  const opt = document.createElement("option");
  opt.value = m.id;
  opt.textContent = `${m.label || m.id}${m.default ? " (default)" : ""}`;
  if (m.default) opt.selected = true;
  sel.appendChild(opt);
}
if (settings?.modelId) sel.value = settings.modelId;
setStatus(models.length ? "Ready" : "Connect bridge to load models");

$("btn-record").addEventListener("click", async () => {
  await persist();
  setBusy(true);
  setStatus("Starting mic on bridge tab…");
  if ($("model").value) {
    await send({ type: "load-model", modelId: $("model").value });
  }
  const res = await send({ type: "start-record" });
  setBusy(false);
  if (!res?.ok) {
    setStatus(res?.error || "Could not start recording");
    return;
  }
  recording = true;
  $("btn-record").disabled = true;
  $("btn-stop").disabled = false;
  $("btn-cancel").disabled = false;
  setStatus("Recording… keep bridge tab open");
});

$("btn-stop").addEventListener("click", async () => {
  if (!recording) return;
  setBusy(true);
  setStatus("Transcribing…");
  const res = await send({ type: "stop-record" });
  setBusy(false);
  recording = false;
  $("btn-record").disabled = false;
  $("btn-stop").disabled = true;
  $("btn-cancel").disabled = true;
  if (!res?.ok) {
    setStatus(res?.error || "Dictation failed");
    return;
  }
  $("output").value = res.result?.text || "";
  setStatus(res.result?.backend ? `Done (${res.result.backend})` : "Done");
});

$("btn-cancel").addEventListener("click", async () => {
  await send({ type: "cancel-record" });
  recording = false;
  $("btn-record").disabled = false;
  $("btn-stop").disabled = true;
  $("btn-cancel").disabled = true;
  setBusy(false);
  setStatus("Cancelled");
});

$("btn-copy").addEventListener("click", async () => {
  const text = $("output").value;
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus("Copied");
});

$("btn-open").addEventListener("click", async () => {
  await send({ type: "open-app" });
  window.close();
});


$("btn-settings").addEventListener("click", async () => {
  await send({ type: "open-options" });
});
