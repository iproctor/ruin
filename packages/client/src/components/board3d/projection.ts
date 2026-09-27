import * as THREE from 'three';

/**
 * Keeps HTML overlay elements glued to 3D positions. Overlay components
 * register an element plus world-space points; the scene projects them every
 * frame and writes the element's position directly (no React re-render).
 *
 *  - 'point': element's top-left is placed at the projected point (use a CSS
 *    transform on the element itself to centre it).
 *  - 'rect':  element covers the screen-space bounding box of all points.
 *  - 'span':  points = [base, top]; element spans that height, width = height × aspect.
 */
export type ProjectionMode = 'point' | 'rect' | 'span';

interface Entry {
  el: HTMLElement;
  points: THREE.Vector3[];
  mode: ProjectionMode;
  aspect: number;
}

export class ProjectionRegistry {
  private entries = new Map<string, Entry>();
  private tmp = new THREE.Vector3();

  set(key: string, el: HTMLElement, points: THREE.Vector3[], mode: ProjectionMode, aspect = 1) {
    const prev = this.entries.get(key);
    if (prev && prev.el === el) {
      prev.points = points;
      prev.mode = mode;
      prev.aspect = aspect;
      return;
    }
    this.entries.set(key, { el, points, mode, aspect });
  }

  /** Live-update the points of an entry (animated standees). */
  move(key: string, index: number, x: number, y: number, z: number) {
    const e = this.entries.get(key);
    if (e && e.points[index]) e.points[index]!.set(x, y, z);
  }

  delete(key: string, el?: HTMLElement) {
    const e = this.entries.get(key);
    if (e && (!el || e.el === el)) this.entries.delete(key);
  }

  project(camera: THREE.Camera, width: number, height: number) {
    for (const e of this.entries.values()) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of e.points) {
        const t = this.tmp.copy(p).project(camera);
        const sx = (t.x * 0.5 + 0.5) * width;
        const sy = (-t.y * 0.5 + 0.5) * height;
        if (sx < minX) minX = sx;
        if (sy < minY) minY = sy;
        if (sx > maxX) maxX = sx;
        if (sy > maxY) maxY = sy;
      }
      const s = e.el.style;
      if (e.mode === 'point') {
        s.left = `${minX}px`;
        s.top = `${minY}px`;
      } else if (e.mode === 'rect') {
        s.left = `${minX}px`;
        s.top = `${minY}px`;
        s.width = `${maxX - minX}px`;
        s.height = `${maxY - minY}px`;
      } else {
        const h = maxY - minY;
        const w = h * e.aspect;
        const cx = (minX + maxX) / 2;
        s.left = `${cx - w / 2}px`;
        s.top = `${minY}px`;
        s.width = `${w}px`;
        s.height = `${h}px`;
      }
    }
  }
}
