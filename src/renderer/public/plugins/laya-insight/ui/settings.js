/**
 * 设置面板注册。
 *
 * 复用客户端既有的扩展点：`Option.registerExtraOptionCard / registerExtraOptionItem`
 * —— 这些设置项会出现在「设置 → 附加」标签页里，不需要改动客户端的设置页面。
 *
 * 每一项都通过 optionKey 持久化到插件私有存储，同时用 callback 同步进
 * 插件自己的 store.settings。
 *
 * 注意：这里**不再**提供「自动分析」开关。分析的开启入口统一收敛到悬浮窗
 * （每个会话单独授权，见 ui/dock.js），设置页只保留长期偏好与工具入口。
 */

import { CARD_ID, PLUGIN_ID, PLUGIN_NAME, PLUGIN_VERSION } from './constants.js'

/**
 * 设置页的分组。注册顺序就是显示顺序：先注册一个分组标题，后面注册的项
 * 就归进这一组（宿主「附加」页支持 type='group'，见 OptAddon.vue）。
 *
 * `open` 是首次进入时的默认状态：常用的展开，后端 / 数据这类低频的收起，
 * 免得一进设置页就看到十几项。
 */
const GROUPS = [
    { id: 'display', title: '显示与标签', description: '标签、徽标与窗口外观', icon: 'tags', open: true },
    { id: 'runtime', title: '推理后端', description: '本地 ONNX 模型 / 远程 API', icon: 'server', open: false },
    { id: 'data', title: '数据与导出', description: '分析结果归档到本地', icon: 'database', open: false },
    { id: 'entries', title: '入口与维护', description: '面板入口与数据清理', icon: 'door-open', open: true },
]

/** 设置项 ↔ option 键 映射 */
const KEYS = {
    showLabels: 'plugin_laya_show_labels',
    showDetail: 'plugin_laya_show_detail',
    showBadge: 'plugin_laya_show_badge',
    hideWindowButtons: 'plugin_laya_hide_window_buttons',
    archiveClearAfterExport: 'plugin_laya_archive_clear',
    modelDir: 'plugin_laya_model_dir',
    apiBaseUrl: 'plugin_laya_api_base_url',
    apiModel: 'plugin_laya_api_model',
    apiKey: 'plugin_laya_api_key',
    modelMirror: 'plugin_laya_model_mirror',
}

/**
 * 注册「设置 → 附加」里的卡片。
 * @param {object} deps
 * @param {Function} deps.exportArchive  归档导出动作（index.js 提供）
 * @param {Function} deps.pickArchiveDir 选择导出目录
 * @param {Function} deps.openArchiveDir 打开导出目录
 */
export function registerSettings({ host, runtime, store, pipeline, openPortrait,
    openPluginManager, exportArchive, pickArchiveDir, openArchiveDir, openDock }) {
    host.option.registerCard({
        id: CARD_ID,
        title: PLUGIN_NAME,
        description: `本地 Laya ONNX 模型驱动 · v${PLUGIN_VERSION} · ${PLUGIN_ID}`,
    })

    const saved = store.getSettings()

    // 把插件内设置回写到 option，保证设置页展示的是真实值
    Object.entries(KEYS).forEach(([name, optionKey]) => {
        if (name === 'modelDir') return
        const current = host.option.get(optionKey, undefined)
        if (current === undefined) host.option.set(optionKey, saved[name] ?? '')
    })

    /**
     * 注册一个可折叠分组。
     *
     * 折叠状态同时写两份：客户端 option（界面即时生效）+ 插件私有存储。
     * 后者是给「生产构建会清掉未登记的客户端配置键」兜底的——那份没了以后，
     * defaultValue 还能从插件存储里取回上次的状态。
     */
    const registerGroup = (id) => {
        const meta = GROUPS.find((item) => item.id === id)
        if (!meta) return
        const optionKey = `plugin_laya_group_${id}`
        const savedGroups = store.getSettings().optionGroups || {}
        host.option.registerItem(CARD_ID, {
            id: `${CARD_ID}-group-${id}`,
            label: meta.title,
            description: meta.description,
            type: 'group',
            icon: ['fas', meta.icon],
            optionKey,
            defaultValue: savedGroups[id] !== undefined
                ? savedGroups[id] === true
                : !meta.open,
            callback: (value) => {
                const groups = { ...(store.getSettings().optionGroups || {}) }
                groups[id] = value === true
                store.saveSettings({ optionGroups: groups })
            },
        })
    }

    /** 布尔开关的统一注册 */
    const registerSwitch = (name, label, description, icon) => {
        host.option.registerItem(CARD_ID, {
            id: KEYS[name],
            label,
            description,
            type: 'switch',
            icon: ['fas', icon],
            optionKey: KEYS[name],
            defaultValue: store.getSettings()[name],
            callback: (value) => {
                store.saveSettings({ [name]: value === true })
                host.emit('setting:changed', { key: name, value: value === true })
            },
        })
    }

    registerGroup('display')
    registerSwitch('showLabels', '消息标签', '在消息下方显示情绪与意图标签', 'tags')
    registerSwitch('showDetail', '标签细节', '在标签后附带置信度', 'circle-info')
    registerSwitch('showBadge', '会话情绪徽标', '在聊天页顶部显示当前会话的整体情绪', 'heart')
    registerSwitch('hideWindowButtons', '隐藏窗口按钮',
        '隐藏客户端标题栏自绘的最小化 / 关闭按钮（关掉立即恢复）', 'window-minimize')
    // 「导出后清空记录」归到「数据与导出」组，见下面 registerGroup('data') 处

    // 模型目录（本地模式）
    host.option.registerItem(CARD_ID, {
        id: KEYS.modelDir,
        label: '模型目录（本地模式）',
        description: '应包含 model.onnx 与 tokenizer/；留空则按候选目录自动探测',
        type: 'input',
        icon: ['fas', 'folder'],
        optionKey: KEYS.modelDir,
        callback: (value) => {
            if (typeof value !== 'string') return
            runtime.configure({ modelDir: value.trim() })
                .then((status) => {
                    if (status && status.filesReady) host.alert('info', '模型目录已更新')
                    else host.alert('err', '该目录里缺少模型文件')
                })
                .catch((e) => host.log.error('更新模型目录失败', e))
        },
    })

    //#region == 推理后端（本地 / API） =========================================

    registerGroup('runtime')
    host.option.registerItem(CARD_ID, {
        id: `${CARD_ID}-api-switch`,
        label: '使用 API 推理',
        description: '开：用 OpenAI 兼容接口做分析（无需本地模型）；关：本地 ONNX 模型。切换后重新加载界面生效',
        type: 'switch',
        icon: ['fas', 'cloud'],
        optionKey: 'plugin_laya_api_mode',
        defaultValue: store.getSettings().backendMode === 'api',
        callback: (value) => {
            const mode = value === true ? 'api' : 'local'
            store.saveSettings({ backendMode: mode })
            host.emit('setting:changed', { key: 'backendMode', value: mode })
        },
    })

    /** 文本输入项的统一注册（API 组） */
    const registerInput = (name, label, description, icon, placeholder = '') => {
        host.option.registerItem(CARD_ID, {
            id: KEYS[name],
            label,
            description,
            type: 'input',
            icon: ['fas', icon],
            optionKey: KEYS[name],
            callback: (value) => {
                if (typeof value !== 'string') return
                store.saveSettings({ [name]: value.trim() })
                host.emit('setting:changed', { key: name, value: value.trim() })
            },
        })
        void placeholder
    }

    registerInput('apiBaseUrl', 'API 地址（本地模式忽略）',
        'OpenAI 兼容接口，如 https://api.deepseek.com/v1（不含 /chat/completions）', 'link')
    registerInput('apiModel', 'API 模型名（本地模式忽略）',
        '如 deepseek-chat、gpt-4o-mini、qwen-plus', 'robot')
    registerInput('apiKey', 'API 密钥（本地模式忽略）',
        '保存在插件自己的存储里，不会上传', 'key')
    registerInput('modelMirror', '模型下载镜像',
        '默认 https://hf-mirror.com；可改回 https://huggingface.co', 'download')

    host.option.registerItem(CARD_ID, {
        id: `${CARD_ID}-download-model`,
        label: '下载本地模型',
        description: `从镜像下载 laya-multilingual-onnx（约 617 MB）到客户端数据目录，进度见悬浮窗`,
        type: 'button',
        icon: ['fas', 'cloud-arrow-down'],
        callback: async () => {
            try {
                const mirror = host.option.get(KEYS.modelMirror, '') || store.getSettings().modelMirror
                await runtime.downloadModel(mirror)
                host.alert('info', '模型下载已在后台开始，进度可在悬浮窗查看；完成后自动生效')
            } catch (e) {
                host.log.error('启动模型下载失败', e)
                host.alert('err', '启动模型下载失败')
            }
        },
    })

    host.option.registerItem(CARD_ID, {
        id: `${CARD_ID}-pick`,
        label: '选择模型目录',
        type: 'button',
        icon: ['fas', 'folder-open'],
        callback: async () => {
            try {
                const dir = await runtime.pickModelDir()
                if (!dir) return
                host.option.set(KEYS.modelDir, dir)
                const status = await runtime.configure({ modelDir: dir })
                host.alert(status && status.filesReady ? 'info' : 'err',
                    status && status.filesReady ? '模型目录已更新' : '该目录里缺少模型文件')
            } catch (e) {
                host.log.error('选择模型目录失败', e)
                host.alert('err', '选择模型目录失败')
            }
        },
    })

    //#endregion

    //#region == 按钮项 ========================================================

    // —— 数据与导出 ——
    registerGroup('data')
    registerSwitch('archiveClearAfterExport', '导出后清空记录',
        '把分析结果导出到本地后清掉插件内的记录，防止越用越卡；聊天记录本身不受影响', 'eraser')

    host.option.registerItem(CARD_ID, {
        id: `${CARD_ID}-export`,
        label: '导出分析结果',
        description: '生成 JSON（完整数据）+ Markdown（可读摘要）到本地目录',
        type: 'button',
        icon: ['fas', 'file-export'],
        callback: async () => {
            try {
                const result = await exportArchive()
                if (!result || result.error) {
                    host.alert('err', `导出失败：${result?.error || '未知错误'}`)
                    return
                }
                host.alert('info',
                    `已导出 ${(result.paths || []).length} 个文件（${result.stats.chats} 会话 / ${result.stats.messages} 条）` +
                    (result.cleared ? '，插件内记录已清空' : ''))
            } catch (e) {
                host.log.error('导出分析结果失败', e)
                host.alert('err', '导出分析结果失败')
            }
        },
    })

    host.option.registerItem(CARD_ID, {
        id: `${CARD_ID}-archive-dir`,
        label: '选择导出目录',
        type: 'button',
        icon: ['fas', 'folder-plus'],
        callback: async () => {
            try {
                const dir = await pickArchiveDir()
                if (dir) host.alert('info', `导出目录已设置：${dir}`)
            } catch (e) {
                host.log.error('选择导出目录失败', e)
                host.alert('err', '选择导出目录失败')
            }
        },
    })

    host.option.registerItem(CARD_ID, {
        id: `${CARD_ID}-archive-open`,
        label: '打开导出目录',
        type: 'button',
        icon: ['fas', 'folder-open'],
        callback: () => {
            Promise.resolve(openArchiveDir())
                .catch((e) => host.log.error('打开导出目录失败', e))
        },
    })

    // —— 入口与维护 ——
    registerGroup('entries')
    host.option.registerItem(CARD_ID, {
        id: `${CARD_ID}-dock`,
        label: '显示悬浮窗',
        description: '插件内容管理中心，分析也在这里手动开启',
        type: 'button',
        icon: ['fas', 'table-columns'],
        callback: () => openDock(),
    })

    host.option.registerItem(CARD_ID, {
        id: `${CARD_ID}-status`,
        label: '模型状态',
        type: 'button',
        icon: ['fas', 'stethoscope'],
        callback: async () => {
            try {
                const status = await runtime.refreshStatus()
                const lines = [
                    `可用：${status.available ? '是' : '否'}`,
                    `依赖：${status.depsInstalled ? '已安装' : '缺失（需 yarn add onnxruntime-node @huggingface/tokenizers）'}`,
                    `会话：${status.loaded ? `已装载（${status.provider}）` : '未装载'}`,
                    `提供者：本机可用 ${(status.availableProviders || []).join('、')}；` +
                        `当前尝试顺序 ${(status.providerHint || []).join(' → ')}`,
                    `推理：${status.threads} 线程 · ${status.executionMode || 'sequential'}`,
                    `目录：${status.modelDir || '未找到'}`,
                    `模型：${status.modelBytes ? (status.modelBytes / 1024 / 1024).toFixed(1) + ' MB' : '缺失'}`,
                    status.missing && status.missing.length ? `缺少：${status.missing.join('、')}` : '',
                    status.error ? `错误：${status.error}` : '',
                ].filter(Boolean)
                host.openPanel({
                    title: 'Laya 模型状态',
                    html: `<div class="plugin-laya-status">${lines
                        .map((line) => `<p>${escapeHtml(line)}</p>`).join('')}</div>`,
                })
            } catch (e) {
                host.log.error('读取模型状态失败', e)
                host.alert('err', '读取模型状态失败')
            }
        },
    })

    host.option.registerItem(CARD_ID, {
        id: `${CARD_ID}-portrait`,
        label: '人物画像',
        type: 'button',
        icon: ['fas', 'chart-simple'],
        callback: () => {
            Promise.resolve(openPortrait()).catch((e) => host.log.error('打开人物画像失败', e))
        },
    })

    host.option.registerItem(CARD_ID, {
        id: `${CARD_ID}-manager`,
        label: '插件管理',
        type: 'button',
        icon: ['fas', 'puzzle-piece'],
        callback: () => openPluginManager(),
    })

    host.option.registerItem(CARD_ID, {
        id: `${CARD_ID}-clear`,
        label: '清除本账号数据',
        type: 'button',
        icon: ['fas', 'trash'],
        callback: () => confirmClearAccount({ host, store }),
    })

    //#endregion

    void pipeline
}

/**
 * 二次确认后清除当前账号的全部插件数据。
 * 设置页与悬浮窗共用，避免两处各写一遍带按钮的确认弹窗。
 */
export function confirmClearAccount({ host, store }) {
    const authStore = host.stores.auth()
    const uin = String(authStore.loginInfo?.uin ?? '')
    if (!uin) {
        host.alert('err', '当前没有登录账号')
        return
    }
    const stats = store.stats(uin)
    host.openPanel({
        title: '清除分析数据',
        html: `<div class="plugin-laya-status">
            <p>将删除账号 <b>${escapeHtml(uin)}</b> 在插件内的全部分析结果：</p>
            <p>会话 ${stats.chats} 个 · 消息 ${stats.messages} 条 · 画像 ${stats.portraits} 份</p>
            <p>不会影响聊天记录本身。</p>
        </div>`,
        buttons: [
            { text: '取消' },
            {
                text: '确认清除',
                master: true,
                fun: () => {
                    store.clearAccount(uin)
                    host.clearMessageDecorations()
                    host.closePanel()
                    host.alert('info', '已清除本账号的分析数据')
                },
            },
        ],
    })
}

/**
 * 插件管理面板：列出登记的插件与运行状态，可切换启用（重启界面后生效）。
 * 启用列表由宿主持久化，通过 host.plugins 读写，不要直接碰客户端配置。
 */
export function createPluginManagerPanel({ host }) {
    const { h, defineComponent, ref, onMounted } = host.vue

    return defineComponent({
        name: 'PluginManagerPanel',
        setup() {
            const list = ref([])
            const enabled = ref([])
            const loading = ref(true)

            onMounted(async () => {
                try {
                    const response = await fetch(new URL('../../index.json', import.meta.url))
                    const data = await response.json()
                    const plugins = Array.isArray(data) ? data : (data.plugins || [])
                    list.value = plugins
                    const ids = host.plugins.getEnabled()
                    enabled.value = Array.isArray(ids) ? ids : []
                } catch (e) {
                    host.log.error('读取插件登记表失败', e)
                } finally {
                    loading.value = false
                }
            })

            const toggle = (id, value) => {
                const set = new Set(enabled.value)
                if (value) set.add(id)
                else set.delete(id)
                enabled.value = [...set]
                host.plugins.setEnabled(enabled.value)
            }

            const reload = () => location.reload()

            return () => {
                const rows = list.value.map((plugin) => {
                    const checked = enabled.value.includes(plugin.id)
                    return h('div', { class: 'plugin-laya-plugin-row' }, [
                        h('div', { class: 'plugin-laya-plugin-meta' }, [
                            h('b', null, plugin.name || plugin.id),
                            h('span', null, `v${plugin.version || '?'} · ${plugin.id}`),
                            h('span', { class: 'plugin-laya-plugin-desc' }, plugin.description || ''),
                        ]),
                        h('label', { class: 'plugin-laya-switch' }, [
                            h('input', {
                                type: 'checkbox',
                                checked,
                                onChange: (event) => toggle(plugin.id, event.target.checked),
                            }),
                            h('span', null, checked ? '已启用' : '已停用'),
                        ]),
                    ])
                })
                return h('div', { class: 'plugin-laya-manager' }, [
                    h('p', { class: 'plugin-laya-hint' },
                        '插件的启用状态在重新加载界面后生效。'),
                    loading.value ? h('p', null, '正在读取插件列表……') : null,
                    ...rows,
                    h('div', { class: 'plugin-laya-actions' }, [
                        h('button', {
                            class: 'ss-button',
                            onClick: reload,
                        }, '重新加载界面'),
                    ]),
                ])
            }
        },
    })
}

function escapeHtml(text) {
    return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
}
