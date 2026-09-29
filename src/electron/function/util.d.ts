export declare function queryKeys(keyPath: string, value: string): Promise<{
    stdout: any;
    stderr: any;
}>;
export declare function runCommand(command: string): Promise<{
    stdout: any;
    stderr: any;
}>;
export declare const linkView: {
    bilibili(url: string, retry?: boolean): any;
    music163(url: string, retry?: boolean): any;
};
