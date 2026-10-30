import { createPinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import { useThemeStore } from "./stores/theme";
import { useUserStore } from "./stores/user";
import { useTenantStore } from "./stores/tenant";
import {
  getPageEnterTenantSnapshot,
  __resetPageEnterTenantSnapshot,
} from "./router";
import { enforceWriteGuard } from "./utils/tenantGuard";

// 主题令牌（Linear 靛紫，深色默认 + 浅色双主题；拷贝自 e-cam-web 同名文件，
// sha256 × 源 commit 登记于 shared-hashes.json，CI 漂移对比由 2.11 承接）
import "./assets/styles/theme-variables.scss";
import "./assets/styles/element-theme.scss";
// 对比度覆盖（本仓自有文件，不参与跨仓漂移对比）：主题令牌在此叠加修正，
// 从而无需改动受 shared-hashes.json 锚定的拷贝面。
import "./assets/styles/contrast-overrides.scss";
// 尊重系统「减弱动效」偏好（WCAG 2.3.3 取向）；本仓自有文件，不参与跨仓漂移对比。
import "./assets/styles/reduced-motion.scss";

// 装配：Vue / Router / Pinia 三件基础设施 + 主题恢复。
// 数据流单向闭环 view → stores → api/eiamAxios 自 2.4（请求层）/ 2.6（守卫）/
// 2.7（全局 stores）起逐层接入。
const app = createApp(App);

const pinia = createPinia();
// persistedstate 全局挂载：仅 theme store 声明 persist（key hc_theme），
// 其余任何 store 不得声明 persist（tech-design Architecture 持久化口径）
pinia.use(piniaPluginPersistedstate);

app.use(pinia);
app.use(router);

// 挂载前实例化 theme store：persist 水合 + html.light 应用先行，避免主题闪烁
useThemeStore();

app.mount("#app");

// ---- E2E 调试钩子（localhost 限定，永不暴露于生产部署）----
// 任务 3.4 S-M2-06 写前守卫负向场景所需：在真实浏览器中制造跨标签租户切换
// 后的 stale-snapshot 条件并调用 enforceWriteGuard（3.1 工具，4.x/5.x list store
// 的写前守卫公共依赖），验证「错租户写被守卫阻断 + location.replace 自愈」。
//
// 仅暴露既有函数（enforceWriteGuard / 快照读 / 快照复位 / fetchProfile / currentTenantId
// 只读），无新逻辑、不绕过鉴权（console 访问本即可触达这些能力）；hostname 非
// localhost/127.0.0.1 时一律不挂载，生产部署（非 localhost）零暴露。
const isE2EHost =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1");
if (isE2EHost) {
  void Object.assign(window, {
    __hcDebug: {
      enforceWriteGuard,
      getPageEnterTenantSnapshot,
      __resetPageEnterTenantSnapshot,
      fetchProfile: () => useUserStore().fetchProfile(),
      currentTenantId: () => useTenantStore().currentTenantId,
    },
  });
}
