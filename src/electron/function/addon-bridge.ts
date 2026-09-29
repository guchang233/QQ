/*
 * @FileDescription: 插件宿主的主进程桥（框架层，与具体插件无关）
 * @Author: WorkBuddy
 * @Date: 2026/09/29
 * @Version: 1.1
 *
 * 两类通道：
 *   addon:store:*  —— 插件私有数据存取（落 <userData>/plugins/<pluginId>/）
 *   addon:file:*   —— 插件通用文件能力（写导出文件 / 选目录 / 资源管理器定位）
 *
 * 与具体插件绑定的能力（如 Laya 模型运行时的 addon:laya:*）由该插件自带的
 * 模块注册（见 addon-laya.ts 的 regLayaIpc），本文件保持插件框架的通用性。
 *
 * 渲染进程侧统一通过 preload 暴露的 window.electron.ipcRenderer 调用，
 * 因此不需要改动 preload 的 contextBridge 白名单。
 */

import fs from 'fs'
import path from 'path'
import log4js from 'log4js'
import { app, dialog, ipcMain, shell } from 'electron'

const logger = log4js.getLogger('addon-bridge')

/** 插件数据根目录 */
function pluginDataDir(pluginId: string): string {
    const safe = String(pluginId ?? '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'unknown'
    return path.join(app.getPath('userData'), 'plugins', safe)
}

/** 键名转安全文件名（保留可读性，避免路径穿越） */
function keyToFile(key: string): string {
    const safe = String(key ?? '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'data'
    return `${safe}.json`
}

function readPluginData(pluginId: string): Record<string, any> {
    const dir = pluginDataDir(pluginId)
    const result: Record<string, any> = {}
    try {
        if (!fs.existsSync(dir)) return result
        for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith('.json')) continue
            try {
                const raw = fs.readFileSync(path.join(dir, file), 'utf8')
                result[file.slice(0, -5)] = JSON.parse(raw)
            } catch (e) {
                logger.error(e as Error, `插件数据读取失败：${pluginId}/${file}`)
            }
        }
    } catch (e) {
        logger.error(e as Error, `插件数据目录读取失败：${pluginId}`)
    }
    return result
}

function writePluginData(pluginId: string, key: string, value: any) {
    const dir = pluginDataDir(pluginId)
    const file = path.join(dir, keyToFile(key))
    try {
        if (value === null || value === undefined) {
            if (fs.existsSync(file)) fs.unlinkSync(file)
            return
        }
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        // 先写临时文件再改名，避免写入中断留下半个 JSON
        const tmp = `${file}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(value), 'utf8')
        fs.renameSync(tmp, file)
    } catch (e) {
        logger.error(e as Error, `插件数据写入失败：${pluginId}/${key}`)
    }
}

/** 防止窗口重建时重复注册（ipcMain.handle 二次注册会抛错） */
let registered = false

/** 注册插件相关 IPC */
export function regAddonIpc() {
    if (registered) return
    registered = true

    //#region == 插件私有存储 ==================================================
    ipcMain.handle('addon:store:getAll', (_, pluginId: string) => {
        return readPluginData(pluginId)
    })
    ipcMain.on('addon:store:set', (_, pluginId: string, key: string, value: any) => {
        writePluginData(pluginId, key, value)
    })
    ipcMain.handle('addon:store:clear', (_, pluginId: string) => {
        const dir = pluginDataDir(pluginId)
        try {
            if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
            return true
        } catch (e) {
            logger.error(e as Error, `插件数据清空失败：${pluginId}`)
            return false
        }
    })
    ipcMain.handle('addon:store:null', (_, category: string) => {
        // 预留：分类清理（例如只清某个插件的分析结果）
        void category
        return true
    })
    //#endregion

    //#region == 插件通用文件能力 ===============================================
    // 插件的导出/归档走独立通道，而不是借用 addon:store:set：导出目录由插件
    // 与用户指定，文件是给人看的，不该混进插件私有数据的命名空间里。
    ipcMain.handle('addon:file:write',
        (_, payload: { dir?: string, name?: string, text?: string }) => {
            const name = String(payload?.name ?? '').replace(/[\\/:*?"<>|]/g, '_').trim()
            if (!name) throw new Error('缺少导出文件名')
            let dir = String(payload?.dir ?? '').trim()
            if (!dir) {
                // 未指定目录时落到插件数据根目录下的 exports/
                dir = path.join(app.getPath('userData'), 'plugins', 'exports')
            }
            // basename 再兜一层，防止拼接出目录外的路径
            const target = path.join(dir, path.basename(name))
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(target, String(payload?.text ?? ''), 'utf8')
            logger.info(`插件文件已写入：${target}`)
            return { path: target }
        })

    ipcMain.handle('addon:file:pickDir', async () => {
        const result = await dialog.showOpenDialog({
            title: '选择导出目录',
            properties: ['openDirectory', 'createDirectory'],
        })
        if (result.canceled || result.filePaths.length === 0) return null
        return result.filePaths[0]
    })

    ipcMain.handle('addon:file:reveal', (_, target: string) => {
        const p = String(target ?? '').trim()
        if (!p || !fs.existsSync(p)) return false
        // 目录直接打开；文件在资源管理器里定位到它
        if (fs.statSync(p).isDirectory()) shell.openPath(p)
        else shell.showItemInFolder(p)
        return true
    })
    //#endregion
}
