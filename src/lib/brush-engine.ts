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

// ---- 批次 2：确定性 PRNG 与笔刷动态（压感/散布/抖动/椭圆笔尖） ----

/**
 * mulberry32 确定性 PRNG：同种子必得同一输出序列（协作重放一致性的根基）。
 * 种子由操作者落笔时生成一次并随 PaintOp 广播，重放端逐章推进同一序列；
 * 重放路径本身禁止 Math.random / Date.now（种子生成发生在本地输入侧，不属重放）。
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 压感最小比例：size = size×(1-minRatio+minRatio×p)，p∈[0,1] → [0.65,1]×size */
export const PRESSURE_MIN_RATIO = 0.35;

/**
 * 压感→比例系数（大小/不透明度通用映射）：p 缺省/非法按 0.5 兜底
 * （旧 points 无 p 字段、以及不支持压感的设备按下报 0 时都用 0.5）。
 */
export function pressureFactor(p: number | undefined): number {
  const v = p == null || !Number.isFinite(p) ? 0.5 : clamp(p, 0, 1);
  return 1 - PRESSURE_MIN_RATIO + PRESSURE_MIN_RATIO * v;
}

/** 笔尖角度 0~180 度（椭圆长轴相对水平方向的旋转），缺省 0 */
export function normalizeAngleDeg(raw: unknown): number {
  if (raw == null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp(n, 0, 180) : 0;
}

/** 圆度 1~100（100=正圆，越小越扁），缺省 100 */
export function normalizeRoundness(raw: unknown): number {
  if (raw == null) return 100;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp(n, 1, 100) : 100;
}

/** 散布 0~500%（章位置随机偏移幅度上限 = 基础大小×散布%，逐轴均匀），缺省 0 */
export function normalizeScatterPercent(raw: unknown): number {
  if (raw == null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp(n, 0, 500) : 0;
}

/** 大小抖动 0~100%（章大小在 [1-j,1]×基础大小 内随机），缺省 0 */
export function normalizeJitterPercent(raw: unknown): number {
  if (raw == null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp(n, 0, 100) : 0;
}

/** 笔画动态参数（PaintOp 可选字段清洗后的结果；全默认 = 旧行为：正圆、无散布、无压感） */
export type StrokeDynamics = {
  pressureSize: boolean;
  pressureOpacity: boolean;
  angleDeg: number;
  roundness: number;
  scatter: number;
  jitter: number;
};

/** PaintOp 可选动态字段 → 清洗后的 StrokeDynamics（重放端二次防御，远端可发任意值） */
export function resolveDynamics(raw: {
  pressureSize?: unknown;
  pressureOpacity?: unknown;
  angle?: unknown;
  roundness?: unknown;
  scatter?: unknown;
  jitter?: unknown;
}): StrokeDynamics {
  return {
    pressureSize: raw.pressureSize === true,
    pressureOpacity: raw.pressureOpacity === true,
    angleDeg: normalizeAngleDeg(raw.angle),
    roundness: normalizeRoundness(raw.roundness),
    scatter: normalizeScatterPercent(raw.scatter),
    jitter: normalizeJitterPercent(raw.jitter),
  };
}

/** 是否需要随机动态（散布/抖动任一开启才创建 rng；压感由点数据驱动不消耗 rng） */
export function dynamicsNeedRng(dyn: StrokeDynamics): boolean {
  return dyn.scatter > 0 || dyn.jitter > 0;
}

/** 单章动态解析（确定性）：
 * - rng 存在时每章固定消费 3 个数（dx、dy、大小抖动系数），本地与远端按同一序列推进；
 *   消费与散布/抖动是否为 0 无关（为 0 时结果恒为 0/1，序列推进不产生可见差异），
 *   只要求两端「消费时机与数量」一致——由同一份 stampAlong/stampOne 保证。
 * - 压感系数来自插值点的 p（两端点 p 线性插值后传入），大小/不透明度按开关分别映射。
 */
export function resolveStampDynamics(
  base: { x: number; y: number },
  p: number | undefined,
  size: number,
  alpha: number,
  dyn: StrokeDynamics,
  rng: (() => number) | null,
): { x: number; y: number; size: number; alpha: number } {
  let x = base.x;
  let y = base.y;
  let sizeF = 1;
  if (rng) {
    const maxOff = size * (dyn.scatter / 100);
    x += (rng() * 2 - 1) * maxOff;
    y += (rng() * 2 - 1) * maxOff;
    sizeF *= 1 - rng() * (dyn.jitter / 100);
  }
  const pf = dyn.pressureSize || dyn.pressureOpacity ? pressureFactor(p) : 1;
  return {
    x,
    y,
    size: size * (dyn.pressureSize ? pf : 1) * sizeF,
    alpha: alpha * (dyn.pressureOpacity ? pf : 1),
  };
}
