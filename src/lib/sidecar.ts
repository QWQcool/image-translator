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

export type SidecarHealth = {
  ok: boolean;
  /** 是否加载了模型（detector.mjs 的 ONNX 档）；传统算法档为 false 但可用 */
  models: boolean;
  /** 'onnx' | 'traditional' | 'unavailable' */
  engine?: string;
  /** detector.mjs 提供 /detect 时为 true */
  detector?: boolean;
};

/** 探测 sidecar 状态（含引擎信息），不可达时返回 null */
export async function sidecarStatus(): Promise<SidecarHealth | null> {
  try {
    const res = await fetch(`${sidecarUrl()}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return (await res.json()) as SidecarHealth;
  } catch {
    return null;
  }
}

export type SidecarDetectResult = {
  blocks: Array<{ x: number; y: number; w: number; h: number; text: string; confidence?: number }>;
  engine?: 'onnx' | 'traditional';
};

/** 调本机检测进程出文字框（坐标 0~1 归一化，text 恒空） */
export async function sidecarDetect(
  image: Buffer,
  mimeType: string,
): Promise<SidecarDetectResult | null> {
  try {
    const res = await fetch(`${sidecarUrl()}/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: image.toString('base64'),
        mimeType,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as SidecarDetectResult;
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
