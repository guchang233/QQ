/**
 * 插件入口：Laya 意图与情绪感知（workbuddy.laya-insight）
 *
 * 生命周期：
 *   activate(host)  —— 注册设置项、注入样式、挂悬浮窗与工具栏按钮、接管会话/消息变化；
 *   deactivate()    —— 取消在跑的任务、卸载悬浮窗、注销按钮、清理渲染槽与样式。
 *
 * **默认行为：完全不读取、不分析聊天记录。**
 * 这里不再有任何「进入会话 / 收到新消息 → 自动分析」的路径，所有推理只能由
 * 悬浮窗触发（`store.isArmed(chatKey)` 是唯一的授权位）：
 *   - 「分析当前会话」按钮 —— 单次分析，跑完就停；
 *   - 「持续分析本会话」开关 —— 用户在悬浮窗里手动打开后，进入该会话与收到
 *     新消息才会继续分析，关掉立刻停止。
 * 会话切换时只会回填「已经算好并存下来的结果」，不触发任何模型推理。
 *
 * 这个文件不使用任何 bare import：插件是被 <base>/plugins/index.json 列出的
 * 独立 ESM 产物，运行时由浏览器原生 import() 加载，Vue 等依赖一律从 host 取。
 */

import { createRuntime } from './laya/runtime.js'
import { PluginStore } from './analysis/store.js'
import { AnalysisPipeline } from './analysis/pipeline.js'
import { openPortrait } from './ui/portrait-panel.js'
import { registerSettings, createPluginManagerPanel, confirmClearAccount } from './ui/settings.js'
import { mountDock } from './ui/dock.js'
import { CARD_ID, PLUGIN_ID, PLUGIN_NAME } from './ui/constants.js'

/** 会话切换后延迟一会儿再开跑，避免和客户端的加载历史抢资源 */
const ANALYZE_DELAY = 800

let host = null
let runtime = null
let store = null
let pipeline = null
let stopHandles = []
let analyzeTimer = null
let styleEl = null
let lastChatKey = ''
let unregisterButton = null
let unmountDock = null

//#region == 样式注入 -----------------------------------------------------------

async function injectStyle() {
    if (styleEl) return
    try {
        const response = await fetch(new URL('./ui/style.css', import.meta.url))
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const css = await response.text()
        styleEl = document.createElement('style')
        styleEl.id = `plugin-style-${PLUGIN_ID.replace(/\./g, '-')}`
        styleEl.textContent = css
        document.head.appendChild(styleEl)
    } catch (e) {
        host.log.debug(`样式注入失败：${e && e.message}`)
    }
}

function removeStyle() {
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
    styleEl = null
}

//#endregion

//#region == 窗口按钮隐藏 -------------------------------------------------------

/**
 * 客户端的窗口按钮（最小化 / 关闭）不是 Electron 原生 frame，而是 App.vue 里
 * 自绘的 `.top-bar .controller`。这里用插件注入的样式隐藏它，不动客户端源码：
 * 关掉设置里的开关（或停用插件）样式随之移除，按钮立刻回来。
 */
const WIN_BUTTONS_STYLE_ID = 'plugin-style-workbuddy-window-buttons'
const WIN_BUTTONS_CSS = '.top-bar .controller { display: none !important; }'

let winButtonsStyleEl = null

function applyWindowButtons(hide) {
    if (hide) {
        if (winButtonsStyleEl) return
        winButtonsStyleEl = document.createElement('style')
        winButtonsStyleEl.id = WIN_BUTTONS_STYLE_ID
        winButtonsStyleEl.textContent = WIN_BUTTONS_CSS
        document.head.appendChild(winButtonsStyleEl)
    } else if (winButtonsStyleEl) {
        winButtonsStyleEl.parentNode?.removeChild(winButtonsStyleEl)
        winButtonsStyleEl = null
    }
}

function syncWindowButtonsFromSettings() {
    applyWindowButtons(store?.getSettings().hideWindowButtons === true)
}

//#endregion

//#region == 归档导出 -----------------------------------------------------------

/**
 * 把当前账号的全部分析结果导出为本地文件（JSON 完整数据 + Markdown 摘要）。
 *
 * 兼带「防卡顿」职能：记录长期堆在插件存储里，设置页 / 悬浮窗的统计和界面
 * 回填都会越来越慢；导出后可选择清空，把体积一次性压回去。
 */
async function exportArchiveNow() {
    const uin = currentUin()
    if (!uin) return { error: '当前没有登录账号' }
    const { buildArchive } = await import('./analysis/archive.js')
    const archive = buildArchive({ store, uin })
    if (!archive || !archive.files || archive.files.length === 0 || archive.stats.messages === 0) {
        return { error: '还没有可导出的分析结果' }
    }
    const settings = store.getSettings()
    const dir = settings.archiveDir || ''
    const written = []
    try {
        for (const file of archive.files) {
            const result = await runtime.writeFile({ dir, name: file.name, text: file.text })
            written.push(result?.path ?? file.name)
        }
    } catch (e) {
        host.log.error('归档导出失败', e)
        return { error: (e && e.message) || String(e), written }
    }
    store.saveSettings({
        lastExport: { at: Date.now(), files: written, stats: archive.stats },
    })
    host.log.debug(
        `归档导出完成：${written.join('、')}（${archive.stats.chats} 会话 / ${archive.stats.messages} 条）`)
    let cleared = false
    if (settings.archiveClearAfterExport) {
        pipeline.cancel()
        store.clearAccount(uin)
        host.clearMessageDecorations()
        cleared = true
    }
    return { paths: written, stats: archive.stats, bytes: archive.bytes, cleared }
}

/** 选择归档导出目录并保存 */
async function pickArchiveDir() {
    const dir = await runtime.pickDirectory()
    if (!dir) return null
    store.saveSettings({ archiveDir: dir })
    return dir
}

/** 在资源管理器里打开导出目录（没自定义目录时定位上次导出的文件） */
async function openArchiveDir() {
    const settings = store.getSettings()
    if (settings.archiveDir) {
        const ok = await runtime.revealPath(settings.archiveDir)
        if (!ok) host.alert('err', '该目录不存在了，请重新选择导出目录')
        return ok ? settings.archiveDir : null
    }
    const lastFile = settings.lastExport?.files?.[0]
    if (lastFile) {
        await runtime.revealPath(lastFile)
        return lastFile
    }
    host.alert('info',
        '还没有导出目录。不选目录时默认导出到客户端数据目录下的 laya-insight-archive，先导出一次即可。')
    return null
}

//#endregion

//#region == 当前会话信息 -------------------------------------------------------

function currentChat() {
    const chatStore = host.stores.chat()
    const show = chatStore.chatInfo && chatStore.chatInfo.show
    if (!show || !show.type || !show.id) return null
    return {
        chatType: show.type,
        chatId: show.id,
        chatKey: `${show.type}:${show.id}`,
        name: show.name || String(show.id),
        messages: chatStore.messageList || [],
        members: show.type === 'group'
            ? (chatStore.chatInfo.info.group_members || []).length
            : null,
    }
}

function currentUin() {
    const authStore = host.stores.auth()
    return String(authStore.loginInfo?.uin ?? '')
}

//#endregion

//#region == 分析调度 -----------------------------------------------------------

/** 取消待执行的定时任务 */
function cancelScheduled() {
    if (analyzeTimer) {
        clearTimeout(analyzeTimer)
        analyzeTimer = null
    }
}

/**
 * 安排一次分析（去抖）。
 *
 * 只有「该会话已在悬浮窗里被手动开启」时才放行——这是自动路径上的唯一闸门，
 * 并且会在真正执行前再查一次，避免中途被关掉开关后仍然跑一轮。
 */
function scheduleAnalyze(reason) {
    cancelScheduled()
    if (!store.isArmed(currentChat()?.chatKey ?? '')) return
    analyzeTimer = setTimeout(() => {
        analyzeTimer = null
        if (!store.isArmed(currentChat()?.chatKey ?? '')) return
        runAnalyze(reason).catch((e) => host.log.error('分析失败', e))
    }, ANALYZE_DELAY)
}

/**
 * 执行一次分析 + 刷新徽标。
 * @returns {Promise<object>} 统计结果；失败时返回 `{ error }`，不抛异常
 */
async function runAnalyze(reason, onProgress) {
    const chat = currentChat()
    const uin = currentUin()
    if (!chat || !uin) return { error: '当前没有打开的会话' }

    let result = null
    try {
        result = await pipeline.analyzeChat({
            uin,
            chatType: chat.chatType,
            chatId: chat.chatId,
            selfId: uin,
            messages: chat.messages,
            onProgress: (info) => {
                try {
                    onProgress?.(info)
                } catch (e) {
                    host.log.debug(`进度回调异常：${(e && e.message) || e}`)
                }
                if (info && info.phase === 'done') {
                    host.log.debug(
                        `${reason}：新增 ${info.analyzed} 条，累计 ${info.total} 条，${info.rate}/s`,
                    )
                }
            },
        })
        if (result && result.reason) host.log.debug(`${reason}：${result.reason}`)
    } catch (e) {
        const name = e && e.name
        if (name === 'ModelNotReadyError') {
            // 用 error 级别而不是 info：客户端 Logger 按 log_level 过滤，默认的
            // debug/err 等级下 INFO 会被丢掉，模型问题就会变成"什么都没发生"。
            host.log.error('模型未就绪', e)
            host.alert('err', `Laya 意图感知：${e.message}`)
            return { error: e.message }
        }
        host.log.error('分析异常', e)
        return { error: (e && e.message) || String(e) }
    }

    pipeline.refreshBadge(uin, chat.chatType, chat.chatId, chat.messages)
    return result
}

/** 会话切换：只回填已有结果，不自动分析 */
function onChatChanged() {
    const chat = currentChat()
    const uin = currentUin()
    if (!chat || !uin) {
        pipeline.cancel()
        host.clearMessageDecorations()
        lastChatKey = ''
        return
    }
    if (chat.chatKey === lastChatKey) return
    lastChatKey = chat.chatKey
    pipeline.cancel()
    host.clearMessageDecorations()

    // 这里读的全是插件自己存下来的分析结果，不碰聊天内容，也不做任何推理
    const ids = (chat.messages || []).map((msg) => msg?.message_id).filter(Boolean)
    const restored = pipeline.restoreDecorations(uin, chat.chatKey, ids)
    host.log.debug(`恢复会话 ${chat.chatKey} 的 ${restored} 条已有标签`)
    pipeline.refreshBadge(uin, chat.chatType, chat.chatId, chat.messages)

    if (store.isArmed(chat.chatKey)) {
        scheduleAnalyze('进入已开启的会话')
    } else {
        host.log.debug(`会话 ${chat.chatKey} 未开启分析，跳过（可在悬浮窗中开启）`)
    }
}

/** 消息列表变化：仅在用户已开启该会话分析时跟随 */
function onMessagesChanged() {
    const chat = currentChat()
    if (!chat) return
    const uin = currentUin()
    if (!uin) return
    pipeline.refreshBadge(uin, chat.chatType, chat.chatId, chat.messages)
    if (store.isArmed(chat.chatKey) && store.getSettings().followNewMessages) {
        scheduleAnalyze('新消息')
    }
}

//#endregion

//#region == 悬浮窗动作 ---------------------------------------------------------

/** 给悬浮窗用的动作集合，避免把宿主细节漏进 UI 层 */
function dockActions() {
    return {
        getContext() {
            const chat = currentChat()
            if (!chat) return null
            return { chatKey: chat.chatKey, label: chat.name, chat }
        },
        getUin: () => currentUin(),
        isRunning: () => !!pipeline?.isRunning,
        /** 单次分析：不改变授权开关 */
        analyzeNow: (options) => {
            cancelScheduled()
            return runAnalyze(options?.reason ?? '手动分析', options?.onProgress)
        },
        stopAnalyze: () => {
            cancelScheduled()
            pipeline?.cancel()
        },
        clearAccountData: () => confirmClearAccount({ host, store }),
        openPortrait: () => openPortraitPanel(),
        /** 归档导出（JSON + Markdown），可选导出后清空插件内记录 */
        exportArchiveNow,
        pickArchiveDir,
        openArchiveDir,
        /**
         * 应用推理加速设置：provider / 线程 / 执行模式走主进程会话重建，
         * 批大小留在渲染侧。返回刷新后的模型状态。
         */
        applyRuntime: async (patch = {}) => {
            const saved = {}
            if (patch.batchSize !== undefined) {
                runtime.setBatchSize(patch.batchSize)
                saved.batchSize = runtime.batchSize
            }
            if (Object.keys(saved).length) store.saveSettings(saved)
            const conf = {}
            if (patch.provider !== undefined) conf.provider = patch.provider
            if (patch.threads !== undefined) conf.threads = patch.threads
            if (patch.executionMode !== undefined) conf.executionMode = patch.executionMode
            if (Object.keys(conf).length) {
                return await runtime.configure(conf)
            }
            return await runtime.refreshStatus()
        },
        /** 预热模型：立即装载，让 provider 回退当场暴露 */
        prewarm: () => runtime.prewarm(),
        openPluginManager: () => {
            const panel = createPluginManagerPanel({ host })
            host.openPanel({ title: '插件管理', component: panel, full: false })
        },
    }
}

//#endregion

//#region == 画像面板 -----------------------------------------------------------

async function openPortraitPanel() {
    const chat = currentChat()
    const uin = currentUin()
    if (!chat || !uin) {
        host.alert('err', '请先打开一个会话')
        return
    }
    const { openPortrait } = await import('./ui/portrait-panel.js')
    await openPortrait({ host, runtime, store, pipeline, chat, uin })
}

//#endregion

//#region == 生命周期 -----------------------------------------------------------

export async function activate(pluginHost) {
    host = pluginHost
    host.log.info(`已启用，客户端版本 ${host.host.clientVersion}`)

    // 注意顺序：store 先建（运行时工厂要读 backendMode / API 配置）
    store = new PluginStore(host)
    runtime = createRuntime(host, store)
    pipeline = new AnalysisPipeline({ host, runtime, store })

    // 本地模式：把已配置的模型目录写给主进程。主进程的模型运行时是进程级
    // 状态（客户端重启、主进程重建都会丢），所以这里总是重新下发一次。
    // 未配置目录时不强行写入——主进程会按候选目录自动探测
    // （LAYA_MODEL_DIR / 应用资源目录 / <userData>/models/laya 等）。
    if (store.getSettings().backendMode !== 'api') {
        const rawDir = host.option.get('plugin_laya_model_dir', '')
        if (rawDir) {
            runtime.configure({ modelDir: rawDir }).catch((e) => {
                host.log.error('下发模型目录失败', e)
            })
        }
    }

    const actions = dockActions()

    // 窗口按钮隐藏：默认关（设置里可开），要在样式注入后立刻应用
    syncWindowButtonsFromSettings()

    // 「设置 → 附加」卡片
    registerSettings({
        host,
        runtime,
        store,
        pipeline,
        openPortrait: openPortraitPanel,
        openPluginManager: actions.openPluginManager,
        exportArchive: exportArchiveNow,
        pickArchiveDir,
        openArchiveDir,
        openDock: () => {
            store.saveDockState({ open: true })
            host.emit('setting:changed', { key: 'dockOpen', value: true })
        },
    })

    await injectStyle()

    // 悬浮窗：插件内容管理中心（也是分析授权入口）
    try {
        unmountDock = mountDock({ host, runtime, store, actions })
        // 渲染期异常会被 errorHandler 吞掉、只留一个空容器，所以挂载后显式数一次节点。
        // 结果同时写进插件自己的存储：客户端的日志等级默认是 debug，而它的 Logger
        // 在 debug 等级下只放行 DEBUG / UI，INFO 会被滤掉——出问题时这份记录是唯一
        // 能直接看到的现场（`<userData>/plugins/workbuddy.laya-insight/dock_mount.json`）。
        const nodes = document.querySelectorAll(
            `#plugin-dock-${PLUGIN_ID.replace(/\./g, '-')} *`).length
        host.store.set('dock_mount', { at: Date.now(), nodes, url: location.href })
        if (nodes > 0) host.log.debug(`悬浮窗已挂载（${nodes} 个节点）`)
        else host.log.error('悬浮窗挂载后没有生成任何节点')
    } catch (e) {
        host.store.set('dock_mount', { at: Date.now(), nodes: -1, error: String(e) })
        host.log.error('悬浮窗挂载失败', e)
    }

    // 工具栏入口
    unregisterButton = host.addToolbarButton({
        id: `${PLUGIN_ID}:portrait`,
        title: '人物画像（本地 Laya）',
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M399 384.2c16.7-30.7 26-65.1 26-101.2 0-59.6-24.2-113.6-63.3-152.8l.1-.1-30.5-30.5C296.5 64.9 245 48 192 48 86 48 0 134 0 240c0 53 21 101 55.9 135.9L24.9 407c-5.1 5.1-8 12-8 19.2V488c0 13.3 10.7 24 24 24H88c13.3 0 24-10.7 24-24 0-13.3 10.7-24 24-24h24c13.3 0 24-10.7 24-24 0-13.3 10.7-24 24-24h35.8c3.8 0 7.5-.9 10.8-2.6l56.3-28.1c36.1-18 65-46.4 88.1-80.1zM112 224a32 32 0 1 1 0-64 32 32 0 1 1 0 64zm80-64a32 32 0 1 1 0-64 32 32 0 1 1 0 64zm96 0a32 32 0 1 1 0-64 32 32 0 1 1 0 64z"/></svg>',
        onClick: () => {
            openPortraitPanel().catch((e) => host.log.error('打开人物画像失败', e))
        },
    })

    // 会话 / 消息监听
    const chatStore = host.stores.chat()
    stopHandles.push(host.vue.watch(
        () => [
            chatStore.chatInfo.show.type,
            chatStore.chatInfo.show.id,
        ],
        () => onChatChanged(),
        { immediate: true },
    ))
    stopHandles.push(host.vue.watch(
        () => (chatStore.messageList || []).length,
        () => onMessagesChanged(),
    ))

    // 设置变化时同步到运行时
    host.on('setting:changed', (payload) => {
        if (!payload) return
        if (payload.key === 'showLabels' && payload.value === false) {
            host.clearMessageDecorations()
        }
        if (payload.key === 'showBadge' && payload.value === false) {
            const chat = currentChat()
            if (chat) host.unsetChatBadge(chat.chatType, chat.chatId)
        }
        // 窗口按钮的显隐是即时生效的样式开关
        if (payload.key === 'hideWindowButtons') {
            applyWindowButtons(payload.value === true)
        }
        // 推理后端切换需要重建运行时，重新加载界面后生效
        if (payload.key === 'backendMode') {
            host.alert('info', '推理后端已切换，重新加载界面后生效（插件管理 → 重新加载界面）')
        }
        // 关掉分析授权就立刻停掉在跑的任务，别让"关不掉"变成意外
        if (payload.key === 'armedChats') {
            const chat = currentChat()
            if (chat && !store.isArmed(chat.chatKey)) {
                cancelScheduled()
                pipeline.cancel()
            }
        }
    })

    host.log.info('装载完成（分析默认关闭，请在悬浮窗中手动开启）')
}

export async function deactivate() {
    cancelScheduled()
    pipeline?.cancel()
    stopHandles.forEach((stop) => {
        try {
            stop?.()
        } catch { /* 忽略 */ }
    })
    stopHandles = []
    if (unmountDock) {
        try {
            unmountDock()
        } catch { /* 忽略 */ }
        unmountDock = null
    }
    if (unregisterButton) unregisterButton()
    unregisterButton = null
    host?.clearMessageDecorations()
    applyWindowButtons(false)
    removeStyle()
    try {
        await runtime?.release()
    } catch { /* 忽略 */ }
    host?.log.info('已停用')
}

export { PLUGIN_ID, PLUGIN_NAME }
