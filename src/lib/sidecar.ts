export type OcrBlock = {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  confidence?: number;
};

export type SidecarOcrResult = { blocks: OcrBlock[] };

const DEFAULT_URL = 'http://127.0.0.1:8765';

export function sidecarUrl(): string {
  return (process.env.SIDECAR_URL ?? DEFAULT_URL).replace(/\/$/, '');
}

export async function sidecarHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${sidecarUrl()}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function sidecarOcr(image: Buffer, mimeType: string): Promise<SidecarOcrResult | null> {
  try {
    const res = await fetch(`${sidecarUrl()}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: image.toString('base64'),
        mimeType,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as SidecarOcrResult;
    if (!Array.isArray(data.blocks)) return null;
    return data;
  } catch {
    return null;
  }
}

export async function sidecarInpaint(
  image: Buffer,
  maskPng: Buffer,
): Promise<Buffer | null> {
  try {
    const res = await fetch(`${sidecarUrl()}/inpaint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: image.toString('base64'),
        mask: maskPng.toString('base64'),
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { image?: string };
    if (!data.image) return null;
    return Buffer.from(data.image, 'base64');
  } catch {
    return null;
  }
}
