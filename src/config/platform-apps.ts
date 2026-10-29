/**
 * 平台顶层应用配置（息壤平台导航唯一事实源，task 3.1 配置化升级）。
 *
 * 为什么单独成模块：原先 AppSwitcher.vue 把「平台应用列」(PLATFORM_APPS) 与
 * 「默认收藏」(DEFAULT_FAVS) 写成两份各自硬编码的数组，新增/改名/调地址都要两处同步，
 * 易漂移。此处收敛为单一数组，应用列与默认收藏均由它派生（single source of truth）。
 *
 * 配置/环境驱动（与 e-cam-web RC#2「build 期 env 注入、不散硬编码」同款语义）：
 * - path：跨应用入口地址走 VITE_APP_*_BASE，缺省回退 nginx 同域前缀（/cam/ 等）。
 * - enabled：部署可用 VITE_APP_*_ENABLED="false" 关闭某个应用（整条隐藏，含默认收藏）。
 *
 * Vite 静态替换约束（硬性）：import.meta.env.VITE_X 仅在「字面量访问」时被构建期替换，
 * import.meta.env[动态 key] 不会（恒 undefined）。故每个应用的 path/enabled 必须逐条
 * 字面量书写，不能用循环或变量索引——这是本文件显式展开而非 map 生成的原因。
 */
import { Bell, Grid, MagicStick, Monitor, SetUp } from "@element-plus/icons-vue";
import type { Component } from "vue";

/** 平台应用条目（配置形态，驱动平台导航面板的应用列与默认收藏） */
export interface PlatformApp {
  /** 全局唯一 key（收藏键、star testid 后缀） */
  key: string;
  /** 入口名 */
  title: string;
  /** 副标题（应用列展示；收藏列展示为「平台 · {desc}」） */
  desc: string;
  /** element-plus icon 组件（面板图标位） */
  icon: Component;
  /** 图标卡片底色（参照图的彩色圆角图标块；仅视觉，非语义） */
  color: string;
  /** 所属职能分组（面板按此分列；取值见 GROUP_ORDER） */
  group: string;
  /** 目标路径：站内路由 / 跨应用同域路径（含前缀） */
  path: string;
  /** true = 新标签打开（跨应用）；false = 站内 router.push */
  external: boolean;
  /** 是否启用（env 可关；关闭则应用列与默认收藏均不含该条） */
  enabled: boolean;
}

/** 职能分组展示顺序（面板列从左到右；每组一个圆点色，仅视觉区分） */
export const GROUP_ORDER: readonly { title: string; dot: string }[] = [
  { title: "资源与身份", dot: "#5e6ad2" },
  { title: "自动化运维", dot: "#0ea5e9" },
  { title: "监控", dot: "#f59e0b" },
];

/**
 * env 开关解析：仅显式置 "false" 关闭，其余（未设置 / 其它值）均视为启用（默认开）。
 * 字面量访问满足 Vite 静态替换约束。
 */
const CAM_ENABLED = import.meta.env.VITE_APP_CAM_ENABLED !== "false";
const OPSAGENT_ENABLED = import.meta.env.VITE_APP_OPSAGENT_ENABLED !== "false";
const CMDB_ENABLED = import.meta.env.VITE_APP_CMDB_ENABLED !== "false";
const WATCHALERT_ENABLED = import.meta.env.VITE_APP_WATCHALERT_ENABLED !== "false";

/**
 * 息壤平台顶层应用（跨应用切换入口）。
 *
 * - 控制台：本应用，站内跳首页（侧边栏已承载内部模块，此处只作应用级回首页）；恒启用、无 env。
 * - 云管 / 运维 Agent / CMDB / 监控告警：nginx 同域路径，新标签打开、共享 cookie 免重复登录；
 *   地址走 VITE_APP_*_BASE，启用走 VITE_APP_*_ENABLED。
 */
export const PLATFORM_APPS_ALL: readonly PlatformApp[] = [
  {
    key: "app-console",
    title: "控制台",
    desc: "统一身份与访问",
    icon: Grid,
    color: "#5e6ad2",
    group: "资源与身份",
    path: "/workbench",
    external: false,
    enabled: true,
  },
  {
    key: "app-cmdb",
    title: "CMDB",
    desc: "资源模型与拓扑",
    icon: SetUp,
    color: "#0d9488",
    group: "资源与身份",
    path: import.meta.env.VITE_APP_CMDB_BASE ?? "/cmdb/",
    external: true,
    enabled: CMDB_ENABLED,
  },
  {
    key: "app-cam",
    title: "云管",
    desc: "多云资源管理",
    icon: Monitor,
    color: "#0ea5e9",
    group: "自动化运维",
    path: import.meta.env.VITE_APP_CAM_BASE ?? "/cam/",
    external: true,
    enabled: CAM_ENABLED,
  },
  {
    key: "app-opsagent",
    title: "运维 Agent",
    desc: "AIOps 智能运维",
    icon: MagicStick,
    color: "#7c3aed",
    group: "自动化运维",
    path: import.meta.env.VITE_APP_OPSAGENT_BASE ?? "/opsagent/",
    external: true,
    enabled: OPSAGENT_ENABLED,
  },
  {
    key: "app-watchalert",
    title: "监控告警",
    desc: "告警中心",
    icon: Bell,
    color: "#f59e0b",
    group: "监控",
    path: import.meta.env.VITE_APP_WATCHALERT_BASE ?? "/watchalert/",
    external: true,
    enabled: WATCHALERT_ENABLED,
  },
];

/** 启用态应用（平台导航应用列与默认收藏的共同来源） */
export const PLATFORM_APPS: readonly PlatformApp[] = PLATFORM_APPS_ALL.filter(
  (a) => a.enabled,
);

/** 职能分组（面板按列渲染）：标题 + 圆点色 + 该组启用态应用 */
export interface PlatformGroup {
  title: string;
  dot: string;
  apps: PlatformApp[];
}

/**
 * 按 GROUP_ORDER 聚合启用态应用成列（空组自动剔除，避免 env 关尽某组后留空列）。
 * 面板直接 v-for 此结构，分组与成员均由单一事实源派生，无二次硬编码。
 */
export const PLATFORM_GROUPS: readonly PlatformGroup[] = GROUP_ORDER.map(
  (g) => ({
    title: g.title,
    dot: g.dot,
    apps: PLATFORM_APPS.filter((a) => a.group === g.title),
  }),
).filter((g) => g.apps.length > 0);

/** 收藏列副标题前缀（与原 DEFAULT_FAVS 文案一致：「平台 · {desc}」） */
export function favDesc(app: PlatformApp): string {
  return `平台 · ${app.desc}`;
}
