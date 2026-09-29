/**
 * 标签词表：模型输出标签 → 中文显示标签。
 *
 * 设计要点（对齐需求文档）：
 *   - 情绪 / 意图是 DISPLAY，不参与好感度；
 *   - 好感度只吃 relationship（对方消息）；
 *   - 意图细项（上游有 547 条 leaf intent）在本插件里按「群组 → 常用词」归并，
 *     统一显示为分享、承诺、协商、邀约这类常用词，避免标签长尾难以阅读。
 */

//#region == 情绪 ================================================================

/** 7 个大类情绪（与模型 EMOTION_QUESTION 的选项顺序一致） */
export const EMOTION_BUCKETS = {
    happy: ['happy', 'excited', 'content', 'relieved', 'grateful', 'hopeful', 'proud'],
    affectionate: ['affectionate', 'tender'],
    neutral: ['neutral', 'calm', 'focused', 'bored', 'tired', 'detached', 'determined', 'curious'],
    amused: ['amused', 'surprised'],
    sad: ['sad', 'lonely', 'disappointed', 'hurt', 'guilty', 'ashamed'],
    anxious: ['anxious', 'fearful', 'worried', 'stressed', 'overwhelmed', 'suspicious', 'confused', 'uncertain', 'embarrassed', 'shy'],
    angry: ['angry', 'frustrated', 'irritated', 'resentful', 'jealous'],
}

/** 大类情绪的中文名（用于顶部情绪徽标与会话摘要） */
export const EMOTION_BUCKET_ZH = {
    happy: '开心',
    affectionate: '亲近',
    neutral: '平静',
    amused: '被逗乐',
    sad: '难过',
    anxious: '不安',
    angry: '生气',
}

/** 细粒度情绪的中文名（40 条上游情绪的 id 是稳定的，这里给出显示名） */
export const EMOTION_ZH = {
    happy: '开心', excited: '兴奋', content: '满足', relieved: '释然', grateful: '感激',
    hopeful: '期待', proud: '自豪', affectionate: '亲近', tender: '温柔',
    neutral: '平静', calm: 'calm', focused: '专注', bored: '无聊', tired: '累了',
    detached: '疏离', determined: '坚决', curious: '好奇',
    amused: '被逗乐', surprised: '惊讶',
    sad: '难过', lonely: '孤单', disappointed: '失望', hurt: '受伤', guilty: '内疚', ashamed: '羞愧',
    anxious: '不安', fearful: '害怕', worried: '担心', stressed: '压力大', overwhelmed: '招架不住',
    suspicious: '警惕', confused: '困惑', uncertain: '犹豫', embarrassed: '尴尬', shy: '害羞',
    angry: '生气', frustrated: '烦躁', irritated: '恼火', resentful: '不满', jealous: '吃醋',
}

/**
 * 情绪语义极性：用于顶部徽标的着色。
 * neutralize 的情绪不参与极性判断。
 */
export const EMOTION_TONE = {
    happy: 'positive', excited: 'positive', content: 'positive', relieved: 'positive',
    grateful: 'positive', hopeful: 'positive', proud: 'positive',
    affectionate: 'positive', tender: 'positive', amused: 'positive', surprised: 'neutral',
    neutral: 'neutral', calm: 'neutral', focused: 'neutral', bored: 'neutral',
    tired: 'negative', detached: 'neutral', determined: 'neutral', curious: 'neutral',
    sad: 'negative', lonely: 'negative', disappointed: 'negative', hurt: 'negative',
    guilty: 'negative', ashamed: 'negative',
    anxious: 'negative', fearful: 'negative', worried: 'negative', stressed: 'negative',
    overwhelmed: 'negative', suspicious: 'negative', confused: 'neutral',
    uncertain: 'neutral', embarrassed: 'negative', shy: 'neutral',
    angry: 'negative', frustrated: 'negative', irritated: 'negative',
    resentful: 'negative', jealous: 'negative',
}

//#endregion

//#region == 意图 ================================================================

/** 26 个细分组的中文名 + 对外显示的「常用词」 */
export const INTENT_GROUPS = {
    greeting: { zh: '招呼寒暄', word: '寒暄' },
    conversation: { zh: '维持交流', word: '闲聊' },
    closure: { zh: '结束告别', word: '告别' },
    sharing: { zh: '分享消息', word: '分享' },
    disclosure: { zh: '自我披露', word: '倾诉' },
    inquiry: { zh: '询问求知', word: '打听' },
    feedback: { zh: '反馈建议', word: '建议' },
    coordination: { zh: '协调事务', word: '协商' },
    planning: { zh: '计划安排', word: '商量' },
    invitation: { zh: '邀请参与', word: '邀约' },
    commitment: { zh: '承诺确认', word: '承诺' },
    transaction: { zh: '交易服务', word: '办事' },
    work: { zh: '工作协作', word: '协作' },
    help_request: { zh: '请求协助', word: '求助' },
    help_offer: { zh: '提供协助', word: '帮忙' },
    support: { zh: '情绪支持', word: '安慰' },
    gratitude: { zh: '感谢赞赏', word: '道谢' },
    apology: { zh: '道歉认错', word: '道歉' },
    repair: { zh: '修复关系', word: '和解' },
    affection: { zh: '表达亲近', word: '亲近' },
    flirt: { zh: '暧昧试探', word: '试探' },
    boundary: { zh: '设立边界', word: '划界限' },
    rejection: { zh: '拒绝回避', word: '婉拒' },
    conflict: { zh: '争论冲突', word: '争执' },
    complaint: { zh: '抱怨申诉', word: '抱怨' },
    humor: { zh: '幽默玩笑', word: '玩笑' },
}

/** 非攻击性但需要提醒用户的意图（用于徽标着色） */
export const INTENT_NEGATIVE_GROUPS = ['conflict', 'complaint', 'rejection', 'boundary']

//#endregion

//#region == 关系 / 发挥 / 六维 ===================================================

/** 好感度权重：对方消息携带的关系信号，[-1, 1]，正数=亲近 */
export const RELATIONSHIP_WEIGHT = {
    romantic: 1.0,
    warm: 0.55,
    neutral: 0.0,
    distant: -0.45,
    rejecting: -1.0,
}

/** 关系信号的英文标签（模型选项） */
export const RELATIONSHIP_OPTIONS = ['romantic', 'warm', 'neutral', 'distant', 'rejecting']

/** 我的发挥权重 */
export const SELF_QUALITY_WEIGHT = {
    connected: 1.0,
    empathic: 0.9,
    'off topic': 0.3,
    pressuring: 0.15,
    offensive: 0.0,
}

export const SELF_QUALITY_OPTIONS = ['connected', 'empathic', 'off topic', 'pressuring', 'offensive']

/** 互动风格六维（与 style.ts 的维度一致） */
export const STYLE_DIMENSIONS = [
    { id: 'socialEnergy', zh: '表达活力' },
    { id: 'humor', zh: '幽默表达' },
    { id: 'composure', zh: '情绪平和' },
    { id: 'initiative', zh: '话题活力' },
    { id: 'care', zh: '关心支持' },
    { id: 'affection', zh: '关注表达' },
]

/** 好感度等级 */
export function affinityGrade(score) {
    if (score >= 90) return { grade: 'S', zh: '形影不离' }
    if (score >= 78) return { grade: 'A', zh: '相当亲近' }
    if (score >= 62) return { grade: 'B', zh: '关系不错' }
    if (score >= 45) return { grade: 'C', zh: '普通来往' }
    if (score >= 28) return { grade: 'D', zh: '略显疏远' }
    return { grade: 'E', zh: '关系冷淡' }
}

/** 我的发挥等级 */
export function selfQualityGrade(score) {
    if (score >= 0.90) return 'SSS'
    if (score >= 0.80) return 'SS'
    if (score >= 0.68) return 'S'
    if (score >= 0.55) return 'A'
    if (score >= 0.42) return 'B'
    if (score >= 0.28) return 'C'
    return 'D'
}

/** MBTI 四轴的左右极 */
export const MBTI_AXES = [
    { id: 'EI', left: 'E', right: 'I', zh: '能量来源', leftZh: '外向', rightZh: '内向' },
    { id: 'SN', left: 'S', right: 'N', zh: '信息获取', leftZh: '现实', rightZh: '直觉' },
    { id: 'TF', left: 'T', right: 'F', zh: '决策方式', leftZh: '理性', rightZh: '感性' },
    { id: 'JP', left: 'J', right: 'P', zh: '生活态度', leftZh: '计划', rightZh: '随性' },
]

/** MBTI 解锁门槛（对齐上游：≥100 条已分析文本） */
export const MBTI_MIN_MESSAGES = 100
/** 单轴证据门槛 */
export const MBTI_MIN_AXIS_EVIDENCE = 30
/** 单轴判定裕度 */
export const MBTI_MIN_AXIS_MARGIN = 0.2

//#endregion
