import { watch, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/**
 * 把列表页的「关键词筛选」同步到 URL query（iter136）。
 *
 * 背景：列表页筛选此前只存在组件内 ref 与 store 里，URL 不携带任何条件，
 * 于是「设筛选 → 进详情/切走 → 返回」后筛选被清空、必须重新输入。
 * 这对运维是高频损耗。CAM 的证书台账与 tasks 页早已把筛选写进 route.query，
 * console 的 IAM 列表页缺失。
 *
 * 用法：
 *   const keyword = ref('')
 *   useUrlKeyword(keyword)               // 挂载即从 ?search= 回填，变化即写回
 *
 * 约定：query 参数名默认 `search`；用 replace 而非 push，
 * 避免每次输入都往历史栈塞一条（返回键仍是一步回到详情前的列表）。
 */
export function useUrlKeyword(
  keyword: Ref<string>,
  options: { param?: string; replaceOnly?: boolean } = {},
): { clear: () => void } {
  const param = options.param ?? 'search'

  // 容错：组件可能在「没有 router 的上下文」被挂载（单元测试 mount 常见、storybook 同理）。
  // useRoute/useRouter 在无注入时会 warn 并返回 undefined —— 此时**静默降级为不做 URL 同步**，
  // 而不是让页面/测试崩溃。既有 6 个页面的单测就是不带 router 挂载的（iter136 实测 51 例失败）。
  const route = useRoute() as ReturnType<typeof useRoute> | undefined
  const router = useRouter() as ReturnType<typeof useRouter> | undefined
  if (!route || !router) {
    return { clear: () => { keyword.value = '' } }
  }

  // ① 挂载时从 URL 回填（组件重建后恢复筛选）
  const initial = typeof route.query[param] === 'string' ? (route.query[param] as string) : ''
  if (initial) keyword.value = initial

  // ② 关键词变化时写回 URL
  watch(keyword, (val) => {
    const cur = typeof route.query[param] === 'string' ? (route.query[param] as string) : ''
    const next = val.trim()
    if (cur === next) return
    const query = { ...route.query } as Record<string, string>
    if (next) {
      query[param] = next
    } else {
      delete query[param]
    }
    void router.replace({ path: route.path, query })
  })

  return {
    clear: () => {
      keyword.value = ''
    },
  }
}
