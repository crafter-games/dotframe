# sim.ts walkthrough

```ts
import { defineSim } from "dotframe/src/sim";
import { checksum, createGame, encode, randomInput, render, snapshot, state, step, WINDOW, PLAYERS } from "./src/game";

export default defineSim({
  players: PLAYERS,
  window: WINDOW,
  options: {},                 // defaults merged under --options
  neutral: 0,                  // encoded "nothing pressed"
  encode,                      // JSON input -> number
  random: randomInput,         // used by --mash
  create: () => {
    let game = createGame(1);
    return {
      ready: Promise.resolve(),               // load assets here when not headless
      start: (seed) => { game = createGame(seed); },
      step: (inputs) => step(game, inputs),
      checksum: () => checksum(game),
      state: () => state(game),
      over: () => game.winner >= 0,
      save: () => snapshot(game),
      restore: (s) => { Object.assign(game, snapshot(s)); },
      inspect: () => game,
      render: (draw) => render(game, draw),
    };
  },
});
```

A game with classes, closures, or GPU handles in its state (like Crafter Smash) needs an identity-preserving snapshotter instead of structuredClone, and a `ready` promise that loads assets onto `platform.gpu` and `platform.draw` when `platform.headless` is false.
