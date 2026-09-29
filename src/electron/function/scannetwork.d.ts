declare class ScanNetwork {
    private logger;
    private win;
    constructor(win: Electron.BrowserWindow);
    /**
     * 获取局域网网段
     * @returns {string[]} 所有可能的 IP 地址
     */
    private getLocalSubnetIPs;
    /**
     * 检查指定 IP 和端口是否可连接
     * @param {string} ip - 目标 IP
     * @param {number} port - 目标端口
     * @returns {Promise<boolean>} 是否可连接
    **/
    private isPortOpen;
    /**
     * 遍历局域网 IP 并检测端口
     * @param {number} port - 要检查的端口
     */
    scanNetwork(): Promise<void>;
}
export default ScanNetwork;
