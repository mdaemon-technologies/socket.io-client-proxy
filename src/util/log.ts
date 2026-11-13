export type Logger = (...args: any[]) => void;

/** A console logger that stays silent unless `debug` is on. */
export function createLogger(debug: boolean): Logger {
  return (...args: any[]): void => {
    if (debug) {
      console.log("[SocketIOProxy]", ...args);
    }
  };
}
