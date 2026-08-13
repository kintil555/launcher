import * as THREE from "three";
import { GLTFLoader } from "./assets/vendor/three/loaders/GLTFLoader.js";

const { invoke } = window.__TAURI__.core;
const { open: openDialog } = window.__TAURI__.dialog;
const { getCurrentWindow } = window.__TAURI__.window;

const MAX_YAW = 0.55;   // radians, ~31.5deg either side
const MAX_PITCH = 0.35; // radians, ~20deg either side
const TRACK_SMOOTHING = 0.12; // lerp factor per animation frame (lower = smoother/slower)
const MAX_CLIENTS = 2;

const ACCENT_PRESETS = ["#8B5CF6", "#22C55E", "#3B82F6", "#F97316", "#EC4899", "#EAB308"];

let settings = null;

// Body-mode viewer (skinview3d)
let bodyViewer = null;

// Head-mode viewer (Three.js + glTF)
let headScene = null;
let headCamera = null;
let headRenderer = null;
let headModelRoot = null;
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

  if (pageName === "modules") {
    loadModulesList();
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
    renderColorSwatches();
    renderFontSelector();
    renderModelToggle();
    renderClientList();
    renderDirectory();

    await loadActiveSkin();

    startTrackingLoop();

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

  function tick() {
    // Exponential smoothing towards the pointer target — gives the head a
    // soft, slightly lagged follow instead of snapping straight to the cursor.
    currentYaw += (targetYaw - currentYaw) * TRACK_SMOOTHING;
    currentPitch += (targetPitch - currentPitch) * TRACK_SMOOTHING;

    const homeVisible = document.getElementById("page-home").classList.contains("active");

    if (headModelRoot && homeVisible) {
      // Blockbench's exported front face points away from the camera by
      // default — add a 180° base offset so the face looks toward the
      // viewer, then layer the mouse-follow rotation on top.
      headModelRoot.rotation.y = Math.PI + currentYaw;
      headModelRoot.rotation.x = currentPitch;
      headRenderer.render(headScene, headCamera);
    }

    if (bodyViewer && homeVisible && document.getElementById("body-canvas").style.display !== "none") {
      bodyViewer.playerObject.rotation.y = currentYaw;
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

  const ambient = new THREE.AmbientLight(0xffffff, 0.9);
  const directional = new THREE.DirectionalLight(0xffffff, 0.6);
  directional.position.set(2, 3, 4);
  headScene.add(ambient, directional);

  const loader = new GLTFLoader();
  loader.load(
    "assets/models/head.gltf",
    (gltf) => {
      headModelRoot = gltf.scene;
      headScene.add(headModelRoot);

      // Grab the material off the first mesh so a skin swap can update its
      // texture later (both the Head and Hat Layer meshes share one material).
      headModelRoot.traverse((obj) => {
        if (obj.isMesh && !headMaterial) {
          headMaterial = obj.material;
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
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const fitDistance = (sphere.radius / Math.sin((headCamera.fov * Math.PI) / 360)) * 1.15;
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

function resizeHeadRenderer() {
  if (!headRenderer) return;

  const canvas = document.getElementById("head-canvas");
  const rect = canvas.getBoundingClientRect();
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
  bodyViewer.zoom = 0.9;

  resizeBodyViewer();
}

function resizeBodyViewer() {
  if (!bodyViewer) return;

  const canvas = document.getElementById("body-canvas");
  const rect = canvas.getBoundingClientRect();
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

async function launchGame() {
  const buttons = [document.getElementById("launch-button"), document.getElementById("launch-button-mini")];
  const status = document.getElementById("status-text");

  buttons.forEach((b) => (b.disabled = true));
  status.textContent = "Launching...";

  try {
    const dllPaths = settings.selected_client_names
      .map((name) => settings.clients.find((c) => c.name === name))
      .filter(Boolean)
      .map((c) => c.dll_path);

    await invoke("launch_minecraft", { clientDllPaths: dllPaths });

    status.textContent = dllPaths.length > 0
      ? `Launched with ${settings.selected_client_names.join(" + ")}.`
      : "Launched.";
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
