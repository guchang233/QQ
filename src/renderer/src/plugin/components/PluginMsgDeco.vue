<!--
 * @FileDescription: 插件消息标签槽（宿主组件）
 * @Author: WorkBuddy
 * @Date: 2026/09/29
 *
 * 说明：这是宿主提供给插件的稳定渲染槽。插件只需往
 * `host.setMessageDecoration(messageId, {...})` 写值，本组件会在消息气泡
 * 下方渲染一行标签。宿主不关心标签含义，样式也全部由插件负责注入。
-->
<template>
    <div v-if="decoration" class="plugin-msg-deco">
        <span v-if="decoration.emotion"
            class="plugin-deco-tag plugin-deco-emotion">{{ decoration.emotion }}</span>
        <span v-if="decoration.intent"
            class="plugin-deco-tag plugin-deco-intent">{{ decoration.intent }}</span>
        <span v-if="decoration.detail" class="plugin-deco-detail">{{ decoration.detail }}</span>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { messageDecorations } from '@renderer/plugin'

defineOptions({ name: 'PluginMsgDeco' })

const props = defineProps<{ messageId: string | number }>()

const decoration = computed(() => messageDecorations[String(props.messageId)])
</script>

<style>
/* 仅提供最基础的行内布局，视觉表现交给插件样式表覆盖 */
.plugin-msg-deco {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin: 3px 0 0 12px;
    font-size: 0.68rem;
    line-height: 1.2;
    user-select: none;
}
.plugin-msg-deco .plugin-deco-tag {
    padding: 1px 6px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--color-font-2) 12%, transparent);
    color: var(--color-font-2);
}
.plugin-msg-deco .plugin-deco-emotion {
    background: color-mix(in srgb, var(--color-main) 16%, transparent);
    color: var(--color-main);
}
.plugin-msg-deco .plugin-deco-detail {
    opacity: 0.6;
}
</style>
