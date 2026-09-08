/**
 * 嵌字笔刷纯数学引擎（客户端/测试共用，无 DOM 依赖，风格对齐 typeset-adjust.ts）。
 *
 * 设计要点（协作重放一致性是最高优先级）：
 * - 这里只放「确定性」纯函数：给定相同输入必得相同输出；
 *   重放路径禁止 Math.random / Date.now，随机性（批次2 的散布/抖动）一律用种子 PRNG。
 * - 旧 PaintOp（无新字段）经过本模块解析后，行为与升级前逐像素一致（向后兼容）：
 *   · hardness 缺省 → 由旧 soft 字段映射（true→50，false/缺省→100）；
 *   · spacing 缺省 → 25%（= 旧硬编码 size/4）；
 *   · flow 缺省或 100 → 旧行为：笔章直接以不透明度逐章叠加进涂改层。
 * - 平滑稳定器（EMA）只作用于本地输入点：广播的 points 本身就是平滑后的点，
 *   远端按同一串点重放天然一致，因此 PaintOp 无需 smooth 标记字段。
 */

export type BrushPoint = { x: number; y: number };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---- 硬度（旧「软边」开关的连续化替代） ----

/** 旧 soft:true 的视觉等价硬度：旧径向渐变从 50% 半径起向边缘渐隐 */
export const SOFT_EQUIVALENT_HARDNESS = 50;

/** 旧 soft 字段 → 等价硬度（true→50，false/缺省→100 硬边） */
export function softToHardness(soft?: boolean): number {
  return soft ? SOFT_EQUIVALENT_HARDNESS : 100;
}

/**
 * PaintOp 笔画硬度解析：新 hardness 字段（0~100）优先，
 * 旧数据缺省回落 soft 映射，保证旧笔画重放逐像素一致。
 */
export function resolveStrokeHardness(hardness: unknown, soft?: boolean): number {
  if (hardness != null) {
    const n = Number(hardness);
    if (Number.isFinite(n)) return clamp(n, 0, 100);
  }
  return softToHardness(soft);
}

/**
 * 硬度 → 渐变内圈半径比例（0~1）：
 * 100 = 硬边（纯色圆，无渐变）；h<100 = 径向渐变从 r*(h/100) 全强度向边缘渐隐到 0。
 * h=50 时内圈 = 0.5r，与旧 soft:true 的 createRadialGradient(x,y,r*0.5,x,y,r) 逐像素一致。
 */
export function hardnessToInnerRatio(hardness: number): number {
  return clamp(hardness, 0, 100) / 100;
}

// ---- 间距 ----

export const DEFAULT_SPACING_PERCENT = 25;

/** 间距百分比清洗：1~500%，缺省 25%（= 旧硬编码 size/4 行） */
export function normalizeSpacingPercent(raw: unknown): number {
  if (raw == null) return DEFAULT_SPACING_PERCENT;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp(n, 1, 500) : DEFAULT_SPACING_PERCENT;
}

/**
 * 相邻两章的行进间距（像素）= size × 间距%。
 * 下限 0.5px：size≥2 时默认 25% = size/4 ≥ 0.5，旧数据路径不受下限影响（行为不变）。
 */
export function stampSpacing(sizePx: number, spacingPercent?: number): number {
  return Math.max(0.5, sizePx * (normalizeSpacingPercent(spacingPercent) / 100));
}

// ---- 流量（两段式渲染方案） ----

export type StrokeFlowPlan = {
  /** true = 两段式：笔章先进离屏层逐章堆积，松手整体合成进涂改层（喷枪感） */
  twoStage: boolean;
  /** 每个笔章画进目标层的 alpha（twoStage 时 = flow/100；直画时 = 不透明度 alpha） */
  stampAlpha: number;
  /** 离屏层整体合成进涂改层的 alpha（twoStage=false 时恒 1，不参与） */
  compositeAlpha: number;
};

/**
 * 流量/不透明度 → 渲染方案：
 * - flow 缺省或 ≥100：旧行为——笔章直接以「不透明度」alpha 逐章叠加进涂改层。
 *   （source-over 满足结合律，直画与「同 alpha 进离屏层再以 1 合成」逐像素等价，
 *    因此旧路径无需离屏层，同时保留实时可见的旧手感。）
 * - flow < 100：两段式——每章以 flow/100 alpha 画进离屏层（低流量逐章堆积），
 *   松手把离屏层以「不透明度」alpha 整体合成（笔画总浓度被不透明度封顶，喷枪手感）。
 *   橡皮同理：离屏层以 source-over 累积「擦除覆盖量」，合成时改用 destination-out。
 */
export function planStrokeFlow(flowPercent: number | undefined, opacityPercent: number): StrokeFlowPlan {
  const alpha = Math.min(1, Math.max(0.05, opacityPercent / 100));
  if (flowPercent == null) return { twoStage: false, stampAlpha: alpha, compositeAlpha: 1 };
  const flow = Number(flowPercent);
  if (!Number.isFinite(flow) || flow >= 100) {
    return { twoStage: false, stampAlpha: alpha, compositeAlpha: 1 };
  }
  return { twoStage: true, stampAlpha: clamp(flow, 1, 99) / 100, compositeAlpha: alpha };
}

// ---- 平滑稳定器（EMA） ----

/**
 * 平滑上限 95%：再往上 EMA 系数趋近 0，落点几乎不动（等于笔刷卡死），
 * 属于无效手感区间，防御式钳掉。UI 滑条同样按 0~95 出。
 */
export const MAX_SMOOTHING_PERCENT = 95;

/** 平滑强度清洗：0~95%，缺省 0 = 关（旧行为） */
export function normalizeSmoothPercent(raw: unknown): number {
  if (raw == null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp(n, 0, MAX_SMOOTHING_PERCENT) : 0;
}

/**
 * 输入点 EMA 平滑器（指数移动平均）：每个新点向原始输入点靠拢 f = 1 - 强度%。
 * 强度 0 = 关（输出=输入，逐位等于旧行为）；强度越高笔迹越「跟手延迟」越平滑。
 * 确定性：同一串输入点必得同一串输出点——本地把平滑后的点直接进 points 广播，
 * 远端按同串点重放，天然逐像素一致（无需在 PaintOp 上加标记字段）。
 */
export function createPointSmoother(strengthPercent: number): (pt: BrushPoint) => BrushPoint {
  const f = 1 - normalizeSmoothPercent(strengthPercent) / 100;
  let initialized = false;
  let sx = 0;
  let sy = 0;
  if (f >= 1) {
    // 强度 0 = 关：恒等映射（显式返回原点，避免 sm+(pt-sm)*1 的浮点舍入偏差）
    return (pt: BrushPoint): BrushPoint => ({ x: pt.x, y: pt.y });
  }
  return (pt: BrushPoint): BrushPoint => {
    if (!initialized) {
      // 首点直接吸附（落笔不该有偏移），保证起点与按下位置一致
      initialized = true;
      sx = pt.x;
      sy = pt.y;
      return { x: sx, y: sy };
    }
    sx += (pt.x - sx) * f;
    sy += (pt.y - sy) * f;
    return { x: sx, y: sy };
  };
}

// ---- 通用小工具 ----

/** 两点线性插值（盖章插值路径共用） */
export function lerpPoint(a: BrushPoint, b: BrushPoint, t: number): BrushPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
