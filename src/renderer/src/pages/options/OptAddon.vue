<!--
 * @FileDescription: 设置页面（附加子页面）
 * @Author: Stapxs
 * @Date: 2026/04/07
 * @Version: 1.0
-->
<!-- eslint-disable max-len -->

<template>
    <div class="opt-page">
        <template v-if="cards.length > 0">
            <div v-for="card in cards" :key="card.id" class="ss-card">
                <header>{{ card.title }}</header>
                <div v-if="card.description" class="tip">
                    {{ card.description }}
                </div>
                <template v-for="row in groupedRows(card)" :key="row.key">
                    <!-- 分组标题：整行点击折叠 / 展开 -->
                    <div v-if="row.kind === 'group'" class="opt-group"
                        :class="{ 'is-collapsed': isCollapsed(row.item) }"
                        @click="onToggleGroup(row.item)">
                        <font-awesome-icon :icon="row.item.icon || ['fas', 'folder']" />
                        <div>
                            <label>{{ row.item.label }}</label>
                            <span v-if="row.item.description">{{ row.item.description }}</span>
                        </div>
                        <span class="opt-group-caret">{{ isCollapsed(row.item) ? '▸' : '▾' }}</span>
                    </div>
                    <div v-else class="opt-item">
                    <template v-if="row.item.type === 'switch'">
                        <font-awesome-icon
                            :icon="row.item.icon || ['fas', 'robot']" />
                        <div>
                            <label :for="`opt-addon-switch-${row.item.id}`">{{ row.item.label }}</label>
                            <span v-if="row.item.description">{{ row.item.description }}</span>
                        </div>
                        <label class="ss-switch">
                            <input :id="`opt-addon-switch-${row.item.id}`" :checked="getItemValue(row.item) === true"
                                type="checkbox" @change="onSwitchChange($event, row.item)">
                            <div><div /></div>
                        </label>
                    </template>
                    <template v-else-if="row.item.type === 'input'">
                        <font-awesome-icon
                            :icon="row.item.icon || ['fas', 'paper-plane']" />
                        <div>
                            <label :for="`opt-addon-input-${row.item.id}`">{{ row.item.label }}</label>
                            <span v-if="row.item.description">{{ row.item.description }}</span>
                        </div>
                        <input :id="`opt-addon-input-${row.item.id}`" :value="getItemValue(row.item) ?? ''"
                            class="ss-input"
                            style="width: 150px"
                            type="text" @input="onInputChange($event, row.item)">
                    </template>
                    <template v-else-if="row.item.type === 'password'">
                        <font-awesome-icon
                            :icon="row.item.icon || ['fas', 'key']" />
                        <div>
                            <label :for="`opt-addon-password-${row.item.id}`">{{ row.item.label }}</label>
                            <span v-if="row.item.description">{{ row.item.description }}</span>
                        </div>
                        <input :id="`opt-addon-password-${row.item.id}`" :value="getItemValue(row.item) ?? ''"
                            class="ss-input"
                            style="width: 150px"
                            type="password" @input="onInputChange($event, row.item)">
                    </template>
                    <template v-else-if="row.item.type === 'select'">
                        <font-awesome-icon v-if="row.item.icon" :icon="row.item.icon" />
                        <div v-if="row.item.label || row.item.description">
                            <label v-if="row.item.label" :for="`opt-addon-select-${row.item.id}`">
                                {{ row.item.label }}
                            </label>
                            <span v-if="row.item.description">{{ row.item.description }}</span>
                        </div>
                        <div class="select-wrapper">
                            <select
                                :id="`opt-addon-select-${row.item.id}`"
                                :value="getItemValue(row.item) ?? (row.item.options?.[0]?.value ?? '')"
                                @change="onSelectChange($event, row.item)">
                                <option
                                    v-for="opt in row.item.options || []"
                                    :key="String(opt.value)"
                                    :value="opt.value">
                                    {{ opt.label }}
                                </option>
                            </select>
                        </div>
                    </template>
                    <template v-else-if="row.item.type === 'button'">
                        <font-awesome-icon v-if="row.item.icon" :icon="row.item.icon" />
                        <div v-if="row.item.label || row.item.description">
                            <span v-if="row.item.label">{{ row.item.label }}</span>
                            <span v-if="row.item.description">{{ row.item.description }}</span>
                        </div>
                        <button class="ss-button" style="width: 100px; font-size: 0.8rem"
                            @click="onClickButton(row.item)">
                            {{ row.item.label }}
                        </button>
                    </template>
                    </div>
                </template>
            </div>
        </template>
        <template v-else>
            <div class="ss-card empty">
                <font-awesome-icon :icon="['fas', 'box-open']" />
                <span>{{ $t('什么都木有') }}</span>
                <a>{{ $t('附加设置页设置项来自页面主题或其他插件注册，现在看起来什么都没有呢。') }}</a>
                <a>{{ $t('注意：有些功能的设置项可能需要在触发后才会被注册。') }}</a>
            </div>
        </template>
    </div>
</template>

<script setup lang="ts">
    import { i18n } from '@renderer/main'
    import { useSettingsStore } from '@renderer/state/settings'
    import {
        extraOptionCards,
        runAS,
        type ExtraOptionCard,
        type ExtraOptionItem,
    } from '@renderer/function/option'

    defineOptions({ name: 'ViewOptAddon' })

    const $t = i18n.global.t
    const settingsStore = useSettingsStore()

    const cards = extraOptionCards

    /**
     * 把卡片的扁平 items 切成「分组标题 + 子项」的行。
     *
     * 插件注册时先注册一个 type='group' 的标题项，后面注册的项就归进这一组，
     * 直到遇到下一个 group。这样插件不用改自己在哪注册，只要按顺序注册即可；
     * 没有 group 的卡片行为和以前完全一样（一行一项）。
     */
    function groupedRows(card: ExtraOptionCard) {
        const rows: { kind: 'group' | 'item'; key: string; item: ExtraOptionItem }[] = []
        let current: ExtraOptionItem | null = null
        for (const item of card.items) {
            if (item.type === 'group') {
                current = item
                rows.push({ kind: 'group', key: item.id, item })
                continue
            }
            // 折叠中的分组：子项整组不渲染
            if (current && isCollapsed(current)) continue
            rows.push({ kind: 'item', key: item.id, item })
        }
        return rows
    }

    /** 分组的折叠状态就存在它自己的 optionKey 上（true = 折叠） */
    function isCollapsed(item: ExtraOptionItem) {
        return getItemValue(item) === true
    }

    function onToggleGroup(item: ExtraOptionItem) {
        const next = !isCollapsed(item)
        if (item.optionKey) runAS(item.optionKey, next)
        if (typeof item.callback === 'function') {
            try {
                item.callback(next)
            } catch (e) {
                // eslint-disable-next-line no-console
                console.error('extra option group callback error:', e)
            }
        }
    }

    function getItemValue(item: ExtraOptionItem): any {
        const key = item.optionKey
        if (key && settingsStore.sysConfig &&
            Object.prototype.hasOwnProperty.call(settingsStore.sysConfig, key)) {
            return (settingsStore.sysConfig as any)[key]
        }
        return item.defaultValue
    }

    function handleChange(item: ExtraOptionItem, value: any) {
        if (item.optionKey) {
            runAS(item.optionKey, value)
        }
        if (typeof item.callback === 'function') {
            try {
                item.callback(value)
            } catch (e) {
                // 回调异常不影响主流程
                // eslint-disable-next-line no-console
                console.error('extra option callback error:', e)
            }
        }
    }

    function onSwitchChange(event: Event, item: ExtraOptionItem) {
        const sender = event.target as HTMLInputElement
        handleChange(item, sender.checked)
    }

    function onInputChange(event: Event, item: ExtraOptionItem) {
        const sender = event.target as HTMLInputElement
        handleChange(item, sender.value)
    }

    function onSelectChange(event: Event, item: ExtraOptionItem) {
        const sender = event.target as HTMLSelectElement
        handleChange(item, sender.value)
    }

    function onClickButton(item: ExtraOptionItem) {
        if (typeof item.callback === 'function') {
            try {
                item.callback(getItemValue(item))
            } catch (e) {
                // eslint-disable-next-line no-console
                console.error('extra option button callback error:', e)
            }
        }
    }
</script>
<style scoped>
/* 分组标题行：与下面的设置项视觉上有区分，整行可点 */
.opt-group {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 6px 0 2px;
    padding: 8px 10px;
    border-radius: 10px;
    cursor: pointer;
    user-select: none;
    background: color-mix(in srgb, var(--color-font-2) 8%, transparent);
    transition: background .15s;
}
.opt-group:hover {
    background: color-mix(in srgb, var(--color-font-2) 14%, transparent);
}
.opt-group > div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}
.opt-group > div > label {
    font-size: 0.85rem;
    color: var(--color-font);
    cursor: pointer;
}
.opt-group > div > span {
    font-size: 0.7rem;
    color: var(--color-font-2);
}
.opt-group-caret {
    margin-left: auto;
    font-size: 0.75rem;
    color: var(--color-main);
}
.opt-group.is-collapsed {
    opacity: .78;
}
.empty {
    margin: 0 auto;
    width: 50%;
    display: flex;
    flex-direction: column;
    align-items: center;
}
.empty svg {
    width: 50px;
    height: 50px;
    margin-bottom: 10px;
    color: var(--color-main);
}
.empty span {
    color: var(--color-main);
    margin-bottom: 10px;
    font-size: 0.9rem;
}
.empty a {
    font-size: 0.8rem;
}
</style>
