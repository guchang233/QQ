/**
 * 后端和前端的简易通信器，封装一些常用的交互
 */
import { BrowserWindow } from 'electron';
export declare function buildWebSocketUrl(address: string, token?: string): URL;
export declare class Connector {
    private logger;
    private win;
    private websocket;
    private reconnectTimes;
    constructor(win: BrowserWindow);
    connect(url: string, token?: string): void;
}
