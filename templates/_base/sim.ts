// The dotframe CLI contract: dotframe sim, snap, replay, and desync drive the game through this module.
import { defineSim, type SimPlatform, type SimRun } from "dotframe/src/sim";
import { checksum, createGame, PLAYERS, encode, type Game, randomInput, render, snapshot, state, step, WINDOW } from "./src/game";

export default defineSim({
  players: PLAYERS,
  window: WINDOW,
  options: {},
  neutral: 0,
  encode,
  random: randomInput,
  create: (_platform: SimPlatform): SimRun => {
    let game: Game = createGame(1);
    return {
      ready: Promise.resolve(),
      start: (seed: number): void => {
        game = createGame(seed);
      },
      step: (inputs: number[]): void => step(game, inputs),
      checksum: (): number => checksum(game),
      state: (): unknown => state(game),
      over: (): boolean => game.winner >= 0,
      save: (): unknown => snapshot(game),
      restore: (saved: unknown): void => {
        Object.assign(game, snapshot(saved as Game));
      },
      inspect: (): unknown => game,
      render: (draw) => render(game, draw),
    };
  },
});
