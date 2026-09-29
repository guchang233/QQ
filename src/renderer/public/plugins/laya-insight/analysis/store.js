/**
 * 插件持久化层。
 *
 * 落到宿主存储：Electron 下是 `<userData>/plugins/workbuddy.laya-insight/<key>.json`，
 * 其他平台回退 localStorage。按「账号 → 会话」两级隔离，切换账号互不干扰。
 *
 * 数据形态刻意保持扁平，便于增量合并：
 *   cfg                      -> 设置（含分析授权）
 *   chats:<uin>              -> 该账号出现过数据的会话键列表
 *   msg:<uin>:<chatKey>      -> { [messageId]: { e, i, g, r, q, t } }
 *   portrait:<uin>:<chatKey> -> 画像聚合结果
 *   meta:<uin>               -> 该账号的分析进度
 *
 * 体积 / 卡顿相关约定：
 *   - `stats()` 带缓存，只在数据真的变过（`dataStamp` 递增）时才重算，
 *     否则悬浮窗的轮询会反复遍历全部记录；
 *   - 记录本身不会自动裁剪，靠「归档导出 + 导出后清空」把体积压回去。
 */

const KEY_CFG = 'cfg'
const KEY_CHATS = (uin) => `chats:${uin}`
const KEY_META = (uin) => `meta:${uin}`
const KEY_MSG = (uin, chatKey) => `msg:${uin}:${chatKey}`
const KEY_PORTRAIT = (uin, chatKey) => `portrait:${uin}:${chatKey}`

/**
 * 分析结果版本。写入每条记录的 `av` 字段；显示、聚合与增量过滤都只认
 * 当前版本的记录。推理逻辑有实质性修正时递增它，旧结果会被新分析自然
 * 覆盖（同 message_id），残留的旧记录不再显示也不参与画像，无需批量删除。
 *
 * v1 —— 初版（state 缺 TARGET 标注 + 情绪细类查询键错误，结果不可信）
 * v2 —— target-first state + general-intent 动态候选 + 情绪查询修复
 */
export const ANALYSIS_VERSION = 2

/** 当前配置结构版本。低于此版本的存量配置会被 migrate() 升级 */
export const SETTINGS_VERSION = 4

/**
 * 默认设置。
 *
 * 关于分析的默认值：插件**默认不读取、不分析任何聊天记录**。建模推理只会在
 * 用户于悬浮窗里为某个会话手动打开开关之后才会发生，`armedChats` 是唯一的
 * 授权来源。
 */
export const DEFAULT_SETTINGS = {
    /** 是否在消息下方显示标签 */
    showLabels: true,
    /** 是否显示置信度等次要信息 */
    showDetail: false,
    /** 单次最多分析多少条消息（翻历史时的新增批次） */
    batchLimit: 40,
    /** 上下文窗口：构造 state 时带上多少条前面消息 */
    contextWindow: 6,
    /** 是否在顶部显示会话情绪徽标 */
    showBadge: true,
    /**
     * 已在悬浮窗里手动开启分析的会话集合（chatKey -> true）。
     * 只有悬浮窗会写这里；插件自身不会往里加任何东西。
     */
    armedChats: {},
    /** 已开启分析的会话里，是否跟随新消息继续分析 */
    followNewMessages: true,
    /** 配置结构版本，用于一次性迁移 */
    settingsVersion: SETTINGS_VERSION,
    /** 悬浮窗是否展开。默认只留一个悬浮球，挡视线的展开面板由用户自己点开 */
    dockOpen: false,
    /** 悬浮窗位置 { x, y }；null 表示停在默认的右下角 */
    dockPos: null,

    // —— 归档（体积控制） ——
    /** 归档导出目录；留空则用主进程的默认目录（<userData>/laya-insight-archive） */
    archiveDir: '',
    /** 导出成功后清空插件内的分析记录，避免记录长期累积导致卡顿 */
    archiveClearAfterExport: false,

    // —— 客户端外观 ——
    /** 隐藏客户端标题栏的窗口按钮（最小化 / 关闭）。默认**关**——隐藏是
     * 小众偏好，v1.2.0 曾默认开，导致很多用户以为客户端坏了 */
    hideWindowButtons: false,

    // —— 推理后端 ——
    /** 推理模式：'local'（本地 ONNX）| 'api'（OpenAI 兼容接口） */
    backendMode: 'local',
    /** OpenAI 兼容接口地址（如 https://api.deepseek.com/v1），仅 api 模式 */
    apiBaseUrl: '',
    /** API 密钥，仅 api 模式 */
    apiKey: '',
    /** API 模型名（如 deepseek-chat），仅 api 模式 */
    apiModel: '',
    /** 模型下载镜像（默认 HF 镜像站，直连 huggingface.co 被墙时也可改回官方） */
    modelMirror: 'https://hf-mirror.com',

    // —— 推理加速（仅本地模式） ——
    /** 执行提供者：auto / cpu / dml(DirectML/GPU) / cuda / tensorrt / openvino */
    provider: 'auto',
    /** CPU 推理线程数（intra-op） */
    threads: 4,
    /** 'sequential' | 'parallel' */
    executionMode: 'sequential',
    /** 一次前向的批大小；越大吞吐越高，但单批延迟也越高 */
    batchSize: 8,
}

/**
 * 升级存量配置。
 *
 * v1 的默认行为是「进入会话即自动分析」。v2 起改成了「必须在悬浮窗里手动
 * 开启」，如果只改 DEFAULT_SETTINGS，老用户 cfg.json 里那份
 * `autoAnalyze: true` 会继续生效，用户看到的仍然是自动分析，像是改动没落地。
 * 所以这里做一次显式降级：删掉废弃的自动开关，并清空任何历史授权。
 *
 * v3 只是新增了归档 / 加速 / 窗口按钮几组键，纯新增，不需要重置任何东西。
 *
 * v4 两件事：把 `hideWindowButtons` 重置为默认关（v1.2.0 默认开是误设计，
 * 用户以为客户端坏掉了）；新增推理后端组（local / api）。删除旧键让
 * DEFAULT_SETTINGS 的新默认值生效。
 */
function migrate(saved) {
    const version = Number(saved?.settingsVersion ?? 1)
    if (!Number.isFinite(version) || version >= SETTINGS_VERSION) return { ...(saved || {}) }

    const next = { ...saved }
    if (version < 2) {
        delete next.autoAnalyze
        next.armedChats = {}
    }
    if (version < 4) {
        delete next.hideWindowButtons
    }
    next.settingsVersion = SETTINGS_VERSION
    return next
}

export class PluginStore {
    constructor(host) {
        this.host = host
        const raw = host.store.get(KEY_CFG, {}) || {}
        const saved = migrate(raw)
        this.settings = { ...DEFAULT_SETTINGS, ...saved }
        /** 账号数据版本号；每次写入递增，用来让 stats 缓存失效 */
        this.dataStamp = 0
        this.statsCache = null
        // 迁移结果落盘，避免每次启动重复升级（也保证外部直接看文件时版本一致）
        if (Number(raw.settingsVersion ?? 1) < SETTINGS_VERSION) {
            this.host.store.set(KEY_CFG, this.settings)
        }
    }

    //#region == 设置 -----------------------------------------------------------

    getSettings() {
        return { ...this.settings }
    }

    saveSettings(patch) {
        this.settings = { ...this.settings, ...patch, settingsVersion: SETTINGS_VERSION }
        this.host.store.set(KEY_CFG, this.settings)
        return this.getSettings()
    }

    //#endregion

    //#region == 分析授权 -------------------------------------------------------

    /**
     * 该会话是否已被用户在悬浮窗里手动开启分析。
     * @param {string} chatKey `${chatType}:${chatId}`
     */
    isArmed(chatKey) {
        if (!chatKey) return false
        return !!(this.settings.armedChats || {})[chatKey]
    }

    /** 开启 / 关闭某个会话的分析授权 */
    setArmed(chatKey, armed) {
        if (!chatKey) return this.getSettings()
        const armedChats = { ...(this.settings.armedChats || {}) }
        if (armed) armedChats[chatKey] = true
        else delete armedChats[chatKey]
        return this.saveSettings({ armedChats })
    }

    /** 已开启分析的会话列表 */
    listArmed() {
        return Object.keys(this.settings.armedChats || {})
    }

    //#endregion

    //#region == 悬浮窗状态 -----------------------------------------------------

    getDockState() {
        const pos = this.settings.dockPos
        const valid = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)
        return {
            open: this.settings.dockOpen !== false,
            pos: valid ? { x: pos.x, y: pos.y } : null,
        }
    }

    saveDockState(patch) {
        const next = {}
        if (patch.open !== undefined) next.dockOpen = patch.open === true
        if (patch.pos !== undefined) {
            const pos = patch.pos
            next.dockPos = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)
                ? { x: pos.x, y: pos.y }
                : null
        }
        return this.saveSettings(next)
    }

    //#endregion

    //#region == 会话索引 -------------------------------------------------------

    /**
     * 记住这个账号下出现过数据的会话。
     * 只靠 meta 会漏掉「清过进度但记录还在」的会话，归档时会算少，所以单独维护一份。
     */
    listAccountChats(uin) {
        if (!uin) return []
        const keys = new Set()
        const indexed = this.host.store.get(KEY_CHATS(uin), [])
        if (Array.isArray(indexed)) indexed.forEach((key) => keys.add(String(key)))
        Object.keys((this.getMeta(uin).chats) || {}).forEach((key) => keys.add(key))
        return [...keys]
    }

    rememberChat(uin, chatKey) {
        if (!uin || !chatKey) return
        const list = this.host.store.get(KEY_CHATS(uin), [])
        const keys = Array.isArray(list) ? list.map((v) => String(v)) : []
        if (keys.includes(chatKey)) return
        keys.push(chatKey)
        this.host.store.set(KEY_CHATS(uin), keys)
    }

    //#endregion

    //#region == 进度 -----------------------------------------------------------

    getMeta(uin) {
        return this.host.store.get(KEY_META(uin), { chats: {}, updatedAt: 0 })
    }

    saveMeta(uin, meta) {
        this.host.store.set(KEY_META(uin), { ...meta, updatedAt: Date.now() })
        this.dataStamp++
    }

    /** 记录会话进度（已分析条数、最后一条消息 id） */
    touchChat(uin, chatKey, patch) {
        const meta = this.getMeta(uin)
        meta.chats = meta.chats || {}
        meta.chats[chatKey] = { ...(meta.chats[chatKey] || {}), ...patch, updatedAt: Date.now() }
        this.saveMeta(uin, meta)
        this.rememberChat(uin, chatKey)
        return meta.chats[chatKey]
    }

    getChatProgress(uin, chatKey) {
        const meta = this.getMeta(uin)
        return (meta.chats || {})[chatKey] || { analyzed: 0, lastMessageId: '' }
    }

    //#endregion

    //#region == 消息记录 -------------------------------------------------------

    getMessages(uin, chatKey) {
        return this.host.store.get(KEY_MSG(uin, chatKey), {}) || {}
    }

    /**
     * 合并写入一批消息记录（增量语义：同 id 覆盖）。
     * @param {Record<string, object>} records
     */
    saveMessages(uin, chatKey, records) {
        const all = this.getMessages(uin, chatKey)
        let added = 0
        for (const [id, record] of Object.entries(records)) {
            if (!all[id]) added++
            all[id] = record
        }
        this.host.store.set(KEY_MSG(uin, chatKey), all)
        const progress = this.getChatProgress(uin, chatKey)
        this.touchChat(uin, chatKey, {
            analyzed: Object.keys(all).length,
            added: (progress.added || 0) + added,
        })
        return { total: Object.keys(all).length, added }
    }

    /**
     * 取消息记录的数组视图（按时间排序），供画像聚合与归档使用。
     * 只返回当前分析版本的记录——旧版本的推理结果不可信，不参与聚合。
     */
    listMessages(uin, chatKey) {
        const all = this.getMessages(uin, chatKey)
        return Object.entries(all)
            .map(([id, record]) => ({ id, ...record }))
            .filter((record) => record.av === ANALYSIS_VERSION)
            .sort((a, b) => (a.t || 0) - (b.t || 0))
    }

    clearChat(uin, chatKey) {
        this.host.store.remove(KEY_MSG(uin, chatKey))
        this.host.store.remove(KEY_PORTRAIT(uin, chatKey))
        const meta = this.getMeta(uin)
        if (meta.chats) {
            delete meta.chats[chatKey]
            this.saveMeta(uin, meta)
        }
        this.dataStamp++
    }

    //#endregion

    //#region == 画像 -----------------------------------------------------------

    getPortrait(uin, chatKey) {
        return this.host.store.get(KEY_PORTRAIT(uin, chatKey), null)
    }

    savePortrait(uin, chatKey, portrait) {
        const next = { ...portrait, updatedAt: Date.now() }
        this.host.store.set(KEY_PORTRAIT(uin, chatKey), next)
        this.rememberChat(uin, chatKey)
        this.dataStamp++
        return next
    }

    //#endregion

    //#region == 账号级操作 -----------------------------------------------------

    /**
     * 汇总某账号的存储占用（条数），用于悬浮窗 / 设置页展示。
     *
     * 带缓存：记录多了以后遍历一遍是 O(总记录数)，而悬浮窗每秒都在问，
     * 所以只在这份数据真的被写过（`dataStamp` 变了）之后才重算。
     */
    stats(uin) {
        if (!uin) return { chats: 0, messages: 0, portraits: 0 }
        const cached = this.statsCache
        if (cached && cached.uin === uin && cached.stamp === this.dataStamp) return cached.value

        let messages = 0
        let portraits = 0
        const chatKeys = this.listAccountChats(uin)
        for (const chatKey of chatKeys) {
            const all = this.getMessages(uin, chatKey)
            for (const record of Object.values(all)) {
                if (record && record.av === ANALYSIS_VERSION) messages++
            }
            if (this.getPortrait(uin, chatKey)) portraits++
        }
        const value = { chats: chatKeys.length, messages, portraits }
        this.statsCache = { uin, stamp: this.dataStamp, value }
        return value
    }

    /** 清除某账号的全部插件数据 */
    clearAccount(uin) {
        for (const chatKey of this.listAccountChats(uin)) {
            this.host.store.remove(KEY_MSG(uin, chatKey))
            this.host.store.remove(KEY_PORTRAIT(uin, chatKey))
        }
        this.host.store.remove(KEY_META(uin))
        this.host.store.remove(KEY_CHATS(uin))
        this.statsCache = null
        this.dataStamp++
    }
}
