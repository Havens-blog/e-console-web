<script setup lang="ts">
// 迷你折线（sparkline）组件 —— 纯 SVG，零依赖。
//
// 设计：趋势类数据用折线而非饼图/柱图；渐变填充承载量感、描边线承载走势、
// 峰值点标注承载注意力。贴合 Linear 单色强调色哲学（靛紫单色梯度）。
//
// 用法：<Sparkline :points="dailyCosts" />
import { computed, ref } from "vue";

const props = withDefaults(
  defineProps<{
    /** 数据点序列（按时间顺序） */
    points: number[];
    /** 可选点标签（如日期，与 points 等长同序）；提供后悬停展示「标签 + 数值」 */
    labels?: string[];
    /** 数值格式化器（悬停 tooltip 数值文案；默认千分位 2 位小数带 ¥） */
    formatValue?: (v: number) => string;
    /** 描边色（CSS color），默认靛紫 */
    color?: string;
    /** svg 高度 px（宽度自适应父容器 100%） */
    height?: number;
  }>(),
  {
    labels: () => [],
    formatValue: (v: number) =>
      `¥${v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    color: "#828fff",
    height: 132,
  },
);

// viewBox 宽度固定 320，高度随 props；preserveAspectRatio=none 拉伸填满宽度
const W = 320;
const H = computed(() => props.height);
const pad = 6;

/** 唯一渐变 id（避免多实例 id 冲突） */
const gradId = `spark-fill-${Math.random().toString(36).slice(2, 9)}`;

const hasData = computed(() => props.points.length >= 2);

/** 每点屏幕坐标（供描边/填充路径与悬停标记复用） */
const coords = computed(() => {
  const raw = props.points;
  if (raw.length < 2) return [];
  const min = Math.min(...raw);
  const max = Math.max(...raw);
  const span = max - min || 1; // 防 0 除
  const xs = (i: number) => pad + (i / (raw.length - 1)) * (W - pad * 2);
  const ys = (v: number) =>
    pad + (1 - (v - min) / span) * (H.value - pad * 2 - 16) + 4;
  return raw.map((v, i) => ({ x: xs(i), y: ys(v), value: v, index: i }));
});

const geom = computed(() => {
  if (!hasData.value) return null;
  const raw = props.points;
  const max = Math.max(...raw);
  const cs = coords.value;
  const pts = cs.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`);
  const linePath = `M ${pts.join(" L ")}`;
  const areaPath = `M ${cs[0]!.x.toFixed(1)},${H.value - pad} L ${pts.join(" L ")} L ${cs[
    cs.length - 1
  ]!.x.toFixed(1)},${H.value - pad} Z`;

  // 峰值点
  const pi = raw.indexOf(max);
  return {
    linePath,
    areaPath,
    peak: { x: cs[pi]!.x.toFixed(1), y: cs[pi]!.y.toFixed(1) },
  };
});

// ---- 悬停交互：按鼠标 x 定位最近点，展示标签 + 数值 tooltip ----
const hoverIdx = ref<number | null>(null);

/** 悬停点（含屏幕坐标 + 原值 + 标签），无悬停时 null */
const hoverPoint = computed(() => {
  if (hoverIdx.value === null) return null;
  const c = coords.value[hoverIdx.value];
  if (!c) return null;
  return {
    x: c.x,
    y: c.y,
    valueText: props.formatValue(c.value),
    label: props.labels[c.index] ?? "",
  };
});

/** tooltip 左偏移百分比（夹在 2%~98%，避免贴边溢出） */
const tooltipLeftPct = computed(() => {
  if (!hoverPoint.value) return 0;
  const pct = (hoverPoint.value.x / W) * 100;
  return Math.min(98, Math.max(2, pct));
});

/** 鼠标移动：换算 viewBox x → 最近点索引 */
function onMove(e: MouseEvent): void {
  const cs = coords.value;
  if (cs.length === 0) return;
  const svg = e.currentTarget as SVGSVGElement;
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0) return;
  const vbX = ((e.clientX - rect.left) / rect.width) * W;
  // 找 x 最近的点
  let best = 0;
  let bestD = Infinity;
  for (const c of cs) {
    const d = Math.abs(c.x - vbX);
    if (d < bestD) {
      bestD = d;
      best = c.index;
    }
  }
  hoverIdx.value = best;
}

function onLeave(): void {
  hoverIdx.value = null;
}
</script>

<template>
  <div v-if="geom" class="spark-wrap">
    <svg
      class="spark"
      :viewBox="`0 0 ${W} ${H}`"
      preserveAspectRatio="none"
      role="img"
      aria-label="趋势折线"
      @mousemove="onMove"
      @mouseleave="onLeave"
    >
      <defs>
        <linearGradient :id="gradId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" :stop-color="color" stop-opacity="0.28" />
          <stop offset="100%" :stop-color="color" stop-opacity="0" />
        </linearGradient>
      </defs>
      <path :d="geom.areaPath" :fill="`url(#${gradId})`" />
      <path
        :d="geom.linePath"
        fill="none"
        :stroke="color"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle
        :cx="geom.peak.x"
        :cy="geom.peak.y"
        r="3"
        fill="var(--text-primary, #f7f8f8)"
        :stroke="color"
        stroke-width="1.5"
      />
      <!-- 悬停竖向辅助线 + 标记点 -->
      <template v-if="hoverPoint">
        <line
          :x1="hoverPoint.x"
          :x2="hoverPoint.x"
          :y1="pad"
          :y2="H - pad"
          :stroke="color"
          stroke-width="1"
          stroke-opacity="0.4"
          stroke-dasharray="3 3"
        />
        <circle
          :cx="hoverPoint.x"
          :cy="hoverPoint.y"
          r="3.5"
          fill="var(--text-primary, #f7f8f8)"
          :stroke="color"
          stroke-width="1.5"
        />
      </template>
    </svg>

    <!-- 悬停 tooltip（HTML 层，百分比定位，夹边防溢出） -->
    <div
      v-if="hoverPoint"
      class="spark-tooltip"
      data-testid="spark-tooltip"
      :style="{ left: tooltipLeftPct + '%' }"
    >
      <span v-if="hoverPoint.label" class="spark-tooltip-label">{{ hoverPoint.label }}</span>
      <span class="spark-tooltip-value">{{ hoverPoint.valueText }}</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.spark-wrap {
  position: relative;
  width: 100%;
}

.spark {
  width: 100%;
  display: block;
}

.spark-tooltip {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 5px 9px;
  border-radius: 7px;
  border: 1px solid var(--border-strong);
  background: var(--bg-overlay);
  box-shadow: var(--shadow-base);
  pointer-events: none;
  white-space: nowrap;
  z-index: 2;
}

.spark-tooltip-label {
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 1.2;
}

.spark-tooltip-value {
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 590;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
</style>
