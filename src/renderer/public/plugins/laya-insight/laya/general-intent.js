/**
 * 泛化意图路线（general-intent v9）。
 *
 * 移植自 WechatVibe（electron/laya/general-intent.ts，其思路是把意图的
 * 「选项集」按消息动态裁剪到 8~10 个候选，而不是让模型在固定大类上硬选）：
 *   - 41 个意图词表（id / 中文 / 英文）；
 *   - 中文题面（模型是多语 mmBERT，中文题面 + 中文聊天内容分布最贴近）；
 *   - 正则线索只负责「把相关候选引入选项」，概率完全由模型给出；
 *   - 直接取 choice 的概率分布，不做任何路由乘法。
 *
 * 为什么要替换原来的「12 大类 → 群组」三级路由：
 *   固定 12 类对短消息没有区分度（"打王者"这种提议被均匀分布随机埋没），
 *   且三级乘法把细类概率压到 0.0x，显示出来像"什么都不敢确定"。
 */

/** 41 个意图词表。zh 用作模型选项文本，也是 UI 显示词 */
export const INTENTS = [
    { id: 'small_talk', zh: '闲聊', en: 'small talk' },
    { id: 'share_news', zh: '分享', en: 'share news' },
    { id: 'ask_question', zh: '提问', en: 'ask question' },
    { id: 'seek_help', zh: '求助', en: 'seek help' },
    { id: 'give_comfort', zh: '安慰', en: 'give comfort' },
    { id: 'agree', zh: '同意', en: 'agree or accept' },
    { id: 'invite', zh: '邀约', en: 'invite or plan' },
    { id: 'show_affection', zh: '表达好感', en: 'show affection' },
    { id: 'complain', zh: '抱怨', en: 'complain' },
    { id: 'apologize', zh: '道歉', en: 'apologize' },
    { id: 'joke', zh: '玩笑', en: 'joke' },
    { id: 'reject', zh: '拒绝', en: 'reject or decline' },
    { id: 'deny', zh: '否认', en: 'deny or disavow' },
    { id: 'distance', zh: '保持距离', en: 'create distance' },
    { id: 'thank', zh: '感谢', en: 'thank' },
    { id: 'greet', zh: '问候', en: 'greet' },
    { id: 'suggest_action', zh: '建议或指令', en: 'suggest or direct an action' },
    { id: 'explain', zh: '解释', en: 'explain' },
    { id: 'inform', zh: '告知事实', en: 'inform' },
    { id: 'plan', zh: '计划', en: 'plan' },
    { id: 'correct', zh: '纠正或异议', en: 'correct or disagree' },
    { id: 'status_report', zh: '状态报告', en: 'report status' },
    { id: 'confirm', zh: '确认', en: 'acknowledge' },
    { id: 'inspect', zh: '查看', en: 'inspect' },
    { id: 'follow_up', zh: '追问', en: 'follow up' },
    { id: 'clarify', zh: '澄清', en: 'clarify' },
    { id: 'share_feeling', zh: '表达感受', en: 'share a feeling' },
    { id: 'confide', zh: '倾诉', en: 'confide' },
    { id: 'seek_comfort', zh: '求安慰', en: 'seek comfort' },
    { id: 'seek_company', zh: '求陪伴', en: 'seek company' },
    { id: 'show_care', zh: '关心', en: 'show care' },
    { id: 'encourage', zh: '鼓励', en: 'encourage' },
    { id: 'praise', zh: '称赞', en: 'praise' },
    { id: 'celebrate', zh: '祝贺', en: 'congratulate' },
    { id: 'miss_you', zh: '表达想念', en: 'express missing someone' },
    { id: 'test_feelings', zh: '探询心意', en: 'ask about feelings' },
    { id: 'set_boundary', zh: '设定边界', en: 'set a boundary' },
    { id: 'reconcile', zh: '缓和关系', en: 'make peace' },
    { id: 'show_material', zh: '展示内容', en: 'show material' },
    { id: 'offer_help', zh: '提供帮助', en: 'offer help' },
    { id: 'tease', zh: '调侃', en: 'tease' },
    { id: 'close_chat', zh: '告别', en: 'say goodbye' },
    { id: 'general_exchange', zh: '一般交流', en: 'general exchange' },
]

const byId = new Map(INTENTS.map((intent) => [intent.id, intent]))
const byOption = new Map(INTENTS.flatMap((intent) => [[intent.zh, intent.id], [intent.en, intent.id]]))

/**
 * 意图 id → 插件群组 id（labels.js 的 26 群组）。
 * 群组用于画像聚合与负向意图提醒，显示词仍以 INTENTS.zh 为准。
 */
export const INTENT_TO_GROUP = {
    small_talk: 'conversation',
    share_news: 'sharing',
    ask_question: 'inquiry',
    seek_help: 'help_request',
    give_comfort: 'support',
    agree: 'commitment',
    invite: 'invitation',
    show_affection: 'affection',
    complain: 'complaint',
    apologize: 'apology',
    joke: 'humor',
    reject: 'rejection',
    deny: 'conversation',
    distance: 'boundary',
    thank: 'gratitude',
    greet: 'greeting',
    suggest_action: 'feedback',
    explain: 'sharing',
    inform: 'sharing',
    plan: 'planning',
    correct: 'conflict',
    status_report: 'sharing',
    confirm: 'commitment',
    inspect: 'planning',
    follow_up: 'inquiry',
    clarify: 'conversation',
    share_feeling: 'disclosure',
    confide: 'disclosure',
    seek_comfort: 'help_request',
    seek_company: 'help_request',
    show_care: 'support',
    encourage: 'support',
    praise: 'gratitude',
    celebrate: 'gratitude',
    miss_you: 'affection',
    test_feelings: 'flirt',
    set_boundary: 'boundary',
    reconcile: 'repair',
    show_material: 'sharing',
    offer_help: 'help_offer',
    tease: 'humor',
    close_chat: 'closure',
    general_exchange: 'conversation',
}

/** 意图 id → 群组 id（未知 id 落到一般交流） */
export function intentGroup(id) {
    return INTENT_TO_GROUP[id] || 'conversation'
}

//#region == 动态候选构造 ---------------------------------------------------------

const GENERAL_INSTRUCTIONS =
    '判断 TARGET 发送者正在做的交流动作。倾诉是主动向对方说自己的困扰，' +
    '安慰是回应对方难过，关心是询问或提醒对方近况；求安慰或陪伴须有明确请求。' +
    '不要根据称呼、引语或隐含关系猜意图；没有贴切项选一般交流。'

/** 恒定锚点与填充候选 */
const ANCHORS = ['inform', 'share_news', 'small_talk']
const FILLERS = ['status_report', 'explain', 'share_feeling', 'agree']
const MAX_OPTIONS = 10
const MIN_OPTIONS = 8

/** 引语剥离：引号里的内容不算当前说话人的意图线索 */
const QUOTED = /“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"]*"|`[^`]*`/gu

/** 疑问句线索（有限的中文疑问词集合，不追求穷尽） */
const QUESTION_CUE = /[？?]|(?:怎么|为什么|如何|是否|是不是|能否|能不能|多少|几点|几号|几(?:个人|位|楼|件|份|次|辆|本|条|张)|什么|咋(?:样|办|回事|了)|啥(?:时候|情况|意思)|干嘛|哪(?:个|家|里|儿))[^。！!？?]{0,20}(?:[。！!，,\s]|$)|(?:吗|呢)(?:[。！!，,\s]|$)|^(?:谁|什么|哪里|哪儿|何时|什么时候|几|多少)/u
const RHETORICAL_CORRECTION = /^(?:[^。！？?]{0,12})?这不[^。！？?]{1,50}(?:了|过)吗[？?]?$/u
const NONQUESTION_SHORT = /^(?:没什么|没啥)(?:事|意思|好说的)?[。！!\s]*$/u
const CARE_CONTINUATION = /[？?].{0,60}(?:早点休息|好好休息|注意身体|照顾好自己|别太累)/u
const DIRECTED_CONFIDING = /想跟你说|想找你聊|想聊聊|说说心里话|能不能听我说/u
const DENY_CONTEXT = /喜欢|爱|在乎|想我|暧昧|关系|要不要|是不是|会不会|是否/u

/** 邀约上下文线索（命中才把拒绝/改期候选引入选项） */
const INVITE_CONTEXT = /(?:要不要|一起|约|有空|安排|见面|出来|吃饭|看展|看电影|逛街|聚|来我家|请你|请我|周六|周日|周末|明天|后天|下周|下个月|开黑|上号|来一把|来一局|排位|巅峰赛|打游戏|王者|吃鸡)/u
/** “下次见/下次聊”是告别，不是邀约改期 */
const DEFERRAL = /改天|下次(?!见|聊|再聊|说)|以后再说|再说吧|再约|看情况|看(?:看)?再说|过(?:几|两)天|有空再说|回头(?:再)?(?:说|约)|晚点再说/u
const CONCRETE_TIME = /今天|明天|后天|明早|今晚|这周|本周|下周|周末|周[一二三四五六日天]|下个月|月底|月初|\d{1,2}[号日]/u
const CONCRETE_PLAN = /请你|请我|请客|我请|一起|约你|约我|见面|来找我|来找你/u

/** 上下文提示的码点上限 */
const MAX_HINT_CODEPOINTS = 240

/**
 * 本地化补充线索：QQ 场景的游戏/联机邀约。
 * 与 WechatVibe 的 CUES 分开列出，便于对照与增删。
 */
const LOCAL_CUES = [
    { pattern: /(?:开黑|上号|来一把|来一局|来把|排位|匹配|巅峰赛|打游戏|打王者|吃鸡|英雄联盟|王者峡谷|五排|双排|三排)/u, ids: ['invite', 'plan'] },
    { pattern: /(?:在吗|在不在|睡了吗|起了吗|到家了吗|下课了吗|下班了吗)/u, ids: ['show_care', 'greet'] },
]

/**
 * 字面措辞只负责检索候选；概率完全由模型给出。
 * 每条 pattern 命中后把对应候选 id 引入选项集。
 */
const CUES = [
    { pattern: /不去了|不参加|没法去|接不了|去不了|没空|不要了|不愿意|我拒绝|不接受|我不同意|(?:我们|咱们|两个人|彼此).{0,4}不(?:太)?合适/u, ids: ['reject', 'distance'] },
    { pattern: /(?:^|[，,。！!\s])(?:那|我)?还是算了(?:吧)?(?=$|[，,。！!\s])/u, ids: ['reject'] },
    { pattern: /别再|不要再|先别|不想谈|(?:我们|咱们|这段关系|这次聊天|这个话题).{0,4}到此为止|需要.{0,4}空间|保持距离/u, ids: ['set_boundary', 'distance'] },
    { pattern: /对不起|抱歉|不好意思|是我不对|我错了/u, ids: ['apologize', 'reconcile'] },
    { pattern: /和好|别生气|我们好好说|不想吵|重新开始/u, ids: ['reconcile', 'clarify'] },
    { pattern: /安慰我|哄哄我|给我点鼓励|想听你安慰|能不能听我说/u, ids: ['seek_comfort', 'confide'] },
    { pattern: /陪陪我|陪我聊|想有人陪|别走|留下来陪/u, ids: ['seek_company', 'seek_comfort'] },
    { pattern: /别(?:太)?难过|别(?:再)?生气|不要生气|别哭|放心|没事的|会好起来|别担心|不用怕|我(?:会|来)?陪你|我会陪你.{0,12}(?:处理|面对|度过)|慢慢来.{0,8}我陪你/u, ids: ['give_comfort'] },
    { pattern: /心里.{0,8}(?:难受|委屈|烦|苦)|有点(?:难过|委屈|伤心)|想跟你说|想找你聊|想聊聊|说说心里话|我很焦虑/u, ids: ['confide', 'share_feeling'] },
    { pattern: /你(?:是不是|还)?(?:喜欢|在乎|想|爱)我|你对我.{0,6}(?:感觉|想法)|我们算什么|你会不会想我/u, ids: ['test_feelings', 'show_affection'] },
    { pattern: /想你|思念你|好久不见|惦记你/u, ids: ['miss_you', 'show_affection'] },
    { pattern: /喜欢你|爱你|有你真好|对你心动/u, ids: ['show_affection', 'miss_you'] },
    { pattern: /还好吗|累不累|吃饭了吗|早点休息|注意身体|照顾好自己|到家了吗/u, ids: ['show_care'] },
    { pattern: /别担心|不用怕|没关系|会好起来|我陪着你/u, ids: ['give_comfort', 'show_care'] },
    { pattern: /加油|别灰心|相信你|你能行|坚持住/u, ids: ['encourage', 'give_comfort'] },
    { pattern: /真厉害|做得好|太棒了|佩服你|真优秀|真好看|你.{0,8}(?:不错|漂亮|好看|太牛|厉害)|(?:真|太|特别)(?:棒|牛|厉害|漂亮)/u, ids: ['praise', 'show_affection'] },
    { pattern: /恭喜|祝贺|生日快乐|新年快乐/u, ids: ['celebrate', 'show_care'] },
    { pattern: /我帮你|需要我帮|我来帮|我可以帮|交给我/u, ids: ['offer_help'] },
    { pattern: /给你看|发你|截图|照片|图片|视频|文件|链接|资料|附件|录屏/u, ids: ['show_material', 'share_news'] },
    { pattern: /真无语|太离谱|受不了|烦死|讨厌|怎么.{0,8}还|等了.{0,12}还没/u, ids: ['complain', 'share_feeling'] },
    { pattern: /不理我|不回我|不搭理我/u, ids: ['complain', 'seek_comfort'] },
    { pattern: /哈哈|笑死|逗你|开个玩笑|闹着玩|别当真|骗你的/u, ids: ['tease', 'joke'] },
    { pattern: /^(?:谢谢|谢了|感谢|多谢)|(?:谢谢|谢了|感谢|多谢)(?:你|您|你们|大家|各位|老师|同学|朋友|宝贝|啦|了|啊|呀|哦|哈|[，,。！!\s]|$)|辛苦(?:了|大家|各位|你们|老师)|感激不尽/u, ids: ['thank', 'show_care'] },
    { pattern: /^(?:你好|嗨|哈喽|早安|早上好|晚安|晚上好|hello|hi)(?:[，,!！。\s]|$)/iu, ids: ['greet', 'close_chat'] },
    { pattern: /你好(?!吃|看)|您好|早上好|下午好|晚上好|早安|晚安/u, ids: ['greet'] },
    { pattern: /拜拜|再见|明天见|回见|下次见|回头见|先挂了|我走了|不聊了|回头聊|先这样|下次聊/u, ids: ['close_chat', 'small_talk'] },
    { pattern: /^(?:嗯|好[的呀啊了]?|可以[的呀啊]?|行[的呀啊]?|没问题|当然可以|同意|OK|ok)(?:[，,.!！。\s]|$)/u, ids: ['agree', 'confirm'] },
    { pattern: /收到|明白了|知道了|确认一下|没错/u, ids: ['confirm', 'agree'] },
    { pattern: /我(?:先)?(?:看(?:看|一下)|查(?:看|一下))|我去看看/u, ids: ['inspect', 'plan'] },
    { pattern: /要不要.{0,12}(?:一起|去|来)|(?:我们|咱们|一起).{0,8}(?:去|来|吃|喝|玩|看|逛|见|聚|聊|打球)|约(?:个|你|我|在)/u, ids: ['invite', 'plan'] },
    { pattern: /帮我|帮忙|能不能.{0,8}(?:弄|看|改|做)|麻烦(?:你|您)|请(?:你|您)|(?:告诉|发给|给)我|把.{1,20}给我/u, ids: ['seek_help', 'ask_question'] },
    { pattern: /不是.{0,30}而是|不是的|当然不是|不对|应该是|你说的不对|我不同意|我不赞成/u, ids: ['correct', 'clarify'] },
    { pattern: /我的意思|我说的是|换句话说|澄清一下|解释一下/u, ids: ['clarify', 'explain'] },
    { pattern: /因为|由于|原因是|是因为|意味着|也就是说/u, ids: ['explain', 'inform'] },
    { pattern: /换个话题|说点别的|话说回来/u, ids: ['small_talk', 'clarify'] },
    { pattern: /后来呢|然后呢|你刚才说|再说说|所以呢|对不对|你知道吧/u, ids: ['follow_up', 'ask_question'] },
    { pattern: /打算|计划|准备|(?:我|我们|咱们)(?:今天|明天|后天|明早|今晚|周末|下周|下个月|改天|过几天).{0,12}(?:去|做|见|吃|看|打|联系|上班|回家)/u, ids: ['plan'] },
    { pattern: /已经|正在|进行中|还没|尚未|完成|修好了|成功了|失败了/u, ids: ['status_report', 'inform'] },
    { pattern: /推荐|你(?:可以|不妨)|可以(?:去|看|试|任?选)|任选(?:一个|一家)|(?:你|您).{0,40}选择.{0,12}吧|(?:你|您)自己选(?:定)?吧|(?:很好|不错|合适)的选择|都(?:还)?挺不错|都还不错|符合.{0,12}(?:要求|标准)|这些.{0,8}可以选择|看(?:你|您)喜欢哪个|挑一个/u, ids: ['suggest_action', 'offer_help'] },
    { pattern: /建议|可以先|不妨|最好|要不|试试|^(?:先|把|将|请|麻烦|记得|不要(?!难过|担心|怕)|别(?!太?难过|担心|怕))/u, ids: ['suggest_action', 'plan'] },
    { pattern: /(?:^|[，,。])我.{0,8}(?:觉得|感觉|开心|高兴|难过|失落|害怕|担心|期待|紧张)/u, ids: ['share_feeling', 'confide'] },
]

/**
 * 为一条目标消息构造动态候选的意图问题。
 * @param {string} targetText  目标消息文本
 * @param {string} contextHint 前文提示（会剥离引语并截到 240 码点）
 * @returns {{ question: object, focused: boolean }}
 */
export function generalIntentQuestion(targetText, contextHint = '') {
    const hint = Array.from(String(contextHint || '').replace(QUOTED, ' ').trim())
        .slice(0, MAX_HINT_CODEPOINTS).join('')
    const inviteContext = INVITE_CONTEXT.test(hint)
    const text = String(targetText || '').replace(QUOTED, ' ').trim()

    const options = [...ANCHORS]
    const add = (id) => {
        if (options.length < MAX_OPTIONS - 1 && !options.includes(id)) options.push(id)
    }
    let matched = false

    if (!NONQUESTION_SHORT.test(text) && !RHETORICAL_CORRECTION.test(text) &&
        QUESTION_CUE.test(text) && !CARE_CONTINUATION.test(text)) {
        add('ask_question')
        matched = true
    }
    if (RHETORICAL_CORRECTION.test(text)) {
        add('correct')
        add('clarify')
        matched = true
    }
    // 具体时间 + 计划动词是改期，不是拒绝
    if (CONCRETE_TIME.test(text) && CONCRETE_PLAN.test(text)) {
        add('plan')
        add('invite')
        matched = true
    } else if (inviteContext && DEFERRAL.test(text)) {
        // 邀约上下文 + 改期措辞：引入拒绝候选，但不替模型做决定
        add('reject')
        matched = true
    }
    // “木有/没有”只有在上下文有可否认的命题时才算否认
    if (/^(?:木有|没有)[。！!？?\s]*$/u.test(text) && DENY_CONTEXT.test(hint)) {
        add('deny')
        matched = true
    }
    for (const cue of [...CUES, ...LOCAL_CUES]) {
        if (!cue.pattern.test(text)) continue
        matched = true
        for (const id of cue.ids) {
            if (id === 'share_feeling' && DIRECTED_CONFIDING.test(text)) continue
            add(id)
        }
    }
    for (const id of FILLERS) {
        if (options.length >= MIN_OPTIONS - 1) break
        if (id === 'share_feeling' && DIRECTED_CONFIDING.test(text)) continue
        add(id)
    }
    options.push('general_exchange')

    return {
        question: {
            type: 'choice',
            instructions: GENERAL_INSTRUCTIONS,
            criteria: options.map((id) => byId.get(id).zh),
        },
        focused: matched,
    }
}

/**
 * 把 choice 答案直接转成「意图 id + 概率」的排序表。
 * 直接用模型的 choice 概率，不做乘法或再归一化。
 * @returns {Array<{ id: string, zh: string, probability: number }>}
 */
export function generalIntentScores(answer) {
    if (!answer || answer.type !== 'choice') return []
    const ranked = Object.entries(answer.probabilities || {})
        .filter(([, probability]) => Number.isFinite(probability) && probability >= 0 && probability <= 1)
        .sort((left, right) => right[1] - left[1])
    return ranked.flatMap(([option, probability]) => {
        const id = byOption.get(option)
        const intent = id ? byId.get(id) : null
        return intent ? [{ id: intent.id, zh: intent.zh, probability }] : []
    })
}

//#endregion
