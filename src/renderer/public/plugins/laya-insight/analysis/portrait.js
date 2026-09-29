/**
 * 画像聚合：把逐条消息的记录汇聚成「人物画像」。
 *
 * 与参考实现的分工一致：
 *   好感度  —— 只吃 relationship（对方消息），按时间做 0.5→1.0 的线性加权；
 *   六维雷达 —— 单独一轮 style 问题，用该对象最近一批消息拼成的整体 state 判定；
 *   MBTI    —— 四轴，需满足文本量门槛与单轴证据门槛，否则该轴保持「未确定」；
 *   摘要/高频词 —— 纯本地启发式（本插件不做 jieba 分词，用 CJK n-gram 近似）。
 */

import {
    EMOTION_ZH, INTENT_GROUPS, STYLE_DIMENSIONS, MBTI_AXES,
    RELATIONSHIP_WEIGHT, affinityGrade, selfQualityGrade,
    MBTI_MIN_MESSAGES, MBTI_MIN_AXIS_EVIDENCE, MBTI_MIN_AXIS_MARGIN,
} from '../laya/labels.js'
import { allStyleQuestions, allMbtiQuestions, RELATIONSHIP_QUESTION } from '../laya/questions.js'

/** 中文停用词（高频词统计用，刻意精简） */
const STOPWORDS = new Set([
    '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '这样', '那样', '就是', '还是',
    '可以', '不是', '没有', '知道', '现在', '真的', '但是', '所以', '因为', '如果', '然后',
    '一个', '一下', '一起', '时候', '东西', '感觉', '其实', '应该', '可能', '已经', '自己',
    '今天', '明天', '昨天', '哈哈哈哈', '哈哈', '哈哈哈',
])

/** 好感度历史权重：越新的消息越重 */
function recencyWeights(count) {
    const weights = []
    for (let i = 0; i < count; i++) {
        weights.push(count <= 1 ? 1 : 0.5 + 0.5 * (i / (count - 1)))
    }
    return weights
}

/** 依据关系信号序列计算好感度 0-100 */
export function affinityFromSignals(signals) {
    const finite = signals.filter((signal) => Number.isFinite(signal))
    if (finite.length === 0) return null
    const weights = recencyWeights(finite.length)
    let sum = 0
    let totalWeight = 0
    finite.forEach((signal, i) => {
        const weight = weights[i] ?? 1
        sum += Math.max(-1, Math.min(1, signal)) * weight
        totalWeight += weight
    })
    const weighted = totalWeight > 0 ? sum / totalWeight : 0
    return {
        score: Math.round(50 + 50 * Math.max(-1, Math.min(1, weighted))),
        weighted: Number(weighted.toFixed(4)),
        samples: finite.length,
    }
}

/** CJK 高频词：按 2-4 字 n-gram 统计，过滤停用词与纯数字 */
export function keywordsFromTexts(texts, limit = 6) {
    const counts = new Map()
    for (const raw of texts) {
        const text = String(raw || '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, ' ')
        for (const run of text.split(/\s+/)) {
            if (!run) continue
            const chars = [...run]
            if (chars.length < 2) continue
            for (let size = 2; size <= Math.min(4, chars.length); size++) {
                for (let i = 0; i + size <= chars.length; i++) {
                    const word = chars.slice(i, i + size).join('')
                    if (STOPWORDS.has(word)) continue
                    counts.set(word, (counts.get(word) || 0) + 1)
                }
            }
        }
    }
    const entries = [...counts.entries()].filter(([, count]) => count >= 2)
    // 去掉被更长词完全包住的子串（例如「今天」压住「今」这类噪声）
    entries.sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))
    const picked = []
    for (const [word, count] of entries) {
        if (picked.some((item) => item.word.includes(word))) continue
        picked.push({ word, count })
        if (picked.length >= limit) break
    }
    return picked
}

/** 统计频次并取 Top N */
function topCounts(counter, limit = 6) {
    return Object.entries(counter)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([key, count]) => ({ key, count }))
}

/** 生成肖像摘要（纯本地拼装，不做模型生成） */
export function summaryFromAggregate(aggregate, target = '对方') {
    const parts = [`已分析 ${aggregate.total} 条${target}消息`]
    if (aggregate.topIntent) parts.push(`常见交流意图为${aggregate.topIntent}`)
    if (aggregate.topEmotion) parts.push(`情绪信号以${aggregate.topEmotion}为主`)
    if (aggregate.keywords.length > 0) {
        parts.push('常见用词有' + aggregate.keywords.slice(0, 3).map((item) => item.word).join('、'))
    }
    return parts.join('，') + '。'
}

/**
 * 由逐条记录做本地聚合（不含模型调用）。
 * @param {Array} records 消息记录数组，元素形如 { e, i, g, r, q, t, text, self }
 */
export function aggregateRecords(records) {
    const emotionCounter = {}
    const intentCounter = {}
    const signals = []
    const otherTexts = []
    const selfQualityScores = []

    for (const record of records) {
        if (record.e) emotionCounter[record.e] = (emotionCounter[record.e] || 0) + 1
        if (record.g && INTENT_GROUPS[record.g]) {
            const word = INTENT_GROUPS[record.g].word
            intentCounter[word] = (intentCounter[word] || 0) + 1
        }
        if (!record.self) {
            if (typeof record.r === 'number') signals.push(record.r)
            if (record.text) otherTexts.push(record.text)
        } else if (typeof record.q === 'number') {
            selfQualityScores.push(record.q)
        }
    }

    const affinity = affinityFromSignals(signals)
    const topEmotionEntry = topCounts(emotionCounter, 1)[0]
    const topIntentEntry = topCounts(intentCounter, 1)[0]
    const keywords = keywordsFromTexts(otherTexts)

    const aggregate = {
        total: records.length,
        otherCount: records.filter((record) => !record.self).length,
        selfCount: records.filter((record) => record.self).length,
        emotions: topCounts(emotionCounter, 6).map((item) => ({
            label: EMOTION_ZH[item.key] || item.key,
            key: item.key,
            count: item.count,
        })),
        intents: topCounts(intentCounter, 6).map((item) => ({
            label: item.key,
            count: item.count,
        })),
        topEmotion: topEmotionEntry ? (EMOTION_ZH[topEmotionEntry.key] || topEmotionEntry.key) : '',
        topIntent: topIntentEntry ? topIntentEntry.key : '',
        affinity,
        selfQuality: selfQualityScores.length
            ? selfQualityGrade(selfQualityScores.reduce((a, b) => a + b, 0) / selfQualityScores.length)
            : null,
        keywords,
    }
    aggregate.summary = summaryFromAggregate(aggregate)
    return aggregate
}

/** 把一批文本拼成整体 state（按字符预算截断，从最新往旧拼） */
export function joinedState(texts, budget = 2400) {
    const parts = []
    let used = 0
    for (let i = texts.length - 1; i >= 0; i--) {
        const text = String(texts[i] || '').trim()
        if (!text) continue
        if (used + text.length > budget) break
        parts.unshift(text)
        used += text.length
    }
    return parts.join('\n')
}

/**
 * 六维互动风格：用整体 state 各问一次。
 * @returns {Promise<Array<{id, zh, value}>>} value ∈ [0,1]，正向选项概率
 */
export async function computeStyle(runtime, texts) {
    const state = joinedState(texts)
    if (!state) return []
    const questions = allStyleQuestions()
    const answers = await runtime.decide(questions.map((item) => ({
        id: `style:${item.id}`,
        question: item.question,
        state,
    })))
    return questions.map((item) => {
        const answer = answers[`style:${item.id}`]
        const dimension = STYLE_DIMENSIONS.find((d) => d.id === item.id)
        const positive = answer && answer.type === 'choice'
            ? (answer.probabilities[item.question.criteria[0]] ?? 0)
            : 0
        return {
            id: item.id,
            zh: dimension ? dimension.zh : item.id,
            value: Number(positive.toFixed(4)),
        }
    })
}

/**
 * MBTI 四轴推测。gate 未通过时整块返回未解锁。
 * @param {Array} axisAnswers axisId -> answer
 * @param {number} total 已分析文本数
 */
export function buildMbti(axisAnswerMap, total) {
    if (total < MBTI_MIN_MESSAGES) {
        return {
            unlocked: false,
            total,
            need: MBTI_MIN_MESSAGES,
            axes: [],
        }
    }
    const axes = MBTI_AXES.map((axis) => {
        const answer = axisAnswerMap[axis.id]
        const [leftText, , insufficientText] = answer
            ? Object.keys(answer.probabilities)
            : []
        const pLeft = answer ? (answer.probabilities[leftText] ?? 0) : 0
        const pRightText = answer ? Object.keys(answer.probabilities)[1] : undefined
        const pRight = answer && pRightText ? (answer.probabilities[pRightText] ?? 0) : 0
        const pInsufficient = answer && insufficientText
            ? (answer.probabilities[insufficientText] ?? 0) : 0
        const evidence = 1 - pInsufficient
        const margin = Math.abs(pLeft - pRight)
        const locked = evidence < 0.5 || margin < MBTI_MIN_AXIS_MARGIN
        const letter = locked ? '' : (pLeft >= pRight ? axis.left : axis.right)
        return {
            id: axis.id,
            zh: axis.zh,
            left: axis.left,
            right: axis.right,
            leftZh: axis.leftZh,
            rightZh: axis.rightZh,
            letter,
            undetermined: locked,
            weight: Number((Math.max(pLeft, pRight) * evidence).toFixed(4)),
            evidence: Number(evidence.toFixed(4)),
        }
    })
    const code = axes.map((axis) => (axis.undetermined ? '·' : axis.letter)).join('')
    return { unlocked: true, total, code, axes }
}

/** 跑一轮 MBTI 判定 */
export async function computeMbti(runtime, texts, total) {
    if (total < MBTI_MIN_MESSAGES) return buildMbti({}, total)
    const state = joinedState(texts, 3000)
    if (!state) return buildMbti({}, total)
    const questions = allMbtiQuestions()
    const answers = await runtime.decide(questions.map((item) => ({
        id: `mbti:${item.id}`,
        question: item.question,
        state,
    })))
    const map = {}
    questions.forEach((item) => {
        map[item.id] = answers[`mbti:${item.id}`]
    })
    return buildMbti(map, total)
}

/**
 * 完整画像刷新：本地聚合 + 六维 + MBTI。
 * @param {object} params
 * @param {object} params.runtime
 * @param {Array} params.records
 * @param {Array<string>} params.otherTexts 用于风格 / MBTI 的原文（对方）
 */
export async function buildPortrait({ runtime, records, otherTexts }) {
    const aggregate = aggregateRecords(records)
    const sampleTexts = otherTexts.slice(-40)

    let style = []
    let mbti = buildMbti({}, aggregate.otherCount)
    try {
        style = await computeStyle(runtime, sampleTexts)
        mbti = await computeMbti(runtime, sampleTexts, aggregate.otherCount)
    } catch (e) {
        // 画像的模型部分失败不影响本地聚合结果
        style = []
    }

    return {
        ...aggregate,
        style,
        mbti,
        grade: aggregate.affinity ? affinityGrade(aggregate.affinity.score) : null,
        samples: { other: aggregate.otherCount, self: aggregate.selfCount },
    }
}

export { RELATIONSHIP_QUESTION, RELATIONSHIP_WEIGHT }
