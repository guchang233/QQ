/**
 * 悬浮窗（Dock）：插件内容管理中心。
 *
 * 为什么需要它：
 *   1. **分析授权入口**。插件默认完全不读取、不分析聊天记录；只有用户在悬浮窗里
 *      为某个会话打开「本会话持续分析」，模型推理才会发生（或点一次「分析当前会话」
 *      做单次分析）。这是唯一的授权来源，`store.isArmed()` 就是它的读法。
 *   2. 设置页（「设置 → 附加」）适合放长期配置，不适合「现在跑一下 / 停一下」这类
 *      即时操作，也不方便随手查看模型状态与进度。
 *
 * 实现要点：
 *   - 用 host.vue 提供的完整 Vue 运行时 `createApp` 挂到 document.body 下的独立
 *     容器里，不占用客户端的任何渲染槽，所以不需要额外的宿主权限；
 *   - 外层容器 `position: fixed; inset: 0; pointer-events: none`，只有球与面板
 *     自身可点击，因此绝不会挡住客户端界面；
 *   - 面板可拖动，位置与展开状态持久化在插件私有存储，重启后保持；
 *   - 颜色一律走客户端主题变量（--color-main / --color-font / --color-font-2），
 *     深色浅色都自适应。
 */

import { PLUGIN_ID, PLUGIN_NAME, PLUGIN_VERSION } from './constants.js'

/** 悬浮球 / 标题用的图标（与工具栏按钮同源） */
const DOCK_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
    + '<path d="M399 384.2c16.7-30.7 26-65.1 26-101.2 0-59.6-24.2-113.6-63.3-152.8l.1-.1'
    + '-30.5-30.5C296.5 64.9 245 48 192 48 86 48 0 134 0 240c0 53 21 101 55.9 135.9L24.9 407'
    + 'c-5.1 5.1-8 12-8 19.2V488c0 13.3 10.7 24 24 24H88c13.3 0 24-10.7 24-24 0-13.3 10.7-24'
    + ' 24-24h24c13.3 0 24-10.7 24-24 0-13.3 10.7-24 24-24h35.8c3.8 0 7.5-.9 10.8-2.6l56.3-28.1'
    + 'c36.1-18 65-46.4 88.1-80.1zM112 224a32 32 0 1 1 0-64 32 32 0 1 1 0 64zm80-64a32 32 0 1 1'
    + ' 0-64 32 32 0 1 1 0 64zm96 0a32 32 0 1 1 0-64 32 32 0 1 1 0 64z"/></svg>'

/** 位置复位的留白 */
const EDGE_GAP = 8

/**
 * 构建悬浮窗组件。
 * @param {object} deps
 * @param {object} deps.host     插件宿主 API
 * @param {object} deps.runtime  LayaRuntime
 * @param {object} deps.store    PluginStore
 * @param {object} deps.actions  插件主模块暴露的动作集合
 */
export function createDockComponent({ host, runtime, store, actions }) {
    const { h, defineComponent, ref, reactive, computed, onMounted, onBeforeUnmount } = host.vue

    return defineComponent({
        name: 'LayaInsightDock',
        setup() {
            const savedDock = store.getDockState()
            const open = ref(savedDock.open)
            const pos = ref(savedDock.pos)

            const dragging = ref(false)
            const busy = ref(false)
            const pipelineRunning = ref(false)
            const phase = ref('')
            const message = ref('')
            const status = ref(null)
            const statusBusy = ref(false)
            const stats = ref({ chats: 0, messages: 0, portraits: 0 })
            const chat = ref({ key: '', label: '' })
            const armed = ref(false)

            /** 推理加速设置的本地镜像；改动后点「应用设置」才下发 */
            const perf = reactive({
                provider: 'auto',
                threads: 4,
                executionMode: 'sequential',
                batchSize: 8,
            })
            /** 下载进度镜像 */
            const download = reactive({ running: false, file: '', received: 0, total: -1, filesDone: 0, filesTotal: 5, error: '', done: false })
            const isApiMode = computed(() => display.backendMode === 'api')
            /** 归档导出的本地镜像 */
            const archive = reactive({
                dir: '',
                clearAfter: false,
                lastExport: null,
                busy: false,
            })
            const perfBusy = ref(false)

            /** 提供者下拉的选项 */
            const PROVIDER_OPTIONS = [
                { value: 'auto', label: '自动（GPU 优先）' },
                { value: 'dml', label: 'GPU · DirectML' },
                { value: 'cpu', label: 'CPU' },
                { value: 'cuda', label: 'CUDA（需额外驱动包）' },
                { value: 'tensorrt', label: 'TensorRT（需额外库）' },
                { value: 'openvino', label: 'OpenVINO（需额外运行时）' },
            ]

            /** 三个显示开关 + 跟随新消息 + 外观/归档开关，是 store 设置的本地镜像 */
            const display = reactive({
                showLabels: true,
                showDetail: false,
                showBadge: true,
                followNewMessages: true,
                hideWindowButtons: true,
                archiveClearAfterExport: false,
                backendMode: 'local',
            })

            const panelRef = ref(null)
            const running = computed(() => busy.value || pipelineRunning.value)

            const modelText = computed(() => {
                const value = status.value
                if (!value) return statusBusy.value ? '读取中…' : '未知'
                if (value.backendMode === 'api') {
                    return value.available ? `API（${value.provider?.replace('api:', '') || '未配置模型'}）` : 'API 未配置'
                }
                if (value.depsInstalled === false) return '缺少依赖'
                if (value.available === false) return '环境不可用'
                if (value.filesReady === false) return '缺少模型文件'
                if (!value.loaded) return '就绪 · 按需装载'
                const mode = perf.executionMode === 'parallel' ? '并行' : '串行'
                return `已装载（${value.provider || 'onnx'} · ${perf.threads} 线程${mode === '并行' ? ' · 并行' : ''} · 批 ${perf.batchSize}）`
            })

            const downloadText = computed(() => {
                if (!download.running && !download.done && !download.error) return ''
                if (download.error) return `下载失败：${download.error}`
                if (download.done) return '模型下载完成，已自动生效'
                const filePart = download.total > 0
                    ? ` ${Math.round((download.received / download.total) * 100)}%`
                    : '…'
                return `下载中（${download.filesDone + 1}/${download.filesTotal}）${download.file}${filePart}`
            })

            const panelStyle = computed(() => {
                if (!pos.value) return {}
                return {
                    left: `${pos.value.x}px`,
                    top: `${pos.value.y}px`,
                    right: 'auto',
                    bottom: 'auto',
                }
            })

            //#region == 状态同步 ---------------------------------------------------

            const syncDisplay = () => {
                const current = store.getSettings()
                display.showLabels = current.showLabels !== false
                display.showDetail = current.showDetail === true
                display.showBadge = current.showBadge !== false
                display.followNewMessages = current.followNewMessages !== false
                display.hideWindowButtons = current.hideWindowButtons === true
                display.archiveClearAfterExport = current.archiveClearAfterExport === true
                display.backendMode = current.backendMode || 'local'
                perf.provider = current.provider || 'auto'
                perf.threads = current.threads || 4
                perf.executionMode = current.executionMode || 'sequential'
                perf.batchSize = current.batchSize || 8
                archive.dir = current.archiveDir || ''
                archive.clearAfter = current.archiveClearAfterExport === true
                archive.lastExport = current.lastExport || null
            }

            const refreshContext = () => {
                const ctx = actions.getContext()
                chat.value = ctx
                    ? { key: ctx.chatKey, label: ctx.label }
                    : { key: '', label: '' }
                armed.value = ctx ? store.isArmed(ctx.chatKey) : false
                stats.value = store.stats(actions.getUin())
                pipelineRunning.value = actions.isRunning()
            }

            const refreshStatus = async () => {
                statusBusy.value = true
                try {
                    status.value = await runtime.refreshStatus()
                } catch (e) {
                    host.log.debug(`读取模型状态失败：${(e && e.message) || e}`)
                } finally {
                    statusBusy.value = false
                }
            }

            //#endregion

            //#region == 操作 -------------------------------------------------------

            const setOpen = (value) => {
                open.value = value
                store.saveDockState({ open: value })
                if (value) {
                    refreshContext()
                    refreshStatus()
                }
            }

            /**
             * 把展开状态从存储同步过来。
             * 设置页的「显示悬浮窗」按钮只能改存储 + 发事件，面板要靠这里才真的
             * 弹回来，否则用户会以为按钮失灵。
             */
            const syncOpen = () => {
                open.value = store.getDockState().open
            }

            /** 单次分析：不改变授权开关，点一次只跑一轮 */
            const analyzeNow = async () => {
                if (!chat.value.key) {
                    host.alert('err', '请先打开一个会话')
                    return
                }
                if (running.value) return
                busy.value = true
                message.value = ''
                phase.value = '准备中'
                try {
                    const result = await actions.analyzeNow({
                        onProgress: (info) => {
                            if (!info) return
                            if (info.phase === 'A') phase.value = '粗分类'
                            else if (info.phase === 'B') phase.value = '细分类'
                            else if (info.phase === 'done') phase.value = '写入结果'
                        },
                    })
                    if (!result) message.value = '没有可分析的内容'
                    else if (result.error) message.value = `分析失败：${result.error}`
                    else if (result.canceled) message.value = '已停止'
                    else if (result.reason) message.value = result.reason
                    else message.value = `本轮分析 ${result.analyzed} 条 · 累计 ${result.total} 条`
                } catch (e) {
                    message.value = `分析失败：${(e && e.message) || e}`
                } finally {
                    busy.value = false
                    phase.value = ''
                    refreshContext()
                }
            }

            const stopAnalyze = () => {
                actions.stopAnalyze()
                phase.value = ''
                message.value = '已请求停止'
                refreshContext()
            }

            /** 授权开关：这是「手动开启分析」的唯一入口 */
            const toggleArmed = (value) => {
                if (!chat.value.key) {
                    host.alert('err', '请先打开一个会话')
                    return
                }
                armed.value = value
                store.setArmed(chat.value.key, value)
                host.emit('setting:changed', {
                    key: 'armedChats',
                    value: store.getSettings().armedChats,
                })
                if (value) {
                    host.alert('info', `已开启「${chat.value.label || chat.value.key}」的分析`)
                    analyzeNow()
                } else {
                    actions.stopAnalyze()
                    message.value = '已关闭本会话的分析，插件不会再读取它'
                }
            }

            const setDisplay = (key, value) => {
                display[key] = value
                store.saveSettings({ [key]: value })
                host.emit('setting:changed', { key, value })
            }

            const clearData = () => {
                Promise.resolve(actions.clearAccountData())
                    .then(() => refreshContext())
                    .catch((e) => host.log.error('清除数据失败', e))
            }

            const openPortrait = () => {
                Promise.resolve(actions.openPortrait())
                    .catch((e) => host.log.error('打开人物画像失败', e))
            }

            const openManager = () => {
                Promise.resolve(actions.openPluginManager())
                    .catch((e) => host.log.error('打开插件管理失败', e))
            }

            /** 归档导出：成功后同步镜像与统计 */
            const exportNow = async () => {
                if (archive.busy) return
                archive.busy = true
                message.value = ''
                try {
                    const result = await actions.exportArchiveNow()
                    if (!result || result.error) {
                        message.value = `导出失败：${(result && result.error) || '未知错误'}`
                    } else {
                        message.value = `已导出 ${result.paths.length} 个文件` +
                            `（${result.stats.chats} 会话 / ${result.stats.messages} 条）` +
                            (result.cleared ? '，插件内记录已清空' : '')
                    }
                } catch (e) {
                    message.value = `导出失败：${(e && e.message) || e}`
                } finally {
                    archive.busy = false
                    syncDisplay()
                    refreshContext()
                }
            }

            const pickArchiveDir = async () => {
                try {
                    const dir = await actions.pickArchiveDir()
                    if (dir) archive.dir = dir
                } catch (e) {
                    host.alert('err', `选择导出目录失败：${(e && e.message) || e}`)
                }
            }

            const openArchiveDir = () => {
                Promise.resolve(actions.openArchiveDir())
                    .catch((e) => host.alert('err', `打开导出目录失败：${(e && e.message) || e}`))
            }

            /** 应用推理加速设置（provider / 线程 / 执行模式 / 批大小） */
            const applyPerf = async () => {
                if (perfBusy.value) return
                perfBusy.value = true
                try {
                    status.value = await actions.applyRuntime({
                        provider: perf.provider,
                        threads: perf.threads,
                        executionMode: perf.executionMode,
                        batchSize: perf.batchSize,
                    })
                    message.value = '性能设置已应用'
                } catch (e) {
                    message.value = `应用性能设置失败：${(e && e.message) || e}`
                } finally {
                    perfBusy.value = false
                }
            }

            /** 预热：立即装载模型，provider 回退当场暴露 */
            const prewarmModel = async () => {
                if (perfBusy.value) return
                perfBusy.value = true
                phase.value = '预热'
                try {
                    status.value = await actions.prewarm()
                    if (status.value?.loaded) {
                        message.value = `模型已装载（${status.value.provider}）`
                    } else if (status.value?.error) {
                        message.value = `预热失败：${status.value.error}`
                    } else {
                        message.value = '预热完成，但模型未装载成功，请检查状态'
                    }
                } catch (e) {
                    message.value = `预热失败：${(e && e.message) || e}`
                } finally {
                    perfBusy.value = false
                    phase.value = ''
                }
            }

            /** 启动模型下载（后台），并立即拉一次进度 */
            const startDownload = async () => {
                try {
                    download.running = true
                    await runtime.downloadModel()
                    await pollDownload()
                } catch (e) {
                    message.value = `启动下载失败：${(e && e.message) || e}`
                }
            }

            /** 拉取下载进度（打开面板期间的轮询里调用） */
            const pollDownload = async () => {
                try {
                    const state = await runtime.downloadStatus()
                    Object.assign(download, state)
                    if (state.done || state.error) refreshStatus()
                } catch { /* 忽略轮询失败 */ }
            }

            //#endregion

            //#region == 拖动 -------------------------------------------------------

            let dragOrigin = null

            const onDragMove = (event) => {
                if (!dragOrigin || !panelRef.value) return
                const rect = panelRef.value.getBoundingClientRect()
                const maxX = Math.max(EDGE_GAP, window.innerWidth - rect.width - EDGE_GAP)
                const maxY = Math.max(EDGE_GAP, window.innerHeight - rect.height - EDGE_GAP)
                const x = Math.min(Math.max(EDGE_GAP, dragOrigin.left + (event.clientX - dragOrigin.x)), maxX)
                const y = Math.min(Math.max(EDGE_GAP, dragOrigin.top + (event.clientY - dragOrigin.y)), maxY)
                pos.value = { x, y }
            }

            const onDragEnd = () => {
                if (dragging.value && pos.value) store.saveDockState({ pos: pos.value })
                dragging.value = false
                dragOrigin = null
                window.removeEventListener('mousemove', onDragMove)
                window.removeEventListener('mouseup', onDragEnd)
            }

            const onDragStart = (event) => {
                if (event.button !== 0) return
                // 头部里的按钮不该触发拖动
                if (event.target && event.target.closest && event.target.closest('button')) return
                const rect = panelRef.value?.getBoundingClientRect()
                if (!rect) return
                dragOrigin = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top }
                dragging.value = true
                window.addEventListener('mousemove', onDragMove)
                window.addEventListener('mouseup', onDragEnd)
                event.preventDefault()
            }

            const resetPosition = () => {
                pos.value = null
                store.saveDockState({ pos: null })
            }

            //#endregion

            //#region == 渲染 -------------------------------------------------------

            const renderSwitch = (label, description, value, onToggle, disabled = false) => h('label', {
                class: ['plugin-laya-dock-row', disabled ? 'is-disabled' : ''],
            }, [
                h('div', { class: 'plugin-laya-dock-row-meta' }, [
                    h('b', null, label),
                    h('span', null, description),
                ]),
                h('input', {
                    type: 'checkbox',
                    class: 'plugin-laya-dock-check',
                    checked: value,
                    disabled,
                    onChange: (event) => {
                        if (!disabled) onToggle(event.target.checked)
                    },
                }),
            ])

            /** 「标签 + 控件」一行：推理加速折叠组里用 */
            const renderField = (label, control) => h('div', { class: 'plugin-laya-dock-field' }, [
                h('label', null, label),
                control,
            ])

            const renderNumberInput = (value, min, max, onChange) => h('input', {
                type: 'number',
                class: 'plugin-laya-dock-num',
                min,
                max,
                value,
                onChange: (event) => {
                    const num = Math.floor(Number(event.target.value))
                    if (Number.isFinite(num)) onChange(Math.min(Math.max(min, num), max))
                },
            })

            const renderBall = () => {
                // 球上直接带状态：不展开面板也能看出这个会话有没有被授权分析
                const state = !chat.value.key
                    ? '未打开会话'
                    : (armed.value ? '本会话已开启分析' : '本会话未开启分析')
                return h('button', {
                    class: [
                        'plugin-laya-dock-ball',
                        running.value ? 'is-running' : '',
                        armed.value ? 'is-armed' : '',
                    ],
                    title: `${PLUGIN_NAME} · ${state} · 点击展开`,
                    onClick: () => setOpen(true),
                }, [h('span', { class: 'plugin-laya-dock-ball-icon', innerHTML: DOCK_ICON })])
            }

            const renderPanel = () => h('div', {
                class: ['plugin-laya-dock-panel', dragging.value ? 'is-dragging' : ''],
                ref: panelRef,
                style: panelStyle.value,
            }, [
                // —— 头部（拖动区）——
                h('div', {
                    class: 'plugin-laya-dock-head',
                    title: '拖动可移动，双击复位到右下角',
                    onMousedown: onDragStart,
                    onDblclick: resetPosition,
                }, [
                    h('span', { class: 'plugin-laya-dock-logo', innerHTML: DOCK_ICON }),
                    h('div', { class: 'plugin-laya-dock-head-text' }, [
                        h('b', null, PLUGIN_NAME),
                        h('span', null, `v${PLUGIN_VERSION} · 本地推理`),
                    ]),
                    h('button', {
                        class: 'plugin-laya-dock-icon-btn',
                        title: '收起',
                        onClick: () => setOpen(false),
                    }, '–'),
                ]),

                // —— 概览 ——
                h('div', { class: 'plugin-laya-dock-overview' }, [
                    h('span', { class: 'plugin-laya-dock-chip' },
                        chat.value.key ? `会话 ${chat.value.label || chat.value.key}` : '未打开会话'),
                    h('span', { class: 'plugin-laya-dock-chip' }, `模型 ${modelText.value}`),
                    h('span', { class: 'plugin-laya-dock-chip' }, `已分析 ${stats.value.messages} 条`),
                ]),

                // —— 分析控制 ——
                h('div', { class: 'plugin-laya-dock-control' }, [
                    h('button', {
                        class: 'ss-button plugin-laya-dock-primary',
                        disabled: running.value || !chat.value.key,
                        onClick: analyzeNow,
                    }, running.value ? `分析中（${phase.value || '…'}）` : '分析当前会话'),
                    h('button', {
                        class: 'ss-button',
                        disabled: !pipelineRunning.value,
                        onClick: stopAnalyze,
                    }, '停止'),
                ]),
                running.value ? h('div', { class: 'plugin-laya-dock-bar' }, [h('i')]) : null,
                message.value ? h('p', { class: 'plugin-laya-dock-msg' }, message.value) : null,

                // —— 授权（核心）——
                h('div', { class: 'plugin-laya-dock-section' }, [
                    h('header', null, '分析授权'),
                    renderSwitch(
                        chat.value.label ? `持续分析「${chat.value.label}」` : '持续分析当前会话',
                        '打开后进入该会话、收到新消息都会自动分析',
                        armed.value,
                        toggleArmed,
                        !chat.value.key,
                    ),
                    renderSwitch(
                        '跟随新消息',
                        '已开启分析的会话里，新消息到达时继续分析',
                        display.followNewMessages,
                        (value) => setDisplay('followNewMessages', value),
                    ),
                    h('p', { class: 'plugin-laya-dock-note' }, chat.value.key
                        ? (armed.value
                            ? '已开启：这个会话会被持续分析，关掉开关即停止。'
                            : '未开启：插件不会读取、也不会分析这个会话的聊天记录。')
                        : '先打开一个会话，才能为它开启分析。'),
                ]),

                // —— 显示 ——
                h('div', { class: 'plugin-laya-dock-section' }, [
                    h('header', null, '显示'),
                    renderSwitch('消息标签', '在消息下方显示情绪与意图标签',
                        display.showLabels, (value) => setDisplay('showLabels', value)),
                    renderSwitch('标签细节', '在标签后附带置信度',
                        display.showDetail, (value) => setDisplay('showDetail', value)),
                    renderSwitch('会话情绪徽标', '在聊天页顶部显示当前会话的整体情绪',
                        display.showBadge, (value) => setDisplay('showBadge', value)),
                    renderSwitch('隐藏窗口按钮', '隐藏标题栏的最小化 / 关闭按钮（可随时关回来）',
                        display.hideWindowButtons, (value) => setDisplay('hideWindowButtons', value)),
                ]),

                // —— 推理加速（默认折叠）——
                h('details', { class: 'plugin-laya-dock-group' }, [
                    h('summary', { class: 'plugin-laya-dock-group-head' },
                        h('b', null, '推理后端与加速')),
                    h('div', { class: 'plugin-laya-dock-group-body' }, [
                        renderField('推理模式', h('select', {
                            class: 'plugin-laya-dock-select',
                            value: display.backendMode,
                            onChange: (event) => setDisplay('backendMode', event.target.value),
                        }, [
                            h('option', { value: 'local' }, '本地模型（ONNX）'),
                            h('option', { value: 'api' }, 'API 接口'),
                        ])),
                        isApiMode.value
                            ? h('p', { class: 'plugin-laya-dock-note' },
                                'API 模式：在「设置 → 附加」里填写接口地址 / 模型名 / 密钥，重新加载界面后生效。')
                            : [
                                renderField('提供者', h('select', {
                                    class: 'plugin-laya-dock-select',
                                    value: perf.provider,
                                    onChange: (event) => { perf.provider = event.target.value },
                                }, PROVIDER_OPTIONS.map((opt) => h('option', {
                                    value: opt.value,
                                    selected: perf.provider === opt.value,
                                }, opt.label)))),
                                renderField('线程', renderNumberInput(
                                    perf.threads, 1, 16, (value) => { perf.threads = value })),
                                renderField('批大小', renderNumberInput(
                                    perf.batchSize, 1, 32, (value) => { perf.batchSize = value })),
                                renderField('执行模式', h('select', {
                                    class: 'plugin-laya-dock-select',
                                    value: perf.executionMode,
                                    onChange: (event) => { perf.executionMode = event.target.value },
                                }, [
                                    h('option', { value: 'sequential' }, '串行（稳定延迟）'),
                                    h('option', { value: 'parallel' }, '并行（单批吞吐）'),
                                ])),
                                h('div', { class: 'plugin-laya-dock-grid' }, [
                                    h('button', {
                                        class: 'ss-button plugin-laya-dock-primary',
                                        disabled: perfBusy.value,
                                        onClick: applyPerf,
                                    }, perfBusy.value ? '应用中…' : '应用设置'),
                                    h('button', {
                                        class: 'ss-button',
                                        disabled: perfBusy.value || status.value?.available === false,
                                        onClick: prewarmModel,
                                    }, '装载 / 预热'),
                                ]),
                                h('p', { class: 'plugin-laya-dock-note' },
                                    `本机可用：${(status.value?.availableProviders || ['cpu']).join('、')}；` +
                                    `当前尝试顺序：${(status.value?.providerHint || [perf.provider]).join(' → ')}`),
                                h('p', { class: 'plugin-laya-dock-note' },
                                    'GPU（DirectML）首次装载需要编译着色器，可能停十几秒，属正常现象；' +
                                    '装载失败会自动退回 CPU，点「装载 / 预热」可以提前看到结果。'),
                                downloadText.value
                                    ? h('p', { class: 'plugin-laya-dock-note' }, downloadText.value)
                                    : h('button', {
                                        class: 'ss-button',
                                        onClick: startDownload,
                                    }, '下载本地模型（约 617 MB，从镜像站）'),
                            ],
                    ]),
                ]),

                // —— 导出与防卡顿 ——
                h('div', { class: 'plugin-laya-dock-section' }, [
                    h('header', null, '导出与防卡顿'),
                    h('div', { class: 'plugin-laya-dock-grid' }, [
                        h('button', {
                            class: 'ss-button plugin-laya-dock-primary',
                            disabled: archive.busy || stats.value.messages === 0,
                            onClick: exportNow,
                        }, archive.busy ? '导出中…' : '导出分析结果'),
                        h('button', { class: 'ss-button', onClick: pickArchiveDir }, '选目录'),
                        h('button', { class: 'ss-button', onClick: openArchiveDir }, '打开目录'),
                    ]),
                    renderSwitch('导出后清空记录',
                        '导出成功后清掉插件内的分析记录，界面立刻回到轻量状态（聊天记录不受影响）',
                        archive.clearAfter,
                        (value) => setDisplay('archiveClearAfterExport', value)),
                    h('p', { class: 'plugin-laya-dock-note' }, archive.dir
                        ? `导出目录：${archive.dir}`
                        : '未指定目录：导出到客户端数据目录下的 laya-insight-archive。'),
                    archive.lastExport
                        ? h('p', { class: 'plugin-laya-dock-note' },
                            `上次导出 ${new Date(archive.lastExport.at).toLocaleString()}，` +
                            `${(archive.lastExport.files || []).length} 个文件（JSON 完整数据 + Markdown 摘要）`)
                        : null,
                    h('p', { class: 'plugin-laya-dock-note' },
                        '记录长期累积会让统计和界面越来越卡；导出成文件后再清空，随时可以重新导入查看。'),
                ]),

                // —— 入口 ——
                h('div', { class: 'plugin-laya-dock-section' }, [
                    h('header', null, '数据与入口'),
                    h('div', { class: 'plugin-laya-dock-grid' }, [
                        h('button', { class: 'ss-button', onClick: openPortrait }, '人物画像'),
                        h('button', { class: 'ss-button', onClick: openManager }, '插件管理'),
                        h('button', { class: 'ss-button', onClick: refreshStatus }, '刷新模型状态'),
                        h('button', {
                            class: 'ss-button plugin-laya-dock-danger',
                            onClick: clearData,
                        }, '清除本账号数据'),
                    ]),
                ]),

                h('p', { class: 'plugin-laya-dock-foot' },
                    '全部推理都在本机完成，结果只写入插件自己的存储目录，不改动聊天记录。'),
            ])

            //#endregion

            //#region == 生命周期 ---------------------------------------------------

            let timer = null
            let stopSettingListener = null

            onMounted(() => {
                syncDisplay()
                refreshContext()
                refreshStatus()
                // 会话、消息列表都在 Pinia 里，用轮询读比注册多个 watch 更省事。
                // 防卡顿：只在面板展开（或正在拖动）且页面可见时才轮询，
                // 收成悬浮球时 stats() 的遍历就完全不发生。
                timer = setInterval(() => {
                    if (document.hidden || (!open.value && !dragging.value)) return
                    refreshContext()
                    // 面板打开期间顺带轮询下载进度（本地模式才有下载这回事）
                    if (!isApiMode.value && (download.running || download.done || download.error)) {
                        pollDownload()
                    }
                }, 1500)
                stopSettingListener = host.on('setting:changed', () => {
                    syncDisplay()
                    syncOpen()
                    refreshContext()
                })
            })

            onBeforeUnmount(() => {
                if (timer) clearInterval(timer)
                timer = null
                if (stopSettingListener) stopSettingListener()
                stopSettingListener = null
                window.removeEventListener('mousemove', onDragMove)
                window.removeEventListener('mouseup', onDragEnd)
            })

            //#endregion

            return () => h('div', { class: 'plugin-laya-dock' }, [
                open.value ? renderPanel() : renderBall(),
            ])
        },
    })
}

/**
 * 挂载悬浮窗，返回卸载函数。
 *
 * 用独立的 Vue 应用实例挂在 body 上，而不是宿主提供的渲染槽：这样插件既不需要
 * 申请额外权限，也不会因为客户端界面结构调整而失效。
 */
export function mountDock({ host, runtime, store, actions }) {
    const Vue = host.vue
    const container = document.createElement('div')
    container.className = 'plugin-laya-dock-mount'
    container.id = `plugin-dock-${PLUGIN_ID.replace(/\./g, '-')}`
    document.body.appendChild(container)

    const app = Vue.createApp(createDockComponent({ host, runtime, store, actions }))
    app.config.errorHandler = (error) => host.log.error('悬浮窗渲染异常', error)
    app.mount(container)

    return () => {
        try {
            app.unmount()
        } catch (e) {
            host.log.debug(`悬浮窗卸载异常：${(e && e.message) || e}`)
        }
        container.remove()
    }
}

export { PLUGIN_ID, PLUGIN_NAME }
