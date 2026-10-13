import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import AutoImport from 'unplugin-auto-import/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import Components from 'unplugin-vue-components/vite'
import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // 加载环境变量
  const env = loadEnv(mode, process.cwd())

  return {
    // 控制台统一挂 /console/ 前缀（nginx 同域反代形态：/console/* → 本应用静态资源，
    // 与 /cam/* → e-cam-web 并列；验收宿主为最终 nginx 形态，见 tech-design 架构）
    base: '/console/',

    // 插件配置：Element Plus 按需自动引入（组件 + API 双 unplugin）
    plugins: [
      vue(),
      AutoImport({
        resolvers: [ElementPlusResolver()],
        imports: ['vue', 'vue-router', 'pinia'],
        dts: 'src/auto-imports.d.ts',
        eslintrc: {
          enabled: false,
        },
      }),
      Components({
        resolvers: [ElementPlusResolver()],
        dts: 'src/components.d.ts',
      }),
    ],

    // 路径别名
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
      extensions: ['.js', '.ts', '.jsx', '.tsx', '.json', '.vue'],
    },

    // 开发服务器配置
    server: {
      // 5173 留给 e-cam-web，控制台用 5174
      port: Number(env.VITE_PORT) || 5174,
      host: true,
      cors: true,
      // API 代理：/api/iam/* -> eiam :9000 /api/*（对齐 nginx.dev.conf 重写规则；
      // 2.4 request/eiam.ts 的请求路径前缀依赖此规则，缺它 dev 直连必 404）
      proxy: {
        '/api/iam': {
          target: 'http://localhost:9000',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/iam/, '/api'),
        },
      },
      warmup: {
        clientFiles: ['./src/main.ts', './src/App.vue'],
      },
    },

    // 构建配置
    build: {
      target: 'es2015',
      outDir: 'dist',
      assetsDir: 'assets',
      sourcemap: mode === 'development',
      minify: 'esbuild',
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        output: {
          // manualChunks 三分包（性能预算承接：element-plus ≤140KB / vue 生态 ≤50KB / 其余）：
          // ① vue 生态 ② element-plus ③ 其余运行时依赖（当前仅 axios）
          manualChunks: {
            'vue-vendor': ['vue', 'vue-router', 'pinia', 'pinia-plugin-persistedstate'],
            'element-plus': ['element-plus'],
            'vendor': ['axios'],
          },
          // 静态资源分类
          chunkFileNames: 'js/[name]-[hash].js',
          entryFileNames: 'js/[name]-[hash].js',
          assetFileNames: '[ext]/[name]-[hash].[ext]',
        },
      },
      esbuild:
        mode === 'production'
          ? {
              drop: ['console', 'debugger'],
            }
          : undefined,
    },

    // 预览服务器配置
    preview: {
      port: 4174,
      host: true,
    },

    // 单元测试（vitest；环境口径与 e-cam-web 完全一致：
    // 默认 node，需要真实 DOM 存储的用例（theme localStorage 持久化 / cookie utils）
    // 以文件级 `// @vitest-environment happy-dom` pragma 切换 —— tech-design §Testing）
    test: {
      globals: true,
      environment: 'node',
      include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
      // 2.1 空骨架零测试文件，`pnpm test` 空跑需可执行；测试落地后此开关自然失效
      passWithNoTests: true,
      // element-plus 组件进入测试图（2.8 MainLayout 用 el-tooltip/el-dropdown/el-icon +
      // ElMessage）后，其 ESM 内的 .css 裸 import 在 node ESM loader 下报「Unknown file
      // extension ".css"」。inline 强制 vite 转译该包，CSS 经 vitest 默认 stub 成空模块，
      // 不污染断言。与 e-cam-web 同款处置。
      server: {
        deps: {
          inline: [/element-plus/],
        },
      },
    },

    // 日志级别
    logLevel: mode === 'development' ? 'info' : 'warn',
  }
})
