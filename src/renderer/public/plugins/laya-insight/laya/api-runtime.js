/**
 * API 推理运行时：与 LayaRuntime 同接口的远程后端。
 *
 * 走 OpenAI 兼容的 chat completions 接口（`/chat/completions`），把插件的问题
 * 定义（情绪 7 选 1 / 动态候选意图 / 关系信号 …）与 target-first state 打包成
 * prompt，要求模型返回严格 JSON，再回填成与本地校准层同构的答案对象。
 * 因此 pipeline / portrait 的全部业务逻辑在两种后端之间零改动复用。
 *
 * 与本地后端的差异（诚实性约定）：
 *   - LLM 不输出校准概率，只输出选择 + 自报信心 0~1；
 *   - 我们把它扩成「伪分布」：top 选择拿信心，其余选项均分剩余概率。
 *     这样两级路由 / 画像聚合照常工作，置信度含义是"模型自报的把握"。
 *   - 同一条消息的多个问题合并成一次 API 调用（按 state 分组），控制成本。
 */

import { toInternal } from './questions.js'

/** API 模式下与本地运行时一致的通道名集合（占位，不真正使用 IPC） */

export class ApiNotConfiguredError extends Error {
    constructor(message) {
        super(message)
        this.name = 'ApiNotConfiguredError'
    }
}

/** 从问题定义提取选项文本数组（与 renderOptions 对齐的精简版） */
function optionTexts(internal) {
    if (internal.t === 'choice') return Object.keys(internal.crit)
    if (internal.t === 'score') return internal.crit.map((_, i) => `level ${i}`)
    return ['false', 'true']
}

/** 每条消息一次调用的最大问题数（防止单次 prompt 过长） */
const MAX_QUESTIONS_PER_CALL = 8

export class ApiRuntime {
    /**
     * @param {object} host  插件宿主 API
     * @param {object} store PluginStore（读取 API 配置）
     */
    constructor(host, store) {
        this.host = host
        this.store = store
        this.status = null
    }

    get usable() {
        return typeof window !== 'undefined' &&
            !!(window.electron && window.electron.ipcRenderer && window.fetch)
    }

    get usableNote() {
        return 'API 推理需要桌面端（Electron）环境'
    }

    //#region == 配置 ------------------------------------------------------------

    get apiSettings() {
        const s = this.store.getSettings()
        return {
            baseUrl: String(s.apiBaseUrl || '').replace(/\/+$/, ''),
            apiKey: String(s.apiKey || ''),
            model: String(s.apiModel || '').trim(),
        }
    }

    get configured() {
        const { baseUrl, model } = this.apiSettings
        return /^https?:\/\//.test(baseUrl) && baseUrl.length > 0 && model.length > 0
    }

    /** 与 LayaRuntime.configure 对齐：接收 patch，返回状态快照 */
    async configure(patch = {}) {
        if (patch && Object.keys(patch).length) {
            this.store.saveSettings({
                ...(patch.apiBaseUrl !== undefined ? { apiBaseUrl: patch.apiBaseUrl } : {}),
                ...(patch.apiKey !== undefined ? { apiKey: patch.apiKey } : {}),
                ...(patch.apiModel !== undefined ? { apiModel: patch.apiModel } : {}),
            })
        }
        return await this.refreshStatus()
    }

    async refreshStatus() {
        const { baseUrl, model } = this.apiSettings
        this.status = {
            available: this.configured,
            depsInstalled: true,
            loaded: this.configured,
            backendMode: 'api',
            modelDir: baseUrl || '',
            candidates: [],
            filesReady: this.configured,
            missing: [],
            modelBytes: 0,
            provider: this.configured ? `api:${model}` : '',
            threads: 0,
            executionMode: '',
            availableProviders: [],
            providerHint: [],
            error: this.configured ? '' : 'API 模式：请在设置里填写接口地址与模型名',
        }
        return this.status
    }

    async ensureReady() {
        await this.refreshStatus()
        if (!this.configured) {
            const e = new ApiNotConfiguredError(this.status.error)
            throw e
        }
    }

    async prewarm() {
        // API 模式无需装载；做一次最小连通性测试
        await this.ensureReady()
        try {
            await this.chat([
                { role: 'user', content: '只回复两个字：就绪' },
            ], 16)
        } catch (e) {
            this.status = { ...this.status, error: (e && e.message) || String(e) }
        }
        return this.status
    }

    async release() {
        this.status = null
    }

    /** API 模式没有本地模型目录；保留接口兼容 */
    async pickModelDir() {
        return null
    }

    //#endregion

    //#region == 调用 ------------------------------------------------------------

    /** 发起一次 chat completions 请求，返回拼接的文本 */
    async chat(messages, timeoutSec = 120) {
        const { baseUrl, apiKey, model } = this.apiSettings
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutSec * 1000)
        try {
            const response = await window.fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                },
                body: JSON.stringify({
                    model,
                    messages,
                    temperature: 0.2,
                    max_tokens: 2048,
                }),
                signal: controller.signal,
            })
            if (!response.ok) {
                const text = await response.text().catch(() => '')
                throw new Error(`API ${response.status}：${text.slice(0, 200) || response.statusText}`)
            }
            const data = await response.json()
            const content = data?.choices?.[0]?.message?.content
            if (typeof content !== 'string' || !content.trim()) {
                throw new Error('API 返回为空')
            }
            return content
        } finally {
            clearTimeout(timer)
        }
    }

    //#endregion

    //#region == decide（核心接口） ----------------------------------------------

    /**
     * 与 LayaRuntime.decide 同签名：questions -> answers。
     * 按 state 分组（同一条消息的问题合并为一次 API 调用）。
     */
    async decide(requests) {
        if (!requests || requests.length === 0) return {}
        await this.ensureReady()

        // 1) 规整 + 按 state 分组
        const groups = new Map()
        const internals = new Map()
        for (const request of requests) {
            const internal = toInternal(request.question)
            internals.set(request.id, internal)
            const state = typeof request.state === 'string' ? request.state : ''
            if (!groups.has(state)) groups.set(state, [])
            groups.get(state).push(request.id)
        }

        // 2) 逐组调用（组内超量时再切片）
        const answers = {}
        for (const [state, ids] of groups.entries()) {
            for (let start = 0; start < ids.length; start += MAX_QUESTIONS_PER_CALL) {
                const chunk = ids.slice(start, start + MAX_QUESTIONS_PER_CALL)
                Object.assign(answers, await this.askGroup(state, chunk, internals))
            }
        }
        return answers
    }

    /** 一组问题一次 API 调用 */
    async askGroup(state, ids, internals) {
        const lines = []
        for (let i = 0; i < ids.length; i++) {
            const q = internals.get(ids[i])
            const options = optionTexts(q)
            lines.push(`${i + 1}. [${ids[i]}] ${q.ins}`)
            lines.push(`   选项：${options.join(' | ')}`)
        }
        const user = [
            '下面是一段对话。标记为 TARGET 的消息是待判断对象。',
            '',
            state,
            '',
            '请逐条回答以下问题。只输出一个 JSON 对象，不要输出任何其他文字：',
            '键是方括号里的问题 id，值是 {"choice": "<选项原文>", "confidence": <0到1的小数>}。',
            'choice 必须严格取自该问题的选项列表原文；confidence 是你对该判断的把握。',
            '',
            ...lines,
        ].join('\n')

        const content = await this.chat([
            { role: 'system', content: '你是消息分析引擎。严格按用户要求的 JSON 格式输出，禁止输出解释、markdown 代码块标记或任何多余文字。' },
            { role: 'user', content: user },
        ])

        const parsed = parseJsonLoose(content)
        if (!parsed || typeof parsed !== 'object') {
            throw new Error('API 返回的 JSON 无法解析')
        }

        const answers = {}
        for (const id of ids) {
            const q = internals.get(id)
            const options = optionTexts(q)
            const raw = parsed[id]
            const choice = normalizeChoice(raw?.choice ?? raw?.choice_label, options)
            const confidence = clamp01(Number(raw?.confidence ?? 0.6)) || 0.6
            answers[id] = buildAnswer(q, options, choice, confidence)
        }
        return answers
    }

    //#endregion
}

//#region == 纯函数工具 ==========================================================

/** 宽松 JSON 解析：容忍 ```json 围栏与前后杂文本 */
function parseJsonLoose(text) {
    const cleaned = String(text).replace(/```(?:json)?/gi, '').trim()
    try {
        return JSON.parse(cleaned)
    } catch { /* 继续尝试截取 */ }
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) {
        try {
            return JSON.parse(cleaned.slice(start, end + 1))
        } catch { /* 放弃 */ }
    }
    return null
}

/** 把模型给的选择归一到选项原文（精确 → 去空白 → 包含） */
function normalizeChoice(raw, options) {
    if (typeof raw !== 'string' || !raw.trim()) return null
    const text = raw.trim()
    if (options.includes(text)) return text
    const folded = text.replace(/\s+/g, '').toLowerCase()
    for (const option of options) {
        if (option.replace(/\s+/g, '').toLowerCase() === folded) return option
    }
    const hit = options.find((option) =>
        text.includes(option) || option.toLowerCase().includes(folded))
    return hit || null
}

function clamp01(v) {
    return Math.min(Math.max(Number.isFinite(v) ? v : 0, 0), 1)
}

/**
 * 构造与本地校准层同构的答案对象。
 * top 选择拿信心，其余选项均分剩余概率（伪分布，供路由/聚合逻辑使用）。
 */
function buildAnswer(internal, options, choice, confidence) {
    const probabilities = {}
    const rest = options.filter((o) => o !== choice)
    const restShare = (1 - confidence) / Math.max(1, rest.length)
    for (const option of options) {
        probabilities[option] = option === choice ? confidence : restShare
    }
    const base = { type: internal.t, confidence: Math.round(confidence * 10000) / 10000, probabilities }
    if (internal.t === 'choice') return { ...base, choice }
    if (internal.t === 'score') {
        const score = options.reduce((sum, _, i) => sum + i * probabilities[`level ${i}`], 0)
        return { ...base, score: Math.round(score * 10000) / 10000 }
    }
    return base
}

//#endregion
