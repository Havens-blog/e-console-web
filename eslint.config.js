// ESLint flat config（eslint 9）— 与 e-cam-web/eslint.config.js 保持同构，
// 三应用 lint 规则基线统一：no-explicit-any off、no-unused-vars warn + '_'-前缀豁免
import vueTsEslintConfig from '@vue/eslint-config-typescript'
import pluginVue from 'eslint-plugin-vue'

export default [
    {
        // 构建产物、覆盖率报告与 Playwright 报告不参与 lint；scripts/ 为手写脚本，纳入检查
        ignores: [
            'dist/**',
            'node_modules/**',
            'coverage/**',
            '**/*.d.ts',
            'public/**',
            'playwright-report/**',
            'test-results/**',
        ],
    },
    ...pluginVue.configs['flat/essential'],
    ...vueTsEslintConfig(),
    {
        rules: {
            'vue/multi-word-component-names': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            // '_'-前缀参数/变量是约定占位（预留接口/回调场景）
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        },
    },
]
