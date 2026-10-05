// Web only: exposes a probe's state as globalThis.__dotframe for dotframe play --online. Native builds must not import
// this (assigning globalThis traps in scriptc); they write the state to a file.
import type { ProbeState } from "./probe";

export function publishProbe(state: ProbeState): void {
  (globalThis as { __dotframe?: ProbeState }).__dotframe = state;
}
