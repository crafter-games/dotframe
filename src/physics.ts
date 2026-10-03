import type { Vec3 } from "./math";

// Axis-aligned boxes in the XY plane (side view), integrated at a fixed step.

export interface Body {
  position: Vec3;
  velocity: Vec3;
  halfWidth: number;
  halfHeight: number;
  onGround: boolean;
}

export interface Solid {
  x: number;
  y: number;
  halfWidth: number;
  halfHeight: number;
}

export const FIXED_STEP = 1 / 60;

function overlaps(body: Body, solid: Solid): boolean {
  return (
    Math.abs(body.position.x - solid.x) < body.halfWidth + solid.halfWidth &&
    Math.abs(body.position.y - solid.y) < body.halfHeight + solid.halfHeight
  );
}

// Moves the body one step and resolves collisions against static solids, X then Y.
export function stepBody(body: Body, solids: Solid[], gravity: number, dt: number): void {
  body.velocity = { x: body.velocity.x, y: body.velocity.y + gravity * dt, z: 0 };

  body.position = { x: body.position.x + body.velocity.x * dt, y: body.position.y, z: body.position.z };
  for (const solid of solids) {
    if (!overlaps(body, solid)) continue;
    // A shallow vertical overlap (resting on or grazing a solid) belongs to the Y pass.
    const overlapX = body.halfWidth + solid.halfWidth - Math.abs(body.position.x - solid.x);
    const overlapY = body.halfHeight + solid.halfHeight - Math.abs(body.position.y - solid.y);
    if (overlapY < overlapX) continue;
    const side = body.position.x < solid.x ? -1 : 1;
    body.position = { x: solid.x + side * (solid.halfWidth + body.halfWidth), y: body.position.y, z: body.position.z };
    body.velocity = { x: 0, y: body.velocity.y, z: 0 };
  }

  body.onGround = false;
  body.position = { x: body.position.x, y: body.position.y + body.velocity.y * dt, z: body.position.z };
  for (const solid of solids) {
    if (!overlaps(body, solid)) continue;
    if (body.velocity.y <= 0 && body.position.y > solid.y) {
      body.position = { x: body.position.x, y: solid.y + solid.halfHeight + body.halfHeight, z: body.position.z };
      body.onGround = true;
    } else {
      body.position = { x: body.position.x, y: solid.y - solid.halfHeight - body.halfHeight, z: body.position.z };
    }
    body.velocity = { x: body.velocity.x, y: 0, z: 0 };
  }
}
