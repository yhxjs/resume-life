declare module "mammoth" {
  export function convertToHtml(input: {
    buffer: Buffer;
  }): Promise<{ value: string; messages: unknown[] }>;
  export function extractRawText(input: {
    buffer: Buffer;
  }): Promise<{ value: string; messages: unknown[] }>;
}
