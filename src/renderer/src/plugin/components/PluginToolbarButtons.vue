<!--
 * @FileDescription: 插件工具栏按钮槽（宿主组件）
 * @Author: WorkBuddy
 * @Date: 2026/09/29
 *
 * 说明：渲染在聊天页顶部「更多」按钮左侧。插件通过
 * host.addToolbarButton({ id, title, svg, onClick }) 注册，图标用内联 SVG，
 * 避免插件还需要声明客户端内部图标名。
-->
<template>
    <template v-for="button in toolbarButtons" :key="button.id">
        <div v-if="button.svg"
            class="plugin-toolbar-btn"
            :title="button.title"
            v-html="button.svg"
            @click="button.onClick()" />
        <font-awesome-icon v-else
            class="plugin-toolbar-btn"
            :title="button.title"
            :icon="['fas', 'puzzle-piece']"
            @click="button.onClick()" />
    </template>
</template>

<script setup lang="ts">
import { toolbarButtons } from '@renderer/plugin'

defineOptions({ name: 'PluginToolbarButtons' })
</script>

<style>
.plugin-toolbar-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    margin-left: 6px;
    border-radius: 7px;
    cursor: pointer;
    color: var(--color-font-2);
    transition: background .2s, color .2s;
}
.plugin-toolbar-btn:hover {
    background: color-mix(in srgb, var(--color-main) 16%, transparent);
    color: var(--color-main);
}
.plugin-toolbar-btn svg {
    width: 14px;
    height: 14px;
    fill: currentColor;
}
</style>
