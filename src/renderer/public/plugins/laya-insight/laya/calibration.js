/**
 * 校准层：把模型原始 logits 变成可读答案。
 *
 * 关键点（与参考实现一致）：
 *   - 取 logits 的前 k 列（k = 本题选项数，即 marker 数）；
 *   - 先按温度缩放（temperature_by_options 优先，否则 temperature[qtype]），
 *     再 softmax；
 *   - choice 取 argmax 映射回标签，同时给出完整概率分布；
 *   - confidence = 1 - H(p)/log(k)，裁剪到 [0,1]。
 */

/** argmax：并列时取最先出现的下标（与 Python argmax 一致） */
export function argmax(values) {
    let best = 0
    for (let i = 1; i < values.length; i++) {
        if (values[i] > values[best]) best = i
    }
    return best
}

/** 数值稳定的 softmax */
export function softmax(values) {
    const z = Array.from(values)
    let max = -Infinity
    for (const v of z) if (v > max) max = v
    const e = z.map((v) => Math.exp(v - max))
    let sum = 0
    for (const v of e) sum += v
    return e.map((v) => v / sum)
}

/** 温度桶：`${qtype}:${选项数区间}` */
export function tempBucket(qtype, k) {
    const name = { 0: 'choice', 1: 'score', 2: 'noul' }[qtype] ?? String(qtype)
    const size = k <= 2 ? '2' : k <= 5 ? '3-5' : k <= 10 ? '6-10' : '11+'
    return `${name}:${size}`
}

/** 置信度：1 - H(p) / log(k) */
export function confidenceFromProbs(p, k) {
    if (k < 2) return 1
    let entropy = 0
    for (const v of p.slice(0, k)) {
        const c = Math.min(Math.max(v, 1e-12), 1)
        entropy -= v * Math.log(c)
    }
    return Math.min(Math.max(1 - entropy / Math.log(k), 0), 1)
}

export const round4 = (x) => Number(Number(x).toFixed(4))

/**
 * 批量格式化答案。
 * @param {object} input
 * @param {object} input.config       rl_agent_config.json
 * @param {string[]} input.questionIds 每行对应的问题 id
 * @param {Array} input.internal      每行对应的内部问题（t / crit）
 * @param {Array} input.items         每行对应的 prepared item（含 markers）
 * @param {Float32Array} input.logits
 * @param {Float32Array} input.actLogits
 * @param {number} input.markers      logits 的第二维
 * @param {number} input.actions      act_logits 的第二维
 */
export function formatAnswers(input) {
    const { config, questionIds, internal, items, logits, actLogits, markers, actions } = input
    if (logits.length !== items.length * markers) {
        throw new Error('formatAnswers：logits 长度不匹配')
    }
    if (actLogits.length !== items.length * actions) {
        throw new Error('formatAnswers：act_logits 长度不匹配')
    }

    const answers = {}
    items.forEach((item, row) => {
        const qid = questionIds[row]
        const q = internal[row]
        const k = item.markers.length
        const act = softmax(actLogits.subarray(row * actions, (row + 1) * actions))
        const scale = (config.temperature_by_options &&
            config.temperature_by_options[tempBucket(item.qtype, k)]) ??
            config.temperature[item.qtype] ?? 1
        const z = Array.from(
            logits.subarray(row * markers, row * markers + k),
            (v) => v / Math.max(1e-3, scale),
        )
        const p = softmax(z)
        const base = {
            confidence: round4(confidenceFromProbs(p, k)),
            action: { act_probability: round4(act[0]) },
        }
        if (q.t === 'choice') {
            const labels = Object.keys(q.crit)
            answers[qid] = {
                type: 'choice',
                ...base,
                choice: labels[argmax(p)],
                probabilities: Object.fromEntries(labels.map((label, i) => [label, round4(p[i])])),
            }
        } else if (q.t === 'score') {
            answers[qid] = {
                type: 'score',
                ...base,
                score: round4(p.reduce((sum, v, i) => sum + i * v, 0)),
                legend: Object.fromEntries(q.crit.map((value, i) => [String(i), value])),
                probabilities: Object.fromEntries(p.map((v, i) => [String(i), round4(v)])),
            }
        } else {
            const pTrue = p[1]
            answers[qid] = {
                type: 'noul',
                ...base,
                confidence: round4(Math.max(pTrue, 1 - pTrue)),
                noul: round4(pTrue),
            }
        }
    })
    return answers
}

/** 取某个 choice 答案里概率最高的标签与概率 */
export function topChoice(answer) {
    if (!answer || answer.type !== 'choice') return null
    const entries = Object.entries(answer.probabilities ?? {})
        .filter(([, p]) => Number.isFinite(p) && p > 0)
        .sort((a, b) => b[1] - a[1])
    if (entries.length === 0) return { label: answer.choice, probability: 0 }
    return { label: entries[0][0], probability: entries[0][1], ranked: entries }
}
