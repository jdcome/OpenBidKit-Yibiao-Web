// Type shim for the verbatim-ported convert.mjs (ESM, no own .d.ts).
// Runtime contract verified against client/electron/services/doc2markdown/convert.mjs.
export class ConversionError extends Error {
  code: string;
  details?: Record<string, unknown>;
}
export interface ConvertImage {
  buffer: Buffer;
  mime: string;
  sourceName: string;
}
export interface ConvertOptions {
  includeImages?: boolean;
  imageResolver?: ((image: ConvertImage) => Promise<string>) | null;
}
export function convertPathToMarkdown(inputPath: string, options?: ConvertOptions): Promise<string>;
export function detectFileFormat(inputPath: string): Promise<string>;
