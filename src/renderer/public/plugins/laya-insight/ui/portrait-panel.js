/**
 * 人物画像面板。
 *
 * 全部用 host.vue 的 h() 手写渲染函数，不依赖客户端内部组件，
 * 也不引入图表库：六维雷达用手写 SVG。
 *
 * 面板内容：好感度 + 等级、六维互动风格雷达、肖像摘要、常聊内容（高频词）、
 * MBTI 四轴（未达门槛时锁定）、分析详情（已分析文本数与速率）。
 * 群聊支持「群整体 / 成员」切换，结果分别保存在各自的 chatKey 下。
 */

import { STYLE_DIMENSIONS, MBTI_MIN_MESSAGES } from '../laya/labels.js'

/** 成员每页数量 */
const PAGE_SIZE = 6

/**
 * 打开画像面板。
 * @param {object} deps
 */
export async function openPortrait({ host, runtime, store, pipeline, chat, uin }) {
    const { defineComponent, h, ref, computed, onMounted } = host.vue

    const chatStore = host.stores.chat()
    const chatName = chatStore.chatInfo?.show?.name || '当前会话'
    const members = chat.chatType === 'group'
        ? (chatStore.chatInfo?.info?.group_members || [])
        : []

    const Panel = defineComponent({
        name: 'LayaPortraitPanel',
        setup() {
            const scope = ref('group')          // group | member
            const memberId = ref(0)
            const page = ref(0)
            const loading = ref(true)
            const error = ref('')
            const portrait = ref(null)
            const progress = ref('')

            const member = computed(() =>
                members.find((item) => String(item.user_id) === String(memberId.value)) || null)

            /**
             * 当前视图的聚合范围。
             * 群整体 = 整会话记录；成员 = 从整会话记录里按发送者过滤后单独聚合。
             * 消息只分析一次，成员画像复用同一批记录，不重复推理。
             */
            const target = computed(() => {
                if (chat.chatType !== 'group' || scope.value === 'group') {
                    return {
                        scopeKey: `${chat.chatType}:${chat.chatId}`,
                        title: chat.chatType === 'group' ? `${chatName}（群整体）` : chatName,
                        senderId: null,
                        memberCount: members.length,
                    }
                }
                const item = member.value
                return {
                    scopeKey: `${chat.chatType}:${chat.chatId}#${memberId.value}`,
                    title: item ? (item.card || item.nickname || String(item.user_id)) : '成员',
                    senderId: memberId.value,
                    memberCount: null,
                }
            })

            const pagedMembers = computed(() =>
                members.slice(page.value * PAGE_SIZE, page.value * PAGE_SIZE + PAGE_SIZE))
            const totalPages = computed(() =>
                Math.max(1, Math.ceil(members.length / PAGE_SIZE)))

            async function load() {
                loading.value = true
                error.value = ''
                progress.value = '正在聚合已有记录……'
                try {
                    const view = target.value
                    progress.value = '正在计算互动风格与 MBTI……'
                    portrait.value = await pipeline.refreshPortrait({
                        uin,
                        chatType: chat.chatType,
                        chatId: chat.chatId,
                        // scopeKey 决定画像存在哪里（群整体 / 单个成员分开保存）
                        scopeKey: view.scopeKey,
                        // senderId 非空时只聚合该成员的消息记录
                        senderId: view.senderId,
                        members: view.memberCount,
                    })
                    if (portrait.value.total === 0 && view.senderId) {
                        error.value = '这位成员还没有可用的已分析消息'
                    }
                } catch (e) {
                    if (e && e.name === 'ModelNotReadyError') {
                        error.value = e.message
                    } else {
                        error.value = (e && e.message) || '画像计算失败'
                        host.log.error('画像计算失败', e)
                    }
                } finally {
                    progress.value = ''
                    loading.value = false
                }
            }

            onMounted(load)

            function switchScope(next) {
                if (scope.value === next) return
                if (next === 'member' && !memberId.value && members.length > 0) {
                    memberId.value = members[0].user_id
                }
                scope.value = next
                load()
            }

            function pickMember(id) {
                memberId.value = id
                scope.value = 'member'
                load()
            }

            return () => {
                const children = []
                children.push(h('div', { class: 'plugin-laya-portrait-head' }, [
                    h('b', null, target.value.title),
                    h('span', null, `账号 ${uin} · 本地 Laya 模型`),
                ]))

                if (chat.chatType === 'group') {
                    children.push(h('div', { class: 'plugin-laya-tabs' }, [
                        h('button', {
                            class: scope.value === 'group' ? 'active' : '',
                            onClick: () => switchScope('group'),
                        }, '群整体'),
                        h('button', {
                            class: scope.value === 'member' ? 'active' : '',
                            onClick: () => switchScope('member'),
                        }, '成员画像'),
                    ]))
                    if (scope.value === 'member') {
                        children.push(h('div', { class: 'plugin-laya-members' }, [
                            ...pagedMembers.value.map((item) => h('button', {
                                class: String(item.user_id) === String(memberId.value) ? 'active' : '',
                                onClick: () => pickMember(item.user_id),
                            }, item.card || item.nickname || String(item.user_id))),
                            totalPages.value > 1 ? h('div', { class: 'plugin-laya-pager' }, [
                                h('button', {
                                    disabled: page.value === 0,
                                    onClick: () => { page.value = Math.max(0, page.value - 1) },
                                }, '上一页'),
                                h('span', null, `${page.value + 1} / ${totalPages.value}`),
                                h('button', {
                                    disabled: page.value >= totalPages.value - 1,
                                    onClick: () => {
                                        page.value = Math.min(totalPages.value - 1, page.value + 1)
                                    },
                                }, '下一页'),
                            ]) : null,
                        ]))
                    }
                }

                if (loading.value) {
                    children.push(h('div', { class: 'plugin-laya-empty' }, progress.value || '正在计算……'))
                    return h('div', { class: 'plugin-laya-portrait' }, children)
                }
                if (error.value) {
                    children.push(h('div', { class: 'plugin-laya-empty error' }, error.value))
                    return h('div', { class: 'plugin-laya-portrait' }, children)
                }
                if (!portrait.value || portrait.value.total === 0) {
                    children.push(h('div', { class: 'plugin-laya-empty' },
                        '还没有可用的分析结果，先在聊天页停留一会儿让插件完成首轮分析。'))
                    return h('div', { class: 'plugin-laya-portrait' }, children)
                }

                const data = portrait.value

                // 好感度
                if (data.affinity && data.grade) {
                    children.push(h('div', { class: 'plugin-laya-affinity' }, [
                        h('div', { class: 'plugin-laya-affinity-score' }, [
                            h('b', null, String(data.affinity.score)),
                            h('span', null, `${data.grade.grade} · ${data.grade.zh}`),
                        ]),
                        h('div', { class: 'plugin-laya-affinity-meta' },
                            `基于 ${data.affinity.samples} 条关系信号（越新的消息权重越高）`),
                    ]))
                }

                // 六维雷达
                children.push(h('div', { class: 'plugin-laya-section' }, [
                    h('header', null, '互动风格'),
                    data.style && data.style.length
                        ? renderRadar(h, data.style)
                        : h('div', { class: 'plugin-laya-empty' }, '互动风格需要模型可用后重新计算'),
                ]))

                // 摘要
                children.push(h('div', { class: 'plugin-laya-section' }, [
                    h('header', null, '肖像摘要'),
                    h('p', { class: 'plugin-laya-text' }, data.summary || '暂无摘要'),
                ]))

                // 常聊内容
                children.push(h('div', { class: 'plugin-laya-section' }, [
                    h('header', null, '常聊内容'),
                    data.keywords.length
                        ? h('div', { class: 'plugin-laya-tags' }, data.keywords.map((item) =>
                            h('span', { class: 'plugin-deco-tag' }, `${item.word} · ${item.count}`)))
                        : h('p', { class: 'plugin-laya-text' }, '暂无高频词'),
                ]))

                // 情绪 / 意图分布
                children.push(h('div', { class: 'plugin-laya-section' }, [
                    h('header', null, '情绪与意图分布'),
                    h('div', { class: 'plugin-laya-tags' }, [
                        ...data.emotions.map((item) =>
                            h('span', { class: 'plugin-deco-tag plugin-deco-emotion' },
                                `${item.label} · ${item.count}`)),
                        ...data.intents.map((item) =>
                            h('span', { class: 'plugin-deco-tag plugin-deco-intent' },
                                `${item.label} · ${item.count}`)),
                    ]),
                ]))

                // MBTI
                children.push(h('div', { class: 'plugin-laya-section' }, [
                    h('header', null, 'MBTI 推测'),
                    data.mbti && data.mbti.unlocked
                        ? h('div', { class: 'plugin-laya-mbti' }, [
                            h('div', { class: 'plugin-laya-mbti-code' }, data.mbti.code),
                            ...data.mbti.axes.map((axis) => h('div', { class: 'plugin-laya-mbti-row' }, [
                                h('span', null, axis.zh),
                                h('b', null, axis.undetermined
                                    ? '未确定'
                                    : `${axis.letter}（${axis.letter === axis.left ? axis.leftZh : axis.rightZh}）`),
                                h('i', null, `证据 ${Math.round(axis.evidence * 100)}%`),
                            ])),
                        ])
                        : h('p', { class: 'plugin-laya-text' },
                            `已分析 ${data.mbti?.total ?? 0} 条，达到 ${MBTI_MIN_MESSAGES} 条后解锁`),
                ]))

                // 分析详情
                children.push(h('div', { class: 'plugin-laya-section' }, [
                    h('header', null, '分析详情'),
                    h('div', { class: 'plugin-laya-detail' }, [
                        h('span', null, `已分析文本 ${data.total} 条`),
                        h('span', null, `对方 ${data.samples.other} · 自己 ${data.samples.self}`),
                        h('span', null, data.selfQuality ? `我的发挥 ${data.selfQuality}` : ''),
                        h('span', null, pipeline.lastRate ? `最近速率 ${pipeline.lastRate}/s` : ''),
                        h('span', null, data.updatedAt
                            ? `更新于 ${new Date(data.updatedAt).toLocaleString()}` : ''),
                    ]),
                ]))

                children.push(h('div', { class: 'plugin-laya-actions' }, [
                    h('button', { class: 'ss-button', onClick: () => load() }, '重新计算'),
                    h('button', {
                        class: 'ss-button',
                        onClick: () => {
                            const stats = store.stats(uin)
                            host.alert('info', `本账号已保存 ${stats.messages} 条分析记录`)
                        },
                    }, '存储概况'),
                ]))

                return h('div', { class: 'plugin-laya-portrait' }, children)
            }
        },
    })

    host.openPanel({
        title: '人物画像',
        component: Panel,
        full: false,
        buttons: [
            { text: '关闭', master: true, fun: () => host.closePanel() },
        ],
    })
    void runtime
}

//#region == 雷达图 =============================================================

/** 手写六维雷达 SVG */
function renderRadar(h, style) {
    const size = 300
    const cx = size / 2
    const cy = size / 2 + 6
    const radius = 92
    const dimensions = STYLE_DIMENSIONS.map((dimension) => {
        const found = style.find((item) => item.id === dimension.id)
        return {
            zh: dimension.zh,
            value: found ? Math.max(0, Math.min(1, found.value)) : 0,
        }
    })
    const count = dimensions.length
    const angleOf = (index) => -Math.PI / 2 + (index * 2 * Math.PI) / count
    const pointAt = (index, value) => [
        cx + radius * value * Math.cos(angleOf(index)),
        cy + radius * value * Math.sin(angleOf(index)),
    ]
    const polygon = (value) => dimensions
        .map((_, index) => pointAt(index, value).map((n) => n.toFixed(1)).join(','))
        .join(' ')

    const children = []
    // 网格
    for (const ratio of [1, 0.75, 0.5, 0.25]) {
        children.push(h('polygon', {
            points: polygon(ratio),
            fill: 'none',
            stroke: 'var(--color-font-2)',
            'stroke-opacity': ratio === 1 ? 0.35 : 0.18,
            'stroke-width': 1,
        }))
    }
    // 轴线
    dimensions.forEach((_, index) => {
        const [x, y] = pointAt(index, 1)
        children.push(h('line', {
            x1: cx, y1: cy, x2: x, y2: y,
            stroke: 'var(--color-font-2)',
            'stroke-opacity': 0.2,
        }))
    })
    // 数据面
    children.push(h('polygon', {
        points: dimensions
            .map((dimension, index) => pointAt(index, dimension.value).map((n) => n.toFixed(1)).join(','))
            .join(' '),
        fill: 'var(--color-main)',
        'fill-opacity': 0.28,
        stroke: 'var(--color-main)',
        'stroke-width': 1.6,
    }))
    // 顶点与标签
    dimensions.forEach((dimension, index) => {
        const [x, y] = pointAt(index, 1)
        const [lx, ly] = pointAt(index, 1.24)
        const anchor = Math.abs(lx - cx) < 6 ? 'middle' : (lx > cx ? 'start' : 'end')
        children.push(h('circle', {
            cx: pointAt(index, dimension.value)[0],
            cy: pointAt(index, dimension.value)[1],
            r: 2.6,
            fill: 'var(--color-main)',
        }))
        children.push(h('text', {
            x: lx, y: ly,
            fill: 'var(--color-font)',
            'font-size': 11,
            'text-anchor': anchor,
            'dominant-baseline': 'middle',
        }, dimension.zh))
        children.push(h('text', {
            x: lx, y: ly + 12,
            fill: 'var(--color-font-2)',
            'font-size': 9,
            'text-anchor': anchor,
            'dominant-baseline': 'middle',
        }, `${Math.round(dimension.value * 100)}%`))
        void x
        void y
    })

    return h('svg', {
        class: 'plugin-laya-radar',
        viewBox: `0 0 ${size} ${size + 26}`,
        xmlns: 'http://www.w3.org/2000/svg',
    }, children)
}

//#endregion
