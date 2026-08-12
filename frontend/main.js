const { invoke } = window.__TAURI__.core;
const { open: openDialog } = window.__TAURI__.dialog;
const { getCurrentWindow } = window.__TAURI__.window;

const VANILLA_OPTION = "__vanilla__";
const MAX_YAW = 0.55;   // radians, ~31.5deg either side
const MAX_PITCH = 0.35; // radians, ~20deg either side
const MAX_CLIENTS = 2;

const ACCENT_PRESETS = ["#8B5CF6", "#22C55E", "#3B82F6", "#F97316", "#EC4899", "#EAB308"];

let settings = null;
let skinViewer = null;
let currentSkinSrc = null;

// --- Window chrome (custom titlebar) -------------------------------------

const appWindow = getCurrentWindow();

document.getElementById("minimize-button").addEventListener("click", () => appWindow.minimize());
document.getElementById("close-button").addEventListener("click", () => appWindow.close());

// --- Navigation -------------------------------------------------------

function showPage(pageName) {
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  document.getElementById(`page-${pageName}`).classList.remove("active"); // no-op safety
  document.getElementById(`page-${pageName}`).classList.add("active");

  document.getElementById("home-nav-button").classList.toggle("active", pageName === "home");
  document.getElementById("settings-nav-button").classList.toggle("active", pageName === "settings");
}

document.getElementById("home-nav-button").addEventListener("click", () => showPage("home"));
document.getElementById("settings-nav-button").addEventListener("click", () => showPage("settings"));

// --- Init ---------------------------------------------------------------

async function init() {
  settings = await invoke("get_settings");

  applyAppearance();
  initHeadViewer();
  renderClientSelector();
  renderColorSwatches();
  renderFontSelector();
  renderModelToggle();
  renderClientList();
  renderDirectory();

  await loadActiveSkin();
}

// Tauri serves local files through a custom protocol; a raw file path won't
// load directly in the webview the way a normal <img src> would.
function convertFileSrc(path) {
  return window.__TAURI__.core.convertFileSrc(path);
}

async function loadActiveSkin() {
  const skinPath = await invoke("find_active_skin_path");
  currentSkinSrc = skinPath ? convertFileSrc(skinPath) : "assets/steve_default.png";
  skinViewer.loadSkin(currentSkinSrc);
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

      settings.model_view = btn.dataset.value;
      buttons.forEach((b) => b.classList.toggle("active", b === btn));

      await saveAppearance();
      updateModelViewMode();
    });
  });
}

// --- Home page: model viewer ---------------------------------------------

function initHeadViewer() {
  const canvas = document.getElementById("head-canvas");

  skinViewer = new skinview3d.SkinViewer({
    canvas,
    width: 220,
    height: 220,
    skin: "assets/steve_default.png",
  });

  skinViewer.background = null;
  skinViewer.controls.enableZoom = false;
  skinViewer.controls.enableRotate = false;
  skinViewer.controls.enablePan = false;

  updateModelViewMode();

  const stage = document.querySelector(".model-stage");

  stage.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const nx = Math.max(-1, Math.min(1, (e.clientX - rect.left - rect.width / 2) / (rect.width / 2)));
    const ny = Math.max(-1, Math.min(1, (e.clientY - rect.top - rect.height / 2) / (rect.height / 2)));

    skinViewer.playerObject.rotation.y = nx * MAX_YAW;
    skinViewer.playerObject.rotation.x = -ny * MAX_PITCH;
  });

  stage.addEventListener("pointerleave", () => {
    skinViewer.playerObject.rotation.y = 0;
    skinViewer.playerObject.rotation.x = 0;
  });
}

// Switches between a cropped head-only view and a full-body view.
function updateModelViewMode() {
  const canvas = document.getElementById("head-canvas");

  if (settings.model_view === "body") {
    canvas.classList.add("body-view");
    skinViewer.setSize(200, 380);
    skinViewer.camera.position.set(0, 0, 60);
    skinViewer.zoom = 0.9;
  } else {
    canvas.classList.remove("body-view");
    skinViewer.setSize(220, 220);
    skinViewer.camera.position.set(0, 20, 40);
    skinViewer.zoom = 2.2;
  }
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
