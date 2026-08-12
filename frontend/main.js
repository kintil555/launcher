const { invoke } = window.__TAURI__.core;
const { open: openDialog } = window.__TAURI__.dialog;

const VANILLA_OPTION = "__vanilla__";
const MAX_YAW = 0.55;   // radians, ~31.5deg either side
const MAX_PITCH = 0.35; // radians, ~20deg either side

let settings = null;
let skinViewer = null;

// --- Navigation -------------------------------------------------------

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));

    btn.classList.add("active");
    document.getElementById(`page-${btn.dataset.page}`).classList.add("active");

    if (btn.dataset.page === "clients") renderClientList();
    if (btn.dataset.page === "directory") renderDirectory();
  });
});

// --- Init ---------------------------------------------------------------

async function init() {
  settings = await invoke("get_settings");

  initHeadViewer();
  renderClientSelector();
  renderDirectory();

  const skinPath = await invoke("find_active_skin_path");
  if (skinPath) {
    skinViewer.loadSkin(convertFileSrc(skinPath));
  }
}

// Tauri serves local files through a custom protocol; a raw file path won't
// load directly in the webview the way a normal <img src> would.
function convertFileSrc(path) {
  return window.__TAURI__.core.convertFileSrc(path);
}

// --- Home page: head viewer ---------------------------------------------

function initHeadViewer() {
  const canvas = document.getElementById("head-canvas");
  const stage = document.querySelector(".head-stage");

  skinViewer = new skinview3d.SkinViewer({
    canvas,
    width: 200,
    height: 200,
    skin: "assets/steve_default.png",
  });

  skinViewer.background = null;
  skinViewer.controls.enableZoom = false;
  skinViewer.controls.enableRotate = false;
  skinViewer.controls.enablePan = false;

  // Crop the view to just the head.
  skinViewer.camera.position.set(0, 20, 40);
  skinViewer.zoom = 2.2;

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

// --- Home page: client selector + launch ---------------------------------

function renderClientSelector() {
  const select = document.getElementById("client-selector");
  select.innerHTML = "";

  const vanillaOpt = document.createElement("option");
  vanillaOpt.value = VANILLA_OPTION;
  vanillaOpt.textContent = "Vanilla (no client)";
  select.appendChild(vanillaOpt);

  for (const client of settings.clients) {
    const opt = document.createElement("option");
    opt.value = client.name;
    opt.textContent = client.name;
    select.appendChild(opt);
  }

  select.value = settings.selected_client_name ?? VANILLA_OPTION;

  select.addEventListener("change", async () => {
    const value = select.value === VANILLA_OPTION ? null : select.value;
    settings = await invoke("set_selected_client", { name: value });
  });
}

document.getElementById("launch-button").addEventListener("click", async () => {
  const button = document.getElementById("launch-button");
  const status = document.getElementById("status-text");

  button.disabled = true;
  status.textContent = "Launching...";

  try {
    const selectedName = settings.selected_client_name;
    const client = selectedName ? settings.clients.find((c) => c.name === selectedName) : null;

    await invoke("launch_minecraft", { clientDllPath: client ? client.dll_path : null });

    status.textContent = client ? `Launched with ${client.name}.` : "Launched.";
  } catch (err) {
    status.textContent = `Failed: ${err}`;
  } finally {
    button.disabled = false;
  }
});

// --- Clients page ---------------------------------------------------------

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

// --- Directory page ---------------------------------------------------------

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
