import type { Vec3 } from "./math";

// Axis-aligned boxes in the XY plane (side view), integrated at a fixed step.

export interface Body {
  position: Vec3;
  velocity: Vec3;
  halfWidth: number;
  halfHeight: number;
  onGround: boolean;
  // Optional compound shape: boxes offset from position (x, y) that replace the single halfWidth by halfHeight box,
  // so an irregular sprite (a tail, a canopy) is not one solid rectangle. halfWidth and halfHeight stay the bounds.
  parts?: Solid[];
}

export interface Solid {
  x: number;
  y: number;
  halfWidth: number;
  halfHeight: number;
}

export const FIXED_STEP = 1 / 60;

const SINGLE: Solid[] = [{ x: 0, y: 0, halfWidth: 0, halfHeight: 0 }];

function partsOf(body: Body): Solid[] {
  if (body.parts && body.parts.length > 0) return body.parts;
  SINGLE[0].halfWidth = body.halfWidth;
  SINGLE[0].halfHeight = body.halfHeight;
  return SINGLE;
}

function overlaps(x: number, y: number, part: Solid, solid: Solid): boolean {
  return (
    Math.abs(x + part.x - solid.x) < part.halfWidth + solid.halfWidth &&
    Math.abs(y + part.y - solid.y) < part.halfHeight + solid.halfHeight
  );
}

// Moves the body one step and resolves collisions against static solids, X then Y.
export function stepBody(
  body: Body,
  solids: Solid[],
  gravity: number,
  dt: number,
): void {
  body.velocity = {
    x: body.velocity.x,
    y: body.velocity.y + gravity * dt,
    z: 0,
  };
  const parts = partsOf(body);

  body.position = {
    x: body.position.x + body.velocity.x * dt,
    y: body.position.y,
    z: body.position.z,
  };
  for (const solid of solids) {
    for (const part of parts) {
      if (!overlaps(body.position.x, body.position.y, part, solid)) continue;
      const px = body.position.x + part.x;
      const py = body.position.y + part.y;
      // A shallow vertical overlap (resting on or grazing a solid) belongs to the Y pass.
      const overlapX =
        part.halfWidth + solid.halfWidth - Math.abs(px - solid.x);
      const overlapY =
        part.halfHeight + solid.halfHeight - Math.abs(py - solid.y);
      if (overlapY < overlapX) continue;
      const side = px < solid.x ? -1 : 1;
      body.position = {
        x: solid.x + side * (solid.halfWidth + part.halfWidth) - part.x,
        y: body.position.y,
        z: body.position.z,
      };
      body.velocity = { x: 0, y: body.velocity.y, z: 0 };
    }
  }

  body.onGround = false;
  body.position = {
    x: body.position.x,
    y: body.position.y + body.velocity.y * dt,
    z: body.position.z,
  };
  for (const solid of solids) {
    for (const part of parts) {
      if (!overlaps(body.position.x, body.position.y, part, solid)) continue;
      // A deeper vertical than horizontal overlap is side contact left by the X pass (or by float rounding there), not
      // a landing or a ceiling: resolving it vertically would teleport the body above or below the solid.
      const overlapX = part.halfWidth + solid.halfWidth - Math.abs(body.position.x + part.x - solid.x);
      const overlapY = part.halfHeight + solid.halfHeight - Math.abs(body.position.y + part.y - solid.y);
      if (overlapX < overlapY) continue;
      if (body.velocity.y <= 0 && body.position.y + part.y > solid.y) {
        body.position = {
          x: body.position.x,
          y: solid.y + solid.halfHeight + part.halfHeight - part.y,
          z: body.position.z,
        };
        body.onGround = true;
      } else {
        body.position = {
          x: body.position.x,
          y: solid.y - solid.halfHeight - part.halfHeight - part.y,
          z: body.position.z,
        };
      }
      body.velocity = { x: body.velocity.x, y: 0, z: 0 };
    }
  }
}

// The boxes a body occupies in world space, for using it as a solid.
export function solidsOf(body: Body): Solid[] {
  const out: Solid[] = [];
  for (const part of partsOf(body)) {
    out.push({
      x: body.position.x + part.x,
      y: body.position.y + part.y,
      halfWidth: part.halfWidth,
      halfHeight: part.halfHeight,
    });
  }
  return out;
}

// Steps every body in array order against the static solids and the other bodies as they stand at that moment, so
// bodies land on and stop against each other. A body resting on another stays only while the boxes still touch.
// The order is part of the result: keep the array order fixed for determinism.
export function stepBodies(
  bodies: Body[],
  solids: Solid[],
  gravity: number,
  dt: number,
): void {
  for (const body of bodies) {
    const all = solids.slice();
    for (const other of bodies)
      if (other !== body) for (const s of solidsOf(other)) all.push(s);
    stepBody(body, all, gravity, dt);
  }
}
