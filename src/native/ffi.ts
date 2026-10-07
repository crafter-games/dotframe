// Signature-only declarations bound to native/df_native.c through native/ffi.*.json.
export declare function dfOpen(width: number, height: number, title: string): number;
export declare function dfKeyDown(scancode: number): boolean;
export declare function dfGamepadAxis(pad: number, axis: number): number;
export declare function dfGamepadButton(pad: number, button: number): boolean;
export declare function dfMouse(field: number): number;
export declare function dfPrefPath(org: string, app: string, out: Uint8Array): number;
export declare function dfWidth(): number;
export declare function dfHeight(): number;
export declare function dfBuffer(usage: number, data: Uint8Array): number;
export declare function dfBufferWrite(buffer: number, data: Uint8Array): void;
export declare function dfBufferDestroy(buffer: number): void;
export declare function dfPipeline(wgsl: string, stride: number, attributes: Uint8Array, flags: number): number;
export declare function dfBind(pipeline: number, buffer: number, texture: number): number;
// mode: 0 nearest, 1 linear, 2 linear with mipmaps and repeat.
export declare function dfTexture(width: number, height: number, rgba: Uint8Array, mode: number): number;
export declare function dfImage(png: Uint8Array, mode: number): number;
export declare function dfTextureDestroy(texture: number): void;
export declare function dfTextureSize(texture: number, axis: number): number;
export declare function dfPoll(): boolean;
export declare function dfTouchCount(): number;
export declare function dfTouch(index: number, field: number): number;
export declare function dfBegin(r: number, g: number, b: number, depth: boolean): number;
export declare function dfDraw(
  pipeline: number,
  bindGroup: number,
  vertexBuffer: number,
  indexBuffer: number,
  first: number,
  count: number,
): void;
export declare function dfTarget(op: number, a: number, b: number, c: number, d: number, e: number): number;
export declare function dfPass(depth: boolean): void;
export declare function dfEnd(): void;
export declare function dfClose(): void;
export declare function dfAudioOpen(): number;
export declare function dfSound(mp3: Uint8Array): number;
export declare function dfPlay(sound: number, volume: number, rate: number): void;
export declare function dfTone(frequency: number, duration: number, volume: number): void;
export declare function dfTrack(mp3: Uint8Array): number;
export declare function dfAudioActive(): number;
// Music and volume in one call (library mode caps host callbacks at 32): op 0 play track a, loop when b != 0, at
// volume c; 1 stop; 2 pause when a != 0, else resume; 3 music volume a; 4 master volume a.
export declare function dfMusic(op: number, a: number, b: number, c: number): number;
export declare function dfVoice(op: number, a: number, b: number, c: number, d: number): number;
// WebSocket client and share (df_ws_apple.m, df_ws_win.c), two calls because library mode caps host callbacks at
// 32. dfWsText: op 0 open url, 1 send text on socket, 2 share text. dfWs: op 0 state, 1 next length, 2 byte, 3 pop,
// 4 close. See native/relay.ts.
export declare function dfWsText(op: number, socket: number, text: string): number;
export declare function dfWs(op: number, socket: number, arg: number): number;
