<script setup lang="ts">
// 环形图（donut）组件 —— 纯 SVG，零依赖。
//
// 设计：占比类数据用环形图（中心承载总数/可用率，信息密度高于饼图）；
// 描边式 donut（stroke-dasharray 分段）贴合 Linear「半透明 + luminance 层级」美学。
// 交互：hover 任一段 → 该段加粗 + 其余段 dim + 图例同步高亮（商用仪表盘标配）。
//
// 用法：<DonutChart :data="segs" center-value="2,847" center-label="资产总数" />
import { computed, ref } from "vue";

/** 单条数据 */
export interface DonutSegment {
  /** 图例名称 */
  name: string;
  /** 数值 */
  value: number;
  /** 段颜色（CSS color） */
  color: string;
}

const props = withDefaults(
  defineProps<{
    /** 数据条目（按 value 降序渲染，大头先画视觉更稳） */
    data: DonutSegment[];
    /** 中心大数字（已格式化的字符串，如 "2,847" / "78%"） */
    centerValue?: string;
    /** 中心小标签（如 "资产总数" / "可用率"） */
    centerLabel?: string;
    /** svg 尺寸 px（正方形） */
    size?: number;
  }>(),
  {
    centerValue: "",
    centerLabel: "",
    size: 132,
  },
);

const R = 48; // 环形半径（viewBox 120x120 内）
const C = 2 * Math.PI * R; // 周长 ≈ 301.59

/** 按值降序，便于大头先画 */
const sorted = computed(() =>
  [...props.data].sort((a, b) => b.value - a.value),
);

const total = computed(() =>
  sorted.value.reduce((s, d) => s + d.value, 0),
);

/** 段间隙 px（>1 段时留 1.5，视觉透气） */
const gap = computed(() => (sorted.value.length > 1 ? 1.5 : 0));

/** 当前 hover 段索引（null = 无 hover） */
const hoverIdx = ref<number | null>(null);

/** 计算每段几何：dasharray / dashoffset */
const segments = computed(() => {
  let offset = 0;
  return sorted.value.map((d, i) => {
    const frac = total.value > 0 ? d.value / total.value : 0;
    const len = frac * C;
    const dash = Math.max(len - gap.value, 0.5);
    const seg = {
      ...d,
      index: i,
      dash,
      dashOffset: -offset,
      pct: total.value > 0 ? frac * 100 : 0,
    };
    offset += len;
    return seg;
  });
});

/** 图例项（与段同序） */
const legendItems = computed(() =>
  segments.value.map((s) => ({
    name: s.name,
    value: s.value,
    color: s.color,
    pct: s.pct,
    index: s.index,
  })),
);

function onEnter(i: number): void {
  hoverIdx.value = i;
}
function onLeave(): void {
  hoverIdx.value = null;
}

/** 某段是否被 dim（有 hover 且不是当前段） */
function isDim(i: number): boolean {
  return hoverIdx.value !== null && hoverIdx.value !== i;
}
</script>

<template>
  <div class="donut-wrap">
    <svg
      class="donut-svg"
      :viewBox="`0 0 120 120`"
      :style="{ width: size + 'px', height: size + 'px' }"
      role="img"
      aria-label="环形图"
    >
      <circle class="track" cx="60" cy="60" :r="R" />
      <circle
        v-for="s in segments"
        :key="s.name"
        class="seg"
        :class="{ 'is-dim': isDim(s.index), 'is-hover': hoverIdx === s.index }"
        cx="60"
        cy="60"
        :r="R"
        :stroke="s.color"
        :stroke-dasharray="`${s.dash} ${C - s.dash}`"
        :stroke-dashoffset="s.dashOffset"
        transform="rotate(-90 60 60)"
        @mouseenter="onEnter(s.index)"
        @mouseleave="onLeave"
      />
      <text v-if="centerValue" class="donut-center num" x="60" y="54">{{
        centerValue
      }}</text>
      <text v-if="centerLabel" class="donut-center lbl" x="60" y="72">{{
        centerLabel
      }}</text>
    </svg>

    <ul class="legend">
      <li
        v-for="item in legendItems"
        :key="item.name"
        class="legend-item"
        :class="{ 'is-dim': isDim(item.index) }"
        @mouseenter="onEnter(item.index)"
        @mouseleave="onLeave"
      >
        <span class="legend-dot" :style="{ background: item.color }" />
        <span class="legend-name">{{ item.name }}</span>
        <span class="legend-val">{{ item.value.toLocaleString() }}</span>
        <span class="legend-pct">{{ item.pct.toFixed(1) }}%</span>
      </li>
    </ul>
  </div>
</template>

<style scoped lang="scss">
.donut-wrap {
  display: flex;
  align-items: center;
  gap: 14px;
}

.donut-svg {
  flex-shrink: 0;
  display: block;
}

.track {
  fill: none;
  stroke: rgba(255, 255, 255, 0.04);
  stroke-width: 12;
}

.seg {
  fill: none;
  stroke-width: 12;
  stroke-linecap: butt;
  transition:
    stroke-width 140ms ease,
    opacity 140ms ease;
  cursor: pointer;
}

.seg.is-dim {
  opacity: 0.25;
}

.seg.is-hover {
  stroke-width: 15;
}

.donut-center {
  text-anchor: middle;
  dominant-baseline: central;
}

.donut-center.num {
  fill: var(--text-primary);
  font-size: 24px;
  font-weight: 590;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.5px;
}

.donut-center.lbl {
  fill: var(--text-quaternary);
  font-size: 10px;
  font-weight: 510;
  letter-spacing: 0.3px;
}

.legend {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 120ms ease, opacity 120ms ease;
}

.legend-item:hover {
  background: rgba(255, 255, 255, 0.04);
}

.legend-item.is-dim {
  opacity: 0.4;
}

.legend-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.legend-name {
  flex: 1;
  min-width: 0;
  color: var(--text-secondary);
  font-size: 12.5px;
  font-weight: 510;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.legend-val {
  color: var(--text-primary);
  font-size: 12.5px;
  font-weight: 590;
  font-variant-numeric: tabular-nums;
}

.legend-pct {
  color: var(--text-quaternary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  min-width: 34px;
  text-align: right;
}

@media (max-width: 1023px) {
  .donut-wrap {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
