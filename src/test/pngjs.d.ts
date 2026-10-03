declare module 'pngjs' {
  export const PNG: { sync: { read(buffer: Uint8Array): { width: number; height: number; data: Uint8Array } } }
}
