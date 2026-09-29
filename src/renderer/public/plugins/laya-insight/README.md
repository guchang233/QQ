# Laya 意图与情绪感知（laya-insight）

Stapxs QQ Lite 的第三方插件。基于 **Laya multilingual ONNX 模型**
（`convaiinnovations/laya-multilingual` 的 ONNX 导出，mmBERT-base encoder，322M 参数），
为聊天消息提供情绪 / 意图标签，并在「人物画像」面板里给出好感度、六维互动风格、
肖像摘要、常聊内容与 MBTI 推测。支持两种推理后端：

* **本地模式**（默认）：本机 ONNX 推理，插件内置模型下载器（支持 HF 镜像）；
* **API 模式**：走任意 OpenAI 兼容的 `/chat/completions` 接口（DeepSeek / OpenAI /
  Ollama …），业务逻辑零改动复用。

> 本地模式不联网（模型下载除外）；**没有关键词兜底、没有随机分**，
> 模型不可用时功能整体降级并给出明确提示。
>
> **默认不读取、不分析任何聊天记录。** 推理只在用户于悬浮窗里为某个会话
> 手动打开开关（或点一次「分析当前会话」）之后才会发生。

---

## 1. 功能对照

| 能力 | 实现位置 | 说明 |
|---|---|---|
| 悬浮窗 | `ui/dock.js` | 插件内容管理中心：状态、分析授权、显示开关、入口按钮 |
| 意图识别标签 | `analysis/pipeline.js` | 消息下方显示「意图」标签（分享 / 承诺 / 协商 / 邀约 …） |
| 情绪感知标签 | 同上 | 同一行显示「情绪」标签（开心 / 期待 / 委屈 / 生气 / 累了 …） |
| 会话情绪徽标 | `pipeline.refreshBadge` | 单聊显示对方情绪，群聊显示整体氛围（只读已存结果，不触发推理） |
| 人物画像 | `ui/portrait-panel.js` | 好感度 + 等级、六维雷达、摘要、常聊内容、分析详情 |
| MBTI 推测 | `analysis/portrait.js` | 四轴，已分析文本 ≥ 100 条解锁，证据不足的轴显示「未确定」 |
| 群聊画像 | 同上 | 「群整体 / 成员画像」切换，二者分别保存 |
| 增量分析 | `pipeline.analyzeChat` | 已分析的 `message_id` 直接跳过，只处理新消息 |
| 分析授权 | `store.js` + `ui/dock.js` | 逐会话授权（`armedChats`），**只有悬浮窗能写入** |
| 标签开关 | 悬浮窗 / 设置页 | 关闭标签只隐藏显示，不丢结果；重新打开恢复 |
| 归档导出 | `analysis/archive.js` + 主进程 `addon:file:*` | 一键导出 JSON（完整数据）+ Markdown（可读摘要）到本地目录；可选导出后清空插件内记录防卡顿 |
| 窗口按钮 | `index.js`（注入样式） | 「隐藏窗口按钮」**默认关**（v1.4.0 重置，v1.2.0 默认开是误设计），开关即时生效，停用插件自动恢复 |
| 推理后端 | `laya/runtime.js` 的 `createRuntime` | 本地 / API 二选一；本地模式含模型下载器（`.part` 断点命名 + rename，HEAD 比大小跳过已存在文件） |
| API 推理 | `laya/api-runtime.js` | OpenAI 兼容 `/chat/completions`；同一条消息的问题按 state 合并成一次调用（每组 ≤8 问），伪分布回填 |
| 推理加速 | 悬浮窗「推理后端与加速」折叠组 | 执行提供者（auto=GPU 优先 / DirectML / CPU / CUDA…）、线程数、批大小、执行模式、装载预热、模型下载 |

---

## 2. 目录结构

```
laya-insight/
├── plugin.json                 # 插件清单
├── index.js                    # 入口：activate / deactivate
├── laya/                       # 推理层（本地 / API 双后端）
│   ├── labels.js               # 标签词表（情绪大类/细类、意图群组/常用词…）
│   ├── questions.js            # 问题定义（情绪、关系、我的发挥、六维、MBTI）
│   ├── general-intent.js       # 动态候选意图问题（v1.3.0，对齐 WechatVibe v9）
│   ├── prompt.js               # prompt 模板、序列构造、张量拼装
│   ├── calibration.js          # softmax / 温度 / 置信度 / 答案映射
│   ├── api-runtime.js          # API 后端（OpenAI 兼容，与 LayaRuntime 同接口）
│   └── runtime.js              # LayaRuntime（本地后端）+ createRuntime 工厂
├── analysis/
│   ├── store.js                # 按「账号 → 会话」持久化 + 分析授权 + 配置迁移
│   ├── pipeline.js             # 两级路由 + 增量编排 + 渲染槽回填
│   └── portrait.js             # 画像聚合（好感度 / 六维 / MBTI / 摘要 / 高频词）
└── ui/
    ├── constants.js            # 插件 ID、版本
    ├── dock.js                 # 悬浮窗（独立 Vue 应用，挂在 body 上）
    ├── settings.js             # 「设置 → 附加」卡片 + 插件管理面板
    ├── portrait-panel.js       # 人物画像面板（手写 SVG 雷达，无图表库）
    └── style.css               # 运行时注入的样式
```

---

## 3. 与 Laya 模型的交互

### 3.1 输入契约（`laya/prompt.js`）

模型是单图多任务结构，5 个输入、2 个输出：

| 输入 | 类型 | 形状 | 说明 |
|---|---|---|---|
| `input_ids` | int64 | `[batch, seq]` | 右侧 padding，pad id 取分词器的 pad |
| `attention_mask` | int64 | `[batch, seq]` | 有效位为 1 |
| `marker_pos` | int64 | `[batch, markers]` | 每个选项 `[MASK]` 在序列中的下标 |
| `marker_mask` | bool | `[batch, markers]` | marker 有效位 |
| `qtype` | int64 | `[batch]` | 0=choice，1=score，2=noul |

输出 `logits [batch, markers]` 与 `act_logits [batch, actions]`，均为 float32。

prompt 模板：

```
[CLS] <choice|score|noul> question: <instructions> [SEP] ([MASK] opt)·N [SEP] <state> [SEP]
```

预算规则与上游一致：每个选项上限 48 token（不含 `[MASK]`）；`head + 全部选项`
合计受 `head_max_len`（256）约束，head 至少保留 8 token；整段序列受
`max_len`（1024）约束，状态文本过长时**从右侧截断**。

### 3.2 输出后处理（`laya/calibration.js`）

```
scale  = temperature_by_options[`${qtype}:${选项数桶}`] ?? temperature[qtype]
p      = softmax(logits[:, :k] / max(1e-3, scale))
choice = argmax(p) 映射回标签
置信度 = 1 - H(p) / log(k)
```

本模型的 `rl_agent_config.json` 里 `temperature = [1.0, 1.0, 1.0]`、
`temperature_by_options = {}`，因此实际就是标准 softmax；代码保留了通用分支，
换成其他校准温度的权重时无需改动。

### 3.3 情绪两级路由与意图动态候选

* 情绪仍是「大类 → 细类」两级条件概率，取最大者：`score = P(大类) × P(细类|大类)`，
  大类置信度 `≥ 0.65` 时只看 top1，否则看 top2（与上游 `routeEmotion` 阈值一致）。
* 意图自 v1.3.0 起改用**动态候选问题**（`laya/general-intent.js`，对齐 WechatVibe
  general-intent v9）：不再让模型在固定 12 大类上硬选再两级路由，而是 43 项意图词表
  加中文题面、正则线索只负责**引入候选**（8~10 个），概率完全由模型给出，直接取
  choice 概率。标签稳定落在 **分享 / 承诺 / 协商 / 邀约 / 倾诉 / 婉拒**这类常用词上，
  词表见 `laya/labels.js` 的 `INTENT_GROUPS`。

> API 模式下同一套问题定义走 LLM（`laya/api-runtime.js`），LLM 只输出选择 + 自报
> 信心，插件扩成「伪分布」（top 选择拿信心、其余均分）供路由 / 聚合逻辑复用。

### 3.4 好感度

只有**对方消息**的 `relationship` 参与，权重
`romantic 1.0 / warm 0.55 / neutral 0 / distant -0.45 / rejecting -1.0`，
按时间做 0.5→1.0 的线性加权后映射到 0-100。情绪**故意不参与**：

```js
score = round(50 + 50 * clamp(Σ w_i · s_i / Σ w_i, -1, 1))
```

「我的发挥」则来自自己回复的 `self_quality` 分布
（`connected 1.0 / empathic 0.9 / off topic 0.3 / pressuring 0.15 / offensive 0`）。

---

## 4. 模型与依赖（本地模式）

| 项 | 值 |
|---|---|
| 模型来源 | HuggingFace `mizchi/laya-multilingual-onnx`（下载镜像默认 `https://hf-mirror.com`，可改） |
| 模型目录 | 留空时自动探测（含 `<userData>/models/laya`）；也可在设置里手动指定 |
| 必需文件 | `model.onnx`、`onnx_config.json`、`rl_agent_config.json`、`tokenizer/tokenizer.json`、`tokenizer/tokenizer_config.json` |
| 模型大小 | 约 647 MB（fp16 权重 + fp32 决策尾） |
| Node 依赖 | `onnxruntime-node`（ONNX 会话）、`@huggingface/tokenizers`（分词，需 WASM） |

**内置下载器**（悬浮窗「推理后端与加速」里的「下载本地模型」按钮）：从镜像仓库按
清单逐文件下载到 `<userData>/models/laya`，`.part` 临时文件写完 rename；每次下载前
HEAD 比对远端大小，已存在且等大的文件直接跳过（可断点续传到文件粒度）。下载进度
实时显示在按钮位置。

API 模式不需要模型与 onnxruntime-node 依赖。

---

## 5. 使用说明

### 5.1 悬浮窗（插件内容管理中心）

启动客户端后，界面右下角会出现一枚圆形悬浮球。点一下展开面板：

| 区块 | 内容 |
|---|---|
| 概览 | 当前会话、模型状态（就绪 / 已装载 / 缺文件）、已分析条数 |
| 分析控制 | **分析当前会话**（单次）、**停止**、不定长进度条与结果文案 |
| 分析授权（可折叠，默认展开） | **持续分析本会话**（逐会话开关，默认关）、**跟随新消息** |
| 显示（可折叠，默认展开） | 消息标签、标签细节、会话情绪徽标、隐藏窗口按钮（默认关） |
| 推理后端与加速（可折叠，默认收起） | 推理模式（本地 / API）、本地模式：执行提供者、线程数、批大小、执行模式、**装载 / 预热**、**下载本地模型**（含进度与镜像）；API 模式：显示「在设置页配置接口地址与模型名」提示 |
| 导出与防卡顿（可折叠，默认收起） | **导出分析结果**（JSON + Markdown）、选目录、打开目录、**导出后清空记录** |
| 数据与入口（可折叠，默认展开） | 人物画像、插件管理、刷新模型状态、清除本账号数据 |

* **球和面板都能拖动**（球按住拖、面板按住标题栏或概览那一行拖），拖到哪儿都行，
  松手即记住；**双击标题栏复位**到右下角。切换形态时会按当前尺寸重新夹紧，
  所以把球拖到最右边再展开，面板也不会跑出屏幕外。
* 每一组设置都能**点击标题栏折叠 / 展开**，状态按组记住（常用的默认展开，
  「推理后端与加速」「导出与防卡顿」默认收起），面板因此能压得很短。
* 默认状态是**只显示悬浮球**（展开的面板会挡住聊天列表）。点球展开，点标题栏右侧的
  `–` 收起；球上有一圈高亮表示**当前会话已开启分析**（运行时则持续呼吸闪烁）。
  面板被收起后也可以从「设置 → 附加 → 显示悬浮窗」唤回。

### 5.2 分析必须手动开启

插件**不会**主动读取或分析聊天记录。两种触发方式，都在悬浮窗里：

1. **单次**：点「分析当前会话」——立即分析当前会话中尚未处理的消息，跑完即停。
2. **持续**：打开「持续分析本会话」——此后进入该会话、以及收到新消息（需同时开着
   「跟随新消息」）时会自动继续分析；关掉开关立刻停止，并在跑的批次会被取消。

会话切换时插件只会**回填已经算好并存下来的标签与徽标**，不触发任何模型推理。
授权状态按会话记录（`armedChats`），存在插件自己的存储里。

### 5.3 其余入口

1. 启动客户端（须为 **Electron 桌面版**；Web / 移动端不加载本插件）。
2. 点聊天页顶部的「拼图」图标，或「设置 → 附加 → 人物画像」按钮，打开画像面板。
3. 「设置 → 附加 → Laya 意图与情绪感知」里可以调整长期偏好：

   | 设置项 | 默认 | 说明 |
   |---|---|---|
   | 消息标签 | 开 | 消息下方显示情绪 / 意图 |
   | 标签细节 | 关 | 额外显示置信度百分比 |
   | 会话情绪徽标 | 开 | 聊天页顶部的整体情绪 |
   | 隐藏窗口按钮 | **关** | 隐藏标题栏自绘的最小化 / 关闭按钮（v1.2.0 曾默认开，v1.4.0 重置） |
   | 导出后清空记录 | 关 | 导出分析结果后清掉插件内记录，防止越用越卡 |
   | 模型目录 | 留空自动探测 | 本地模型位置；「选择目录」按钮可图形化挑目录 |
   | 下载模型镜像 | `https://hf-mirror.com` | 「下载本地模型」用的 HuggingFace 镜像（直连被墙时的替代源） |
   | 使用 API 推理 | 关 | 开启后走 OpenAI 兼容接口；切换后重新加载界面生效 |
   | API 接口地址 / 模型名 / Key | 空 | 例：`https://api.deepseek.com/v1` + `deepseek-chat`；Key 仅存插件私有存储 |
   | 导出分析结果 | — | 生成 JSON + Markdown 到本地目录 |
   | 选择 / 打开导出目录 | — | 归档目录管理 |
   | 显示悬浮窗 | — | 分析授权入口；面板被关掉时可从这里唤回 |
   | 模型状态 | — | 查看依赖、目录、会话装载与可用执行提供者 |
   | 清除本账号数据 | — | 只删插件内分析结果，不动聊天记录 |

### 归档导出与防卡顿

分析记录长期堆在插件存储里，统计与界面回填都会变慢。悬浮窗「导出与防卡顿」提供：

1. **导出分析结果**：一次写出两个文件——`laya-insight_<uin>_<时间戳>.json`（完整
   原始数据，含每条消息的情绪 / 意图 / 关系 / 好感度明细）与同名 `.md`
   （人可读摘要：总览表、每会话小结、人物画像、明细表）。默认导出到
   `<userData>/laya-insight-archive`，可用「选目录」改。
2. **导出后清空记录**（默认关）：导出成功后清掉插件内的记录与画像，把存储体积
   一次性压回去；聊天记录本身不受影响，导出的 JSON 留档随时可查。
3. 悬浮窗**收起成球时停止统计轮询**，打开面板才恢复——即使不导出，空闲开销也趋近于零。

### 推理加速

悬浮窗「推理加速」折叠组（改完点「应用设置」）：

* **执行提供者**：`auto`（默认，先 GPU 后 CPU）、`GPU · DirectML`（随
  onnxruntime-node 分发，无需额外安装）、`CPU`、CUDA / TensorRT / OpenVINO
  （需自行安装对应原生运行时）。装载失败会自动退回 CPU。
* **线程数**：CPU 推理的 intra-op 线程（1–16，默认 4）。
* **批大小**：一次前向的行数（1–32，默认 8）；GPU 下可调大提高吞吐。
* **执行模式**：`sequential`（默认，稳定延迟）/ `parallel`（单批内并行算子）。
* **装载 / 预热**：不等第一次分析、立即装载模型；DirectML 首次装载要编译着色器
  （可能停十几秒），provider 回退的结果也会当场显示，而不是等到分析时才失败。

### 性能预期

参考实现在 WebGPU + batch 8 下约 91 decisions/s；CPU 提供者明显更慢。
批大小可在悬浮窗「推理加速」里调整（默认 8），有独显的机器选 DirectML
通常能快数倍。首次分析 40 条消息大约需要发出
`40×3 + 追问行` ≈ 140 行推理，请以「分析详情」里显示的实时速率估算耗时。
分析不阻塞界面：界面侧只消费响应式标签槽。

---

### 悬浮窗交互重写（v1.5.0）

1. **设置分组全部可折叠**：原先只有「推理加速」能折叠，其余四组硬展开，面板很长。
   现在每组标题栏都可点开 / 收起，状态按组记在 `dockGroups` 里（合并写入，
   改一组不会清掉别的组），重启客户端仍然保持。
2. **悬浮球可以拖动**：之前只有面板标题栏能拖，球固定在右下角。现在球与面板共用
   一套坐标，`mousedown` 进入「可能的拖动」，位移超过 4px 才算拖动——所以
   「点一下球」仍然是展开面板，不会和拖动手势打架。
3. **切换形态时重新夹紧**：球 46px、面板 322px 共享左上角坐标，若直接展开会有一截
   跑到视口外，因此展开 / 收起 / 首次挂载都按当前元素尺寸夹一次，保证永远完整可见。

### 推理后端与设置扩展（v1.4.0）

1. **插件框架与插件本体分离**：通用 IPC 通道（`addon:store:*` / `addon:file:*`）收敛到
   框架层 `src/electron/function/addon-bridge.ts`；插件自带的通道（`addon:laya:*`）与
   模型下载器移回 `addon-laya.ts` 的 `regLayaIpc()`，由 `ipc.ts` 分开注册。
2. **本地 / API 双后端**：`createRuntime` 工厂按 `backendMode` 返回 `LayaRuntime` 或
   `ApiRuntime`（OpenAI 兼容 `/chat/completions`，问题按 state 分组合并调用）。
3. **模型下载器**：主进程按 HF 仓库清单下载到 `<userData>/models/laya`，支持镜像、
   HEAD 秒传判断与 `.part` + rename 原子落盘；悬浮窗可视化进度。
4. **窗口按钮默认值修复**：「隐藏窗口按钮」默认改回关（`SETTINGS_VERSION` 3 → 4 迁移
   显式重置），v1.2.0 默认开曾让用户误以为客户端坏了。

### 准确性修正（v1.3.0，分析版本 av=2）

早期版本的分析结果不可信，v1.3.0 做了三处实质修正（每条记录带 `av` 版本标，
显示 / 聚合 / 增量过滤只认当前版本，旧结果会被重新分析自然覆盖）：

1. **state 加 TARGET 标注**：旧版把整段聊天流水平铺给模型，模型不知道要判哪条
   消息，只能判"整段对话的氛围"。现改为 target-first 格式（`TARGET message to
   judge:` + `[me]/[them]` 上下文，无上下文用 `{"message": …}` 包裹）。
   实测置信度从 ~5% 提升到 76–99%。
2. **意图改用动态候选问题**（对齐 WechatVibe general-intent v9）：不再让模型在
   固定 12 大类上硬选再三级路由，而是按消息内容动态裁剪出 8~10 个候选（正则
   线索只负责引入候选，概率完全由模型给出），直接取 choice 概率。
3. **修情绪细类查询键错误**：细类问题的选项是英文 id，旧版用中文显示名去查
   概率表、全部落空，只有 calm（中英同形）能命中——这直接导致"平静"垄断
   所有消息、置信度恒为 0.0x。

## 6. 已知边界

* **平台**：只用 `window.electron.ipcRenderer`，因此仅 Electron 桌面端可用；
  Tauri / Web / Capacitor 端会给出「仅支持桌面端」的提示而不是报错。
* **分词**：主进程用 `@huggingface/tokenizers@0.2.0`，并对 Metaspace 的
  added-token 行为做了与 Rust `tokenizers` 对齐的修正（见 `src/electron/function/addon-laya.ts` 的
  `LayaTokenizer`）。升级该依赖后需要重新核对这段修正。
* **高频词**：没有引入 jieba，改用 CJK 2-4 字 n-gram 频次近似，
  对短句效果尚可，长文会有少量噪声词。
* **摘要**：本地模式是模板拼装（不是生成式），与上游 `summary_from_aggregate` 同思路。
* **历史深度**：默认只分析当前会话已加载的消息；翻历史触发的加载会被识别为新消息并继续分析
  —— 前提是该会话已被授权，否则不会跑。
* **旧配置迁移**：v1.0.0 的「自动分析」开关会在升级时被清除（v1→v2）；v1.4.0 会把
  「隐藏窗口按钮」重置为关并补齐推理后端配置组（v3→v4），
  避免历史配置让「默认不隐藏 / 本地推理」看起来没生效。

---

## 7. 开发者备注

* 悬浮窗不占用宿主的任何渲染槽，用独立的 `createApp` 挂在 `document.body` 下，
  因此**不需要额外宿主权限**（`plugin.json` 里的 `ui.dock` 只是自我描述）。
* 引用宿主能力一律从传入的 `host` 取：`host.vue`（完整 Vue 运行时）、
  `host.stores`（Pinia）、`host.store`（插件私有存储）、`host.option`（设置项注册）、
  `host.log` / `host.alert` / `host.openPanel`。
* 插件是独立 ESM 产物，**不要写 bare import**，否则运行时的原生 `import()` 会解析失败。
* **日志陷阱**：客户端的 `Logger.add()` 按 `log_level` 过滤，而 `log_level` 默认为
  `debug` —— 该等级下只放行 `DEBUG` / `UI`，**`INFO` 会被丢弃**。所以
  `host.log.info()` 在默认配置下什么都看不到，排查问题请用 `host.log.debug()`。
  悬浮窗的挂载现场因此额外落盘到
  `<userData>/plugins/workbuddy.laya-insight/dock_mount.json`
  （`{ at, nodes, url }`，`nodes` 为 0 或负数表示渲染失败）。
