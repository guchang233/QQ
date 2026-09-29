/*
 * @FileDescription: 插件用 Laya 本地模型运行时
 * @Author: WorkBuddy
 * @Date: 2026/09/29
 * @Version: 1.0
 *
 * 职责：把「模型文件 + 分词器 + ONNX 会话」这层重资产收在主进程里，
 * 渲染进程侧的插件只负责 prompt 构造与结果校准，两者通过 IPC 交换
 * 已经张量化好的输入 / 输出。
 *
 * 这样切分的理由：
 *   - model.onnx 体积 647MB，让它待在主进程只被读一次，避免渲染进程
 *     反复经由协议层搬运；
 *   - tokenizer.json 34MB，同样是本地文件，主进程读盘最直接；
 *   - onnxruntime-node 是原生模块，只能跑在主进程。
 *
 * 依赖（需在客户端根目录执行安装后生效）：
 *   yarn add onnxruntime-node @huggingface/tokenizers
 */

import fs from 'fs'
import path from 'path'
import log4js from 'log4js'
import Store from 'electron-store'
import { app, dialog, ipcMain } from 'electron'

const logger = log4js.getLogger('addon-laya')
const store = new Store()

/** 模型目录配置在应用配置里的键名 */
const MODEL_DIR_KEY = 'plugin_laya_model_dir'

/** 模型文件清单（与 laya-multilingual ONNX 发布包一致） */
export const MODEL_FILES = {
    model: 'model.onnx',
    agentConfig: 'rl_agent_config.json',
    onnxConfig: 'onnx_config.json',
    tokenizerJson: path.join('tokenizer', 'tokenizer.json'),
    tokenizerConfig: path.join('tokenizer', 'tokenizer_config.json'),
} as const

/**
 * 可选的执行提供者。
 *   auto      —— 先试 GPU（DirectML 随 onnxruntime-node 分发），失败自动退回 CPU
 *   dml       —— Windows DirectML（GPU），无需额外安装
 *   cuda / tensorrt / openvino —— 需要另行安装对应的原生运行时
 */
export type LayaProvider = 'auto' | 'cpu' | 'dml' | 'cuda' | 'tensorrt' | 'openvino'
/** ONNX 会话执行模式 */
export type LayaExecutionMode = 'sequential' | 'parallel'

/** 运行时状态 */
export interface LayaStatus {
    /** 依赖是否齐备且模型可加载 */
    available: boolean
    /** 依赖是否已安装（onnxruntime-node / @huggingface/tokenizers） */
    depsInstalled: boolean
    /** 模型是否已装载 */
    loaded: boolean
    /** 当前生效的模型目录 */
    modelDir: string
    /** 自动探测到的候选目录 */
    candidates: string[]
    /** 模型文件是否齐全 */
    filesReady: boolean
    /** 缺失的文件 */
    missing: string[]
    /** model.onnx 字节数 */
    modelBytes: number
    /** 实际使用的执行提供者 */
    provider: string
    /** 推理线程数 */
    threads: number
    /** ONNX 会话执行模式 */
    executionMode: LayaExecutionMode
    /** 本机探测可用的执行提供者（不含 auto） */
    availableProviders: string[]
    /** 按当前偏好的实际尝试顺序 */
    providerHint: string[]
    /** 错误信息 */
    error?: string
}

//#region == 状态 ================================================================

/** 插件显式配置的模型目录（优先于自动探测） */
let configuredDir = ''
/** 执行提供者偏好 */
let preferredProvider: LayaProvider = 'auto'
/** 推理线程数 */
let intraOpThreads = 4
/** ONNX 会话执行模式 */
let executionMode: LayaExecutionMode = 'sequential'

interface LoadedRuntime {
    ort: any
    tokenizer: LayaTokenizer
    session: any
    dir: string
    provider: string
}

let runtime: LoadedRuntime | null = null
let loading: Promise<LoadedRuntime> | null = null
/** 代际：配置变更后让在途加载作废 */
let generation = 0
/** 模型只跑一次推理，串行化避免同一 session 并发写 */
let runTail: Promise<any> = Promise.resolve()

//#endregion

//#region == 依赖懒加载 ==========================================================

let ortModule: any = null
let tokenizersModule: any = null
let depsError = ''

/**
 * 懒加载原生依赖。onnxruntime-node 是 CJS 包，从 ESM 里 import 之后
 * 命名导出是否可用取决于 cjs-module-lexer，这里两种形态都兜住。
 */
async function importNativeDeps() {
    if (ortModule && tokenizersModule) return { ort: ortModule, tokenizers: tokenizersModule }
    try {
        const ortRaw: any = await import('onnxruntime-node')
        const ort = ortRaw?.InferenceSession ? ortRaw : (ortRaw?.default ?? ortRaw)
        if (!ort?.InferenceSession) throw new Error('onnxruntime-node 未导出 InferenceSession')

        const tkRaw: any = await import('@huggingface/tokenizers')
        const tokenizers = tkRaw?.Tokenizer ? tkRaw : (tkRaw?.default ?? tkRaw)
        if (!tokenizers?.Tokenizer) throw new Error('@huggingface/tokenizers 未导出 Tokenizer')

        ortModule = ort
        tokenizersModule = tokenizers
        depsError = ''
        return { ort, tokenizers }
    } catch (e) {
        depsError = (e as Error)?.message ?? String(e)
        logger.error(e as Error, '插件模型依赖加载失败')
        throw new Error(
            '缺少模型运行依赖，请在客户端根目录执行：\n' +
            '  yarn add onnxruntime-node @huggingface/tokenizers\n' +
            `原始错误：${depsError}`,
        )
    }
}

//#endregion

//#region == Tokenizer ==========================================================

/**
 * 与 Rust `tokenizers` crate 对齐的 Metaspace 编码器。
 *
 * 来源：laya-mlx（Apache-2.0）web/packages/laya-web/src/tokenizer.ts，
 * 经 WechatVibe 移植版本精简。逻辑保持一致，仅去掉注释与未使用分支，
 * 便于在本客户端内维护；升级 @huggingface/tokenizers 后需重新核对
 * 下面注释里提到的两处偏差。
 *
 * @huggingface/tokenizers@0.2.0 与 Rust 实现有两处差异：
 *   1. 对 lstrip added token，它会对前一个切片做 trimEnd()，若该切片本身
 *      是纯空白 added token（如 "\n"），会被清空并当作零长切片丢弃；
 *   2. 它的 lstrip/rstrip 判断用的是 JS 的 trimStart/trimEnd（等价 \s），
 *      而非 Unicode White_Space。
 * 因此这里不调用库自带的 added token 匹配：先在原文上做两阶段匹配
 * （阶段一按「最左最长」找出所有 added token 内容，阶段二按 lstrip/rstrip
 * 向两侧空白扩展，但不越过相邻匹配），剩余空隙再按 Replace(" "→_)
 * 归一化 + Metaspace `always` 前导 + 逐片 BPE 编码。
 */
interface AddedTokenInfo {
    id: number
    lstrip: boolean
    rstrip: boolean
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const isWhitespace = (ch: string) => /\p{White_Space}/u.test(ch)

export class LayaTokenizer {
    readonly clsTokenId: number
    readonly sepTokenId: number
    readonly padTokenId: number
    readonly maskTokenId: number
    readonly maskToken: string

    private readonly inner: any
    private readonly contentPattern: RegExp
    private readonly addedTokenInfo: Map<string, AddedTokenInfo>
    private readonly replacement: string
    private readonly pieceSplitter: RegExp

    constructor(tokenizerJson: any, tokenizerConfig: any, Tokenizer: any) {
        const pre = tokenizerJson.pre_tokenizer
        if (pre?.type !== 'Metaspace' ||
            pre.prepend_scheme !== 'always' || pre.split !== true) {
            throw new Error('LayaTokenizer 只支持 Metaspace(prepend_scheme=always, split=true)')
        }
        this.replacement = pre.replacement ?? '▁'
        if ([...this.replacement].length !== 1) {
            throw new Error('Metaspace replacement 必须是单个码点')
        }
        const norm = tokenizerJson.normalizer
        if (norm !== null && (norm.type !== 'Replace' ||
            norm.pattern?.String !== ' ' || norm.content !== this.replacement)) {
            throw new Error('LayaTokenizer 只支持 null 或 Replace(" " -> replacement) 归一化器')
        }
        const addedTokens: any[] = Array.isArray(tokenizerJson.added_tokens)
            ? tokenizerJson.added_tokens : []
        if (addedTokens.some((a) => a.normalized || a.single_word)) {
            throw new Error('LayaTokenizer 要求 added token 的 normalized=false 且 single_word=false')
        }

        this.inner = new Tokenizer(tokenizerJson, tokenizerConfig)
        const added = [...addedTokens].sort((a, b) => b.content.length - a.content.length)
        this.addedTokenInfo = new Map(
            added.map((a) => [a.content, { id: a.id, lstrip: a.lstrip, rstrip: a.rstrip }]),
        )
        this.contentPattern = new RegExp(
            added.map((a) => escapeRegExp(a.content)).join('|'), 'gu')
        this.pieceSplitter = new RegExp(
            `${escapeRegExp(this.replacement)}[^${escapeRegExp(this.replacement)}]*`, 'gu')

        const special = (name: string): [string, number] => {
            const raw = tokenizerConfig?.[name]
            const content = typeof raw === 'string' ? raw : raw?.content
            const id = content === undefined
                ? undefined
                : (this.addedTokenInfo.get(content)?.id ?? this.inner.token_to_id(content))
            if (content === undefined || id === undefined) {
                throw new Error(`分词器缺少有效的 ${name}`)
            }
            return [content, id]
        }
        this.maskToken = special('mask_token')[0]
        this.maskTokenId = special('mask_token')[1]
        this.clsTokenId = special('cls_token')[1]
        this.sepTokenId = special('sep_token')[1]
        this.padTokenId = special('pad_token')[1]
    }

    /** 去掉 special token 的编码，等价 Python `tok(text, add_special_tokens=False)` */
    encode(text: string): number[] {
        const ids: number[] = []
        let last = 0
        for (const match of this.matchAddedTokens(text)) {
            ids.push(...this.encodeSegment(text.slice(last, match.start)))
            ids.push(match.id)
            last = match.end
        }
        ids.push(...this.encodeSegment(text.slice(last)))
        return ids
    }

    private matchAddedTokens(text: string): { start: number; end: number; id: number }[] {
        const raw: { start: number; end: number; info: AddedTokenInfo }[] = []
        for (const m of text.matchAll(this.contentPattern)) {
            const info = this.addedTokenInfo.get(m[0])
            if (info === undefined) continue
            raw.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, info })
        }
        const extended: { start: number; end: number; id: number }[] = []
        let prevEnd = 0
        for (let i = 0; i < raw.length; i++) {
            const { start: rawStart, end: rawEnd, info } = raw[i]
            let start = rawStart
            let end = rawEnd
            if (info.lstrip) {
                while (start > prevEnd && isWhitespace(text[start - 1])) start--
            }
            const nextStart = i + 1 < raw.length ? raw[i + 1].start : text.length
            if (info.rstrip) {
                while (end < nextStart && isWhitespace(text[end])) end++
            }
            extended.push({ start, end, id: info.id })
            prevEnd = end
        }
        return extended
    }

    private encodeSegment(segment: string): number[] {
        if (segment === '') return []
        let normalized = segment.replaceAll(' ', this.replacement)
        if (!normalized.startsWith(this.replacement)) {
            normalized = this.replacement + normalized
        }
        const pieces = normalized.match(this.pieceSplitter) ?? []
        const ids: number[] = []
        for (const piece of pieces) {
            ids.push(...this.inner.encode(piece, { add_special_tokens: false }).ids)
        }
        return ids
    }
}

//#endregion

//#region == 模型目录解析 ========================================================

/** 模型目录自动探测候选（按优先级） */
export function listModelDirCandidates(): string[] {
    const list: string[] = []
    const push = (p?: string) => {
        if (!p) return
        const abs = path.resolve(p)
        if (!list.includes(abs)) list.push(abs)
    }
    push(configuredDir)
    push(process.env.LAYA_MODEL_DIR)
    // 打包形态：应用根目录（asar 所在目录）下的 .local/models/laya
    try {
        push(path.join(path.dirname(app.getAppPath()), '.local', 'models', 'laya'))
    } catch { /* 忽略 */ }
    // 打包形态：随应用资源分发
    try {
        if ((process as any).resourcesPath) {
            const res = (process as any).resourcesPath as string
            // <resources>/<应用目录>/.local/models/laya —— 本机 win-unpacked 布局
            push(path.join(res, 'client', '.local', 'models', 'laya'))
            push(path.join(res, 'models', 'laya'))
        }
    } catch { /* 忽略 */ }
    // 用户数据目录（插件内下载的模型落点）
    try {
        push(path.join(app.getPath('userData'), 'models', 'laya'))
    } catch { /* 忽略 */ }
    // 工作目录约定
    push(path.join(process.cwd(), '.local', 'models', 'laya'))
    push(path.join(process.cwd(), '.models', 'laya'))
    push(path.join(process.cwd(), 'models', 'laya'))
    return list
}

/** 目录里的模型文件检查结果 */
function inspectDir(dir: string) {
    const missing: string[] = []
    Object.values(MODEL_FILES).forEach((rel) => {
        if (!fs.existsSync(path.join(dir, rel))) missing.push(rel)
    })
    let modelBytes = 0
    try {
        modelBytes = fs.statSync(path.join(dir, MODEL_FILES.model)).size
    } catch { /* 忽略 */ }
    return { missing, filesReady: missing.length === 0, modelBytes }
}

/** 解析生效的模型目录：优先显式配置，其次第一个文件齐全的候选 */
export function resolveModelDir(): string {
    const candidates = listModelDirCandidates()
    if (configuredDir) {
        const abs = path.resolve(configuredDir)
        if (inspectDir(abs).filesReady) return abs
    }
    for (const dir of candidates) {
        if (inspectDir(dir).filesReady) return dir
    }
    // 都不完整时返回首个候选，供状态展示
    return candidates[0] ?? ''
}

//#endregion

//#region == 装载 / 释放 =========================================================

function sessionOptions(provider: string) {
    const useCpu = provider === 'cpu'
    return {
        executionProviders: [provider],
        intraOpNumThreads: intraOpThreads,
        interOpNumThreads: 1,
        executionMode,
        graphOptimizationLevel: 'all',
        // 仅 CPU 下启用内存池，GPU 提供者下反而拖慢首次装载
        enableMemPattern: useCpu,
        logSeverityLevel: 3,
    }
}

/**
 * 把偏好展开成实际尝试顺序。
 * auto = 「先 GPU 后 CPU」——DirectML.dll 随 onnxruntime-node 一起分发，
 * 没有独立显卡的机器也能靠集成显卡跑；显式指定时同样保留 CPU 兜底。
 */
function providerOrder(preference: LayaProvider): string[] {
    if (preference === 'auto') return ['dml', 'cpu']
    if (preference === 'cpu') return ['cpu']
    return [preference, 'cpu']
}

/**
 * 探测本机可用的执行提供者。
 * CPU 恒可用；DirectML 看随包分发的 DirectML.dll 是否存在（dev 与打包布局都查）。
 * cuda / tensorrt / openvino 需要用户自行安装原生库，这里不做运行时探测。
 */
function listAvailableProviders(): string[] {
    const list = ['cpu']
    const rel = path.join('onnxruntime-node', 'bin', 'napi-v6', process.platform, process.arch)
    for (const root of [app.getAppPath(), process.cwd()]) {
        try {
            if (fs.existsSync(path.join(root, rel, 'DirectML.dll'))) {
                list.push('dml')
                break
            }
        } catch { /* 忽略 */ }
    }
    return list
}

/** 用一次极小前向确认 provider 可用 */
async function probe(ort: any, session: any): Promise<boolean> {
    try {
        const feeds: Record<string, any> = {
            input_ids: new ort.Tensor('int64', BigInt64Array.from([1n, 2n]), [1, 2]),
            attention_mask: new ort.Tensor('int64', BigInt64Array.from([1n, 1n]), [1, 2]),
            marker_pos: new ort.Tensor('int64', BigInt64Array.from([1n, 1n]), [1, 2]),
            marker_mask: new ort.Tensor('bool', Uint8Array.from([1, 1]), [1, 2]),
            qtype: new ort.Tensor('int64', BigInt64Array.from([0n]), [1]),
        }
        await session.run(feeds)
        return true
    } catch (e) {
        logger.error(e as Error, '模型自检失败')
        return false
    }
}

/** 加载（或复用）运行时 */
export async function ensureRuntime(): Promise<LoadedRuntime> {
    if (runtime) return runtime
    if (loading) return loading

    const myGeneration = generation
    loading = (async () => {
        const { ort, tokenizers } = await importNativeDeps()
        const dir = resolveModelDir()
        if (!dir) throw new Error('未找到 Laya 模型目录，请在插件设置中指定')
        const { missing, filesReady } = inspectDir(dir)
        if (!filesReady) {
            throw new Error(`模型目录文件不完整，缺少：${missing.join('、')}`)
        }

        const tokenizerJson = JSON.parse(
            fs.readFileSync(path.join(dir, MODEL_FILES.tokenizerJson), 'utf8'))
        const tokenizerConfig = JSON.parse(
            fs.readFileSync(path.join(dir, MODEL_FILES.tokenizerConfig), 'utf8'))

        const tokenizer = new LayaTokenizer(tokenizerJson, tokenizerConfig, tokenizers.Tokenizer)

        const preference = preferredProvider
        const order = providerOrder(preference)

        let session: any = null
        let used = ''
        for (const candidate of order) {
            try {
                const next = await ort.InferenceSession.create(
                    path.join(dir, MODEL_FILES.model),
                    sessionOptions(candidate),
                )
                if (await probe(ort, next)) {
                    session = next
                    used = candidate
                    break
                }
                await next.release?.()
            } catch (e) {
                logger.error(e as Error, `执行提供者 ${candidate} 装载失败，尝试下一个`)
            }
        }
        if (!session) throw new Error('ONNX 会话创建失败：所有执行提供者均不可用')
        if (generation !== myGeneration) {
            await session.release?.()
            throw new Error('模型加载已被新的配置请求取代')
        }

        runtime = { ort, tokenizer, session, dir, provider: used }
        logger.info(`Laya 模型装载完成（provider=${used}）`)
        return runtime
    })()

    try {
        return await loading
    } finally {
        loading = null
    }
}

/** 释放会话 */
export async function releaseRuntime() {
    if (runtime) {
        try {
            await runtime.session?.release?.()
        } catch (e) {
            logger.error(e as Error, '释放 ONNX 会话失败')
        }
        runtime = null
    }
    generation++
}

/** 串行化推理，避免同一 session 并发 */
function runTailLock<T>(task: () => Promise<T>): Promise<T> {
    const next = runTail.then(task, task)
    runTail = next.catch(() => undefined)
    return next
}

//#endregion

//#region == 对外能力 ============================================================

/** 读取状态 */
export async function getStatus(): Promise<LayaStatus> {
    const dir = resolveModelDir()
    const { missing, filesReady, modelBytes } = dir
        ? inspectDir(dir)
        : { missing: [] as string[], filesReady: false, modelBytes: 0 }
    let depsInstalled = !!ortModule && !!tokenizersModule
    if (!depsInstalled) {
        try {
            await importNativeDeps()
            depsInstalled = true
        } catch { /* 依赖缺失 */ }
    }
    return {
        available: filesReady && depsInstalled,
        depsInstalled,
        loaded: !!runtime,
        modelDir: dir,
        candidates: listModelDirCandidates(),
        filesReady,
        missing,
        modelBytes,
        provider: runtime?.provider ?? '',
        threads: intraOpThreads,
        executionMode,
        availableProviders: listAvailableProviders(),
        providerHint: providerOrder(preferredProvider),
        error: depsError || undefined,
    }
}

/**
 * 更新配置（模型目录 / provider / 线程数 / 执行模式），会使已装载会话失效。
 * 线程数与执行模式是会话级参数，改动同样需要重建会话才能生效。
 */
export async function configure(patch: {
    modelDir?: string
    provider?: LayaProvider
    threads?: number
    executionMode?: LayaExecutionMode
}): Promise<LayaStatus> {
    const prevThreads = intraOpThreads
    const prevMode = executionMode
    if (typeof patch.modelDir === 'string') configuredDir = patch.modelDir.trim()
    if (patch.provider) preferredProvider = patch.provider
    if (patch.threads && patch.threads > 0) {
        intraOpThreads = Math.min(Math.max(1, Math.floor(patch.threads)), 16)
    }
    if (patch.executionMode === 'sequential' || patch.executionMode === 'parallel') {
        executionMode = patch.executionMode
    }
    const changed = typeof patch.modelDir === 'string'
        || !!patch.provider
        || intraOpThreads !== prevThreads
        || executionMode !== prevMode
    if (changed && runtime) {
        await releaseRuntime()
    }
    return getStatus()
}

/**
 * 预热：立即装载模型。provider 的回退（dml 装载失败退回 cpu）只有真正
 * create 会话时才会暴露，预热能把这类问题在配置阶段就摆到用户面前。
 */
export async function prewarm(): Promise<LayaStatus> {
    try {
        await ensureRuntime()
    } catch (e) {
        logger.error(e as Error, '模型预热失败')
    }
    return getStatus()
}

/** 分词：返回每段文本的 token id 序列 */
export async function tokenize(texts: string[]) {
    const { tokenizer } = await ensureRuntime()
    return {
        ids: texts.map((text) => tokenizer.encode(String(text ?? ''))),
        special: {
            cls: tokenizer.clsTokenId,
            sep: tokenizer.sepTokenId,
            pad: tokenizer.padTokenId,
            mask: tokenizer.maskTokenId,
            maskToken: tokenizer.maskToken,
        },
    }
}

/** 读取 special token 表（不装载模型也能拿到） */
export async function specialTokens() {
    const { tokenizer } = await ensureRuntime()
    return {
        cls: tokenizer.clsTokenId,
        sep: tokenizer.sepTokenId,
        pad: tokenizer.padTokenId,
        mask: tokenizer.maskTokenId,
        maskToken: tokenizer.maskToken,
    }
}

/** 推理输入 */
export interface InferPayload {
    rows: number
    length: number
    markers: number
    /** int64 [rows, length] */
    inputIds: BigInt64Array | number[]
    /** int64 [rows, length] */
    attentionMask: BigInt64Array | number[]
    /** int64 [rows, markers] */
    markerPos: BigInt64Array | number[]
    /** bool [rows, markers] */
    markerMask: Uint8Array | number[]
    /** int64 [rows] */
    qtype: BigInt64Array | number[]
}

function toBigInt64(src: BigInt64Array | number[]): BigInt64Array {
    if (src instanceof BigInt64Array) return src
    return BigInt64Array.from(src, (v) => BigInt(v))
}

/** 推理：返回 float32 logits / act_logits */
export async function infer(payload: InferPayload) {
    return runTailLock(async () => {
        const { ort, session } = await ensureRuntime()
        const rows = Number(payload.rows)
        const length = Number(payload.length)
        const markers = Number(payload.markers)
        const feeds: Record<string, any> = {
            input_ids: new ort.Tensor('int64', toBigInt64(payload.inputIds), [rows, length]),
            attention_mask: new ort.Tensor('int64', toBigInt64(payload.attentionMask), [rows, length]),
            marker_pos: new ort.Tensor('int64', toBigInt64(payload.markerPos), [rows, markers]),
            marker_mask: new ort.Tensor('bool',
                payload.markerMask instanceof Uint8Array
                    ? payload.markerMask
                    : Uint8Array.from(payload.markerMask as number[]),
                [rows, markers]),
            qtype: new ort.Tensor('int64', toBigInt64(payload.qtype), [rows]),
        }
        const output = await session.run(feeds)
        const logits = output?.logits
        const actLogits = output?.act_logits
        if (!logits || !actLogits) {
            throw new Error('ONNX 图未返回 logits / act_logits')
        }
        return {
            markers: Number(logits.dims[1]),
            actions: Number(actLogits.dims[1]),
            logits: logits.data as Float32Array,
            actLogits: actLogits.data as Float32Array,
        }
    })
}

/** 读取模型目录里的 rl_agent_config.json */
export async function agentConfig() {
    const dir = resolveModelDir()
    if (!dir) throw new Error('未找到 Laya 模型目录')
    return JSON.parse(fs.readFileSync(path.join(dir, MODEL_FILES.agentConfig), 'utf8'))
}

//#endregion

//#region == 插件 IPC 注册 ======================================================

/** 防止窗口重建时重复注册（ipcMain.handle 二次注册会抛错） */
let ipcRegistered = false

/**
 * 注册 Laya 模型运行时的 IPC 通道（addon:laya:*）。
 * 由 ipc.ts 调用；与通用插件桥（addon-bridge.ts）分离，保持框架层与
 * 具体插件的边界——框架层不感知任何模型。
 */
export function regLayaIpc() {
    if (ipcRegistered) return
    ipcRegistered = true

    ipcMain.handle('addon:laya:status', async () => {
        try {
            return await getStatus()
        } catch (e) {
            logger.error(e as Error, '读取模型状态失败')
            return { available: false, loaded: false, error: (e as Error)?.message }
        }
    })

    ipcMain.handle('addon:laya:configure', async (_, patch: any) => {
        try {
            const status = await configure(patch ?? {})
            if (patch && typeof patch.modelDir === 'string') {
                store.set(MODEL_DIR_KEY, patch.modelDir)
            }
            logger.info(`模型配置已更新：dir=${status.modelDir} provider=${patch?.provider ?? '-'}`)
            return status
        } catch (e) {
            logger.error(e as Error, '更新模型配置失败')
            return { available: false, loaded: false, error: (e as Error)?.message }
        }
    })

    ipcMain.handle('addon:laya:pickModelDir', async () => {
        const result = await dialog.showOpenDialog({
            title: '选择 Laya 模型目录（应包含 model.onnx 与 tokenizer/）',
            properties: ['openDirectory'],
        })
        if (result.canceled || result.filePaths.length === 0) return null
        return result.filePaths[0]
    })

    ipcMain.handle('addon:laya:specialTokens', async () => {
        return await specialTokens()
    })

    ipcMain.handle('addon:laya:tokenize', async (_, texts: string[]) => {
        return await tokenize(Array.isArray(texts) ? texts : [])
    })

    ipcMain.handle('addon:laya:infer', async (_, payload: InferPayload) => {
        return await infer(payload)
    })

    ipcMain.handle('addon:laya:agentConfig', async () => {
        return await agentConfig()
    })

    ipcMain.handle('addon:laya:release', async () => {
        await releaseRuntime()
        return true
    })

    // 预热：立即装载模型，让 provider 回退 / 缺文件等问题在配置时就暴露
    ipcMain.handle('addon:laya:prewarm', async () => {
        try {
            return await prewarm()
        } catch (e) {
            logger.error(e as Error, '模型预热失败')
            return { available: false, loaded: false, error: (e as Error)?.message }
        }
    })

    // 模型下载（默认 HF 镜像，可在插件设置里改镜像源）
    ipcMain.handle('addon:laya:downloadModel', async (_, mirror?: string) => {
        return await downloadModel(mirror)
    })

    ipcMain.handle('addon:laya:downloadStatus', async () => {
        return downloadStatus()
    })

    // 启动时恢复上次配置的模型目录
    const savedDir = store.get(MODEL_DIR_KEY)
    if (typeof savedDir === 'string' && savedDir.trim().length > 0) {
        configure({ modelDir: savedDir })
            .then((status) => {
                logger.info(`已恢复模型目录：${status.modelDir}（文件${status.filesReady ? '齐全' : '不完整'}）`)
            })
            .catch((e) => logger.error(e as Error, '恢复模型目录失败'))
    }
}

//#endregion

//#region == 模型下载 ===========================================================

/**
 * 模型仓库清单（mizchi/laya-multilingual-onnx）。
 * 与 MODEL_FILES 一一对应；model.onnx 约 617MB，走 LFS。
 */
const DOWNLOAD_FILES = [
    'model.onnx',
    'onnx_config.json',
    'rl_agent_config.json',
    'tokenizer/tokenizer.json',
    'tokenizer/tokenizer_config.json',
]
const MODEL_REPO = 'mizchi/laya-multilingual-onnx'
const DEFAULT_MIRROR = 'https://hf-mirror.com'

interface DownloadState {
    running: boolean
    /** 当前文件（0-based 序号 + 名字） */
    index: number
    file: string
    /** 当前文件已接收 / 总字节；total 可能为 -1（服务端未给长度） */
    received: number
    total: number
    /** 已完成文件数 / 全部文件数 */
    filesDone: number
    filesTotal: number
    error: string
    done: boolean
}

let downloadState: DownloadState = {
    running: false, index: 0, file: '', received: 0, total: -1,
    filesDone: 0, filesTotal: DOWNLOAD_FILES.length, error: '', done: false,
}

function downloadTargetDir(): string {
    // 与 listModelDirCandidates 的自动探测候选保持一致
    return path.join(app.getPath('userData'), 'models', 'laya')
}

/** 启动模型下载（幂等：下载中重复调用直接返回当前状态） */
export async function downloadModel(mirror?: string): Promise<DownloadState> {
    if (downloadState.running) return downloadState
    const base = String(mirror ?? '').trim().replace(/\/+$/, '') || DEFAULT_MIRROR
    const dir = downloadTargetDir()
    downloadState = {
        running: true, index: 0, file: '', received: 0, total: -1,
        filesDone: 0, filesTotal: DOWNLOAD_FILES.length, error: '', done: false,
    }
    // 后台执行，进度用 addon:laya:downloadStatus 轮询
    void (async () => {
        try {
            fs.mkdirSync(path.join(dir, 'tokenizer'), { recursive: true })
            for (let i = 0; i < DOWNLOAD_FILES.length; i++) {
                const rel = DOWNLOAD_FILES[i]
                downloadState.index = i
                downloadState.file = rel
                downloadState.received = 0
                downloadState.total = -1
                const target = path.join(dir, rel)
                // 已存在且大小一致的文件跳过（断点续传的粗粒度形态）
                if (fs.existsSync(target)) {
                    const remoteSize = await headSize(`${base}/${MODEL_REPO}/resolve/main/${rel}`)
                    if (remoteSize > 0 && fs.statSync(target).size === remoteSize) {
                        downloadState.filesDone++
                        continue
                    }
                }
                const response = await fetch(`${base}/${MODEL_REPO}/resolve/main/${rel}`, {
                    redirect: 'follow',
                })
                if (!response.ok || !response.body) {
                    throw new Error(`下载 ${rel} 失败：HTTP ${response.status}`)
                }
                const total = Number(response.headers.get('content-length') ?? -1)
                downloadState.total = total
                const fileStream = fs.createWriteStream(`${target}.part`)
                let received = 0
                const reader = (response.body as any).getReader()
                for (;;) {
                    const { done, value } = await reader.read()
                    if (done) break
                    received += value.byteLength
                    downloadState.received = received
                    await new Promise<void>((resolve, reject) => {
                        fileStream.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()))
                    })
                }
                await new Promise<void>((resolve, reject) => {
                    fileStream.end((err: any) => (err ? reject(err) : resolve()))
                })
                fs.renameSync(`${target}.part`, target)
                downloadState.filesDone++
                logger.info(`模型文件下载完成：${rel}（${(received / 1024 / 1024).toFixed(1)} MB）`)
            }
            downloadState.done = true
            // 下载完成后重新探测目录，模型立即可用（userData/models/laya 在候选里）
            await releaseRuntime()
            logger.info(`模型下载全部完成：${dir}`)
        } catch (e) {
            downloadState.error = (e as Error)?.message ?? String(e)
            logger.error(e as Error, '模型下载失败')
        } finally {
            downloadState.running = false
        }
    })()
    return downloadState
}

/** HEAD 请求拿文件大小（失败返回 -1，不影响主流程） */
async function headSize(url: string): Promise<number> {
    try {
        const response = await fetch(url, { method: 'HEAD', redirect: 'follow' })
        return Number(response.headers.get('content-length') ?? -1)
    } catch {
        return -1
    }
}

export function downloadStatus(): DownloadState {
    return { ...downloadState }
}

//#endregion
