import * as THREE from "three";
import { loadWorld } from "./data";
import { Cards } from "./cards";
import { Residency } from "./residency";
import { buildFixtures, buildShell } from "./fixtures";
import { TileSource } from "./tiles";
import { Player, isTouchDevice } from "./player";
import { Cart } from "./cart";
import { Interactions } from "./interact";
import { VRMode } from "./vr";
import { loadProductAtlas, probeMaxTextureSize } from "./atlas";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const overlay = document.getElementById("overlay")!;
const statusEl = document.getElementById("overlay-status")!;
const barEl = document.getElementById("overlay-bar")!;
const enterBtn = document.getElementById("enter-btn") as HTMLButtonElement;
const helpEl = document.getElementById("overlay-help")!;
if (isTouchDevice) document.body.classList.add("touch");

async function init() {
  const world = await loadWorld((m) => (statusEl.textContent = m));
  statusEl.textContent = "Laster vareveggene…";
  let loaded = 0;
  // phones keep the combined atlas at half resolution (memory); near products stream sharp tiles anyway
  const atlas = await loadProductAtlas(
    world.atlasIndex.atlasCount,
    world.atlasIndex.format,
    isTouchDevice ? 4096 : probeMaxTextureSize(),
    () => {
      loaded++;
      barEl.style.width = `${(loaded / world.atlasIndex.atlasCount) * 100}%`;
    }
  );

  // phones: no MSAA and a lower pixel-ratio cap keep GPU memory inside mobile budgets
  const renderer = new THREE.WebGLRenderer({ antialias: !isTouchDevice, powerPreference: "high-performance" });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, isTouchDevice ? 1.5 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  document.getElementById("app")!.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x191b20);
  const W = world.layout.hall.w;
  scene.fog = new THREE.Fog(0x191b20, 24, Math.max(60, W * 1.2));

  statusEl.textContent = "Bygger butikken…";
  const fixtures = buildFixtures(world.layout);
  scene.add(buildShell(world.layout));
  scene.add(fixtures.group);

  // Quest and phones get the smaller detail cache + radius (ADR-0002)
  const isQuest = /OculusBrowser|Quest/i.test(navigator.userAgent);
  const small = isQuest || isTouchDevice;
  const detailSize = small ? 2048 : 4096;
  const detailRadius = small ? 3 : 7;

  // Quest and phones: fewer copies per slot and shorter detail distances (vertex budget)
  const cards = new Cards(
    world,
    atlas,
    detailSize,
    small
      ? { maxFacings: 2, maxRows: 2, nearRadius: 2.5, farRadius: 9 }
      : { maxFacings: 4, maxRows: 3, nearRadius: 7, farRadius: 22 }
  );
  // studio-like reflections for products only (fixtures keep the plain hall lighting)
  const pmrem = new THREE.PMREMGenerator(renderer);
  cards.material.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  cards.material.envMapIntensity = 0.6;
  pmrem.dispose();
  for (const m of cards.meshes) scene.add(m);

  const player = new Player(renderer.domElement, world.layout, fixtures);
  scene.add(player.rig);

  const tiles = new TileSource(world.atlasIndex);
  const residency = new Residency(renderer, cards, tiles, detailRadius, (detailSize / 256) ** 2);
  const cart = new Cart(world.catalog, tiles);
  cart.init();
  const interact = new Interactions(world, cards, cart, player, tiles);
  const vr = new VRMode(renderer, scene, world, cards, cart, player, tiles);

  statusEl.textContent = `${world.catalog.products.length} varer i hyllene`;
  enterBtn.classList.remove("hidden");
  helpEl.classList.remove("hidden");

  enterBtn.addEventListener("click", () => player.requestLock());
  const resumeBtn = document.getElementById("cart-resume") as HTMLButtonElement;
  resumeBtn.addEventListener("click", () => {
    // Chrome enforces ~1.3s cooldown on relock after Esc — retry with disabled state
    resumeBtn.disabled = true;
    player.requestLock();
    setTimeout(() => (resumeBtn.disabled = false), 1500);
  });
  document.getElementById("touch-menu")!.addEventListener("click", () => player.exit());
  player.onActiveChange = (active) => {
    overlay.classList.toggle("hidden", active);
    if (!active) interact.reset(); // cart-mode transition resets panel + dwell (ADR-0003)
  };
  renderer.xr.addEventListener("sessionstart", () => overlay.classList.add("hidden"));
  renderer.xr.addEventListener("sessionend", () => overlay.classList.remove("hidden"));

  window.addEventListener("resize", () => {
    player.onResize();
    renderer.setSize(innerWidth, innerHeight);
  });

  // dev/debug hook: lets tooling force a render and read pixels or stats
  (window as any).__store = {
    renderer,
    scene,
    player,
    cards,
    vr,
    shot(width = 900) {
      renderer.render(scene, player.camera);
      const src = renderer.domElement;
      const c = document.createElement("canvas");
      c.width = width;
      c.height = Math.round((src.height / src.width) * width);
      c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.85);
    },
    stats() {
      return { drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, products: cards.stats() };
    },
  };

  const clock = new THREE.Clock();
  const camWorld = new THREE.Vector3();
  let firstFrames = 0;
  const frame = (dt: number) => {
    try {
      const inXR = renderer.xr.isPresenting;
      player.update(dt);
      if (inXR) vr.update(dt);
      interact.update(dt, player.locked && !inXR);
      player.camera.getWorldPosition(camWorld);
      cards.update(camWorld);
      residency.update(dt, camWorld);
      if (firstFrames++ === 90) residency.burst = false; // cold-fill burst window over
      renderer.render(scene, player.camera);
    } catch (err) {
      (window as any).__err = String((err as Error)?.stack ?? err);
      throw err;
    }
  };
  (window as any).__store.tick = (dt = 1 / 60) => frame(dt);
  renderer.setAnimationLoop(() => frame(Math.min(clock.getDelta(), 0.05)));
}

init().catch((err) => {
  statusEl.textContent = `Kunne ikke laste: ${err?.message ?? err}`;
  console.error(err);
});
