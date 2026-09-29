/**
 * 问题定义层（业务语义）。
 *
 * 与参考实现（WechatVibe / laya-mlx）保持一致的分工：
 *   emotion      —— 仅展示；大类 → 细类的两级路由；
 *   intent       —— 仅展示；大类 → 群组 的两级路由，群组再归并为「常用词」；
 *   relationship —— 唯一参与好感度的信号，且只对「对方」消息提问；
 *   self_quality —— 对「自己」最近一条回复提问，映射到「我的发挥」等级；
 *   style        —— 六维互动风格的二选一问题；
 *   mbti         —— 四轴，每轴三个选项（左 / 右 / 证据不足）。
 */

import {
    EMOTION_BUCKETS,
    RELATIONSHIP_OPTIONS,
    STYLE_DIMENSIONS,
    MBTI_AXES,
} from './labels.js'

//#region == 内部问题结构 =========================================================

const QTYPES = { choice: 0, score: 1, noul: 2 }

/** 把外部问题定义规整成 { t, ins, crit } */
export function toInternal(question) {
    if (!question || typeof question !== 'object') {
        throw new Error('问题必须是对象')
    }
    const kind = question.type
    if (!Object.prototype.hasOwnProperty.call(QTYPES, kind)) {
        throw new Error(`未知的问题类型 ${kind}；仅支持 choice / score / noul`)
    }
    const ins = typeof question.instructions === 'string'
        ? question.instructions
        : JSON.stringify(question.instructions ?? null)

    let criteria = question.criteria
    if (kind === 'choice') {
        if (Array.isArray(criteria)) {
            const labels = [...criteria]
            if (new Set(labels).size !== labels.length) throw new Error('选项标签必须唯一')
            criteria = Object.fromEntries(labels.map((c) => [c, null]))
        }
        if (!criteria || typeof criteria !== 'object' || Object.keys(criteria).length === 0) {
            throw new Error('choice 的 criteria 必须是非空字典或数组')
        }
        return { t: 'choice', ins, crit: criteria }
    }
    if (kind === 'score') {
        if (!Array.isArray(criteria) || criteria.length === 0) {
            throw new Error('score 的 criteria 必须是非空数组')
        }
        return { t: 'score', ins, crit: criteria }
    }
    return { t: 'noul', ins, crit: criteria ?? null }
}

/** 渲染单个选项文本（字符串直通，对象转紧凑 JSON） */
export function renderCriterion(value) {
    return typeof value === 'string' ? value : JSON.stringify(value)
}

/** 渲染全部选项文本（choice 按标签声明顺序） */
export function renderOptions(q) {
    if (q.t === 'choice') {
        return Object.entries(q.crit).map(([key, value]) => {
            const blank = value === null || value === undefined || value === ''
            return blank ? key : `${key}: ${renderCriterion(value)}`
        })
    }
    if (q.t === 'score') {
        return q.crit.map((c, i) => `level ${i}: ${renderCriterion(c)}`)
    }
    const crit = q.crit ?? {}
    const falseCrit = crit.false
    const trueCrit = crit.true
    return [
        'false: ' + (falseCrit ? renderCriterion(falseCrit) : 'no, the statement does not hold'),
        'true: ' + (trueCrit ? renderCriterion(trueCrit) : 'yes, the statement holds'),
    ]
}

//#endregion

//#region == 情绪 ================================================================

/** 大类情绪问题（7 选项） */
export const EMOTION_QUESTION = {
    type: 'choice',
    instructions:
        'Which ONE broad emotion does the sender of the TARGET message feel? ' +
        'Judge the sender\'s emotion, not the recipient\'s illness or their conversational purpose. ' +
        'Use neutral for matter-of-fact messages.',
    criteria: Object.keys(EMOTION_BUCKETS),
}

/** 细类情绪问题（在某个大类内部细分） */
export function emotionDetailQuestion(bucket) {
    const options = EMOTION_BUCKETS[bucket]
    if (!options) throw new Error(`未知的情绪大类：${bucket}`)
    return {
        type: 'choice',
        instructions:
            'Within this emotional family, what is the sender of the TARGET message actually feeling?',
        criteria: [...options],
    }
}

//#endregion

//#region == 关系 / 发挥 ==========================================================

/** 关系信号（好感度唯一来源） */
export const RELATIONSHIP_QUESTION = {
    type: 'choice',
    instructions:
        'From the sender of the TARGET message toward the recipient, what relationship signal does ' +
        'the TARGET message carry? Choose romantic for clear romantic interest, warm for friendly ' +
        'affection, neutral for ordinary or task talk, distant for cooling off or emotional ' +
        'distance, and rejecting for an explicit refusal or push-away.',
    criteria: [...RELATIONSHIP_OPTIONS],
}

/** 我的发挥（自己最近一条回复） */
export const SELF_QUALITY_QUESTION = {
    type: 'choice',
    instructions:
        'The other person sent the PREVIOUS message. The SELF reply is the TARGET. ' +
        'How good is the SELF reply as a response to the other person?',
    criteria: {
        connected: 'responds directly and keeps the conversation moving naturally',
        empathic: 'acknowledges the other person\'s feelings before anything else',
        'off topic': 'ignores or changes the subject away from what the other person said',
        pressuring: 'pushes, demands or rushes the other person',
        offensive: 'hostile, insulting, contemptuous or rude',
    },
}

//#endregion

//#region == 六维互动风格 =========================================================

/**
 * 六维互动风格：每维一个二选一问题。
 * 正向选项放第 0 位，取值时直接取第 0 项概率作为该维度得分。
 */
const STYLE_PROMPTS = {
    socialEnergy: {
        positive: '开口就热络，主动带话题',
        negative: '更安静，等着对方开口',
    },
    humor: {
        positive: '常开玩笑、抖机灵',
        negative: '说话偏正经，很少玩梗',
    },
    composure: {
        positive: '情绪起伏小，表达平和',
        negative: '情绪外放，好恶写在字面上',
    },
    initiative: {
        positive: '主动抛新话题、提新事情',
        negative: '主要接着对方的话题聊',
    },
    care: {
        positive: '常问候、关心对方的状况',
        negative: '更少主动关心对方近况',
    },
    affection: {
        positive: '表达亲近、想念、喜欢',
        negative: '表达克制，保持礼貌距离',
    },
}

/** 生成某一维度的判定问题 */
export function styleQuestion(dimensionId) {
    const prompt = STYLE_PROMPTS[dimensionId]
    if (!prompt) throw new Error(`未知的互动风格维度：${dimensionId}`)
    return {
        type: 'choice',
        instructions:
            'Looking at the TARGET sender\'s messages in the state, which description fits better? ' +
            'Answer with the single best-fitting description.',
        criteria: [prompt.positive, prompt.negative],
    }
}

/** 一次性拿到六维问题 */
export function allStyleQuestions() {
    return STYLE_DIMENSIONS.map((dimension) => ({
        id: dimension.id,
        question: styleQuestion(dimension.id),
    }))
}

//#endregion

//#region == MBTI ================================================================

const MBTI_PROMPTS = {
    EI: {
        left: '话多、主动找人聊、在群里活跃',
        right: '话少、更多是回应、独处倾向明显',
    },
    SN: {
        left: '聊具体的事、时间地点、实际结果',
        right: '聊感受、联想、可能性与比喻',
    },
    TF: {
        left: '更常讲道理、给判断、直接下结论',
        right: '更常照顾感受、顾及对方情绪',
    },
    JP: {
        left: '喜欢定计划、约时间、把事落实',
        right: '随性、临时起意、不做规划',
    },
}

/** 生成某一轴的问题（左 / 右 / 证据不足 三选项） */
export function mbtiAxisQuestion(axisId) {
    const axis = MBTI_AXES.find((item) => item.id === axisId)
    const prompt = MBTI_PROMPTS[axisId]
    if (!axis || !prompt) throw new Error(`未知的 MBTI 轴：${axisId}`)
    return {
        type: 'choice',
        instructions:
            'Based on the TARGET sender\'s messages in the state, which side does this person lean ' +
            'toward? Choose "insufficient evidence" when the messages do not show it clearly.',
        criteria: [prompt.left, prompt.right, 'insufficient evidence'],
    }
}

/** 一次性拿到四轴问题 */
export function allMbtiQuestions() {
    return MBTI_AXES.map((axis) => ({
        id: axis.id,
        question: mbtiAxisQuestion(axis.id),
    }))
}

//#endregion

export { QTYPES }
