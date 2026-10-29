// @vitest-environment happy-dom
/**
 * 环形图（DonutChart）单测。
 *
 * 覆盖 AC：
 * - 段数 = data 长度（按 value 降序渲染）
 * - 每段 stroke-dasharray 为合法数字（周长 2πr≈301.59 的分配）
 * - 图例条目数 = 段数，含 name/value/pct
 * - 中心文字（centerValue/centerLabel）渲染
 * - hover 一段 → 该段 is-hover、其余 is-dim、图例同步 is-dim
 * - 空数据不崩（0 段，仅渲染 track + center）
 */
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import DonutChart, { type DonutSegment } from "./DonutChart.vue";

const DATA: DonutSegment[] = [
  { name: "阿里云", value: 20, color: "#ff6a00" },
  { name: "AWS", value: 15, color: "#ff9900" },
  { name: "腾讯云", value: 7, color: "#006eff" },
];

function mountDonut(props: Partial<InstanceType<typeof DonutChart>["$props"]> = {}) {
  return mount(DonutChart, {
    props: { data: DATA, centerValue: "42", centerLabel: "资产总数", ...props },
  });
}

describe("DonutChart", () => {
  it("段数 = data 长度（降序渲染），图例条目同步", () => {
    const wrapper = mountDonut();
    const segs = wrapper.findAll(".seg");
    expect(segs).toHaveLength(3);
    expect(wrapper.findAll(".legend-item")).toHaveLength(3);
  });

  it("每段 stroke-dasharray 为合法数字串（周长分配）", () => {
    const wrapper = mountDonut();
    const segs = wrapper.findAll(".seg");
    for (const s of segs) {
      const arr = s.attributes("stroke-dasharray")?.split(/\s+/).map(Number);
      expect(arr).toBeDefined();
      expect(arr!.length).toBe(2);
      expect(Number.isFinite(arr![0])).toBe(true);
      expect(Number.isFinite(arr![1])).toBe(true);
      expect(arr![0]).toBeGreaterThan(0);
    }
  });

  it("图例含 name + value + 百分比", () => {
    const wrapper = mountDonut();
    const items = wrapper.findAll(".legend-item");
    // 降序后第一项 = 阿里云 20（20/42≈47.6%）
    expect(items[0]!.text()).toContain("阿里云");
    expect(items[0]!.text()).toContain("20");
    expect(items[0]!.text()).toContain("47.6%");
  });

  it("中心文字渲染（centerValue + centerLabel）", () => {
    const wrapper = mountDonut();
    const txt = wrapper.find(".donut-svg").text();
    expect(txt).toContain("42");
    expect(txt).toContain("资产总数");
  });

  it("hover 一段 → 该段 is-hover、其余 is-dim、图例同步", async () => {
    const wrapper = mountDonut();
    const segs = wrapper.findAll(".seg");
    const legends = wrapper.findAll(".legend-item");
    // hover 第二段（降序后 AWS）
    await segs[1]!.trigger("mouseenter");
    expect(segs[1]!.classes()).toContain("is-hover");
    expect(segs[0]!.classes()).toContain("is-dim");
    expect(segs[2]!.classes()).toContain("is-dim");
    // 图例同步
    expect(legends[0]!.classes()).toContain("is-dim");
    expect(legends[1]!.classes()).not.toContain("is-dim");
    // 离开恢复
    await segs[1]!.trigger("mouseleave");
    expect(segs[1]!.classes()).not.toContain("is-hover");
    expect(segs[0]!.classes()).not.toContain("is-dim");
  });

  it("hover 图例项 → 对应段高亮（图例驱动联动）", async () => {
    const wrapper = mountDonut();
    const segs = wrapper.findAll(".seg");
    const legends = wrapper.findAll(".legend-item");
    await legends[2]!.trigger("mouseenter");
    expect(segs[2]!.classes()).toContain("is-hover");
    expect(segs[0]!.classes()).toContain("is-dim");
  });

  it("空数据不崩（0 段，仍渲染 track + center）", () => {
    const wrapper = mountDonut({ data: [] });
    expect(wrapper.findAll(".seg")).toHaveLength(0);
    expect(wrapper.findAll(".track")).toHaveLength(1);
  });

  it("单段数据无 gap（避免 1 段被间隙吃掉）", () => {
    const wrapper = mountDonut({
      data: [{ name: "仅一项", value: 10, color: "#7170ff" }],
    });
    const segs = wrapper.findAll(".seg");
    expect(segs).toHaveLength(1);
    const dash = segs[0]!.attributes("stroke-dasharray")?.split(/\s+/).map(Number);
    // 单段应接近整周长（无间隙扣减）
    expect(dash![0]).toBeGreaterThan(300);
  });
});
