// Signature-only declarations bound to native/df_native.c through native/ffi.*.json.
export declare function dfOpen(width: number, height: number, title: string): number;
export declare function dfKeyDown(scancode: number): boolean;
export declare function dfGamepadAxis(pad: number, axis: number): number;
export declare function dfGamepadButton(pad: number, button: number): boolean;
export declare function dfMouseX(): number;
export declare function dfMouseY(): number;
export declare function dfMouseButtons(): number;
export declare function dfPrefPath(org: string, app: string, out: Uint8Array): number;
export declare function dfWidth(): number;
export declare function dfHeight(): number;
export declare function dfBuffer(usage: number, data: Uint8Array): number;
export declare function dfBufferWrite(buffer: number, data: Uint8Array): void;
export declare function dfBufferDestroy(buffer: number): void;
export declare function dfPipeline(wgsl: string, stride: number, attributes: Uint8Array, flags: number): number;
export declare function dfBind(pipeline: number, buffer: number, texture: number): number;
export declare function dfTexture(width: number, height: number, rgba: Uint8Array, smooth: boolean): number;
export declare function dfImage(png: Uint8Array, smooth: boolean): number;
export declare function dfTextureWidth(texture: number): number;
export declare function dfTextureHeight(texture: number): number;
export declare function dfPoll(): boolean;
export declare function dfBegin(r: number, g: number, b: number, depth: boolean): number;
export declare function dfDraw(
  pipeline: number,
  bindGroup: number,
  vertexBuffer: number,
  indexBuffer: number,
  first: number,
  count: number,
): void;
export declare function dfEnd(): void;
export declare function dfClose(): void;
export declare function dfAudioOpen(): number;
export declare function dfSound(mp3: Uint8Array): number;
export declare function dfPlay(sound: number, volume: number, rate: number): void;
export declare function dfTone(frequency: number, duration: number, volume: number): void;
export declare function dfTrack(mp3: Uint8Array): number;
export declare function dfMusicPlay(track: number, loop: boolean, volume: number): number;
export declare function dfMusicStop(): void;
export declare function dfMusicPause(paused: boolean): void;
export declare function dfMusicVolume(volume: number): void;
export declare function dfMasterVolume(volume: number): void;
export declare function dfAudioActive(): number;
