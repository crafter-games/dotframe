// Signature-only declarations bound to native/df_native.c through native/ffi.*.json.
export declare function dfOpen(width: number, height: number, title: string): number;
export declare function dfWidth(): number;
export declare function dfHeight(): number;
export declare function dfBuffer(usage: number, data: Uint8Array): number;
export declare function dfBufferWrite(buffer: number, data: Uint8Array): void;
export declare function dfPipeline(wgsl: string, stride: number, attributes: Uint8Array, flags: number): number;
export declare function dfBindUniform(pipeline: number, buffer: number): number;
export declare function dfPoll(): boolean;
export declare function dfBegin(r: number, g: number, b: number, depth: boolean): number;
export declare function dfDraw(pipeline: number, bindGroup: number, vertexBuffer: number, indexBuffer: number, count: number): void;
export declare function dfEnd(): void;
export declare function dfClose(): void;
