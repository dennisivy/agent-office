import * as THREE from 'three';
import { mesh, roundedBox, textPlane, toon } from '../../world/toon';
import type { Collider, Interactable } from '../../world/types';
import type { Fixture } from '../../world/office/fixture';
import { chair } from '../../world/office/seats';
import { deskMug } from '../../world/office';

// The trading desk: a dark desk with four monitors in a shallow arc round its chair and a scrolling
// price ticker over them, out on the open floor south of the desk pods, its screens facing back
// into the room. Walk up and press E to take the screens over (see desk.ts).

/** Where it stands, and which way its chair faces (PI: south, towards the windows). */
export const TRADING_DESK = { x: -0.9, z: 8.85, rotY: Math.PI, width: 3.6, depth: 1, height: 0.76 } as const;
/** The monitors: how many, each screen's size, and the arc they stand on round where you sit. */
export const MONITORS = { count: 4, width: 0.84, height: 0.4725, radius: 1.95, spread: 0.47, y: 1.18, eye: 1.45 } as const;
/** The pixels each monitor's picture is drawn at. */
export const SCREEN_PX = { w: 1024, h: 576 } as const;

export interface TradingDeskModel {
  group: THREE.Group;
  /** The monitors' screens, left to right as you sit. */
  screens: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[];
  /** What each screen's picture is drawn on. */
  canvases: HTMLCanvasElement[];
  textures: THREE.CanvasTexture[];
  /** The ticker's strip of prices, and the texture that scrolls it. */
  ticker: { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture };
  interactable: Interactable;
  colliders: Collider[];
  /** Where the middle of the desk is in the world, to tell how far you are from it. */
  center: THREE.Vector3;
  update(dt: number): void;
}

export function buildTradingDesk(): TradingDeskModel {
  const { x, z, rotY, width, depth, height } = TRADING_DESK;
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.rotation.y = rotY;

  const top = toon('#2f3545');
  const frame = toon('#1f2430');
  const plastic = toon('#16181f');
  // A rug marks out the desk's patch of floor.
  group.add(mesh(roundedBox(width + 1.4, 0.02, 3, 0.6), toon('#b8c0ff'), 0, 0.011, 0.6, false));
  group.add(mesh(roundedBox(width, 0.06, depth, 0.03), top, 0, height - 0.03, 0));
  for (const sx of [-1, 1]) group.add(mesh(roundedBox(0.07, height - 0.06, depth - 0.1, 0.02), frame, sx * (width / 2 - 0.12), (height - 0.06) / 2, 0));
  group.add(mesh(new THREE.BoxGeometry(width - 0.3, 0.42, 0.03), frame, 0, 0.47, -depth / 2 + 0.08));
  // A strip of light along the front edge.
  const glow = new THREE.Mesh(new THREE.BoxGeometry(width - 0.1, 0.015, 0.012), new THREE.MeshBasicMaterial({ color: '#4cc9f0' }));
  glow.position.set(0, height - 0.065, depth / 2 + 0.002);
  group.add(glow);

  // The monitors, on an arc round where you sit, each turned to face you.
  const screens: TradingDeskModel['screens'] = [];
  const canvases: HTMLCanvasElement[] = [];
  const textures: THREE.CanvasTexture[] = [];
  const { count, width: sw, height: sh, radius, spread, y: my, eye } = MONITORS;
  for (let i = 0; i < count; i++) {
    const a = (i - (count - 1) / 2) * spread;
    const monitor = new THREE.Group();
    monitor.position.set(Math.sin(a) * radius, my, eye - Math.cos(a) * radius);
    monitor.rotation.y = -a;
    const bezel = mesh(roundedBox(sw + 0.05, 0.035, sh + 0.05, 0.02), plastic, 0, 0, 0);
    bezel.rotation.x = Math.PI / 2;
    monitor.add(bezel);
    const canvas = document.createElement('canvas');
    canvas.width = SCREEN_PX.w;
    canvas.height = SCREEN_PX.h;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#131722';
    g.fillRect(0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
    screen.position.z = 0.019;
    monitor.add(screen);
    // Its stand: a neck down to a foot on the desk.
    monitor.add(mesh(new THREE.BoxGeometry(0.05, my - height - 0.02, 0.03), plastic, 0, -(my - height) / 2 - 0.01, -0.05));
    monitor.add(mesh(roundedBox(0.26, 0.015, 0.18, 0.02), plastic, 0, height - my + 0.008, -0.05));
    group.add(monitor);
    screens.push(screen);
    canvases.push(canvas);
    textures.push(texture);
  }

  // The ticker over the screens, on two posts from the back of the desk.
  const tickerY = my + sh / 2 + 0.24;
  for (const sx of [-1, 1]) group.add(mesh(new THREE.CylinderGeometry(0.025, 0.025, tickerY - height + 0.1, 8), frame, sx * (width / 2 - 0.22), (tickerY + height) / 2, -depth / 2 + 0.06));
  group.add(mesh(roundedBox(width - 0.3, 0.2, 0.06, 0.03), plastic, 0, tickerY, -depth / 2 + 0.06));
  const tickerCanvas = document.createElement('canvas');
  tickerCanvas.width = 2048;
  tickerCanvas.height = 64;
  const tickerTex = new THREE.CanvasTexture(tickerCanvas);
  tickerTex.colorSpace = THREE.SRGBColorSpace;
  tickerTex.wrapS = THREE.RepeatWrapping;
  tickerTex.repeat.x = 0.6;
  const ticker = new THREE.Mesh(new THREE.PlaneGeometry(width - 0.42, 0.15), new THREE.MeshBasicMaterial({ map: tickerTex, toneMapped: false }));
  ticker.position.set(0, tickerY, -depth / 2 + 0.095);
  group.add(ticker);
  const sign = textPlane('📈 Trading desk', { bg: '#fffaf3', size: 44 });
  sign.scale.multiplyScalar(0.42);
  sign.position.set(0, tickerY + 0.2, -depth / 2 + 0.06);
  group.add(sign);

  // What's on the desk, and the chair.
  group.add(mesh(roundedBox(0.46, 0.02, 0.15, 0.01), plastic, 0, height + 0.01, 0.22));
  group.add(mesh(roundedBox(0.06, 0.025, 0.1, 0.02), plastic, 0.36, height + 0.012, 0.24));
  const mug = deskMug('#4cc9f0');
  mug.position.set(-0.95, height, 0.18);
  group.add(mug);
  const seat = chair('#5bc0eb');
  seat.position.set(0, 0, 0.95);
  group.add(seat);

  group.updateMatrixWorld(true);
  const ahead = { x: Math.sin(rotY), z: Math.cos(rotY) };
  const interactable: Interactable = { kind: 'trading', x: x + ahead.x * 1.05, z: z + ahead.z * 1.05, radius: 1.7 };
  group.userData.interact = interactable;
  const colliders: Collider[] = [{ minX: x - width / 2, maxX: x + width / 2, minZ: z - depth / 2, maxZ: z + depth / 2, top: tickerY + 0.1 }];

  return {
    group,
    screens,
    canvases,
    textures,
    ticker: { canvas: tickerCanvas, texture: tickerTex },
    interactable,
    colliders,
    center: new THREE.Vector3(x, 1, z),
    update(dt) {
      tickerTex.offset.x = (tickerTex.offset.x + dt * 0.05) % 1;
    },
  };
}

declare module '../../world/types' {
  interface OfficeHandles {
    /** The trading desk south of the desk pods. */
    tradingDesk: TradingDeskModel;
  }
}

export const tradingDesk: Fixture<'tradingDesk'> = () => {
  const built = buildTradingDesk();
  return { group: built.group, colliders: built.colliders, interactables: [built.interactable], update: (_t, dt) => built.update(dt), handle: { tradingDesk: built } };
};
