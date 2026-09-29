/*
 * @FileDescription: 插件子系统入口
 * @Author: WorkBuddy
 * @Date: 2026/09/29
 *
 * 对外只暴露初始化与生命周期控制；界面侧只依赖本模块导出的两个响应式槽
 * （messageDecorations / chatBadges）与工具栏按钮列表。
 */

export {
    initPluginHost,
    disposePlugins,
    setPluginEnabled,
    isPluginEnabled,
    flushSlots,
    chatKey,
    resolvePluginUrl,
    messageDecorations,
    chatBadges,
    toolbarButtons,
    pluginRuntime,
    HOST_API_VERSION,
    PLUGIN_BASE,
    PLUGIN_REGISTRY,
} from './host'

export type {
    PluginHostApi,
    PluginManifest,
    PluginModule,
    PluginRegistryEntry,
    PluginRuntimeInfo,
    PluginStatus,
    MessageDecoration,
    ChatBadge,
    ToolbarButton,
    PanelOptions,
} from './host'
