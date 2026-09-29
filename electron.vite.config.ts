import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

import * as viteConfig from './vite.config.ts'

export default defineConfig({
    main: {
        plugins: [
            externalizeDepsPlugin(),
            viteStaticCopy({
                targets: [
                    // overwrite: false → 走 fs.cp 的合并复制（force=false），
                    // 不会为了清场而先删除 out/main/assets 下已存在的文件。
                    // 默认的 overwrite: true 每次构建都先删 280+ 个图标，
                    // 既慢又会触发本地批量删除保护，导致 dev / build 中途被打断。
                    { src: 'src/electron/assets', dest: './', overwrite: false },
                ]
            })
        ],
        build: {
            // 主进程源码位于 src/electron，不在 electron-vite 约定的 src/main 下，
            // 必须显式给出入口。
            lib: { entry: 'src/electron/index.ts' },
            // 不自动清空 outDir：产物是覆盖式写入，清理只会拖慢构建并触发
            // 上述批量删除保护。
            emptyOutDir: false,
        }
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
        build: {
            emptyOutDir: false,
        }
    },
    renderer: viteConfig.configFactory('out/renderer'),
})
