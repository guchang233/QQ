<!--
 * @FileDescription: 插件会话徽标槽（宿主组件）
 * @Author: WorkBuddy
 * @Date: 2026/09/29
 *
 * 说明：渲染在聊天页顶部标题右侧，用于展示当前会话的整体状态
 * （例如单聊对象的情绪、群聊氛围）。插件通过 host.setChatBadge() 写入。
-->
<template>
    <span v-if="badge"
        class="plugin-chat-badge"
        :class="'plugin-tone-' + (badge.tone ?? 'neutral')"
        :title="badge.title ?? badge.text">
        {{ badge.text }}
    </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { chatBadges, chatKey } from '@renderer/plugin'
import { useChatStore } from '@renderer/state/chat'

defineOptions({ name: 'PluginChatBadge' })

const chatStore = useChatStore()

const badge = computed(() => {
    const show = chatStore.chatInfo.show
    if (!show || !show.type || !show.id) return undefined
    return chatBadges[chatKey(show.type, show.id)]
})
</script>

<style>
.plugin-chat-badge {
    margin-left: 8px;
    padding: 1px 7px;
    border-radius: 7px;
    font-size: 0.68rem;
    line-height: 1.5;
    white-space: nowrap;
    background: color-mix(in srgb, var(--color-font-2) 12%, transparent);
    color: var(--color-font-2);
}
.plugin-chat-badge.plugin-tone-positive {
    background: color-mix(in srgb, var(--color-green) 18%, transparent);
    color: var(--color-green);
}
.plugin-chat-badge.plugin-tone-negative {
    background: color-mix(in srgb, var(--color-red) 18%, transparent);
    color: var(--color-red);
}
.plugin-chat-badge.plugin-tone-neutral {
    background: color-mix(in srgb, var(--color-main) 16%, transparent);
    color: var(--color-main);
}
</style>
