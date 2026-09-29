/**
 * 分析编排层：把会话里的消息变成逐条标签记录，并驱动增量更新。
 *
 * 流程（对齐 WechatVibe 最终形态）：
 *   Pass A  每条消息问 emotion（7 大类）/ intent（general-intent 动态候选）
 *           / relationship（仅对方）/ self_quality（仅自己）；
 *   Pass B  只给情绪追问：按 Pass A 的 top1（p≥0.65）或 top2，问该大类内部的
 *           细类。意图不再路由——动态候选问题一次给出全部候选的概率。
 *   state   target-first 格式（`TARGET message to judge:` + `[me]/[them]` 上下文），
 *           让模型明确知道要判哪条消息；无上下文时用 `{"message": …}` 孤立包裹。
 *   合并    意图直接取 choice 概率（不做乘法）；情绪显示大类概率。
 *
 * 版本（av）：每条记录带 ANALYSIS_VERSION，增量过滤 / 显示 / 聚合只认当前版本，
 * 推理逻辑修正后旧结果会被同 id 的新结果自然覆盖。
 *
 * 增量语义：已存在且 av 匹配的 message_id 直接跳过，只有新消息才进入本批。
 */

import {
    EMOTION_QUESTION,
    RELATIONSHIP_QUESTION,
    SELF_QUALITY_QUESTION,
    emotionDetailQuestion,
} from '../laya/questions.js'
import { generalIntentQuestion, generalIntentScores, intentGroup } from '../laya/general-intent.js'
import {
    EMOTION_BUCKETS,
    EMOTION_ZH,
    EMOTION_TONE,
    INTENT_NEGATIVE_GROUPS,
    RELATIONSHIP_WEIGHT,
    SELF_QUALITY_WEIGHT,
} from '../laya/labels.js'
import { ANALYSIS_VERSION } from './store.js'
import { topChoice } from '../laya/calibration.js'
import { buildPortrait } from './portrait.js'

/**
 * state 的字符预算：max_len=1024 token，问题前缀与选项约占 200+，
 * 中文约 1.5 字/token，1200 字符 ≈ 800 token，安全。
 */
const CONTEXT_BUDGET = 1200
/** 大类置信度达到该值就只看 top1，否则看 top2 */
const ROUTE_CONFIDENT = 0.65

/** 把一条消息的片段数组拍平成可分析文本 */
export function messageText(msg) {
    if (!msg || !Array.isArray(msg.message)) return ''
    const parts = []
    for (const segment of msg.message) {
        if (!segment || typeof segment !== 'object') continue
        switch (segment.type) {
            case 'text':
                if (segment.text) parts.push(segment.text)
                break
            case 'at':
                parts.push('@某人')
                break
            case 'image':
            case 'bface':
                parts.push('[图片]')
                break
            case 'mface':
            case 'face':
                parts.push('[表情]')
                break
            case 'record':
                parts.push('[语音]')
                break
            case 'video':
                parts.push('[视频]')
                break
            case 'file':
                parts.push('[文件]')
                break
            case 'forward':
                parts.push('[聊天记录]')
                break
            case 'json':
            case 'xml':
                parts.push('[卡片]')
                break
            case 'poke':
                parts.push('[戳一戳]')
                break
            default:
                break
        }
    }
    return parts.join('').trim()
}

/** 消息发送者显示名 */
function senderName(msg) {
    const sender = msg?.sender || {}
    return sender.card || sender.nickname || String(sender.user_id ?? '某人')
}

export class AnalysisPipeline {
    /**
     * @param {object} deps
     * @param {object} deps.host    插件宿主 API
     * @param {object} deps.runtime LayaRuntime
     * @param {object} deps.store   PluginStore
     */
    constructor({ host, runtime, store }) {
        this.host = host
        this.runtime = runtime
        this.store = store
        /** 任务代际：切换会话 / 取消时递增，旧任务自行退出 */
        this.generation = 0
        this.running = false
        this.lastRate = 0
    }

    /** 取消在跑的任务（不等待，任务在下一个检查点退出） */
    cancel() {
        this.generation++
        this.running = false
    }

    /** 是否有分析任务在跑（悬浮窗据此显示状态，只读） */
    get isRunning() {
        return this.running
    }

    //#region == 上下文构造 ------------------------------------------------------

    /**
     * 构造某条消息的 state —— target-first 格式（对齐 WechatVibe context.ts）：
     *
     *   TARGET message to judge:
     *   [them]: 打王者
     *
     *   Recent context before the target (oldest first):
     *   [me]: 在吗
     *   [them]: 怎么了
     *
     * 关键点：模型必须能从 state 里看出「要判的是哪一条」。旧版把整个聊天流水
     * 平铺给模型、不标 target，模型判的是整段对话的氛围——这是"打王者→婉拒"
     * 这类错位的主因之一。说话人用 [me]/[them] 而不是昵称（贴近训练分布）。
     * 无上下文时用孤立包裹 `{"message": …}`。超预算从最老的上文开始丢。
     */
    buildState(entries, index, contextWindow) {
        const target = entries[index]
        if (!target || !target.text) return ''
        const role = (entry) => (entry.self ? 'me' : 'them')

        // 收集 target 之前有文本的消息（从近往远，最多 contextWindow 条）
        const context = []
        for (let i = index - 1; i >= 0 && context.length < contextWindow; i--) {
            const entry = entries[i]
            if (!entry || !entry.text) continue
            context.unshift(entry)
        }
        if (context.length === 0) {
            return JSON.stringify({ message: target.text })
        }

        const head = [
            'TARGET message to judge:',
            `[${role(target)}]: ${target.text}`,
            '',
            'Recent context before the target (oldest first):',
        ]
        let body = context.map((entry) => `[${role(entry)}]: ${entry.text}`)
        while (body.length > 0 &&
            [...head, ...body].join('\n').length > CONTEXT_BUDGET) {
            body.shift()
        }
        return [...head, ...body].join('\n')
    }

    /** 给 general-intent 用的前文提示：只取文本，由 general-intent 内部截断 */
    buildContextHint(entries, index) {
        const parts = []
        for (let i = index - 1; i >= 0 && parts.length < 8; i--) {
            const entry = entries[i]
            if (!entry || !entry.text) continue
            parts.unshift(entry.text)
        }
        return parts.join(' ')
    }

    //#endregion

    //#region == 主体 -----------------------------------------------------------

    /**
     * 分析一个会话的消息。
     * @param {object} params
     * @param {string} params.uin      当前账号
     * @param {string} params.chatType 'user' | 'group'
     * @param {number|string} params.chatId
     * @param {number|string} params.selfId 自己的 uin
     * @param {Array} params.messages  chatStore.messageList（旧→新）
     * @param {number} [params.limit]  本批最多分析多少条
     * @param {(info: object) => void} [params.onProgress]
     * @returns {Promise<object>} 本轮统计
     */
    async analyzeChat({ uin, chatType, chatId, selfId, messages, limit, onProgress }) {
        const chatKey = `${chatType}:${chatId}`
        const settings = this.store.getSettings()
        const batchLimit = limit || settings.batchLimit || 40
        const contextWindow = settings.contextWindow || 6

        // 1) 拍平消息（保留原文用于上下文，不参与分析的片段也留名字）
        const entries = []
        for (const msg of messages || []) {
            if (!msg) continue
            if (msg.post_type !== 'message' && msg.post_type !== 'message_sent') continue
            const text = messageText(msg)
            entries.push({
                id: String(msg.message_id),
                name: senderName(msg),
                userId: String(msg.sender?.user_id ?? ''),
                text,
                time: Number(msg.time) || 0,
                self: String(msg.sender?.user_id) === String(selfId),
            })
        }

        const analyzable = entries.filter((entry) => entry.text.length > 0)
        if (analyzable.length === 0) {
            return { analyzed: 0, skipped: entries.length, reason: '本会话没有可分析的文本消息' }
        }

        // 2) 增量过滤：已存在且是当前分析版本的记录才跳过，旧版本重算覆盖
        const existing = this.store.getMessages(uin, chatKey)
        const isCurrent = (record) => record && record.av === ANALYSIS_VERSION
        const pending = analyzable.filter((entry) => !isCurrent(existing[entry.id]))
        const targets = pending.slice(-batchLimit)
        if (targets.length === 0) {
            return {
                analyzed: 0,
                skipped: analyzable.length,
                total: Object.keys(existing).length,
                reason: '没有新消息需要分析',
            }
        }

        const generation = ++this.generation
        this.running = true
        const startedAt = Date.now()

        try {
            // 3) Pass A：情绪 / 动态候选意图 / 关系或发挥
            const passA = []
            targets.forEach((entry) => {
                const index = entries.indexOf(entry)
                const state = this.buildState(entries, index, contextWindow)
                entry.state = state
                entry.contextHint = this.buildContextHint(entries, index)
                passA.push({ id: `a:emotion:${entry.id}`, question: EMOTION_QUESTION, state })
                // 意图：按消息动态裁剪选项集（8~10 个候选），概率全部由模型给出
                passA.push({
                    id: `a:intent:${entry.id}`,
                    question: generalIntentQuestion(entry.text, entry.contextHint).question,
                    state,
                })
                if (entry.self) {
                    passA.push({ id: `a:self:${entry.id}`, question: SELF_QUALITY_QUESTION, state })
                } else {
                    passA.push({ id: `a:rel:${entry.id}`, question: RELATIONSHIP_QUESTION, state })
                }
            })
            if (onProgress) onProgress({ phase: 'A', done: 0, total: passA.length })
            const answersA = await this.runtime.decide(passA)
            if (generation !== this.generation) return { canceled: true }

            // 4) Pass B：只追问情绪细类（意图一次成型，无需路由）
            const passB = []
            const routes = new Map()
            targets.forEach((entry) => {
                const emotionTop = topChoice(answersA[`a:emotion:${entry.id}`])
                const buckets = pickRoute(emotionTop, Object.keys(EMOTION_BUCKETS))
                routes.set(entry.id, { buckets })
                buckets.forEach((bucket) => {
                    passB.push({
                        id: `b:emotion:${entry.id}:${bucket}`,
                        question: emotionDetailQuestion(bucket),
                        state: entry.state,
                    })
                })
            })
            if (onProgress) onProgress({ phase: 'B', done: 0, total: passB.length })
            const answersB = passB.length ? await this.runtime.decide(passB) : {}
            if (generation !== this.generation) return { canceled: true }

            // 5) 合并成记录
            const records = {}
            for (const entry of targets) {
                const route = routes.get(entry.id)
                const emotionAnswer = answersA[`a:emotion:${entry.id}`]
                const relationshipAnswer = answersA[`a:rel:${entry.id}`]
                const selfAnswer = answersA[`a:self:${entry.id}`]

                const emotionLeaf = combineEmotion(emotionAnswer, route.buckets, answersB, entry.id)

                // 意图：直接取动态候选问题的概率分布 top1
                const intentScores = generalIntentScores(answersA[`a:intent:${entry.id}`])
                const intentTop = intentScores[0] || null

                const record = {
                    t: entry.time,
                    self: entry.self,
                    // 发送者 uin：群聊成员画像据此过滤记录，避免重复推理
                    u: entry.userId,
                    av: ANALYSIS_VERSION,
                    e: emotionLeaf ? emotionLeaf.key : '',
                    g: intentTop ? intentGroup(intentTop.id) : '',
                    i: intentTop ? intentTop.zh : '',
                    // ec 显示「大类概率」：标签 e 是该大类下选出的细类，大类概率
                    // 才是模型对这个情绪家族的真实置信度（乘积会显得过小）
                    ec: emotionLeaf ? emotionLeaf.probability : 0,
                    ic: intentTop ? intentTop.probability : 0,
                    text: entry.text.slice(0, 400),
                }
                if (entry.self) {
                    record.q = selfQualityScore(selfAnswer)
                } else {
                    const relationship = topChoice(relationshipAnswer)
                    record.rr = relationship ? relationship.label : ''
                    record.r = relationship && relationship.label in RELATIONSHIP_WEIGHT
                        ? RELATIONSHIP_WEIGHT[relationship.label]
                        : 0
                }
                records[entry.id] = record
            }

            // 6) 落盘 + 更新渲染槽
            const saved = this.store.saveMessages(uin, chatKey, records)
            this.applyDecorations(uin, chatKey, records)

            const elapsed = Math.max(1, Date.now() - startedAt)
            const rows = passA.length + passB.length
            this.lastRate = Math.round((rows / elapsed) * 1000)

            if (onProgress) {
                onProgress({
                    phase: 'done',
                    analyzed: targets.length,
                    total: saved.total,
                    rate: this.lastRate,
                })
            }

            return {
                analyzed: targets.length,
                added: saved.added,
                total: saved.total,
                pending: pending.length - targets.length,
                rate: this.lastRate,
                elapsed,
                chatKey,
            }
        } finally {
            if (generation === this.generation) this.running = false
        }
    }

    //#endregion

    //#region == 渲染槽 ---------------------------------------------------------

    /** 把记录写进宿主的消息装饰槽 */
    applyDecorations(uin, chatKey, records) {
        const settings = this.store.getSettings()
        if (!settings.showLabels) return
        for (const [id, record] of Object.entries(records)) {
            const decoration = {}
            if (record.e) decoration.emotion = EMOTION_ZH[record.e] || record.e
            if (record.i) decoration.intent = record.i
            if (settings.showDetail) {
                const bits = []
                if (record.ec) bits.push(`情绪 ${Math.round(record.ec * 100)}%`)
                if (record.ic) bits.push(`意图 ${Math.round(record.ic * 100)}%`)
                decoration.detail = bits.join(' · ')
            }
            decoration.source = 'local:laya'
            if (decoration.emotion || decoration.intent) {
                this.host.setMessageDecoration(id, decoration)
            }
        }
        void uin
        void chatKey
    }

    /** 用已保存的记录回填渲染槽（重新打开会话时调用） */
    restoreDecorations(uin, chatKey, messageIds) {
        const settings = this.store.getSettings()
        if (!settings.showLabels) {
            this.host.clearMessageDecorations()
            return 0
        }
        const all = this.store.getMessages(uin, chatKey)
        let done = 0
        for (const id of messageIds) {
            const record = all[String(id)]
            // 旧版本的推理结果不可信，不回填（重新分析后会以新 av 出现）
            if (!record || record.av !== ANALYSIS_VERSION) continue
            const decoration = { source: 'local:laya' }
            if (record.e) decoration.emotion = EMOTION_ZH[record.e] || record.e
            if (record.i) decoration.intent = record.i
            if (settings.showDetail && (record.ec || record.ic)) {
                decoration.detail = [record.ec ? `情绪 ${Math.round(record.ec * 100)}%` : '',
                    record.ic ? `意图 ${Math.round(record.ic * 100)}%` : '']
                    .filter(Boolean).join(' · ')
            }
            if (decoration.emotion || decoration.intent) {
                this.host.setMessageDecoration(id, decoration)
                done++
            }
        }
        return done
    }

    /**
     * 刷新顶部会话徽标。
     * 单聊：对方最近情绪；群聊：本会话整体氛围（所有非自己消息的众数情绪）。
     */
    refreshBadge(uin, chatType, chatId, messages) {
        const settings = this.store.getSettings()
        if (!settings.showBadge) {
            this.host.unsetChatBadge(chatType, chatId)
            return
        }
        const chatKey = `${chatType}:${chatId}`
        const all = this.store.getMessages(uin, chatKey)
        const recent = (messages || [])
            .map((msg) => all[String(msg?.message_id)])
            .filter((record) => record && record.av === ANALYSIS_VERSION)
            .slice(-30)
        if (recent.length === 0) return

        const counter = {}
        for (const record of recent) {
            if (!record.e) continue
            counter[record.e] = (counter[record.e] || 0) + 1
        }
        const top = Object.entries(counter).sort((a, b) => b[1] - a[1])[0]
        if (!top) return
        const zh = EMOTION_ZH[top[0]] || top[0]
        const tone = EMOTION_TONE[top[0]] || 'neutral'
        const text = chatType === 'group' ? `群氛围 · ${zh}` : `情绪 · ${zh}`
        this.host.setChatBadge(chatType, chatId, {
            text,
            tone,
            title: `基于最近 ${recent.length} 条已分析消息（本地 Laya 模型）`,
        })
    }

    /** 依据最近记录判断是否有值得提醒的负面意图（供徽标补充说明） */
    recentAlertGroups(uin, chatKey, count = 20) {
        const all = this.store.getMessages(uin, chatKey)
        const records = Object.values(all)
            .filter((record) => record && record.av === ANALYSIS_VERSION)
            .slice(-count)
        const hit = {}
        for (const record of records) {
            if (record.g && INTENT_NEGATIVE_GROUPS.includes(record.g)) {
                hit[record.g] = (hit[record.g] || 0) + 1
            }
        }
        return Object.entries(hit).sort((a, b) => b[1] - a[1]).slice(0, 3)
    }

    //#endregion

    //#region == 画像 -----------------------------------------------------------

    /**
     * 刷新某会话（或群里某个成员）的画像。
     *
     * 消息记录只存在会话维度（chatKey），成员画像是在同一批记录上
     * 按发送者过滤后单独聚合的，因此不会重复推理。
     *
     * @param {object} params
     * @param {string} [params.scopeKey] 画像存储键；群成员用 `<chatKey>#<uin>`
     * @param {number|string|null} [params.senderId] 仅聚合该发送者的记录
     */
    async refreshPortrait({ uin, chatType, chatId, members, scopeKey, senderId }) {
        const chatKey = `${chatType}:${chatId}`
        let records = this.store.listMessages(uin, chatKey)
        if (senderId !== undefined && senderId !== null && String(senderId) !== '') {
            records = records.filter((record) => String(record.u) === String(senderId))
        }
        const otherTexts = records.filter((record) => !record.self).map((record) => record.text)
        const portrait = await buildPortrait({
            runtime: this.runtime,
            records,
            otherTexts,
        })
        portrait.chatKey = chatKey
        portrait.scopeKey = scopeKey || chatKey
        portrait.chatType = chatType
        portrait.chatId = chatId
        portrait.senderId = senderId ? String(senderId) : null
        portrait.memberCount = members ?? null
        return this.store.savePortrait(uin, scopeKey || chatKey, portrait)
    }

    //#endregion
}

//#region == 纯函数工具 ===========================================================

/** 按置信度决定看 top1 还是 top2 */
function pickRoute(top, allowed) {
    if (!top || !top.ranked) return []
    const candidates = top.ranked
        .filter(([label]) => allowed.includes(label))
        .slice(0, top.probability >= ROUTE_CONFIDENT ? 1 : 2)
    return candidates.map(([label]) => label)
}

/**
 * 情绪两级合并：
 * 对每个候选大类 b，取该大类下每个细类 leaf，score = P(b) * P(leaf | b)。
 *
 * 注意查询键：emotionDetailQuestion 的 criteria 是英文 id（与模型词表一致），
 * 所以条件概率必须用英文 id 查——旧版用中文显示名查，全部落空，
 * 只有 calm（恰好中英同形）能命中，导致"平静"垄断所有消息。
 * 返回的 probability 是大类概率（作为显示置信度），top 细类在 best.key。
 */
function combineEmotion(emotionAnswer, buckets, answersB, messageId) {
    if (!emotionAnswer || emotionAnswer.type !== 'choice' || buckets.length === 0) return null
    let best = null
    for (const bucket of buckets) {
        const parent = emotionAnswer.probabilities[bucket] ?? 0
        const detail = answersB[`b:emotion:${messageId}:${bucket}`]
        if (!detail || detail.type !== 'choice') continue
        for (const leaf of EMOTION_BUCKETS[bucket] || []) {
            // 用英文 id 查条件概率（criteria 的键就是英文 id）
            const conditional = detail.probabilities[leaf] ?? 0
            const score = parent * conditional
            if (!best || score > best.raw) {
                best = { key: leaf, zh: EMOTION_ZH[leaf] || leaf, probability: parent, raw: score }
            }
        }
    }
    if (!best) return null
    return { key: best.key, zh: best.zh, probability: best.probability }
}

/** 我的发挥：Σ P(class) * weight(class) */
function selfQualityScore(answer) {
    if (!answer || answer.type !== 'choice') return null
    let sum = 0
    for (const [label, probability] of Object.entries(answer.probabilities)) {
        const weight = SELF_QUALITY_WEIGHT[label]
        if (typeof weight === 'number') sum += probability * weight
    }
    return Number(sum.toFixed(4))
}
