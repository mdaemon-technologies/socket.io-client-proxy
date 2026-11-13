export type Logger = (...args: any[]) => void;
/** A console logger that stays silent unless `debug` is on. */
export declare function createLogger(debug: boolean): Logger;
