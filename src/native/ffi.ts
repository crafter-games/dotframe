// Signature-only declarations bound to native/df_native.c through native/ffi.*.json.
export declare function dfOpen(width: number, height: number, title: string): number;
export declare function dfKeyDown(scancode: number): boolean;
export declare function dfGamepadAxis(axis: number): number;
export declare function dfGamepadButton(button: number): boolean;
export declare function dfWidth(): number;
export declare function dfHeight(): number;
export declare function dfBuffer(usage: number, data: Uint8Array): number;
export declare function dfBufferWrite(buffer: number, data: Uint8Array): void;
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
