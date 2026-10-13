import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

/** 主题档位：仅 light / dark 两档（深色为默认，无 auto 档） */
export type Theme = 'light' | 'dark'

/**
 * 主题 store —— 全局 3 个 store 之一（tech-design Architecture Store 清单）。
 *
 * 持久化口径（Hard Rule）：persistedstate 插件仅本 store 声明 persist（key `hc_theme`），
 * 其余任何 store 不得声明 persist。
 * 主题策略（ui-design §Design System）：深色默认；月/日切换在 html 根节点切 `light`
 * class；选择持久化 localStorage；**不跟随**系统 prefers-color-scheme
 * （与 e-cam-web app store 的 auto 档有意不同，控制台无 auto、无 matchMedia 监听）。
 */
export const useThemeStore = defineStore(
  'theme',
  () => {
    const theme = ref<Theme>('dark')

    /** 主题落到 DOM：浅色挂 html.light；深色为默认态（无 class） */
    const applyTheme = (value: Theme) => {
      document.documentElement.classList.toggle('light', value === 'light')
    }

    // setTheme 同步落 DOM（与 e-cam-web app store 同款）：watch 为 pre-flush 异步，
    // 依赖它会让切换后第一帧仍渲染旧主题
    const setTheme = (value: Theme) => {
      theme.value = value
      applyTheme(value)
    }

    /** 月/日切换：light ↔ dark */
    const toggleTheme = () => {
      setTheme(theme.value === 'light' ? 'dark' : 'light')
    }

    // immediate：store 实例化即应用当前主题；persist 水合（$patch 直改 state、
    // 不经 action）改写 theme 时经此 watch 落 DOM —— 刷新后无需额外 init 调用
    // 即恢复上次选择（挂载前无主题闪烁）
    watch(theme, applyTheme, { immediate: true })

    return { theme, setTheme, toggleTheme }
  },
  {
    persist: {
      key: 'hc_theme',
      storage: localStorage,
      pick: ['theme'],
    },
  },
)
