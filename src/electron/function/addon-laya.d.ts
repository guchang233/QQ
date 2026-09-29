/** 模型文件清单（与 laya-multilingual ONNX 发布包一致） */
export declare const MODEL_FILES: {
    readonly model: "model.onnx";
    readonly agentConfig: "rl_agent_config.json";
    readonly onnxConfig: "onnx_config.json";
    readonly tokenizerJson: string;
    readonly tokenizerConfig: string;
};
/**
 * 可选的执行提供者。
 *   auto      —— 先试 GPU（DirectML 随 onnxruntime-node 分发），失败自动退回 CPU
 *   dml       —— Windows DirectML（GPU），无需额外安装
 *   cuda / tensorrt / openvino —— 需要另行安装对应的原生运行时
 */
export type LayaProvider = 'auto' | 'cpu' | 'dml' | 'cuda' | 'tensorrt' | 'openvino';
/** ONNX 会话执行模式 */
export type LayaExecutionMode = 'sequential' | 'parallel';
/** 运行时状态 */
export interface LayaStatus {
    /** 依赖是否齐备且模型可加载 */
    available: boolean;
    /** 依赖是否已安装（onnxruntime-node / @huggingface/tokenizers） */
    depsInstalled: boolean;
    /** 模型是否已装载 */
    loaded: boolean;
    /** 当前生效的模型目录 */
    modelDir: string;
    /** 自动探测到的候选目录 */
    candidates: string[];
    /** 模型文件是否齐全 */
    filesReady: boolean;
    /** 缺失的文件 */
    missing: string[];
    /** model.onnx 字节数 */
    modelBytes: number;
    /** 实际使用的执行提供者 */
    provider: string;
    /** 推理线程数 */
    threads: number;
    /** ONNX 会话执行模式 */
    executionMode: LayaExecutionMode;
    /** 本机探测可用的执行提供者（不含 auto） */
    availableProviders: string[];
    /** 按当前偏好的实际尝试顺序 */
    providerHint: string[];
    /** 错误信息 */
    error?: string;
}
interface LoadedRuntime {
    ort: any;
    tokenizer: LayaTokenizer;
    session: any;
    dir: string;
    provider: string;
}
export declare class LayaTokenizer {
    readonly clsTokenId: number;
    readonly sepTokenId: number;
    readonly padTokenId: number;
    readonly maskTokenId: number;
    readonly maskToken: string;
    private readonly inner;
    private readonly contentPattern;
    private readonly addedTokenInfo;
    private readonly replacement;
    private readonly pieceSplitter;
    constructor(tokenizerJson: any, tokenizerConfig: any, Tokenizer: any);
    /** 去掉 special token 的编码，等价 Python `tok(text, add_special_tokens=False)` */
    encode(text: string): number[];
    private matchAddedTokens;
    private encodeSegment;
}
/** 模型目录自动探测候选（按优先级） */
export declare function listModelDirCandidates(): string[];
/** 解析生效的模型目录：优先显式配置，其次第一个文件齐全的候选 */
export declare function resolveModelDir(): string;
/** 加载（或复用）运行时 */
export declare function ensureRuntime(): Promise<LoadedRuntime>;
/** 释放会话 */
export declare function releaseRuntime(): Promise<void>;
/** 读取状态 */
export declare function getStatus(): Promise<LayaStatus>;
/**
 * 更新配置（模型目录 / provider / 线程数 / 执行模式），会使已装载会话失效。
 * 线程数与执行模式是会话级参数，改动同样需要重建会话才能生效。
 */
export declare function configure(patch: {
    modelDir?: string;
    provider?: LayaProvider;
    threads?: number;
    executionMode?: LayaExecutionMode;
}): Promise<LayaStatus>;
/**
 * 预热：立即装载模型。provider 的回退（dml 装载失败退回 cpu）只有真正
 * create 会话时才会暴露，预热能把这类问题在配置阶段就摆到用户面前。
 */
export declare function prewarm(): Promise<LayaStatus>;
/** 分词：返回每段文本的 token id 序列 */
export declare function tokenize(texts: string[]): Promise<{
    ids: number[][];
    special: {
        cls: number;
        sep: number;
        pad: number;
        mask: number;
        maskToken: string;
    };
}>;
/** 读取 special token 表（不装载模型也能拿到） */
export declare function specialTokens(): Promise<{
    cls: number;
    sep: number;
    pad: number;
    mask: number;
    maskToken: string;
}>;
/** 推理输入 */
export interface InferPayload {
    rows: number;
    length: number;
    markers: number;
    /** int64 [rows, length] */
    inputIds: BigInt64Array | number[];
    /** int64 [rows, length] */
    attentionMask: BigInt64Array | number[];
    /** int64 [rows, markers] */
    markerPos: BigInt64Array | number[];
    /** bool [rows, markers] */
    markerMask: Uint8Array | number[];
    /** int64 [rows] */
    qtype: BigInt64Array | number[];
}
/** 推理：返回 float32 logits / act_logits */
export declare function infer(payload: InferPayload): Promise<{
    markers: number;
    actions: number;
    logits: Float32Array;
    actLogits: Float32Array;
}>;
/** 读取模型目录里的 rl_agent_config.json */
export declare function agentConfig(): Promise<any>;
/**
 * 注册 Laya 模型运行时的 IPC 通道（addon:laya:*）。
 * 由 ipc.ts 调用；与通用插件桥（addon-bridge.ts）分离，保持框架层与
 * 具体插件的边界——框架层不感知任何模型。
 */
export declare function regLayaIpc(): void;
interface DownloadState {
    running: boolean;
    /** 当前文件（0-based 序号 + 名字） */
    index: number;
    file: string;
    /** 当前文件已接收 / 总字节；total 可能为 -1（服务端未给长度） */
    received: number;
    total: number;
    /** 已完成文件数 / 全部文件数 */
    filesDone: number;
    filesTotal: number;
    error: string;
    done: boolean;
}
/** 启动模型下载（幂等：下载中重复调用直接返回当前状态） */
export declare function downloadModel(mirror?: string): Promise<DownloadState>;
export declare function downloadStatus(): DownloadState;
export {};
