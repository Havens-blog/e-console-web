<p align="center">
  <img src="public/xirang-mark.svg" width="96" alt="息壤" />
</p>

<h1 align="center">息壤 · 控制台</h1>

<p align="center">平台控制台 · 统一入口 + 身份治理 + 权限管理 + 工作台</p>

---

> **仓库沿革**：本仓原名 `Houtu`，已更名为 **`Xirang`（息壤运维平台）**，
> 旧 URL 由 GitHub 自动 301 重定向至新名。本地 `origin` 现指向
> `https://github.com/Havens-blog/Xirang.git`。

## 项目简介

**息壤控制台**（`haven-console`）是息壤运维平台的统一管理前端，定位为
**独立纯前端 SPA**——零后端、零数据库，直接调用 [eiam](../eiam) 既有 HTTP
API，**不自造鉴权**：登录态复用 eiam 写入的共享 Redis session（与
e-cam-service `EcmdbAuthMiddleware` 同源），服务端授权由 eiam 强制。

功能域覆盖：

| 域 | 模块（`src/views`） |
| --- | --- |
| 统一入口 | `login` 登录 · `tenant-select` 租户选择 |
| 身份治理 | `users` 用户 · `organizations` 组织 · `tenants` 租户 · `identity-sources` 身份源 |
| 权限管理 | `roles` 角色 · `authorizations` 授权 · `policies` 策略 |
| 工作台 | `workbench` 工作台 |
| 其他 | `error` 错误页 |

数据流（单向）：`views → stores → api/eiamAxios →(HTTP)→ eiam`。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | Vue 3.5 + Vite 7 + TypeScript 5.9 |
| 路由 / 状态 | Vue Router 4.6 + Pinia 3（`persistedstate`，仅持久化 `theme`） |
| UI | Element Plus 2.11 + `@element-plus/icons-vue`，`unplugin-*` 按需自动引入 |
| 样式 | Sass + `theme-variables.scss` / `element-theme.scss`（Linear 靛紫令牌，深色默认） |
| HTTP | axios（`eiamAxios`：`withCredentials` + cookie 注入 Bearer + 401 跳登录 + 15s 超时） |
| 单测 | Vitest 4.1 |
| E2E | Playwright 1.55（chromromium 矩阵，真实浏览器） |
| 包管理 | pnpm 10.30.3 · Node 20 |

> 技术栈与 [e-cam-web](../e-cam-web) 完全同源，前端共享件（令牌、Element Plus 主题、
> `xirang-mark.svg` 品牌标识）通过 `shared-hashes.json` 拷贝面登记 + CI 漂移对比锁一致。

## 目录结构

```
haven-console/
├── public/                 # 静态资产（xirang-mark.svg 品牌标识 + 登录封面）
├── src/
│   ├── api/                # eiam 客户端 + 类型（request/eiam.ts 拦截器、auth/users/...）
│   ├── stores/             # Pinia（10 个：3 全局 + 7 页面级，统一 list 契约）
│   ├── router/             # 路由 + 全局守卫（401/403/租户上下文）
│   ├── layouts/            # 主布局（侧边栏 + header）
│   ├── components/         # 共享 UI（TenantSelector / StatusBadge / 文案契约渲染）
│   ├── views/              # 11 页面（见上表）
│   ├── composables/        # 组合式逻辑
│   ├── config/             # permission-codes 等常量
│   ├── utils/              # cookie、文案契约 keys、校验
│   └── assets/             # 样式与图片
├── e2e/                    # Playwright 验收测试
├── nginx/                  # 同域反代配置（/api/iam -> eiam，静态托管）
├── scripts/                # CI 辅助（gzip 预算、漂移对比、gz 预生成）
├── index.html              # 入口（title: 息壤 · 控制台）
├── vite.config.ts · tsconfig*.json · eslint.config.js
└── shared-hashes.json      # 拷贝面登记（与 e-cam-web 源文件 sha256 对账）
```

## 快速开始

前置：Node 20、pnpm 10.30.3、本地 [eiam](../eiam) 运行于 `:9000`（控制台
直调其 HTTP API，登录态走共享 session）。

```bash
pnpm install               # 安装依赖（frozen lockfile）
pnpm dev                   # 本地开发（Vite，默认 5173）
pnpm build                 # 生产构建
pnpm build:gz              # 构建 + 预生成 .gz（供 nginx gzip_static）
pnpm preview               # 预览构建产物
```

测试与质量：

```bash
pnpm test                  # Vitest 单测
pnpm test:e2e              # Playwright E2E（真实 chromium）
pnpm typecheck             # vue-tsc 类型检查
pnpm lint                  # ESLint 检查（0 error / 0 warning 基线）
pnpm lint:fix              # 自动修复
```

## CI 闸门（`.github/workflows/ci.yml`）

push / PR 至 `main` 触发，五条并行硬闸门全绿方可合入：

- **Typecheck & Build**：`vue-tsc -b` + `build:gz`，上传 `dist` 产物
- **Vitest**：单测，失败上报 junit annotation + 产物留存
- **ESLint**：0 error / 0 warning 基线
- **Gzip Budget**：`dist/**/*.gz` ≤ 300KB（四桶分解，超限 fail）
- **Drift Compare**：以 [e-cam-web](https://github.com/Havens-blog/e-cam-web)
  `main` 源文件重算 sha256，对账 `shared-hashes.json`，拷贝面零漂移

## 关联仓库

息壤为**单仓收编**形态，下列模块均已并入本仓（分支以 `console/`、
`ecam-service/`、`ecam-web/` 等命名空间前缀防互踩），本地工作区为各自独立
clone 的并行开发副本：

| 模块 | 本地目录 | 角色 |
| --- | --- | --- |
| [e-iam](https://github.com/Havens-blog/e-iam) | `eiam` | 身份与访问管理服务（控制台直调的 HTTP API 后端） |
| [e-cam-service](https://github.com/Havens-blog/e-cam-service) | `e-cam-service` | 摄像/资源管理服务 |
| [e-cam-web](https://github.com/Havens-blog/e-cam-web) | `e-cam-web` | 摄像/资源管理前端（共享件漂移对账源） |
| [e-cmdb-service](https://github.com/Havens-blog/e-cmdb-service) | `e-cmdb-service` | CMDB 服务 |
| [e-cmdb-web](https://github.com/Havens-blog/e-cmdb-web) | `e-cmdb-web` | CMDB 前端 |
| [e-common-go](https://github.com/Havens-blog/e-common-go) | `e-common-go` | Go 公共库 |
| [e-cloudx-sdk](https://github.com/Havens-blog/e-cloudx-sdk) | `e-cloudx-sdk` | 云商 SDK |
| [opsagent](https://github.com/Havens-blog/opsagent) | `opsagent` | 运维 Agent 服务 |

## 设计文档

产品与工程细则见工作区 `docs/features/platform-console/`：

- [`design/tech-design.md`](../docs/features/platform-console/design/tech-design.md) — 技术设计
- [`ui/ui-design.md`](../docs/features/platform-console/ui/ui-design.md) — UI 设计
- [`tasks/`](../docs/features/platform-console/tasks/) — 任务记录与决策沿革
