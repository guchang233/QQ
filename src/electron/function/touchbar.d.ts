import { BrowserWindow } from 'electron';
import { NotifyInfo } from './elements.ts';
export declare class touchBar {
    private win;
    private nowView;
    private itemList;
    private msgList;
    touchBarScrubber: Electron.TouchBarScrubber;
    search: Electron.TouchBarButton;
    baseView: (Electron.TouchBarButton | Electron.TouchBarPopover | Electron.TouchBarSpacer)[];
    constructor(win: BrowserWindow);
    /**
     * 刷新消息列表
     * @param messageList 消息列表
     */
    flushOnMessage(messageList: {
        id: number;
        name: string;
        image: string;
    }[]): void;
    /**
     * 刷新好友搜索
     * @param nameList 好友列表
     */
    flushFriendSearch(nameList: {
        id: number;
        name: string;
    }[]): void;
    /**
     * 保存新消息
     * @param data 新消息
     */
    newMessage(data: NotifyInfo): Promise<void>;
    /**
     * 删除消息
     * @param tag 消息标签
     */
    removeMessage(tag: string): void;
    /**
     * 刷新主页面
     */
    private loadHome;
}
