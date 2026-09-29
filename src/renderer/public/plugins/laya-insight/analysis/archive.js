/**
 * 归档导出：把插件内已经算好的分析结果打包成可以长期保存的文件。
 *
 * 为什么需要它：
 *   插件的记录全部放在宿主存储里（渲染进程一份内存缓存 + 每个会话一个 JSON 文件）。
 *   记录堆到几万条以后，每次写入要整文件重新序列化、界面侧的统计也要遍历全部记录，
 *   于是就会出现「越用越卡」。导出成独立文件之后可以随时翻看 / 备份，再配合
 *   「导出后清空」把插件自身的体积压回去。
 *
 * 产出两类文件（同名不同后缀）：
 *   <base>.json —— 完整原始数据，字段结构与内部存储一致，便于以后再处理
 *   <base>.md   —— 人可读摘要，直接打开就能看
 *
 * 这个模块是纯函数 + 只读 store，不碰模型、不发 IPC，方便单独验证。
 */

import { EMOTION_ZH } from '../laya/labels.js'
import { PLUGIN_ID, PLUGIN_VERSION } from '../ui/constants.js'

/** 关系倾向的中文说明（与 laya/labels.js 的 RELATIONSHIP_OPTIONS 一一对应） */
const RELATIONSHIP_ZH = {
    romantic: '亲密',
    warm: '亲近',
    neutral: '中性',
    distant: '疏远',
    rejecting: '拒绝',
}

/** 明细区最多写多少条，避免归档文件本身过大 */
const DETAIL_LIMIT = 60

/** 秒级时间戳 → `YYYY-MM-DD HH:mm` */
function formatTime(seconds) {
    const value = Number(seconds)
    if (!value) return ''
    const date = new Date(value * 1000)
    const pad = (n) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 文件基本名用的时间戳 `YYYYMMDD-HHmmss` */
export function stamp(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0')
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
        `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function utf8Bytes(text) {
    try {
        return new TextEncoder().encode(text).length
    } catch {
        return text.length
    }
}

/** 计数排序取前 n 项 */
function topEntries(counter, limit) {
    return Object.entries(counter)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
}

/** 从聊天记录里挑一个可读名字：优先群名 / 好友昵称，退回 id */
function chatLabel(key, meta, portrait) {
    const id = String(key).split(':')[1] || key
    return (portrait && portrait.target) || (meta && meta.name) || id
}

/**
 * 汇总单个会话的可读信息（不调模型，全部来自已存记录）。
 */
function summarizeChat({ key, records, portrait }) {
    const emotionCounter = {}
    const intentCounter = {}
    const relationshipCounter = {}
    let otherCount = 0
    let selfCount = 0
    let minTime = 0
    let maxTime = 0

    for (const record of records) {
        if (record.e) emotionCounter[record.e] = (emotionCounter[record.e] || 0) + 1
        if (record.i) intentCounter[record.i] = (intentCounter[record.i] || 0) + 1
        if (record.rr) relationshipCounter[record.rr] = (relationshipCounter[record.rr] || 0) + 1
        if (record.self) selfCount++
        else otherCount++
        const time = Number(record.t) || 0
        if (time) {
            if (!minTime || time < minTime) minTime = time
            if (!maxTime || time > maxTime) maxTime = time
        }
    }

    return {
        key,
        records: records.length,
        otherCount,
        selfCount,
        minTime,
        maxTime,
        topEmotions: topEntries(emotionCounter, 6)
            .map(([code, count]) => ({ label: EMOTION_ZH[code] || code, code, count })),
        topIntents: topEntries(intentCounter, 8)
            .map(([label, count]) => ({ label, count })),
        topRelationships: topEntries(relationshipCounter, 5)
            .map(([code, count]) => ({ label: RELATIONSHIP_ZH[code] || code, code, count })),
        portrait: portrait || null,
    }
}

/**
 * 生成归档文件内容。
 *
 * @param {object} params
 * @param {object} params.store  PluginStore
 * @param {string} params.uin    账号
 * @returns {{ base: string, files: Array<{name: string, text: string}>, bytes: number,
 *             stats: { chats: number, messages: number, portraits: number } }}
 */
export function buildArchive({ store, uin }) {
    const now = new Date()
    const base = `laya-insight_${uin || 'unknown'}_${stamp(now)}`
    const meta = store.getMeta(uin)
    const chatKeys = Object.keys(meta.chats || {})

    const chats = chatKeys.map((key) => {
        const records = store.listMessages(uin, key)
        const portrait = store.getPortrait(uin, key)
        const progress = (meta.chats || {})[key] || {}
        return {
            key,
            name: chatLabel(key, progress, portrait),
            records,
            portrait,
            progress,
        }
    })

    // 没有 meta 记录但存了数据的会话也要带上（例如清过 meta 之后又算过）
    const attachments = store.listAccountChats(uin)
    for (const key of attachments) {
        if (chatKeys.includes(key)) continue
        chats.push({
            key,
            name: chatLabel(key, null, store.getPortrait(uin, key)),
            records: store.listMessages(uin, key),
            portrait: store.getPortrait(uin, key),
            progress: {},
        })
    }

    const summaries = chats.map((chat) => summarizeChat(chat))
    const totalMessages = summaries.reduce((sum, item) => sum + item.records, 0)

    const payload = {
        plugin: PLUGIN_ID,
        version: PLUGIN_VERSION,
        schema: 1,
        uin,
        exportedAt: Date.now(),
        note: '由本地 Laya ONNX 模型生成，全部推理在本机完成，未联网。',
        chats: Object.fromEntries(chats.map((chat, index) => [chat.key, {
            name: chat.name,
            progress: chat.progress,
            summary: {
                records: summaries[index].records,
                otherCount: summaries[index].otherCount,
                selfCount: summaries[index].selfCount,
                minTime: summaries[index].minTime,
                maxTime: summaries[index].maxTime,
                topEmotions: summaries[index].topEmotions,
                topIntents: summaries[index].topIntents,
                topRelationships: summaries[index].topRelationships,
            },
            portrait: chat.portrait,
            messages: Object.fromEntries(
                chat.records.map((record) => [record.id, omitId(record)])),
        }])),
    }

    const markdown = buildMarkdown({ uin, base, summaries, chats, meta })
    const jsonText = JSON.stringify(payload, null, 2)

    return {
        base,
        files: [
            { name: `${base}.json`, text: jsonText },
            { name: `${base}.md`, text: markdown },
        ],
        bytes: utf8Bytes(jsonText) + utf8Bytes(markdown),
        stats: {
            chats: chats.length,
            messages: totalMessages,
            portraits: chats.filter((chat) => chat.portrait).length,
        },
    }
}

/** 记录里的 id 已经作为 key，导出时去掉重复字段 */
function omitId(record) {
    const { id, ...rest } = record
    void id
    return rest
}

/** 人可读摘要 */
function buildMarkdown({ uin, base, summaries, chats, meta }) {
    const lines = []
    lines.push('# Laya 意图与情绪感知 · 分析归档')
    lines.push('')
    lines.push(`- 账号：\`${uin}\``)
    lines.push(`- 导出时间：${formatTime(Date.now() / 1000)}`)
    lines.push(`- 会话：${summaries.length} 个 · 记录：${summaries.reduce((s, i) => s + i.records, 0)} 条`)
    lines.push(`- 插件版本：v${PLUGIN_VERSION}`)
    lines.push(`- 归档标识：\`${base}\``)
    lines.push('')
    lines.push('> 全部推理在本机的 Laya ONNX 模型上完成，未联网。')
    lines.push('> 同名的 `.json` 是完整原始数据，本文件只是便于浏览的摘要。')
    lines.push('')

    const sorted = [...summaries].sort((a, b) => (b.records || 0) - (a.records || 0))
    lines.push('## 总览')
    lines.push('')
    lines.push('| 会话 | 记录 | 对方 / 我 | 主要情绪 | 主要意图 | 好感度 |')
    lines.push('| --- | ---: | --- | --- | --- | --- |')
    for (const item of sorted) {
        const portrait = item.portrait || {}
        const score = portrait.affinity && typeof portrait.affinity.score === 'number'
            ? String(portrait.affinity.score)
            : (typeof portrait.score === 'number' ? String(portrait.score) : '—')
        lines.push(`| ${escapeCell(nameOf(item, chats))} | ${item.records} | ` +
            `${item.otherCount} / ${item.selfCount} | ${item.topEmotions[0]?.label || '—'} | ` +
            `${item.topIntents[0]?.label || '—'} | ${score} |`)
    }
    lines.push('')

    for (const item of summaries) {
        const chat = chats.find((entry) => entry.key === item.key) || { records: [], name: item.key }
        lines.push(`## ${nameOf(item, chats)}`)
        lines.push('')
        lines.push(`- 会话键：\`${item.key}\``)
        lines.push(`- 记录：${item.records} 条（对方 ${item.otherCount} / 我 ${item.selfCount}）`)
        if (item.minTime) {
            lines.push(`- 时间范围：${formatTime(item.minTime)} ~ ${formatTime(item.maxTime)}`)
        }
        lines.push(`- 情绪分布：${formatCounts(item.topEmotions)}`)
        lines.push(`- 意图分布：${formatCounts(item.topIntents)}`)
        if (item.topRelationships.length) {
            lines.push(`- 关系倾向：${formatCounts(item.topRelationships)}`)
        }
        lines.push('')

        const portrait = item.portrait
        if (portrait) {
            lines.push('### 人物画像')
            lines.push('')
            const score = (portrait.affinity && portrait.affinity.score) ??
                (typeof portrait.score === 'number' ? portrait.score : null)
            if (score !== null) {
                lines.push(`- 好感度：**${score}**${portrait.grade ? `（${portrait.grade}）` : ''}`)
            }
            if (portrait.summary) lines.push(`- 摘要：${portrait.summary}`)
            if (portrait.mbti && portrait.mbti.unlocked && portrait.mbti.code) {
                lines.push(`- MBTI：**${portrait.mbti.code}**（基于 ${portrait.mbti.total} 条）`)
            }
            if (Array.isArray(portrait.keywords) && portrait.keywords.length) {
                lines.push(`- 高频词：${portrait.keywords.map((w) => w.word || w).join('、')}`)
            }
            if (portrait.selfQuality) lines.push(`- 我的发挥：${portrait.selfQuality}`)
            if (Array.isArray(portrait.style) && portrait.style.length) {
                const text = portrait.style
                    .map((dim) => (dim && typeof dim === 'object'
                        ? `${dim.label || dim.name || dim.key} ${dim.value ?? dim.score ?? ''}`.trim()
                        : String(dim)))
                    .filter(Boolean)
                    .join(' · ')
                if (text) lines.push(`- 互动风格：${text}`)
            }
            lines.push('')
        }

        const detail = chat.records.slice(-DETAIL_LIMIT)
        if (detail.length) {
            lines.push(`### 记录明细（最近 ${detail.length} 条，共 ${item.records} 条）`)
            lines.push('')
            lines.push('| 时间 | 谁 | 情绪 | 意图 | 文本 |')
            lines.push('| --- | --- | --- | --- | --- |')
            for (const record of detail) {
                lines.push(`| ${formatTime(record.t)} | ${record.self ? '我' : '对方'} | ` +
                    `${EMOTION_ZH[record.e] || record.e || '—'} | ${record.i || '—'} | ` +
                    `${escapeCell(record.text || '')} |`)
            }
            lines.push('')
        }
    }

    if (meta && meta.updatedAt) {
        lines.push('---')
        lines.push('')
        lines.push(`_插件内该账号的进度更新时间：${formatTime(meta.updatedAt / 1000)}_`)
    }

    return lines.join('\n')
}

function nameOf(item, chats) {
    const chat = chats.find((entry) => entry.key === item.key)
    return (chat && chat.name) || item.key
}

function formatCounts(list) {
    if (!list || list.length === 0) return '—'
    return list.map((item) => `${item.label} ${item.count}`).join(' · ')
}

/** Markdown 表格单元格转义 */
function escapeCell(text) {
    return String(text ?? '')
        .replaceAll('|', '\\|')
        .replaceAll('\n', ' ')
        .trim()
}
