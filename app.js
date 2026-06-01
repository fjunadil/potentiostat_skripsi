import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app-check.js";
import { getAnalytics, isSupported as analyticsSupported } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-analytics.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { getDatabase, onValue, push, ref, serverTimestamp, set } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-database.js";

let DEVICE_PATH = "potentiostat";
let db = null;
let authUser = null;

const config = {
  parameters: {
    cv: {
      quietValue: 0.0,
      quietTime: 3000,
      startValue: -0.5,
      vertex1Value: 0.5,
      vertex2Value: -0.5,
      stepValue: 0.01,
      scanRate: 0.02,
      numCycles: 1,
      currentRange: "1000 uA",
    },
    dpv: {
      quietValue: -0.4,
      quietTime: 500,
      amplitude: 0.05,
      startValue: -0.4,
      finalValue: 0.2,
      stepValue: 0.005,
      window: 0.2,
    },
  },
  presets: {
    cv_standard: { method: "cv", notes: "CV standar", parameters: {} },
    spce_activation: {
      method: "cv",
      notes: "Aktivasi SPCE",
      parameters: { quietTime: 10000, startValue: 0.0, vertex1Value: 0.0, vertex2Value: 1.0, stepValue: 0.01, scanRate: 0.1, numCycles: 15 },
    },
    dpv_standard: { method: "dpv", notes: "DPV standar", parameters: {} },
    blank: { method: "cv", notes: "Blanko", parameters: { quietTime: 3000, startValue: -0.5, vertex1Value: 0.5, vertex2Value: -0.5, stepValue: 0.01, scanRate: 0.1 } },
    sample: { method: "cv", notes: "Sampel", parameters: { quietTime: 3000, startValue: -0.5, vertex1Value: 0.5, stepValue: 0.01, scanRate: 0.1 } },
    calibration: { method: "cv", notes: "Kalibrasi", parameters: { quietTime: 3000, startValue: -0.5, vertex1Value: 0.5, vertex2Value: -0.5, stepValue: 0.005, scanRate: 0.05 } },
  },
};

let latestState = {};
let latestMeasurements = {};
let selectedFile = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function setView(name) {
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === name));
  if (name === "data") renderFiles();
}

function updateState(state = {}) {
  latestState = state;
  $("#statusPill").textContent = state.status || "Menunggu Raspberry";
  $("#ipValue").textContent = state.ip || "-";
  $("#potValue").textContent = state.potentiostat || "-";
  $("#wifiValue").textContent = state.wifi || "-";
  $("#dataValue").textContent = `${state.dataCount || 0} file`;
  $("#summaryText").textContent = state.summary || "Belum ada hasil pengukuran.";
  $("#resultText").textContent = state.result || "-";
  $("#logText").textContent = state.log || "";
  $("#startButton").disabled = Boolean(state.running);
  $("#stopButton").disabled = !state.running;
  $("#logText").scrollTop = $("#logText").scrollHeight;
}

function renderParameters(method) {
  const box = $("#parameterFields");
  box.innerHTML = "";
  Object.entries(config.parameters[method]).forEach(([key, value]) => {
    const label = document.createElement("label");
    label.textContent = key;
    const input = document.createElement("input");
    input.name = `param:${key}`;
    input.value = value;
    label.appendChild(input);
    box.appendChild(label);
  });
}

function applyPreset(name) {
  const preset = config.presets[name];
  $("#methodSelect").value = preset.method;
  renderParameters(preset.method);
  Object.entries(preset.parameters || {}).forEach(([key, value]) => {
    const input = document.querySelector(`[name="param:${key}"]`);
    if (input) input.value = value;
  });
  document.querySelector('[name="notes"]').value = preset.notes || "";
}

function measurementPayload() {
  const form = $("#measureForm");
  const method = $("#methodSelect").value;
  const parameters = {};
  Object.keys(config.parameters[method]).forEach((key) => {
    parameters[key] = form.elements[`param:${key}`].value;
  });
  return {
    port: form.elements.port.value,
    method,
    channels: $$('input[name="channel"]:checked').map((item) => Number(item.value)),
    parameters,
    metadata: {
      sample: form.elements.sample.value,
      concentration: form.elements.concentration.value,
      operator: form.elements.operator.value,
      replicate: form.elements.replicate.value,
      notes: form.elements.notes.value,
    },
  };
}

async function sendCommand(action, payload = {}) {
  if (!db || !authUser) {
    throw new Error("Firebase belum siap");
  }
  const commandRef = push(ref(db, `${DEVICE_PATH}/commands`));
  await set(commandRef, {
    action,
    payload,
    status: "pending",
    createdAt: serverTimestamp(),
    source: "vercel-dashboard",
    uid: authUser.uid,
  });
}

function renderFiles() {
  const list = $("#fileList");
  list.innerHTML = "";
  const files = flattenMeasurementFiles(latestMeasurements);
  if (!files.length) {
    list.innerHTML = "<div class=\"preview-box\">Belum ada data sinkron dari Raspberry.</div>";
    return;
  }
  files.forEach((file) => {
    const row = document.createElement("button");
    row.className = `file-row ${selectedFile === file.name ? "active" : ""}`;
    row.type = "button";
    row.innerHTML = `<strong>${escapeHtml(file.name)}</strong><span>${escapeHtml(file.type)}</span><span>${escapeHtml(file.time)}</span>`;
    row.addEventListener("click", () => previewFile(file));
    list.appendChild(row);
  });
}

function flattenMeasurementFiles(measurements) {
  return Object.entries(measurements || {}).flatMap(([id, item]) => {
    const result = item.result || {};
    const time = item.summary ? "Selesai" : id.slice(-8);
    return [
      ...(result.data_files || []),
      result.plot_file,
      result.analysis_file,
      result.metadata_file,
    ].filter(Boolean).map((name) => ({
      name: String(name).split(/[\\/]/).pop(),
      path: String(name),
      type: String(name).split(".").pop().toUpperCase(),
      time,
      summary: item.summary || "",
    }));
  }).reverse();
}

function previewFile(file) {
  selectedFile = file.name;
  $("#previewBox").innerHTML = `<pre>${escapeHtml(file.path)}\n\n${escapeHtml(file.summary || "Preview file mentah hanya tersedia di Raspberry/local web server.")}</pre>`;
  renderFiles();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

function bindUi() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $$(".preset-grid button").forEach((button) => button.addEventListener("click", () => applyPreset(button.dataset.preset)));
  $("#methodSelect").addEventListener("change", (event) => renderParameters(event.target.value));
  $("#advancedToggle").addEventListener("change", (event) => $("#parameterFields").classList.toggle("hidden", !event.target.checked));
  $("#refreshStatus").addEventListener("click", () => sendCommand("refresh"));
  $("#refreshFiles").addEventListener("click", renderFiles);
  $("#stopButton").addEventListener("click", () => sendCommand("stop"));
  $("#connectWifi").addEventListener("click", () => {
    sendCommand("wifi", { ssid: $("#ssidInput").value, password: $("#passwordInput").value });
  });
  $("#measureForm").addEventListener("submit", (event) => {
    event.preventDefault();
    sendCommand("start", measurementPayload());
  });
}

async function loadFirebaseRuntimeConfig() {
  const response = await fetch("/api/firebase-config", {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Konfigurasi Firebase Vercel belum lengkap");
  }
  return response.json();
}

async function initFirebase() {
  const runtime = await loadFirebaseRuntimeConfig();
  DEVICE_PATH = runtime.devicePath || DEVICE_PATH;

  const firebaseApp = initializeApp(runtime.firebaseConfig);
  if (runtime.appCheckSiteKey) {
    initializeAppCheck(firebaseApp, {
      provider: new ReCaptchaV3Provider(runtime.appCheckSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  }
  db = getDatabase(firebaseApp);
  const auth = getAuth(firebaseApp);
  const credential = await signInAnonymously(auth);
  authUser = credential.user;

  analyticsSupported().then((supported) => {
    if (supported && runtime.firebaseConfig.measurementId) getAnalytics(firebaseApp);
  });
}

async function boot() {
  renderParameters("cv");
  bindUi();
  await initFirebase();
  onValue(ref(db, `${DEVICE_PATH}/state`), (snapshot) => {
    $("#firebaseState").textContent = "Firebase: realtime aktif";
    updateState(snapshot.val() || {});
  }, (error) => {
    $("#firebaseState").textContent = `Firebase: ${error.message}`;
  });
  onValue(ref(db, `${DEVICE_PATH}/measurements`), (snapshot) => {
    latestMeasurements = snapshot.val() || {};
    renderFiles();
  });
}

boot().catch((error) => {
  $("#firebaseState").textContent = "Firebase: konfigurasi gagal";
  $("#statusPill").textContent = "Error";
  $("#summaryText").textContent = error.message;
});
