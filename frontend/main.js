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
let headMaterial = null;

// Shared pointer-tracking state, smoothed every animation frame regardless
// of which viewer is active.
let targetYaw = 0;
let targetPitch = 0;
let currentYaw = 0;
let currentPitch = 0;

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
  if (pageName === "extensions") {
    syncJodToggleUI();
    checkAllExtensionUpdates();
  }

  // The canvas has zero size while its page is hidden (display: none), so any
  // renderer sized during that time ends up 0x0. Resize once the page is visible.
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

async function loadModulesList() {
  const statusEl = document.getElementById("modules-status");
  const listEl = document.getElementById("modules-list");

  statusEl.textContent = "";
  listEl.innerHTML = "";

  let modules;
  try {
    modules = await invoke("list_modules");
  } catch (err) {
    statusEl.textContent = err;
    return;
  }

  if (modules.length === 0) {
    statusEl.textContent = "No modules found in the config yet.";
    return;
  }

  for (const mod of modules) {
    const row = document.createElement("div");
    row.className = "module-row";

    const label = document.createElement("span");
    label.className = "module-name";
    label.textContent = mod.name;

    const toggle = document.createElement("button");
    toggle.className = "module-toggle" + (mod.enabled ? " on" : "");
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(mod.enabled));

    toggle.addEventListener("click", async () => {
      const nextEnabled = !toggle.classList.contains("on");
      // Optimistic UI update; revert if the write fails so the toggle
      // never shows a state the file doesn't actually have.
      toggle.classList.toggle("on", nextEnabled);
      toggle.setAttribute("aria-checked", String(nextEnabled));
      try {
        await invoke("set_module_enabled", { moduleName: mod.name, enabled: nextEnabled });
      } catch (err) {
        toggle.classList.toggle("on", !nextEnabled);
        toggle.setAttribute("aria-checked", String(!nextEnabled));
        statusEl.textContent = err;
      }
    });

    row.appendChild(label);
    row.appendChild(toggle);
    listEl.appendChild(row);
  }
}


// --- Init ---------------------------------------------------------------

async function init() {
  try {
    settings = await invoke("get_settings");

    applyAppearance();
    initHeadRenderer();
    initBodyViewer();
    setActiveModelView(settings.model_view, { skipSave: true });

    renderClientSelector();
    syncSourceModeUI();
    renderColorSwatches();
    renderFontSelector();
    renderModelToggle();
    renderHeadBounceToggle();
    renderHeadBounceSliders();
    renderClientList();
    renderDirectory();

    await loadActiveSkin();

    startTrackingLoop();

    // Don't block startup on this — just kick it off in the background so
    // Latite/JoD stay current even if the user never opens Extensions.
    checkAllExtensionUpdates();

    const chooseBtn = document.getElementById("choose-skin-btn");
    if (chooseBtn) chooseBtn.addEventListener("click", chooseSkinManually);

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
  const chooseBtn = document.getElementById("choose-skin-btn");

  if (skinPath) {
    currentSkinSrc = convertFileSrc(skinPath);
    if (chooseBtn) chooseBtn.style.display = "none";
  } else {
    // custom_skins folder missing/empty/undetected — fall back to Steve
    // and let the user manually pick a skin file instead of guessing.
    currentSkinSrc = "assets/steve_default.png";
    if (chooseBtn) chooseBtn.style.display = "block";
  }

  if (bodyViewer) bodyViewer.loadSkin(currentSkinSrc);
  applySkinToHeadModel(currentSkinSrc);
}

async function chooseSkinManually() {
  const selected = await window.__TAURI__.dialog.open({
    multiple: false,
    filters: [{ name: "Minecraft Skin", extensions: ["png"] }],
  });
  if (!selected) return;

  currentSkinSrc = convertFileSrc(selected);
  if (bodyViewer) bodyViewer.loadSkin(currentSkinSrc);
  applySkinToHeadModel(currentSkinSrc);

  const chooseBtn = document.getElementById("choose-skin-btn");
  if (chooseBtn) chooseBtn.style.display = "none";
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
      // viewer, then layer the mouse-follow rotation on top.
      headModelRoot.rotation.y = Math.PI + currentYaw;
      headModelRoot.rotation.x = currentPitch;
      headModelRoot.position.y = bounceOffset;
      headRenderer.render(headScene, headCamera);
    }

    if (bodyViewer && homeVisible && document.getElementById("body-canvas").style.display !== "none") {
      bodyViewer.playerObject.rotation.y = currentYaw;
      bodyViewer.playerObject.position.y = bounceOffset;
    }

    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
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
      // at its true color. Grab the resulting material off the first mesh so
      // a skin swap can update its texture later (Head + Hat Layer share one).
      headModelRoot.traverse((obj) => {
        if (obj.isMesh) {
          const prev = obj.material;
          obj.material = new THREE.MeshBasicMaterial({
            map: prev.map || null,
            transparent: prev.transparent,
            alphaTest: prev.alphaTest,
            side: prev.side,
          });
          if (!headMaterial) headMaterial = obj.material;
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
      // resting bounding sphere implies). That's the actual root cause of
      // clipping that kept reappearing regardless of the CSS canvas box:
      // the camera framing itself was too tight for the model in motion,
      // not the canvas position/size on the page.
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      headModelRadius = sphere.radius;
      const motionMargin = sphere.radius + MAX_BOUNCE_AMPLITUDE; // worst-case distance from center during bounce
      const fitDistance = (motionMargin / Math.sin((headCamera.fov * Math.PI) / 360)) * 1.35;
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
  // Square sized off the stage's shorter/constraining axis (its height, since
  // the stage is always much wider than tall), capped so it can never exceed
  // the stage's width either.
  // Camera framing now has proper margin for the bounce/tilt animation (see
  // initHeadRenderer's fitDistance fix), so the actual root cause of
  // clipping is fixed — this CSS box no longer needs to be kept artificially
  // small to avoid it.
  const side = Math.min(stageRect.height * 1.0, stageRect.width * 1.0);

  canvas.style.width = `${side}px`;
  canvas.style.height = `${side}px`;
  canvas.style.left = `${stageRect.width / 2 - side / 2}px`;
  // At 100% size, half-height = 50% of stage, so top must be exact center
  // (50%) to avoid clipping the CSS box itself top or bottom.
  canvas.style.top = `${stageRect.height * 0.5 - side / 2}px`;

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
  if (!headMaterial) return;

  new THREE.TextureLoader().load(skinSrc, (texture) => {
    texture.flipY = false;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.colorSpace = THREE.SRGBColorSpace;

    headMaterial.map = texture;
    headMaterial.needsUpdate = true;
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
  // Zoomed out slightly further than a tight fit to leave headroom for the
  // head-bounce animation (moves the model along Y up to MAX_BOUNCE_AMPLITUDE)
  // — same clipping-during-motion issue fixed on the head camera above.
  bodyViewer.zoom = 0.82;

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
  const button = document.getElementById("client-selector-button");

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

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("open");
  });

  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && e.target !== button) {
      menu.classList.remove("open");
    }
  });

  updateLabel();
  renderMenu();
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

init();
