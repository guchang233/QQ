/*
 * @FileDescription: 第三方插件宿主（Plugin Host）
 * @Author: WorkBuddy
 * @Date: 2026/09/29
 * @Version: 1.0
 *
 * 说明：
 *   本模块为 Stapxs QQ Lite 提供运行时插件加载能力。客户端内置的扩展点
 *   （Option.registerExtraOptionCard / registerExtraOptionItem、chatView 替换、
 *   custom_css 注入）只能做到「设置项 + 样式」，无法让第三方代码在同一页面里
 *   注册数据钩子与渲染片段，因此这里补上一层插件宿主：
 *
 *   1. 从 `<base>/plugins/index.json` 读取插件登记表（随 vite publicDir 原样拷贝到
 *      构建产物的 plugins/ 目录，运行时可通过 app://plugins/... 访问）；
 *   2. 用原生 import() 动态加载插件入口（不经打包器解析，插件是独立产物）；
 *   3. 向插件暴露一份受限的宿主 API（Vue 运行时、Pinia store、设置读写、
 *      消息装饰槽、会话徽标槽、工具栏按钮槽、弹窗、事件总线、宿主存储）；
 *   4. 插件通过填充「响应式槽位」把结果喂回界面，界面侧只在 MsgBody / Chat
 *      里各读一次，耦合面收敛到两处。
 */

import { reactive, markRaw, shallowReactive, nextTick } from 'vue'
import * as Vue from 'vue'

import { backend } from '@renderer/runtime/backend'
import Option from '@renderer/function/option'
import { Logger, LogType, PopInfo, PopType } from '@renderer/function/base'
import { useSettingsStore } from '@renderer/state/settings'
import { useChatStore } from '@renderer/state/chat'
import { useUIStore } from '@renderer/state/ui'
import { useAuthStore } from '@renderer/state/auth'
import { useContactStore } from '@renderer/state/contact'

const logger = new Logger()

/** 插件目录（相对应用根路径，最终解析为 app://plugins/...） */
export const PLUGIN_BASE = 'plugins'
/** 插件登记表文件名 */
export const PLUGIN_REGISTRY = 'index.json'
/** 宿主 API 版本：插件可用 engines.host 声明依赖 */
export const HOST_API_VERSION = 1

//#region == 类型 ================================================================

/** 插件清单（plugin.json / 登记表条目） */
export interface PluginManifest {
    /** 插件唯一 ID，建议 `作者.插件名`，用于命名空间隔离 */
    id: string
    /** 显示名 */
    name: string
    /** 插件版本 */
    version: string
    /** 一句话描述 */
    description?: string
    /** 作者 */
    author?: string
    /** 入口文件，相对插件目录 */
    entry: string
    /** 依赖声明：宿主 API 版本号下限 */
    engines?: { host?: number }
    /** 需要宿主提供的能力 */
    permissions?: string[]
    /** 是否默认启用 */
    defaultEnabled?: boolean
}

/** 登记表条目：清单 + 所在目录 */
export interface PluginRegistryEntry extends PluginManifest {
    /** 插件目录（相对 plugins/） */
    dir: string
    /** 插件目录的最终 URL，由宿主填充 */
    baseUrl?: string
}

export type PluginStatus =
    | 'idle'
    | 'loading'
    | 'active'
    | 'disabled'
    | 'error'
    | 'unsupported'

/** 插件运行时信息 */
export interface PluginRuntimeInfo {
    id: string
    name: string
    version: string
    status: PluginStatus
    error?: string
    dir: string
}

/** 消息装饰：显示在消息气泡下方的一行标签 */
export interface MessageDecoration {
    /** 意图标签（主要标签，强调色） */
    intent?: string
    /** 情绪标签 */
    emotion?: string
    /** 次要说明，例如置信度 / 模型来源 */
    detail?: string
    /** 结果来源标识，例如 local:laya */
    source?: string
}

/** 会话徽标：显示在聊天页顶部标题旁 */
export interface ChatBadge {
    /** 文本，例如「情绪 · 期待」 */
    text: string
    /** 语义色，用于前端着色：positive / neutral / negative */
    tone?: 'positive' | 'neutral' | 'negative'
    /** 悬浮提示 */
    title?: string
}

/** 工具栏按钮 */
export interface ToolbarButton {
    id: string
    title: string
    /** 内联 SVG 字符串 */
    svg: string
    onClick: () => void
}

/** 弹窗参数 */
export interface PanelOptions {
    title?: string
    /** 已用 markRaw 包裹的组件 */
    component?: any
    /** 直接给 HTML（与 component 二选一） */
    html?: string
    /** 传给组件的 props */
    props?: Record<string, any>
    full?: boolean
    /** 是否允许 Esc 快捷关闭 */
    allowQuickClose?: boolean
    /** 底部按钮 */
    buttons?: { text: string; master?: boolean; fun?: (value?: any) => void }[]
}

/** 宿主 API 契约 */
export interface PluginHostApi {
    /** 宿主信息 */
    readonly host: {
        apiVersion: number
        clientVersion: string
        clientType: string
        platform: string | undefined
        pluginId: string
    }
    /** Vue 运行时（插件被打成独立产物，无法自行解析 bare import） */
    readonly vue: typeof Vue
    /**
     * 设置读写。写入一律落到插件私有存储；读取优先私有存储，
     * 未命中时回退到客户端设置（只读），因此不会污染客户端配置。
     */
    readonly option: {
        get: (key: string, fallback?: any) => any
        set: (key: string, value: any) => void
        /** 注册设置卡片（显示在「设置 → 附加」） */
        registerCard: (card: { id: string; title: string; description?: string }) => void
        registerItem: (cardId: string, item: any) => void
    }
    /** 插件启用列表（宿主级状态，落在插件存储的保留命名空间） */
    readonly plugins: {
        getEnabled: () => string[]
        setEnabled: (ids: string[]) => void
    }
    /** Pinia store 访问器（延迟求值） */
    readonly stores: {
        settings: () => ReturnType<typeof useSettingsStore>
        chat: () => ReturnType<typeof useChatStore>
        ui: () => ReturnType<typeof useUIStore>
        auth: () => ReturnType<typeof useAuthStore>
        contact: () => ReturnType<typeof useContactStore>
    }
    /** 平台后端（isDesktop / isWeb / type / platform） */
    readonly backend: typeof backend
    /** 日志（统一前缀） */
    readonly log: {
        info: (msg: string) => void
        debug: (msg: string) => void
        error: (msg: string, e?: unknown) => void
    }
    /** 右上角气泡提示 */
    alert: (type: 'info' | 'err', msg: string) => void

    // ---- 渲染槽 ----------------------------------------------------------
    /** 消息装饰槽（界面侧消费） */
    readonly messageDecorations: Record<string, MessageDecoration>
    /** 会话徽标槽（key = `${type}:${id}`） */
    readonly chatBadges: Record<string, ChatBadge>
    /** 工具栏按钮列表 */
    readonly toolbarButtons: ToolbarButton[]
    /** 写入 / 清除消息装饰 */
    setMessageDecoration: (messageId: string | number, deco: MessageDecoration) => void
    unsetMessageDecoration: (messageId: string | number) => void
    clearMessageDecorations: () => void
    /** 写入 / 清除会话徽标 */
    setChatBadge: (chatType: string, chatId: number | string, badge: ChatBadge) => void
    unsetChatBadge: (chatType: string, chatId: number | string) => void
    /** 注册工具栏按钮，返回注销函数 */
    addToolbarButton: (button: ToolbarButton) => () => void

    // ---- 界面 ------------------------------------------------------------
    /** 打开弹窗面板 */
    openPanel: (options: PanelOptions) => void
    /** 关闭最上层弹窗 */
    closePanel: () => void

    // ---- 宿主存储（electron 走 userData 目录，web 走 localStorage） -------
    readonly store: {
        get: <T = any>(key: string, fallback?: T) => T
        set: (key: string, value: any) => void
        remove: (key: string) => void
    }

    // ---- 事件总线 --------------------------------------------------------
    on: (event: string, cb: (payload?: any) => void) => () => void
    emit: (event: string, payload?: any) => void
}

/** 插件模块导出的生命周期 */
export interface PluginModule {
    activate: (host: PluginHostApi) => void | Promise<void>
    deactivate?: () => void | Promise<void>
}

//#endregion

//#region == 响应式槽位 ===========================================================

/** 消息装饰：key = message_id */
export const messageDecorations = reactive<Record<string, MessageDecoration>>({})
/** 会话徽标：key = `${chatType}:${chatId}` */
export const chatBadges = reactive<Record<string, ChatBadge>>({})
/** 工具栏按钮 */
export const toolbarButtons = shallowReactive<ToolbarButton[]>([])
/** 插件运行状态 */
export const pluginRuntime = reactive<PluginRuntimeInfo[]>([])

/** 生成会话 key */
export function chatKey(chatType: string, chatId: number | string): string {
    return `${chatType}:${chatId}`
}

//#endregion

//#region == 事件总线 =============================================================

const listeners = new Map<string, Set<(payload?: any) => void>>()

function onEvent(event: string, cb: (payload?: any) => void): () => void {
    let set = listeners.get(event)
    if (!set) {
        set = new Set()
        listeners.set(event, set)
    }
    set.add(cb)
    return () => set?.delete(cb)
}

function emitEvent(event: string, payload?: any) {
    listeners.get(event)?.forEach((cb) => {
        try {
            cb(payload)
        } catch (e) {
            logger.error(e as Error, `插件事件处理失败：${event}`)
        }
    })
}

//#endregion

//#region == 插件宿主存储 =========================================================

/**
 * 宿主存储：electron 下经 IPC 落到 `<userData>/plugins/<pluginId>/`，
 * 其他平台回退到 localStorage。插件侧无需关心差异。
 */
class PluginStorage {
    private cache = new Map<string, any>()
    private ready: Promise<void>

    constructor(private readonly pluginId: string) {
        this.ready = this.hydrate()
    }

    /** 等待首次水合完成（宿主在 activate 之前 await） */
    whenReady() {
        return this.ready
    }

    private hasBridge(): boolean {
        return backend.type === 'electron' &&
            typeof window !== 'undefined' &&
            !!(window as any).electron?.ipcRenderer
    }

    private async hydrate() {
        if (this.hasBridge()) {
            try {
                const all = await backend.call(
                    undefined, 'addon:store:getAll', true, this.pluginId)
                if (all && typeof all === 'object') {
                    Object.entries(all).forEach(([k, v]) => this.cache.set(k, v))
                }
                return
            } catch (e) {
                logger.add(LogType.DEBUG, '插件存储读取失败，降级为空数据',
                    (e as Error)?.message)
            }
        }
        try {
            const raw = localStorage.getItem(`plugins:${this.pluginId}`)
            if (raw) {
                Object.entries(JSON.parse(raw)).forEach(([k, v]) => this.cache.set(k, v))
            }
        } catch {
            // 忽略损坏的本地缓存
        }
    }

    get<T = any>(key: string, fallback?: T): T {
        return this.cache.has(key) ? (this.cache.get(key) as T) : (fallback as T)
    }

    set(key: string, value: any) {
        this.cache.set(key, value)
        this.flush(key)
    }

    remove(key: string) {
        this.cache.delete(key)
        this.flush(key, true)
    }

    private flush(key: string, removed = false) {
        if (this.hasBridge()) {
            backend.call(undefined, 'addon:store:set', false,
                this.pluginId, key, removed ? null : this.cache.get(key))
            return
        }
        try {
            const dump: Record<string, any> = {}
            this.cache.forEach((v, k) => (dump[k] = v))
            localStorage.setItem(`plugins:${this.pluginId}`, JSON.stringify(dump))
        } catch (e) {
            logger.error(e as Error, '插件数据本地写入失败')
        }
    }
}

//#endregion

//#region == 宿主创建 =============================================================

/** 创建宿主 API；ready 用于等待存储水合完成 */
function createHostApi(pluginId: string, clientVersion: string) {
    const storage = new PluginStorage(pluginId)

    const api: PluginHostApi = {
        host: {
            apiVersion: HOST_API_VERSION,
            clientVersion,
            clientType: backend.isDesktop() ? 'desktop' : (backend.isMobile() ? 'mobile' : 'web'),
            platform: backend.platform,
            pluginId,
        },
        vue: Vue,
        option: {
            // 插件私有存储是权威来源，客户端的 Option 只作只读回退。
            // 不直接写 Option 的原因：客户端配置缓存 1) 在 Bootloader 完成前
            // 未初始化（写入会抛 Cannot set properties of undefined），
            // 2) 生产构建会清除所有未在 optDefault 登记的键，插件状态会被抹掉。
            get: (key, fallback) => {
                const own = storage.get<any>(key)
                if (own !== undefined) return own
                try {
                    const value = Option.get(key)
                    if (value !== null && value !== undefined) return value
                } catch {
                    // 客户端配置缓存尚未就绪，忽略
                }
                return fallback
            },
            set: (key, value) => storage.set(key, value),
            registerCard: (card) => {
                Option.registerExtraOptionCard(card)
            },
            registerItem: (cardId, item) => {
                Option.registerExtraOptionItem(cardId, item)
            },
        },
        plugins: {
            getEnabled: () => currentEnabled.slice(),
            setEnabled: (ids) => {
                const list = (Array.isArray(ids) ? ids : []).map((v) => String(v))
                currentEnabled.splice(0, currentEnabled.length, ...list)
                writeEnabled(list)
                emitEvent('plugins:enabled-changed', currentEnabled.slice())
            },
        },
        stores: {
            settings: () => useSettingsStore(),
            chat: () => useChatStore(),
            ui: () => useUIStore(),
            auth: () => useAuthStore(),
            contact: () => useContactStore(),
        },
        backend,
        log: {
            info: (msg) => logger.info(`[插件 ${pluginId}] ${msg}`),
            debug: (msg) => logger.add(LogType.DEBUG, `[插件 ${pluginId}] ${msg}`),
            error: (msg, e) => logger.error((e as Error) ?? null, `[插件 ${pluginId}] ${msg}`),
        },
        alert: (type, msg) => {
            new PopInfo().add(type === 'err' ? PopType.ERR : PopType.INFO, msg, false)
        },

        messageDecorations,
        chatBadges,
        toolbarButtons,
        setMessageDecoration: (messageId, deco) => {
            messageDecorations[String(messageId)] = deco
        },
        unsetMessageDecoration: (messageId) => {
            delete messageDecorations[String(messageId)]
        },
        clearMessageDecorations: () => {
            Object.keys(messageDecorations).forEach((k) => delete messageDecorations[k])
        },
        setChatBadge: (chatType, chatId, badge) => {
            chatBadges[chatKey(chatType, chatId)] = badge
        },
        unsetChatBadge: (chatType, chatId) => {
            delete chatBadges[chatKey(chatType, chatId)]
        },
        addToolbarButton: (button) => {
            const safe: ToolbarButton = {
                ...button,
                onClick: markRaw(button.onClick),
            }
            const exist = toolbarButtons.findIndex((b) => b.id === button.id)
            if (exist >= 0) toolbarButtons.splice(exist, 1, safe)
            else toolbarButtons.push(safe)
            return () => {
                const index = toolbarButtons.findIndex((b) => b.id === button.id)
                if (index >= 0) toolbarButtons.splice(index, 1)
            }
        },

        openPanel: (options) => {
            const uiStore = useUIStore()
            uiStore.popBoxList.push({
                title: options.title,
                template: options.component ? markRaw(options.component) : undefined,
                templateValue: options.props ? markRaw(options.props) : undefined,
                html: options.html,
                full: options.full,
                allowQuickClose: options.allowQuickClose ?? true,
                button: options.buttons,
            })
        },
        closePanel: () => {
            useUIStore().popBoxList.shift()
        },

        store: {
            get: (key, fallback) => storage.get(key, fallback),
            set: (key, value) => storage.set(key, value),
            remove: (key) => storage.remove(key),
        },

        on: onEvent,
        emit: emitEvent,
    }

    return { api, ready: storage.whenReady() }
}

//#endregion

//#region == 插件发现与加载 ========================================================

/** 解析资源 URL：桌面端为 app://，Web/移动端为相对路径 */
export function resolvePluginUrl(relative: string): string {
    const base = document.baseURI || window.location.href
    return new URL(relative, base).href
}

/**
 * 读取插件登记表。
 * 登记表是一个数组，每项为插件清单 + dir 字段；宿主会补上 baseUrl。
 */
async function loadRegistry(): Promise<PluginRegistryEntry[]> {
    const url = resolvePluginUrl(`${PLUGIN_BASE}/${PLUGIN_REGISTRY}`)
    try {
        const response = await fetch(url, { cache: 'no-cache' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json()
        const list: PluginRegistryEntry[] = Array.isArray(data)
            ? data
            : (Array.isArray(data?.plugins) ? data.plugins : [])
        return list
            .filter((item) => item && typeof item.id === 'string' && typeof item.entry === 'string')
            .map((item) => ({
                ...item,
                dir: item.dir ?? item.id,
                baseUrl: resolvePluginUrl(`${PLUGIN_BASE}/${item.dir ?? item.id}/`),
            }))
    } catch (e) {
        logger.add(LogType.DEBUG, '未找到插件登记表，插件系统空载', (e as Error)?.message)
        return []
    }
}

/** 已启用插件 ID 的持久化键 */
const ENABLE_KEY = 'plugin_enabled_ids'

/**
 * 宿主级存储。插件私有存储是按 pluginId 分目录的，而启用列表属于宿主，
 * 因此占用一个保留命名空间。
 */
let hostStorage: PluginStorage | undefined
function getHostStorage(): PluginStorage {
    if (!hostStorage) hostStorage = new PluginStorage('__host__')
    return hostStorage
}

/**
 * 等客户端后端就绪。
 *
 * `backend.type` 的初值是 'web'，要等 App.vue 在 `window.onload` 里
 * `await backend.init()` 跑完才会变成 'electron'（platform 同时被填上）。
 * 在那之前 PluginStorage.hasBridge() 会误判成 Web 端，把插件数据写进
 * localStorage 而不是 userData/plugins。
 */
async function waitBackendReady(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && backend.platform === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
}

async function readEnabled(): Promise<string[] | null> {
    const storage = getHostStorage()
    await storage.whenReady()
    const raw = storage.get<any>(ENABLE_KEY)
    if (Array.isArray(raw)) return raw.map((v: any) => String(v))
    return null
}

function writeEnabled(ids: string[]) {
    getHostStorage().set(ENABLE_KEY, ids)
}

//#endregion

//#region == 宿主对外接口 =========================================================

const activePlugins = new Map<string, PluginModule>()

/** 当前客户端版本 */
let clientVersion = ''

/** 已启用的插件 id（内存副本，供 host.plugins 同步读取） */
const currentEnabled: string[] = []

/** 是否已初始化 */
let initialized = false

/**
 * 初始化插件宿主。应在 `app.mount()` 之后调用。
 * @param version 客户端版本号
 */
export async function initPluginHost(version: string) {
    if (initialized) return
    initialized = true
    clientVersion = version

    // 插件存储要按平台选通道，必须等后端初始化完成
    await waitBackendReady()

    const registry = await loadRegistry()
    if (registry.length === 0) {
        logger.add(LogType.DEBUG, '插件登记表为空，跳过插件加载')
        return
    }

    // 首次运行：把 defaultEnabled 的插件写进启用列表
    let enabled = await readEnabled()
    if (enabled === null) {
        enabled = registry.filter((p) => p.defaultEnabled !== false).map((p) => p.id)
        writeEnabled(enabled)
    }
    currentEnabled.splice(0, currentEnabled.length, ...enabled)
    const enabledList = enabled

    pluginRuntime.splice(0, pluginRuntime.length,
        ...registry.map((p) => ({
            id: p.id,
            name: p.name,
            version: p.version,
            dir: p.dir,
            status: (enabledList.includes(p.id) ? 'idle' : 'disabled') as PluginStatus,
        })),
    )

    // 串行加载，避免多个插件同时抢模型资源
    for (const entry of registry) {
        if (!enabledList.includes(entry.id)) continue
        await loadPlugin(entry)
    }
}

/** 加载单个插件 */
async function loadPlugin(entry: PluginRegistryEntry) {
    const info = pluginRuntime.find((p) => p.id === entry.id)
    if (info) info.status = 'loading'

    // 兼容性检查：宿主 API 版本
    const needHost = entry.engines?.host ?? 1
    if (needHost > HOST_API_VERSION) {
        if (info) {
            info.status = 'unsupported'
            info.error = `需要宿主 API v${needHost}，当前为 v${HOST_API_VERSION}`
        }
        logger.error(null, `插件 ${entry.id} 与当前客户端版本不兼容`)
        return
    }

    const url = `${entry.baseUrl}${entry.entry}`
    try {
        // 插件是独立产物，交给运行时解析，不经打包器静态分析
        const mod = (await import(/* @vite-ignore */ url)) as PluginModule
        if (typeof mod.activate !== 'function') {
            throw new Error('插件入口未导出 activate(host)')
        }
        const { api, ready } = createHostApi(entry.id, clientVersion)
        // 存储先水合，插件 activate 里即可同步读取历史数据
        await ready
        await mod.activate(api)
        activePlugins.set(entry.id, mod)
        if (info) info.status = 'active'
        logger.info(`插件已加载：${entry.name} v${entry.version}`)
        emitEvent('plugin:loaded', entry.id)
    } catch (e) {
        if (info) {
            info.status = 'error'
            info.error = (e as Error)?.message ?? String(e)
        }
        logger.error(e as Error, `插件 ${entry.name} 加载失败`)
    }
}

/** 启用 / 禁用插件（需要重载界面生效） */
export function setPluginEnabled(pluginId: string, enabled: boolean) {
    const current = readEnabled() ?? []
    const next = enabled
        ? Array.from(new Set([...current, pluginId]))
        : current.filter((id) => id !== pluginId)
    writeEnabled(next)
    emitEvent('plugin:enabled-changed', { pluginId, enabled })
}

/** 查询插件是否启用 */
export function isPluginEnabled(pluginId: string): boolean {
    return (readEnabled() ?? []).includes(pluginId)
}

/** 停用全部插件 */
export async function disposePlugins() {
    for (const [id, mod] of activePlugins) {
        try {
            await mod.deactivate?.()
        } catch (e) {
            logger.error(e as Error, `插件 ${id} 停用失败`)
        }
    }
    activePlugins.clear()
    Object.keys(messageDecorations).forEach((k) => delete messageDecorations[k])
    Object.keys(chatBadges).forEach((k) => delete chatBadges[k])
    toolbarButtons.splice(0, toolbarButtons.length)
}

/** 等待界面刷新（插件批量写入槽位后调用） */
export function flushSlots() {
    return nextTick()
}

export default {
    initPluginHost,
    disposePlugins,
    setPluginEnabled,
    isPluginEnabled,
    chatKey,
    resolvePluginUrl,
    messageDecorations,
    chatBadges,
    toolbarButtons,
    pluginRuntime,
    HOST_API_VERSION,
    PLUGIN_BASE,
    PLUGIN_REGISTRY,
}
