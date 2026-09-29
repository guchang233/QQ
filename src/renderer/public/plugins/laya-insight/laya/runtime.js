/**
 * Laya 运行时门面：渲染进程侧与主进程推理桥的唯一边界。
 *
 * 分工：
 *   主进程：模型文件、ONNX 会话、分词器（tokenizer.json 是本地文件，读盘最直接）；
 *   本插件：prompt 构造、温度校准、业务语义。
 *
 * 一次 decide() 只产生两次 IPC：prime（批量分词）+ infer（批量推理）。
 */

import { buildSequence, collate, fragmentsFor } from './prompt.js'
import { formatAnswers } from './calibration.js'
import { toInternal } from './questions.js'
import { ApiRuntime } from './api-runtime.js'

/** 默认单批行数；参考实现实测 batch=8 在 CPU 上吞吐最好，GPU 下可调大 */
export const BATCH_SIZE = 8
/** 批大小的允许范围 */
export const BATCH_SIZE_RANGE = { min: 1, max: 32 }
/** 分词缓存上限，超出直接清空（文本片段以题面为主，会反复命中） */
const TOKEN_CACHE_LIMIT = 20000

/** 主进程通道名 */
const CH = {
    status: 'addon:laya:status',
    configure: 'addon:laya:configure',
    pickModelDir: 'addon:laya:pickModelDir',
    specialTokens: 'addon:laya:specialTokens',
    tokenize: 'addon:laya:tokenize',
    infer: 'addon:laya:infer',
    agentConfig: 'addon:laya:agentConfig',
    release: 'addon:laya:release',
    prewarm: 'addon:laya:prewarm',
    downloadModel: 'addon:laya:downloadModel',
    downloadStatus: 'addon:laya:downloadStatus',
    writeFile: 'addon:file:write',
    pickDir: 'addon:file:pickDir',
    reveal: 'addon:file:reveal',
}

/** 模型未就绪时抛出的错误，便于上层区分「需要引导配置」与「真的出错」 */
export class ModelNotReadyError extends Error {
    constructor(message, status) {
        super(message)
        this.name = 'ModelNotReadyError'
        this.status = status
    }
}

export class LayaRuntime {
    /**
     * @param {object} host 插件宿主 API
     */
    constructor(host) {
        this.host = host
        this.cache = new Map()
        /** rl_agent_config.json */
        this.config = null
        /** 分词器门面（由 specialTokens + 缓存组成） */
        this.tokenizer = null
        this.status = null
        this.loading = null
        /** 一次前向的批大小（渲染侧配置，推理前在本地分批） */
        this.batchSize = BATCH_SIZE
    }

    /** 设置批大小（夹紧到允许范围），下一次 decide() 即生效 */
    setBatchSize(value) {
        const num = Math.floor(Number(value) || BATCH_SIZE)
        this.batchSize = Math.min(Math.max(BATCH_SIZE_RANGE.min, num), BATCH_SIZE_RANGE.max)
        return this.batchSize
    }

    /** 是否具备调用条件（桌面端 + preload 已注入 ipcRenderer） */
    get usable() {
        return this.host.backend.type === 'electron' &&
            typeof window !== 'undefined' &&
            !!(window.electron && window.electron.ipcRenderer)
    }

    get bridge() {
        return window.electron.ipcRenderer
    }

    /** 依赖不可用时的统一错误 */
    requireBridge() {
        if (!this.usable) {
            throw new ModelNotReadyError('本地模型仅支持桌面端（Electron）运行')
        }
        return this.bridge
    }

    //#region == 状态与配置 ------------------------------------------------------

    async refreshStatus() {
        if (!this.usable) {
            return {
                available: false, depsInstalled: false, loaded: false,
                modelDir: '', candidates: [], filesReady: false, missing: [],
                modelBytes: 0, provider: '', threads: 0,
                executionMode: '', availableProviders: [], providerHint: [],
                error: '本地模型仅支持桌面端（Electron）运行',
            }
        }
        this.status = await this.bridge.invoke(CH.status)
        return this.status
    }

    async configure(patch = {}) {
        this.requireBridge()
        this.status = await this.bridge.invoke(CH.configure, patch)
        // 批大小是渲染侧参数，不进主进程
        if (patch.batchSize !== undefined) this.setBatchSize(patch.batchSize)
        // 目录 / provider / 会话级参数（线程、执行模式）变化会让主进程释放会话；
        // 只有这类变化才需要丢分词缓存，单纯改批大小不必。
        if (patch.modelDir !== undefined || patch.provider !== undefined ||
            patch.threads !== undefined || patch.executionMode !== undefined) {
            this.config = null
            this.tokenizer = null
            this.cache.clear()
        }
        return this.status
    }

    /** 预热：立即装载模型，provider 回退 / 缺文件等问题当场暴露 */
    async prewarm() {
        this.requireBridge()
        this.status = await this.bridge.invoke(CH.prewarm)
        return this.status
    }

    /** 写归档文件（主进程侧默认目录为 <userData>/laya-insight-archive） */
    async writeFile({ dir = '', name, text }) {
        this.requireBridge()
        return await this.bridge.invoke(CH.writeFile, { dir, name, text })
    }

    /** 弹出系统目录选择框 */
    async pickDirectory() {
        this.requireBridge()
        return await this.bridge.invoke(CH.pickDir)
    }

    /** 在资源管理器中定位（目录直接打开，文件定位到所在文件夹） */
    async revealPath(target) {
        this.requireBridge()
        return await this.bridge.invoke(CH.reveal, String(target ?? ''))
    }

    /** 启动模型下载（后台执行，用 downloadStatus 轮询进度） */
    async downloadModel(mirror) {
        this.requireBridge()
        return await this.bridge.invoke(CH.downloadModel, mirror)
    }

    /** 查询模型下载进度 */
    async downloadStatus() {
        this.requireBridge()
        return await this.bridge.invoke(CH.downloadStatus)
    }

    async pickModelDir() {
        this.requireBridge()
        return await this.bridge.invoke(CH.pickModelDir)
    }

    async release() {
        if (!this.usable) return
        await this.bridge.invoke(CH.release)
        this.config = null
        this.tokenizer = null
        this.cache.clear()
    }

    //#endregion

    //#region == 装载 -----------------------------------------------------------

    /**
     * 确保配置 / 分词表齐备。失败时抛 ModelNotReadyError。
     */
    async ensureReady() {
        if (this.config && this.tokenizer) return
        if (this.loading) return this.loading
        this.loading = (async () => {
            this.requireBridge()
            const status = await this.refreshStatus()
            if (!status || !status.filesReady) {
                throw new ModelNotReadyError(
                    status && status.missing && status.missing.length
                        ? `模型目录文件不完整，缺少：${status.missing.join('、')}`
                        : '未找到 Laya 模型目录，请在「设置 → 附加 → Laya 意图与情绪感知」中指定',
                    status,
                )
            }
            if (!status.depsInstalled) {
                throw new ModelNotReadyError(
                    '缺少模型运行依赖（onnxruntime-node / @huggingface/tokenizers）',
                    status,
                )
            }
            const [config, special] = await Promise.all([
                this.bridge.invoke(CH.agentConfig),
                this.bridge.invoke(CH.specialTokens),
            ])
            this.config = config
            this.tokenizer = {
                clsTokenId: special.cls,
                sepTokenId: special.sep,
                padTokenId: special.pad,
                maskTokenId: special.mask,
                maskToken: special.maskToken,
                encode: (text) => this.encodeSync(text),
            }
            this.status = { ...(this.status ?? {}), ...status, loaded: true }
        })()
        try {
            await this.loading
        } finally {
            this.loading = null
        }
    }

    //#endregion

    //#region == 分词 -----------------------------------------------------------

    /**
     * 同步取缓存里的 token。未命中直接抛错——调用方必须先 prime()。
     * 这样能把「提示词构造」保持在纯同步逻辑里，便于排查。
     */
    encodeSync(text) {
        const hit = this.cache.get(text)
        if (hit === undefined) {
            throw new Error('分词缓存未命中，请先调用 runtime.prime(fragmentsFor(...))')
        }
        return hit
    }

    /** 批量预分词（去重 + 只请求缓存里没有的） */
    async prime(texts) {
        await this.ensureReady()
        const missing = []
        for (const text of texts) {
            if (!this.cache.has(text)) missing.push(text)
        }
        if (missing.length === 0) return 0
        if (this.cache.size + missing.length > TOKEN_CACHE_LIMIT) this.cache.clear()
        const result = await this.bridge.invoke(CH.tokenize, missing)
        const ids = result && result.ids
        if (!Array.isArray(ids) || ids.length !== missing.length) {
            throw new Error('分词结果与请求不一致')
        }
        missing.forEach((text, i) => this.cache.set(text, ids[i]))
        return missing.length
    }

    //#endregion

    //#region == 推理 -----------------------------------------------------------

    async infer(batch) {
        return await this.bridge.invoke(CH.infer, batch)
    }

    /**
     * 一批问题一次性求解。
     * @param {Array<{ id: string, question: object, state: any }>} requests
     * @returns {Promise<Record<string, object>>} qid -> answer
     */
    async decide(requests) {
        if (!requests || requests.length === 0) return {}
        await this.ensureReady()

        const internals = requests.map((request) => ({
            id: request.id,
            question: toInternal(request.question),
            state: typeof request.state === 'string' ? request.state : '',
        }))

        // 1) 一次 IPC 完成本批全部片段分词
        await this.prime(fragmentsFor(internals, this.tokenizer.maskToken))

        // 2) 本地构造序列
        const maxLen = Number(this.config.max_len) || 1024
        const headMaxLen = Number(this.config.head_max_len) || 256
        const prepared = internals.map((item) =>
            buildSequence(this.tokenizer, item.state, item.question, maxLen, headMaxLen),
        )

        // 3) 分批推理 + 校准（批大小可在悬浮窗「推理加速」里调）
        const batchSize = Math.max(1, this.batchSize || BATCH_SIZE)
        const answers = {}
        for (let start = 0; start < prepared.length; start += batchSize) {
            const chunk = prepared.slice(start, start + batchSize)
            const chunkInternals = internals.slice(start, start + batchSize)
            const batch = collate(chunk, this.tokenizer.padTokenId)
            const output = await this.infer(batch)
            Object.assign(answers, formatAnswers({
                config: this.config,
                questionIds: chunkInternals.map((item) => item.id),
                internal: chunkInternals.map((item) => item.question),
                items: chunk,
                logits: output.logits,
                actLogits: output.actLogits,
                markers: output.markers,
                actions: output.actions,
            }))
        }
        return answers
    }

    //#endregion
}

/**
 * 按设置构建推理后端：'api' 走 OpenAI 兼容接口，其余（默认）走本地 ONNX。
 * 切换 backendMode 后需要重新加载界面才会重建运行时。
 */
export function createRuntime(host, store) {
    const mode = store.getSettings().backendMode
    return mode === 'api'
        ? new ApiRuntime(host, store)
        : new LayaRuntime(host)
}
