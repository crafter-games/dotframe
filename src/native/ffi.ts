// Signature-only declarations bound to native/df_native.c through the FFI manifest.
export declare function dfOpen(width: number, height: number, title: string): number;
export declare function dfPipeline(wgsl: string): number;
export declare function dfPoll(): boolean;
export declare function dfFrame(r: number, g: number, b: number, pipeline: number, vertexCount: number): number;
export declare function dfClose(): void;
