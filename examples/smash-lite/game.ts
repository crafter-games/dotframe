import { createWorld, spawn, type World } from "../../src/ecs";
import type { Frame, Gpu, Setup } from "../../src/gpu";
import { GamepadAxis, GamepadButton, type Input, Key } from "../../src/input";
import { type Vec3, vec3 } from "../../src/math";
import { type Body, FIXED_STEP, type Solid, stepBody } from "../../src/physics";
import { createRenderer } from "../../src/render";
import { box } from "../../src/shapes";

export const windowOptions = { width: 960, height: 540, title: "dotframe: smash-lite" };

const GRAVITY = -30;
const RUN_SPEED = 7;
const JUMP_SPEED = 13;
const ATTACK_RANGE = 1.6;
const ATTACK_COOLDOWN = 0.35;
const KILL_Y = -9;

interface Controls {
  left: number;
  right: number;
  jump: number;
  attack: number;
  gamepad: boolean;
}

interface Intent {
  move: number;
  jump: boolean;
  attack: boolean;
}

interface Player {
  entity: number;
  body: Body;
  color: Vec3;
  spawn: Vec3;
  controls: Controls;
  damage: number;
  facing: number;
  cooldown: number;
  flash: number;
  // Seconds without control after being hit, so knockback is not overwritten.
  stun: number;
  jumpHeld: boolean;
  attackHeld: boolean;
  kos: number;
}

const stage: Solid[] = [
  { x: 0, y: -1, halfWidth: 6, halfHeight: 0.5 },
  { x: -3.5, y: 1.8, halfWidth: 1.3, halfHeight: 0.15 },
  { x: 3.5, y: 1.8, halfWidth: 1.3, halfHeight: 0.15 },
];

function readIntent(input: Input, controls: Controls): Intent {
  let move = 0;
  if (input.down(controls.left)) move -= 1;
  if (input.down(controls.right)) move += 1;
  let jump = input.down(controls.jump);
  let attack = input.down(controls.attack);
  if (controls.gamepad) {
    const stick = input.axis(GamepadAxis.LeftX);
    if (Math.abs(stick) > 0.25) move = stick;
    jump = jump || input.button(GamepadButton.South);
    attack = attack || input.button(GamepadButton.West);
  }
  return { move, jump, attack };
}

// Scripted behaviour for demo mode: chase, face and attack in range, hop now and then.
function demoIntent(self: Player, target: Player, time: number): Intent {
  const dx = target.body.position.x - self.body.position.x;
  const distance = Math.abs(dx);
  let move = distance > 1.2 ? Math.sign(dx) : self.facing === Math.sign(dx) ? 0 : Math.sign(dx) * 0.01;
  // Do not chase a launched opponent off the stage.
  if (Math.abs(self.body.position.x) > 5.2 && Math.sign(move) === Math.sign(self.body.position.x)) move = 0;
  return { move, jump: Math.sin(time * 2.3 + self.entity) > 0.97, attack: distance < ATTACK_RANGE && Math.sin(time * 9) > 0 };
}

function respawn(player: Player): void {
  player.body.position = vec3(player.spawn.x, player.spawn.y, 0);
  player.body.velocity = vec3(0, 0, 0);
  player.damage = 0;
  player.stun = 0;
}

export function createSetup(demo: boolean): Setup {
  return (gpu: Gpu, input: Input): Frame => {
    const renderer = createRenderer(gpu);
    const cube = renderer.addMesh(box());
    const world: World = createWorld();

    for (const solid of stage) {
      const entity = spawn(world);
      world.transforms.set(entity, {
        position: vec3(solid.x, solid.y, 0),
        rotation: vec3(0, 0, 0),
        scale: vec3(solid.halfWidth * 2, solid.halfHeight * 2, 2),
      });
      world.meshes.set(entity, { mesh: cube, color: vec3(0.32, 0.34, 0.42) });
    }

    const makePlayer = (spawnPoint: Vec3, color: Vec3, controls: Controls, facing: number): Player => {
      const entity = spawn(world);
      const player: Player = {
        entity,
        body: { position: spawnPoint, velocity: vec3(0, 0, 0), halfWidth: 0.4, halfHeight: 0.6, onGround: false },
        color,
        spawn: spawnPoint,
        controls,
        damage: 0,
        facing,
        cooldown: 0,
        flash: 0,
        stun: 0,
        jumpHeld: false,
        attackHeld: false,
        kos: 0,
      };
      world.transforms.set(entity, { position: spawnPoint, rotation: vec3(0, 0, 0), scale: vec3(0.8, 1.2, 0.8) });
      world.meshes.set(entity, { mesh: cube, color });
      return player;
    };

    const players: Player[] = [
      makePlayer(vec3(-2.5, 1, 0), vec3(0.98, 0.45, 0.09), { left: Key.A, right: Key.D, jump: Key.W, attack: Key.J, gamepad: true }, 1),
      makePlayer(vec3(2.5, 1, 0), vec3(0.35, 0.65, 0.98), { left: Key.Left, right: Key.Right, jump: Key.Up, attack: Key.Enter, gamepad: false }, -1),
    ];

    const update = (time: number): void => {
      for (let i = 0; i < players.length; i++) {
        const player = players[i];
        const opponent = players[1 - i];
        const intent = demo ? demoIntent(player, opponent, time) : readIntent(input, player.controls);
        const body = player.body;

        player.stun = Math.max(0, player.stun - FIXED_STEP);
        if (player.stun === 0) {
          body.velocity = vec3(intent.move * RUN_SPEED, body.velocity.y, 0);
          if (intent.move !== 0) player.facing = Math.sign(intent.move);
          if (intent.jump && !player.jumpHeld && body.onGround) body.velocity = vec3(body.velocity.x, JUMP_SPEED, 0);
        }
        player.jumpHeld = intent.jump;

        player.cooldown = Math.max(0, player.cooldown - FIXED_STEP);
        player.flash = Math.max(0, player.flash - FIXED_STEP);
        if (intent.attack && !player.attackHeld && player.cooldown === 0 && player.stun === 0) {
          player.cooldown = ATTACK_COOLDOWN;
          const dx = opponent.body.position.x - body.position.x;
          const dy = opponent.body.position.y - body.position.y;
          if (Math.abs(dx) < ATTACK_RANGE && Math.abs(dy) < 1.2 && Math.sign(dx) === player.facing) {
            opponent.damage += 12;
            const force = 6 + opponent.damage * 0.12;
            opponent.body.velocity = vec3(player.facing * force, 6 + opponent.damage * 0.05, 0);
            opponent.body.position = vec3(opponent.body.position.x, opponent.body.position.y + 0.05, 0);
            opponent.flash = 0.15;
            opponent.stun = 0.3 + opponent.damage * 0.004;
          }
        }
        player.attackHeld = intent.attack;
      }

      for (let i = 0; i < players.length; i++) {
        const player = players[i];
        stepBody(player.body, stage, GRAVITY, FIXED_STEP);
        if (player.body.position.y < KILL_Y) {
          players[1 - i].kos += 1;
          console.log(`KO! score ${players[0].kos} - ${players[1].kos}`);
          respawn(player);
        }
      }
    };

    let simulated = 0;
    return (frameGpu: Gpu, time: number): boolean => {
      if (!demo && input.down(Key.Escape)) return false;
      // Fixed-step simulation, capped so a stall does not spiral.
      let steps = 0;
      while (simulated + FIXED_STEP <= time && steps < 8) {
        update(simulated);
        simulated += FIXED_STEP;
        steps++;
      }
      if (steps === 8) simulated = time;

      for (const player of players) {
        const transform = world.transforms.get(player.entity);
        if (transform) {
          transform.position = player.body.position;
          transform.rotation = vec3(0, player.facing > 0 ? 0.35 : -0.35, 0);
        }
        const tint = player.flash > 0 ? vec3(1, 1, 1) : player.color;
        world.meshes.set(player.entity, { mesh: cube, color: tint });
      }

      const midX = (players[0].body.position.x + players[1].body.position.x) / 2;
      const spread = Math.abs(players[0].body.position.x - players[1].body.position.x);
      const distance = Math.min(Math.max(11, spread * 1.4 + 6), 18);
      renderer.render(
        world,
        { eye: vec3(midX * 0.6, 3, distance), target: vec3(midX * 0.6, 0.5, 0), fovY: 0.8 },
        { r: 0.06, g: 0.06, b: 0.1 },
      );
      return true;
    };
  };
}
