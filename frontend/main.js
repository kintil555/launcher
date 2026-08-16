import * as THREE from "three";
import { GLTFLoader } from "./assets/vendor/three/loaders/GLTFLoader.js";

const { invoke } = window.__TAURI__.core;
const { open: openDialog } = window.__TAURI__.dialog;
const { getCurrentWindow } = window.__TAURI__.window;

const MAX_YAW = 0.55;   // radians, ~31.5deg either side
const MAX_PITCH = 0.35; // radians, ~20deg either side
const TRACK_SMOOTHING = 0.12; // lerp factor per animation frame (lower = smoother/slower)
const MAX_CLIENTS = 2;
const MIN_BOUNCE_SPEED = 0.2;
const MAX_BOUNCE_SPEED = 4.0;
const MIN_BOUNCE_AMPLITUDE = 0.0;
const MAX_BOUNCE_AMPLITUDE = 0.2;

const ACCENT_PRESETS = ["#8B5CF6", "#22C55E", "#3B82F6", "#F97316", "#EC4899", "#EAB308"];

let settings = null;

// Body-mode viewer (skinview3d)
let bodyViewer = null;

// Head-mode viewer (Three.js + glTF)
let headScene = null;
let headCamera = null;
let headRenderer = null;
let headModelRoot = null;
let headModelRadius = 1;
let headMaterials = []; // one entry per mesh (Head + Hat Layer are separate meshes/materials)

// Shared pointer-tracking state, smoothed every animation frame regardless
// of which viewer is active.
let targetYaw = 0;
let targetPitch = 0;
let currentYaw = 0;
let currentPitch = 0;

// Click-to-spin state. When the head is clicked it does one full spin, then
// eases back to whatever the mouse-follow position is via a back-out curve
// (a slight overshoot past the resting angle before settling), rather than
// snapping straight back.
let spinActive = false;
let spinStartTime = 0;
const SPIN_DURATION_MS = 900;
const SPIN_TURNS = 1; // full rotations added on top of the resting yaw
const SPIN_ROLL_MAX = 0.5; // radians of z-axis roll/tilt layered into the spin

let currentSkinSrc = null;

// --- Window chrome (custom titlebar) -------------------------------------

const appWindow = getCurrentWindow();

document.getElementById("minimize-button").addEventListener("click", () => {
  appWindow.minimize().catch((err) => console.error("minimize failed", err));
});

document.getElementById("close-button").addEventListener("click", () => {
  appWindow.close().catch((err) => console.error("close failed", err));
});

// --- Navigation -------------------------------------------------------

function showPage(pageName) {
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  document.getElementById(`page-${pageName}`).classList.add("active");

  document.getElementById("home-nav-button").classList.toggle("active", pageName === "home");
  document.getElementById("settings-nav-button").classList.toggle("active", pageName === "settings");
  document.getElementById("modules-nav-button").classList.toggle("active", pageName === "modules");
  document.getElementById("extensions-nav-button").classList.toggle("active", pageName === "extensions");

  if (pageName === "modules") {
    loadModulesList();
  }
  if (pageName === "skins") {
    loadSkinsGrid();
  }
  if (pageName === "extensions") {
    syncJodToggleUI();
    checkAllExtensionUpdates();
  }

  // The home page's .model-stage is display:none while another tab is
  // active, so any resize that fires during that time (window resize,
  // maximize/restore, DPI change) reads a 0x0 stage rect and shrinks the
  // renderer/camera to 0 -- nothing then automatically re-sizes it back
  // up when the user returns, so the head/body stay invisible. Force a
  // resize on the next frame every time home becomes active again.
  if (pageName === "home") {
    requestAnimationFrame(() => {
      resizeHeadRenderer();
      resizeBodyViewer();
    });
  }
}

document.getElementById("home-nav-button").addEventListener("click", () => showPage("home"));
document.getElementById("settings-nav-button").addEventListener("click", () => showPage("settings"));
document.getElementById("modules-nav-button").addEventListener("click", () => showPage("modules"));
document.getElementById("extensions-nav-button").addEventListener("click", () => showPage("extensions"));

// --- Extensions page --------------------------------------------------

function syncJodToggleUI() {
  const toggle = document.getElementById("jod-toggle");
  const enabled = !!settings.jod_extension_enabled;
  toggle.classList.toggle("on", enabled);
  toggle.setAttribute("aria-checked", String(enabled));
}

// Silently checks for a newer build and downloads it if one exists; the
// backend command itself is the source of truth for "is this already the
// latest" (it compares the release's published_at against a local marker
// and no-ops if unchanged), so this just reflects that result in the UI —
// no manual "Download" action needed anywhere.
async function checkAndUpdateExtension(fetchCommand, statusElId) {
  const statusEl = document.getElementById(statusElId);
  statusEl.textContent = "Checking...";
  statusEl.classList.remove("error");

  try {
    await invoke(fetchCommand, { launcherDirectory: settings.launcher_directory });
    statusEl.textContent = "Latest";
  } catch (err) {
    statusEl.textContent = "Check failed";
    statusEl.classList.add("error");
    console.error(fetchCommand, err);
  }
}

// Latite ("Release") is intentionally excluded here: it now downloads
// on-demand at Launch time (see launchGame) instead of eagerly in the
// background, so users aren't surprised by a silent download they didn't
// ask for. JoD is a separate opt-in extension and keeps auto-checking.
async function checkAllExtensionUpdates() {
  await checkAndUpdateExtension("fetch_jod_extension", "jod-status");
}

document.getElementById("jod-toggle").addEventListener("click", async () => {
  const toggle = document.getElementById("jod-toggle");
  const nextEnabled = !toggle.classList.contains("on");

  // Optimistic UI, revert on failure.
  toggle.classList.toggle("on", nextEnabled);
  toggle.setAttribute("aria-checked", String(nextEnabled));

  try {
    settings = await invoke("set_jod_enabled", { enabled: nextEnabled });
  } catch (err) {
    toggle.classList.toggle("on", !nextEnabled);
    toggle.setAttribute("aria-checked", String(!nextEnabled));
    console.error("set_jod_enabled failed:", err);
  }
});


// --- Modules page ---------------------------------------------------------

let allModules = [];

function renderModulesList(filterText = "") {
  const listEl = document.getElementById("modules-list");
  listEl.innerHTML = "";

  const query = filterText.trim().toLowerCase();
  const filtered = query
    ? allModules.filter((m) => m.name.toLowerCase().includes(query))
    : allModules;

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "modules-empty";
    empty.textContent = query ? `No modules match "${filterText}".` : "No modules found in the config yet.";
    listEl.appendChild(empty);
    return;
  }

  for (const mod of filtered) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "module-card" + (mod.enabled ? " on" : "");
    card.setAttribute("role", "switch");
    card.setAttribute("aria-checked", String(mod.enabled));

    card.innerHTML = `
      <span class="module-card-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
      </span>
      <span class="module-card-name">${mod.name}</span>
      <span class="module-card-status">${mod.enabled ? "Enabled" : "Disabled"}</span>
    `;

    card.addEventListener("click", async () => {
      const nextEnabled = !card.classList.contains("on");
      // Optimistic UI update; revert if the write fails so the toggle
      // never shows a state the file doesn't actually have.
      card.classList.toggle("on", nextEnabled);
      card.setAttribute("aria-checked", String(nextEnabled));
      card.querySelector(".module-card-status").textContent = nextEnabled ? "Enabled" : "Disabled";
      mod.enabled = nextEnabled;
      try {
        await invoke("set_module_enabled", { moduleName: mod.name, enabled: nextEnabled });
      } catch (err) {
        card.classList.toggle("on", !nextEnabled);
        card.setAttribute("aria-checked", String(!nextEnabled));
        card.querySelector(".module-card-status").textContent = !nextEnabled ? "Enabled" : "Disabled";
        mod.enabled = !nextEnabled;
        document.getElementById("modules-status").textContent = err;
      }
    });

    listEl.appendChild(card);
  }
}

async function loadModulesList() {
  const statusEl = document.getElementById("modules-status");
  const listEl = document.getElementById("modules-list");
  const searchInput = document.getElementById("modules-search");

  statusEl.textContent = "";
  listEl.innerHTML = "";
  if (searchInput) searchInput.value = "";

  try {
    allModules = await invoke("list_modules");
  } catch (err) {
    statusEl.textContent = err;
    allModules = [];
    return;
  }

  renderModulesList();
}

document.getElementById("modules-search")?.addEventListener("input", (e) => {
  renderModulesList(e.target.value);
});

document.getElementById("discord-join-button")?.addEventListener("click", () => {
  invoke("open_url", { url: "https://discord.gg/sPY8acc7Ny" }).catch((err) => {
    console.error("open_url failed:", err);
  });
});

// --- Skins page -------------------------------------------------------

let skinsPreviewViewer = null;
let selectedSkinPath = null;

// Draws just the front-face layer (8x8 region at 8,8 in the standard 64x64
// skin layout) scaled up into a small canvas -- cheap per-card thumbnail
// instead of spinning up a full 3D viewer for every grid item.
function drawSkinFaceThumbnail(canvas, img) {
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Base face (8,8 8x8) then the hat/overlay layer (40,8 8x8) on top, so
  // skins using the second-layer hat still look right in the thumbnail.
  ctx.drawImage(img, 8, 8, 8, 8, 0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 40, 8, 8, 8, 0, 0, canvas.width, canvas.height);
}

function renderSkinCard(skin) {
  const card = document.createElement("div");
  card.className = "skin-card";
  card.setAttribute("role", "button");
  card.setAttribute("tabindex", "0");
  card.dataset.path = skin.path;

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "skin-card-delete";
  deleteBtn.title = "Delete skin";
  deleteBtn.setAttribute("aria-label", "Delete skin");
  deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

  const thumb = document.createElement("canvas");
  thumb.className = "skin-card-thumb";
  thumb.width = 48;
  thumb.height = 48;

  const label = document.createElement("span");
  label.className = "skin-card-name";
  label.textContent = skin.filename.replace(/\.png$/i, "");

  card.appendChild(deleteBtn);
  card.appendChild(thumb);
  card.appendChild(label);

  const img = new Image();
  img.onload = () => drawSkinFaceThumbnail(thumb, img);
  img.src = convertFileSrc(skin.path);

  card.addEventListener("click", () => selectSkin(skin, card));
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectSkin(skin, card);
    }
  });

  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    deleteBtn.disabled = true;
    try {
      await invoke("delete_skin", { path: skin.path });
      if (selectedSkinPath === skin.path) {
        selectedSkinPath = null;
        document.getElementById("skin-apply-button").disabled = true;
      }
      await loadSkinsGrid();
    } catch (err) {
      console.error("delete_skin failed:", err);
      deleteBtn.disabled = false;
    }
  });

  return card;
}

function selectSkin(skin, cardEl) {
  document.querySelectorAll(".skin-card.selected").forEach((c) => c.classList.remove("selected"));
  cardEl.classList.add("selected");
  selectedSkinPath = skin.path;

  document.getElementById("skin-preview-name").textContent = skin.filename.replace(/\.png$/i, "");
  document.getElementById("skin-apply-button").disabled = false;

  const src = convertFileSrc(skin.path);
  if (skinsPreviewViewer) {
    skinsPreviewViewer.loadSkin(src);
  }
}

function initSkinsPreviewViewer() {
  if (skinsPreviewViewer) return;
  const canvas = document.getElementById("skin-preview-canvas");
  skinsPreviewViewer = new skinview3d.SkinViewer({
    canvas,
    width: 200,
    height: 320,
    skin: "assets/steve_default.png",
  });
  skinsPreviewViewer.background = null;
  skinsPreviewViewer.controls.enableZoom = false;
  skinsPreviewViewer.controls.enablePan = false;
  skinsPreviewViewer.camera.position.set(0, 0, 60);
  skinsPreviewViewer.zoom = 0.9;
  skinsPreviewViewer.globalLight.intensity = 1.0;
  skinsPreviewViewer.cameraLight.intensity = 0.0;
  skinsPreviewViewer.autoRotate = true;
  skinsPreviewViewer.autoRotateSpeed = 1.0;
}

async function loadSkinsGrid() {
  const statusEl = document.getElementById("skins-status");
  const gridEl = document.getElementById("skins-grid");
  statusEl.textContent = "";
  gridEl.innerHTML = "";
  selectedSkinPath = null;
  document.getElementById("skin-apply-button").disabled = true;
  document.getElementById("skin-preview-name").textContent = "Select a skin";

  initSkinsPreviewViewer();

  let skinsList;
  try {
    skinsList = await invoke("list_custom_skins");
  } catch (err) {
    statusEl.textContent = err;
    return;
  }

  if (skinsList.length === 0) {
    statusEl.textContent = "No skins found in custom_skins yet.";
    return;
  }

  for (const skin of skinsList) {
    gridEl.appendChild(renderSkinCard(skin));
  }
}

document.getElementById("skin-fetch-button")?.addEventListener("click", async () => {
  const input = document.getElementById("skin-username-input");
  const statusEl = document.getElementById("skins-status");
  const btn = document.getElementById("skin-fetch-button");
  const username = input.value;

  btn.disabled = true;
  statusEl.textContent = "Fetching...";
  try {
    await invoke("fetch_skin_by_username", { username });
    input.value = "";
    statusEl.textContent = "";
    await loadSkinsGrid();
  } catch (err) {
    statusEl.textContent = err;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("skin-username-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("skin-fetch-button")?.click();
});

document.getElementById("skin-apply-button")?.addEventListener("click", async () => {
  if (!selectedSkinPath) return;
  const statusEl = document.getElementById("skins-status");
  try {
    await invoke("set_active_skin", { path: selectedSkinPath });
    statusEl.textContent = "Applied. Your Home page skin will update.";
    // Home page's active-skin display reads whichever file has the newest
    // mtime; refresh it now so switching back to Home shows it immediately.
    await loadActiveSkin();
  } catch (err) {
    statusEl.textContent = err;
  }
});


// --- Init ---------------------------------------------------------------

function refreshSettingsUI() {
  applyAppearance();
  renderClientSelector();
  syncSourceModeUI();
  renderColorSwatches();
  renderFontSelector();
  renderModelToggle();
  renderHeadBounceToggle();
  renderHeadBounceSliders();
  renderClientList();
  renderDirectory();
  renderAccountChip();
}

async function init() {
  try {
    settings = await invoke("get_settings");

    applyAppearance();
    initHeadRenderer();
    initBodyViewer();
    setActiveModelView(settings.model_view, { skipSave: true });

    initClientSelectorDropdown();
    refreshSettingsUI();

    await loadActiveSkin();

    startTrackingLoop();

    // Don't block startup on this — just kick it off in the background so
    // Latite/JoD stay current even if the user never opens Extensions.
    checkAllExtensionUpdates();

    const chooseBtn = document.getElementById("choose-skin-btn");
    if (chooseBtn) chooseBtn.addEventListener("click", () => showPage("skins"));

    const uploadBtn = document.getElementById("skin-upload-button");
    if (uploadBtn) uploadBtn.addEventListener("click", uploadSkinManually);

    // Same zero-size guard as showPage(): on first paint the stage may not
    // have its final layout size yet, so the initial renderer size (set
    // inside initHeadRenderer/initBodyViewer) can end up 0x0 and render
    // nothing. Force a resize once the frame has settled.
    requestAnimationFrame(() => {
      resizeHeadRenderer();
      resizeBodyViewer();
    });

    window.addEventListener("resize", () => {
      resizeHeadRenderer();
      resizeBodyViewer();
    });
  } catch (err) {
    console.error("init() failed:", err);
    const statusEl = document.getElementById("status-text");
    if (statusEl) statusEl.textContent = "Startup error: " + (err?.message || err);
  }
}

// Tauri serves local files through a custom protocol; a raw file path won't
// load directly in the webview the way a normal <img src> would.
function convertFileSrc(path) {
  return window.__TAURI__.core.convertFileSrc(path);
}

async function loadActiveSkin() {
  const skinPath = await invoke("find_active_skin_path");

  if (skinPath) {
    currentSkinSrc = convertFileSrc(skinPath);
  } else {
    // custom_skins folder missing/empty/undetected — fall back to Steve
    // and let the user pick a skin from the Skins tab instead of guessing.
    currentSkinSrc = "assets/steve_default.png";
  }

  if (bodyViewer) bodyViewer.loadSkin(currentSkinSrc);
  applySkinToHeadModel(currentSkinSrc);
}

async function uploadSkinManually() {
  const selected = await window.__TAURI__.dialog.open({
    multiple: false,
    filters: [{ name: "Minecraft Skin", extensions: ["png"] }],
  });
  if (!selected) return;

  const statusEl = document.getElementById("skins-status");
  try {
    await invoke("import_skin_file", { sourcePath: selected });
    if (statusEl) statusEl.textContent = "Skin imported.";
    await loadSkinsGrid();
  } catch (err) {
    console.error("import_skin_file failed:", err);
    if (statusEl) statusEl.textContent = "Import failed: " + (err?.message || err);
  }
}

// --- Appearance -----------------------------------------------------------

function applyAppearance() {
  const root = document.documentElement.style;
  root.setProperty("--accent", settings.accent_color);
  root.setProperty("--accent-soft", hexToRgba(settings.accent_color, 0.18));
  root.setProperty("--app-font", settings.font_family);
}

function hexToRgba(hex, alpha) {
  const clean = hex.replace("#", "");
  const bigint = parseInt(clean, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

async function saveAppearance() {
  settings = await invoke("update_appearance", {
    accentColor: settings.accent_color,
    fontFamily: settings.font_family,
    modelView: settings.model_view,
    headBounceEnabled: settings.head_bounce_enabled,
    headBounceSpeed: settings.head_bounce_speed,
    headBounceAmplitude: settings.head_bounce_amplitude,
  });
  applyAppearance();
}

function renderColorSwatches() {
  const row = document.getElementById("color-swatch-row");
  row.innerHTML = "";

  for (const color of ACCENT_PRESETS) {
    const swatch = document.createElement("button");
    swatch.className = "color-swatch";
    swatch.style.background = color;
    swatch.classList.toggle("active", settings.accent_color.toLowerCase() === color.toLowerCase());

    swatch.addEventListener("click", async () => {
      settings.accent_color = color;
      await saveAppearance();
      renderColorSwatches();
    });

    row.appendChild(swatch);
  }
}

function renderFontSelector() {
  const select = document.getElementById("font-selector");
  select.value = settings.font_family;

  select.addEventListener("change", async () => {
    settings.font_family = select.value;
    await saveAppearance();
  });
}

function renderModelToggle() {
  const buttons = document.querySelectorAll("#model-view-toggle .segmented-option");

  buttons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === settings.model_view);

    btn.addEventListener("click", async () => {
      if (btn.dataset.value === settings.model_view) return;

      buttons.forEach((b) => b.classList.toggle("active", b === btn));
      setActiveModelView(btn.dataset.value);
      await saveAppearance();
    });
  });
}

function renderHeadBounceToggle() {
  const toggle = document.getElementById("head-bounce-toggle");

  function syncUI() {
    const enabled = !!settings.head_bounce_enabled;
    toggle.classList.toggle("on", enabled);
    toggle.setAttribute("aria-checked", String(enabled));
  }

  syncUI();

  toggle.addEventListener("click", async () => {
    const nextEnabled = !settings.head_bounce_enabled;

    // Optimistic UI, revert on failure.
    settings.head_bounce_enabled = nextEnabled;
    syncUI();

    try {
      await saveAppearance();
    } catch (err) {
      settings.head_bounce_enabled = !nextEnabled;
      syncUI();
      console.error("saveAppearance (head bounce) failed:", err);
    }
  });
}

function renderHeadBounceSliders() {
  const speedInput = document.getElementById("head-bounce-speed");
  const speedValue = document.getElementById("head-bounce-speed-value");
  const ampInput = document.getElementById("head-bounce-amplitude");
  const ampValue = document.getElementById("head-bounce-amplitude-value");

  speedInput.min = MIN_BOUNCE_SPEED;
  speedInput.max = MAX_BOUNCE_SPEED;
  speedInput.step = 0.1;
  ampInput.min = MIN_BOUNCE_AMPLITUDE;
  ampInput.max = MAX_BOUNCE_AMPLITUDE;
  ampInput.step = 0.01;

  function syncUI() {
    speedInput.value = settings.head_bounce_speed;
    speedValue.textContent = `${settings.head_bounce_speed.toFixed(1)}x`;
    ampInput.value = settings.head_bounce_amplitude;
    ampValue.textContent = settings.head_bounce_amplitude.toFixed(2);
  }

  syncUI();

  // Live-update the visible bounce while dragging; only persist (and clamp
  // server-side) once the user releases the slider, to avoid spamming saves.
  speedInput.addEventListener("input", () => {
    settings.head_bounce_speed = parseFloat(speedInput.value);
    speedValue.textContent = `${settings.head_bounce_speed.toFixed(1)}x`;
  });
  speedInput.addEventListener("change", async () => {
    try {
      await saveAppearance();
    } catch (err) {
      console.error("saveAppearance (bounce speed) failed:", err);
    }
    syncUI();
  });

  ampInput.addEventListener("input", () => {
    settings.head_bounce_amplitude = parseFloat(ampInput.value);
    ampValue.textContent = settings.head_bounce_amplitude.toFixed(2);
  });
  ampInput.addEventListener("change", async () => {
    try {
      await saveAppearance();
    } catch (err) {
      console.error("saveAppearance (bounce amplitude) failed:", err);
    }
    syncUI();
  });
}

// Switches which viewer is mounted (head glTF vs. full-body skinview3d).
// Persisting the choice is handled by the caller via saveAppearance().
function setActiveModelView(view, { skipSave = false } = {}) {
  settings.model_view = view;
  void skipSave; // kept for call-site clarity; persistence happens in the caller

  const headCanvas = document.getElementById("head-canvas");
  const bodyCanvas = document.getElementById("body-canvas");

  if (view === "body") {
    headCanvas.style.display = "none";
    bodyCanvas.style.display = "block";
    resizeBodyViewer();
  } else {
    bodyCanvas.style.display = "none";
    headCanvas.style.display = "block";
    resizeHeadRenderer();
  }
}

// --- Home page: pointer tracking (shared by both viewers) -----------------

// Standard "back out" easing (Penner-style): overshoots past 1.0 before
// settling, giving the spin a springy, decisive finish instead of a linear
// or ease-out stop.
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function triggerHeadSpin() {
  if (spinActive) return; // ignore repeat clicks mid-spin
  spinActive = true;
  spinStartTime = performance.now();
  spawnSprinkles();
}

// Bursts a handful of emoji "sprinkles" from the model-stage center that
// pop out, drift, and fade — purely a DOM/CSS effect layered over the
// canvas, so it doesn't touch the three.js scene at all.
const SPRINKLE_EMOJI = ["✨", "🎉", "⭐"];
function spawnSprinkles() {
  const stage = document.querySelector(".model-stage");
  if (!stage) return;
  const count = 10;
  for (let i = 0; i < count; i++) {
    const el = document.createElement("span");
    el.className = "head-sprinkle";
    el.textContent = SPRINKLE_EMOJI[Math.floor(Math.random() * SPRINKLE_EMOJI.length)];
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    const dist = 70 + Math.random() * 90;
    el.style.setProperty("--sx", `${Math.cos(angle) * dist}px`);
    el.style.setProperty("--sy", `${Math.sin(angle) * dist - 20}px`);
    el.style.setProperty("--srot", `${(Math.random() - 0.5) * 240}deg`);
    el.style.animationDelay = `${Math.random() * 80}ms`;
    stage.appendChild(el);
    el.addEventListener("animationend", () => el.remove());
  }
}

function startTrackingLoop() {
  // Track relative to whichever model canvas is currently visible, but
  // listen on the whole window — the head/body should keep following the
  // mouse even when it's over the header, launch button, or other UI
  // outside the stage, not just directly above the canvas.
  const headCanvas = document.getElementById("head-canvas");
  const bodyCanvas = document.getElementById("body-canvas");

  function onPointerMove(e) {
    const stage = headCanvas.style.display !== "none" ? headCanvas : bodyCanvas;
    const rect = stage.getBoundingClientRect();
    const nx = Math.max(-1, Math.min(1, (e.clientX - rect.left - rect.width / 2) / (rect.width / 2)));
    const ny = Math.max(-1, Math.min(1, (e.clientY - rect.top - rect.height / 2) / (rect.height / 2)));

    targetYaw = nx * MAX_YAW;
    targetPitch = ny * MAX_PITCH;
  }

  window.addEventListener("pointermove", onPointerMove);

  // Freeze at the last tracked pose when the pointer leaves the stage,
  // rather than resetting to center.

  const bounceStart = performance.now();

  function tick() {
    // Exponential smoothing towards the pointer target — gives the head a
    // soft, slightly lagged follow instead of snapping straight to the cursor.
    currentYaw += (targetYaw - currentYaw) * TRACK_SMOOTHING;
    currentPitch += (targetPitch - currentPitch) * TRACK_SMOOTHING;

    // Click-to-spin: adds one extra full rotation on top of the resting
    // mouse-follow yaw, eased out with a back-out curve so it overshoots
    // slightly before settling back onto the resting angle.
    let spinOffset = 0;
    let spinRoll = 0;
    if (spinActive) {
      const elapsed = performance.now() - spinStartTime;
      const t = Math.min(1, elapsed / SPIN_DURATION_MS);
      const eased = easeOutBack(t);
      spinOffset = (1 - eased) * SPIN_TURNS * Math.PI * 2;
      // One full sine cycle of roll over the spin's duration: tilts one way,
      // back through center, tilts the other way, then settles flat — so
      // the head wobbles on the z-axis instead of spinning on a flat plane.
      spinRoll = Math.sin(t * Math.PI * 2) * SPIN_ROLL_MAX * (1 - t);

      if (t >= 1) spinActive = false;
    }

    const homeVisible = document.getElementById("page-home").classList.contains("active");

    // Gentle up/down bob, layered on top of whatever base position the
    // model already sits at — toggleable in Settings, off means the
    // offset just settles back to 0 rather than the loop stopping.
    const bounceOffset = settings && settings.head_bounce_enabled
      ? Math.sin((performance.now() - bounceStart) / 1000 * settings.head_bounce_speed) * settings.head_bounce_amplitude
      : 0;

    if (headModelRoot && homeVisible) {
      // Blockbench's exported front face points away from the camera by
      // default — add a 180° base offset so the face looks toward the
      // viewer, then layer the mouse-follow rotation and spin on top.
      headModelRoot.rotation.y = Math.PI + currentYaw + spinOffset;
      headModelRoot.rotation.x = currentPitch;
      headModelRoot.rotation.z = spinRoll;
      headModelRoot.position.y = bounceOffset;
      headRenderer.render(headScene, headCamera);
    }

    if (bodyViewer && homeVisible && document.getElementById("body-canvas").style.display !== "none") {
      bodyViewer.playerObject.rotation.y = currentYaw + spinOffset;
      bodyViewer.playerObject.rotation.z = spinRoll;
      bodyViewer.playerObject.position.y = bounceOffset;
    }

    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);

  headCanvas.addEventListener("click", triggerHeadSpin);
  bodyCanvas.addEventListener("click", triggerHeadSpin);
}

// --- Home page: head viewer (Three.js + glTF) ------------------------------

function initHeadRenderer() {
  const canvas = document.getElementById("head-canvas");

  headScene = new THREE.Scene();
  headCamera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  headCamera.position.set(0, 0, 8);

  headRenderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  if (!headRenderer.getContext()) {
    console.error("headRenderer: WebGL context creation failed");
  }
  headRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Fullbright: ambient-only lighting at full intensity so every face of the
  // model reads at its true texture color with no shading/shadow, regardless
  // of its orientation to a directional source.
  const ambient = new THREE.AmbientLight(0xffffff, 1.0);
  headScene.add(ambient);

  const loader = new GLTFLoader();
  loader.load(
    "assets/models/head.gltf",
    (gltf) => {
      headModelRoot = gltf.scene;
      headScene.add(headModelRoot);

      // Fullbright: MeshStandardMaterial (Blockbench's glTF default) is still
      // lit/PBR-shaded even under ambient-only light, so faces facing away
      // from nothing still darken at grazing angles. Swap to MeshBasicMaterial,
      // which ignores scene lighting entirely and always renders the texture
      // at its true color.
      //
      // BUG FIX: Head and Hat Layer are separate meshes with separate material
      // instances (not shared, despite what an earlier comment here assumed) —
      // assigning obj.material = new MeshBasicMaterial(...) per mesh guarantees
      // they're separate regardless. Only capturing the FIRST mesh's material
      // into a single headMaterial variable meant a skin swap only ever updated
      // the Head mesh's texture; the Hat Layer mesh kept its original/default
      // texture forever, which is why the visible skin never seemed to change.
      // Now every mesh's material is collected so a skin swap can update all
      // of them.
      headMaterials = [];
      headModelRoot.traverse((obj) => {
        if (obj.isMesh) {
          const prev = obj.material;
          obj.material = new THREE.MeshBasicMaterial({
            map: prev.map || null,
            transparent: prev.transparent,
            alphaTest: prev.alphaTest,
            side: prev.side,
          });
          headMaterials.push(obj.material);
        }
      });

      // Re-center the model on its own geometric center. The source gltf's
      // pivot isn't guaranteed to be at the mesh's visual center, which is
      // what made the head appear off-center in the stage.
      const box = new THREE.Box3().setFromObject(headModelRoot);
      const center = box.getCenter(new THREE.Vector3());
      headModelRoot.position.sub(center);

      // Fit the camera distance to the model's actual size instead of a
      // fixed z, since a hardcoded distance only looked right for the old
      // model's scale and made this smaller model render tiny.
      //
      // The old 1.15x margin only accounted for the model's static bounding
      // sphere — it didn't leave room for the head-bounce animation (moves
      // the model up to MAX_BOUNCE_AMPLITUDE along Y) or the mouse-follow
      // tilt (rotates up to MAX_YAW/MAX_PITCH, which swings corners of a
      // non-spherical mesh like the hat layer further from center than the
      // resting bounding sphere implies). motionMargin below already covers
      // the bounce distance, so the multiplier here only needs to be a thin
      // safety buffer on top of that (not a second full margin) — bringing
      // it down from 1.35 to 1.05 zooms the camera in noticeably closer,
      // making the head fill much more of the same canvas frame without
      // needing a taller window/stage (which was the wrong lever — see the
      // reverted 0b308eb window-height approach).
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      headModelRadius = sphere.radius;
      const motionMargin = sphere.radius + MAX_BOUNCE_AMPLITUDE; // worst-case distance from center during bounce
      const fitDistance = (motionMargin / Math.sin((headCamera.fov * Math.PI) / 360)) * 1.05;
      headCamera.position.set(0, 0, fitDistance);
      headCamera.near = fitDistance / 100;
      headCamera.far = fitDistance * 100;
      headCamera.updateProjectionMatrix();

      if (currentSkinSrc) applySkinToHeadModel(currentSkinSrc);
      resizeHeadRenderer();
      requestAnimationFrame(resizeHeadRenderer);
    },
    undefined,
    (err) => {
      console.error("Failed to load head model:", err);
      const statusEl = document.getElementById("status-text");
      if (statusEl) statusEl.textContent = "Head model failed to load: " + (err?.message || err);
    }
  );

  resizeHeadRenderer();
}

// Sizes and positions a model canvas as an explicit pixel square derived from
// the live .model-stage box, then returns the resulting rect. Bypassing
// CSS %/aspect-ratio here guarantees the box getBoundingClientRect() reports
// right after is exactly what was computed, so the Three.js/skinview3d camera
// aspect set from that rect can never disagree with what's actually rendered.
function sizeModelCanvas(canvas) {
  const stage = canvas.closest(".model-stage");
  if (!stage) return canvas.getBoundingClientRect();

  const stageRect = stage.getBoundingClientRect();
  // Blueberry Client (the design reference) sizes its own head-canvas as a
  // FIXED pixel square (481px, confirmed from their saved page's inline
  // canvas style) rather than a percentage of its stage — that's the actual
  // reason their head reads as consistently large regardless of the stage's
  // own proportions: it isn't fighting for a % share of variable space.
  // Match that: fixed target size, clamped down only if the stage is
  // smaller than that (so it still can't overflow on an unexpectedly small
  // window).
  const TARGET_HEAD_PX = 550;
  const side = Math.min(TARGET_HEAD_PX, stageRect.height * 1.0, stageRect.width * 1.0);

  canvas.style.width = `${side}px`;
  canvas.style.height = `${side}px`;
  canvas.style.left = `${stageRect.width / 2 - side / 2}px`;
  // Positioned low in the stage (close to "Choose Skin..."/launch card
  // below), within the safe bound for whichever of the two clamps above
  // ends up applying: half-height can't exceed stageRect.height - side/2.
  const maxTop = stageRect.height - side / 2 - 4; // 4px safety margin
  const desiredTop = stageRect.height * 0.68 - side / 2;
  canvas.style.top = `${Math.min(desiredTop, maxTop)}px`;

  return canvas.getBoundingClientRect();
}

function resizeHeadRenderer() {
  if (!headRenderer) return;

  const canvas = document.getElementById("head-canvas");
  const rect = sizeModelCanvas(canvas);
  if (rect.width === 0 || rect.height === 0) return;

  headRenderer.setSize(rect.width, rect.height, false);
  headCamera.aspect = rect.width / rect.height;
  headCamera.updateProjectionMatrix();

  if (headScene) headRenderer.render(headScene, headCamera);
}

function applySkinToHeadModel(skinSrc) {
  if (headMaterials.length === 0) return;

  new THREE.TextureLoader().load(skinSrc, (texture) => {
    texture.flipY = false;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.colorSpace = THREE.SRGBColorSpace;

    for (const material of headMaterials) {
      material.map = texture;
      material.needsUpdate = true;
    }
  });
}

// --- Home page: body viewer (skinview3d) -----------------------------------

function initBodyViewer() {
  const canvas = document.getElementById("body-canvas");

  bodyViewer = new skinview3d.SkinViewer({
    canvas,
    width: 300,
    height: 500,
    skin: "assets/steve_default.png",
  });

  bodyViewer.background = null;
  bodyViewer.controls.enableZoom = false;
  bodyViewer.controls.enableRotate = false;
  bodyViewer.controls.enablePan = false;
  bodyViewer.camera.position.set(0, 0, 60);
  // Zoomed in close, with just enough margin to cover the head-bounce
  // animation's Y offset — matches the head camera's approach (fill the
  // frame rather than relying on a bigger window/stage).
  bodyViewer.zoom = 0.95;

  // Fullbright: ambient-only, no camera point light means no shading/shadow
  // regardless of the player model's rotation.
  bodyViewer.globalLight.intensity = 1.0;
  bodyViewer.cameraLight.intensity = 0.0;

  resizeBodyViewer();
}

function resizeBodyViewer() {
  if (!bodyViewer) return;

  const canvas = document.getElementById("body-canvas");
  const rect = sizeModelCanvas(canvas);
  if (rect.width === 0 || rect.height === 0) return;

  bodyViewer.setSize(rect.width, rect.height);
}

// --- Home page: client selector (checklist dropdown, max 2) --------------

function renderClientSelector() {
  const menu = document.getElementById("client-selector-menu");
  const label = document.getElementById("client-selector-label");

  function updateLabel() {
    const names = settings.selected_client_names;
    label.textContent = names.length === 0 ? "Vanilla" : names.join(" + ");
  }

  function renderMenu() {
    menu.innerHTML = "";

    if (settings.clients.length === 0) {
      const hint = document.createElement("p");
      hint.className = "client-option-hint";
      hint.textContent = "No clients yet — add one in Settings.";
      menu.appendChild(hint);
      return;
    }

    const hint = document.createElement("p");
    hint.className = "client-option-hint";
    hint.textContent = `Select up to ${MAX_CLIENTS} to inject together.`;
    menu.appendChild(hint);

    for (const client of settings.clients) {
      const option = document.createElement("label");
      option.className = "client-option";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = settings.selected_client_names.includes(client.name);

      checkbox.addEventListener("change", async () => {
        let names = [...settings.selected_client_names];

        if (checkbox.checked) {
          if (names.length >= MAX_CLIENTS) {
            checkbox.checked = false;
            return;
          }
          names.push(client.name);
        } else {
          names = names.filter((n) => n !== client.name);
        }

        settings = await invoke("set_selected_clients", { names });
        updateLabel();
        renderMenu();
      });

      const text = document.createElement("span");
      text.textContent = client.name;

      option.appendChild(checkbox);
      option.appendChild(text);
      menu.appendChild(option);
    }
  }

  updateLabel();
  renderMenu();
}

// Dropdown open/close wiring — attached exactly once at startup rather than
// inside renderClientSelector(), which gets called again every time a
// client is added/removed. Re-attaching listeners on every render was
// stacking duplicate handlers that fought each other (one click could
// toggle "open" on then immediately back off), which is why the dropdown
// stopped responding after adding a client and only recovered on restart.
function initClientSelectorDropdown() {
  const menu = document.getElementById("client-selector-menu");
  const button = document.getElementById("client-selector-button");

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    if (button.disabled) return;
    menu.classList.toggle("open");
  });

  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && e.target !== button) {
      menu.classList.remove("open");
    }
  });
}

document.getElementById("launch-button").addEventListener("click", launchGame);
document.getElementById("launch-button-mini").addEventListener("click", launchGame);

// --- Client source mode (Release / Custom) ---------------------------

function syncSourceModeUI() {
  const isRelease = settings.client_source_mode === "release";
  document.getElementById("source-release-button").classList.toggle("active", isRelease);
  document.getElementById("source-custom-button").classList.toggle("active", !isRelease);
  const row = document.getElementById("client-select-row");
  row.classList.toggle("disabled", isRelease);
  document.getElementById("client-selector-button").disabled = isRelease;
  if (isRelease) {
    document.getElementById("client-selector-menu").classList.remove("open");
  }
}

async function setSourceMode(mode) {
  if (settings.client_source_mode === mode) return;
  try {
    settings = await invoke("set_client_source_mode", { mode });
  } catch (err) {
    console.error("set_client_source_mode failed:", err);
  }
  syncSourceModeUI();
}

document.getElementById("source-release-button").addEventListener("click", () => setSourceMode("release"));
document.getElementById("source-custom-button").addEventListener("click", () => setSourceMode("custom"));

async function launchGame() {
  const buttons = [document.getElementById("launch-button"), document.getElementById("launch-button-mini")];
  const status = document.getElementById("status-text");

  buttons.forEach((b) => (b.disabled = true));

  try {
    let dllPaths = [];
    let launchedLabel = "Launched.";

    if (settings.client_source_mode === "release") {
      // Download-on-demand: no-ops if the local build is already current.
      status.textContent = "Checking for latest client...";
      const releasePath = await invoke("fetch_latest_latite", { launcherDirectory: settings.launcher_directory });
      dllPaths.push(releasePath);
      launchedLabel = "Launched with Release.";
    } else {
      dllPaths = settings.selected_client_names
        .map((name) => settings.clients.find((c) => c.name === name))
        .filter(Boolean)
        .map((c) => c.dll_path);
      launchedLabel = dllPaths.length > 0
        ? `Launched with ${settings.selected_client_names.join(" + ")}.`
        : "Launched.";
    }

    if (settings.jod_extension_enabled) {
      const jodPath = await invoke("get_jod_dll_path", { launcherDirectory: settings.launcher_directory });
      if (jodPath) dllPaths.push(jodPath);
    }

    status.textContent = "Launching...";
    await invoke("launch_minecraft", { clientDllPaths: dllPaths });

    status.textContent = launchedLabel;
  } catch (err) {
    status.textContent = `Failed: ${err}`;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

// --- Settings page: clients list ------------------------------------------

function renderClientList() {
  const list = document.getElementById("client-list");
  list.innerHTML = "";

  if (settings.clients.length === 0) {
    const empty = document.createElement("p");
    empty.className = "status-text";
    empty.textContent = "No clients added yet.";
    list.appendChild(empty);
    return;
  }

  for (const client of settings.clients) {
    const row = document.createElement("div");
    row.className = "client-row";

    const info = document.createElement("div");
    info.className = "client-info";

    const name = document.createElement("div");
    name.className = "client-name";
    name.textContent = client.name;

    const path = document.createElement("div");
    path.className = "client-path";
    path.textContent = client.dll_path;

    info.appendChild(name);
    info.appendChild(path);

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-secondary";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", async () => {
      settings = await invoke("remove_client", { name: client.name });
      renderClientList();
      renderClientSelector();
    });

    row.appendChild(info);
    row.appendChild(removeBtn);
    list.appendChild(row);
  }
}

document.getElementById("add-client-button").addEventListener("click", async () => {
  const selected = await openDialog({
    multiple: false,
    filters: [{ name: "Client DLL", extensions: ["dll"] }],
  });

  if (!selected) return;

  const path = Array.isArray(selected) ? selected[0] : selected;
  const name = path.split(/[\\/]/).pop().replace(/\.dll$/i, "");

  settings = await invoke("add_client", { name, dllPath: path });
  renderClientList();
  renderClientSelector();
});

// --- Settings page: directory ---------------------------------------------

function renderDirectory() {
  document.getElementById("directory-text").value = settings.launcher_directory;
  document.getElementById("directory-status").textContent = "";
}

document.getElementById("open-folder-button").addEventListener("click", async () => {
  await invoke("open_directory", { path: settings.launcher_directory }).catch(() => {});
});

document.getElementById("change-folder-button").addEventListener("click", async () => {
  const selected = await openDialog({ directory: true, multiple: false });
  if (!selected) return;

  const path = Array.isArray(selected) ? selected[0] : selected;
  settings = await invoke("set_launcher_directory", { directory: path });
  renderDirectory();
  document.getElementById("directory-status").textContent = "Directory updated.";
});

// --- Danger zone: delete all launcher data ---------------------------------

{
  const deleteButton = document.getElementById("delete-all-data-button");
  const overlay = document.getElementById("delete-data-confirm-overlay");
  const cancelButton = document.getElementById("delete-data-cancel-button");
  const confirmButton = document.getElementById("delete-data-confirm-button");

  deleteButton.addEventListener("click", () => overlay.classList.remove("hidden"));
  cancelButton.addEventListener("click", () => overlay.classList.add("hidden"));
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.add("hidden");
  });

  confirmButton.addEventListener("click", async () => {
    confirmButton.disabled = true;
    confirmButton.textContent = "Deleting...";
    try {
      settings = await invoke("delete_all_launcher_data");
      refreshSettingsUI();
      document.getElementById("directory-status").textContent = "All launcher data deleted.";
    } catch (err) {
      console.error("delete_all_launcher_data failed:", err);
      document.getElementById("directory-status").textContent = "Failed to delete: " + (err?.message || err);
    } finally {
      confirmButton.disabled = false;
      confirmButton.textContent = "Delete everything";
      overlay.classList.add("hidden");
    }
  });
}

// --- Discord account chip -------------------------------------------------

function renderAccountChip() {
  const chip = document.getElementById("discord-account-chip");
  const nameEl = document.getElementById("discord-account-name");
  const avatarEl = document.getElementById("discord-avatar-fallback");
  const menu = document.getElementById("discord-account-menu");
  const signOutItem = document.getElementById("discord-signout-button");
  const overlay = document.getElementById("signout-confirm-overlay");
  const confirmBody = document.getElementById("signout-confirm-body");
  const confirmCancel = document.getElementById("signout-cancel-button");
  const confirmSignOut = document.getElementById("signout-confirm-button");
  const fallbackSvg = avatarEl.innerHTML;

  function closeMenu() {
    menu.classList.remove("open");
  }

  function closeConfirm() {
    overlay.classList.add("hidden");
  }

  function syncUI() {
    const account = settings.discord_account;

    if (account) {
      chip.classList.add("signed-in");
      chip.title = "Discord account";
      nameEl.textContent = account.global_name || account.username;

      if (account.avatar_url) {
        avatarEl.innerHTML = "";
        const img = document.createElement("img");
        img.src = account.avatar_url;
        img.alt = "";
        avatarEl.appendChild(img);
      } else {
        avatarEl.innerHTML = fallbackSvg;
      }
    } else {
      chip.classList.remove("signed-in");
      chip.title = "Sign in with Discord";
      nameEl.textContent = "Sign in";
      avatarEl.innerHTML = fallbackSvg;
      closeMenu();
    }
  }

  syncUI();

  chip.addEventListener("click", async (e) => {
    if (chip.disabled) return;

    // Already signed in: this click just opens/closes the dropdown —
    // signing out requires picking "Sign out" from the menu, then
    // confirming, so a stray click never logs the user out by accident.
    if (settings.discord_account) {
      e.stopPropagation();
      menu.classList.toggle("open");
      return;
    }

    chip.disabled = true;
    nameEl.textContent = "Signing in...";
    try {
      settings = await invoke("discord_login");
    } catch (err) {
      console.error("discord_login failed:", err);
    } finally {
      chip.disabled = false;
      syncUI();
    }
  });

  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && e.target !== chip) {
      closeMenu();
    }
  });

  signOutItem.addEventListener("click", () => {
    closeMenu();
    const account = settings.discord_account;
    const label = account ? (account.global_name || account.username) : "your account";
    confirmBody.textContent = `You'll be signed out of ${label} on this launcher.`;
    overlay.classList.remove("hidden");
  });

  confirmCancel.addEventListener("click", closeConfirm);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeConfirm();
  });

  confirmSignOut.addEventListener("click", async () => {
    confirmSignOut.disabled = true;
    try {
      settings = await invoke("discord_logout");
      syncUI();
    } catch (err) {
      console.error("discord_logout failed:", err);
    } finally {
      confirmSignOut.disabled = false;
      closeConfirm();
    }
  });
}

init();
