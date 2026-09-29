/**
 * Prompt 构造（与参考实现 laya-mlx / WechatVibe 的 prompt.ts 等价）。
 *
 * 模板：`[CLS] <choice|score|noul> question: <instructions> [SEP] ([MASK] opt)* [SEP] <state> [SEP]`
 *   - marker_pos 记录每个选项 [MASK] 在序列中的下标；
 *   - qtype 由题型映射 0/1/2；
 *   - 选项各自上限 48 token（[MASK] 本身不计入），head + 选项合计受 head_max_len 约束。
 *
 * 与参考实现的一处差异：分词在主进程完成，因此这里不能同步任意分词。
 * 调用方需要先 `fragmentsFor()` 收集本次批量需要的全部文本片段，交给运行时
 * 一次性预分词并填充缓存，之后再调用 `buildSequence()`（此时 encode 必然命中缓存）。
 */

import { renderOptions } from './questions.js'

export const QTYPES = { choice: 0, score: 1, noul: 2, }
/** 与 QTYPE_NAMES 对应，用于温度桶 */
export const QTYPE_NAMES = { 0: 'choice', 1: 'score', 2: 'noul' }

/** 选项 token 上限（不含 [MASK]） */
const OPTION_TOKEN_CAP = 48
/** head 至少保留的 token 数 */
const MIN_HEAD_TOKENS = 8
/** 触发选项二次收缩的剩余预算阈值 */
const HEAD_BUDGET_FLOOR = 16

/**
 * 状态序列化：本插件只传字符串（聊天文本），对象走 JSON。
 * 上游用的是 Python json.dumps(ensure_ascii=False) 的等价实现，这里
 * 参数只可能是字符串，因此直接用 JSON.stringify 即可覆盖。
 */
export function serializeState(state) {
    return typeof state === 'string' ? state : JSON.stringify(state)
}

/**
 * 收集构造某批序列所需的全部文本片段。
 * @param {Array<{question: object, state: any}>} items 规整后的问题（t / ins / crit）
 * @param {string} maskToken
 * @returns {string[]} 去重后的文本片段
 */
export function fragmentsFor(items, maskToken) {
    const set = new Set()
    for (const item of items) {
        const q = item.question
        const ins = String(q.ins ?? '').replaceAll(maskToken, ' ')
        set.add(`${q.t} question: ${ins}`)
        for (const option of renderOptions(q)) {
            set.add(' ' + option.replaceAll(maskToken, ' '))
        }
        set.add(serializeState(item.state).replaceAll(maskToken, ' '))
    }
    return [...set]
}

/**
 * 构造前缀：`[CLS] head [SEP] [MASK] opt0 [MASK] opt1 ... [SEP]`
 * @returns {{ids: number[], markers: number[]}}
 */
export function buildPrefix(tokenizer, q, headMaxLen) {
    const mask = tokenizer.maskToken
    const options = renderOptions(q)
    const ins = String(q.ins ?? '').replaceAll(mask, ' ')

    let headIds = tokenizer.encode(`${q.t} question: ${ins}`)
    let optIds = options.map((option) => [
        tokenizer.maskTokenId,
        ...tokenizer.encode(' ' + option.replaceAll(mask, ' ')).slice(0, OPTION_TOKEN_CAP),
    ])

    const total = (rows) => rows.reduce((n, row) => n + row.length, 0)
    let optBudget = headMaxLen - total(optIds)
    if (optBudget < HEAD_BUDGET_FLOOR) {
        const per = Math.max(4, Math.floor((headMaxLen - HEAD_BUDGET_FLOOR) / Math.max(1, optIds.length)))
        optIds = optIds.map((row) => row.slice(0, per))
        optBudget = headMaxLen - total(optIds)
    }
    headIds = headIds.slice(0, Math.max(MIN_HEAD_TOKENS, optBudget))

    const ids = [tokenizer.clsTokenId, ...headIds, tokenizer.sepTokenId]
    const markers = []
    for (const row of optIds) {
        markers.push(ids.length)
        ids.push(...row)
    }
    ids.push(tokenizer.sepTokenId)
    return { ids, markers }
}

/**
 * 构造完整序列：前缀 + 状态（右侧截断）+ [SEP]，总长不超过 maxLen。
 * @returns {{ids: number[], markers: number[], qtype: number}}
 */
export function buildSequence(tokenizer, state, q, maxLen, headMaxLen) {
    const prefix = buildPrefix(tokenizer, q, headMaxLen)
    const room = Math.max(0, maxLen - prefix.ids.length - 1)
    const stateIds = tokenizer
        .encode(serializeState(state).replaceAll(tokenizer.maskToken, ' '))
        .slice(0, room)
    const ids = [...prefix.ids, ...stateIds, tokenizer.sepTokenId].slice(0, maxLen)
    return {
        ids,
        markers: prefix.markers.filter((m) => m < maxLen),
        qtype: QTYPES[q.t],
    }
}

/**
 * 把一组序列拼成右侧 padding 的批量张量，markers 至少两列。
 */
export function collate(items, padId) {
    if (items.length === 0) throw new Error('不能对空批次做 collate')
    const rows = items.length
    const length = items.reduce((max, item) => Math.max(max, item.ids.length), 0)
    const markers = items.reduce((max, item) => Math.max(max, item.markers.length), 2)

    const batch = {
        rows,
        length,
        markers,
        inputIds: new BigInt64Array(rows * length).fill(BigInt(padId)),
        attentionMask: new BigInt64Array(rows * length),
        markerPos: new BigInt64Array(rows * markers),
        markerMask: new Uint8Array(rows * markers),
        qtype: BigInt64Array.from(items, (item) => BigInt(item.qtype)),
    }
    items.forEach((item, row) => {
        item.ids.forEach((id, i) => {
            batch.inputIds[row * length + i] = BigInt(id)
            batch.attentionMask[row * length + i] = 1n
        })
        item.markers.forEach((position, i) => {
            batch.markerPos[row * markers + i] = BigInt(position)
            batch.markerMask[row * markers + i] = 1
        })
    })
    return batch
}

/** 估算状态文本可用预算（用于超长会话的截断决策） */
export function stateTokenBudget(prefixIds, maxLen) {
    return Math.max(0, maxLen - prefixIds.length - 1)
}
