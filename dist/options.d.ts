import type { ManagerOptions, SocketOptions } from "socket.io-client";
import type { SocketIOProxyOptions } from "./types";
export type SocketIOOptions = Partial<ManagerOptions & SocketOptions>;
/** Defaults for the proxy's own options. */
export declare const DEFAULTS: {
    readonly debug: false;
    readonly heartbeatInterval: 3000;
    readonly heartbeatTimeout: 10000;
    readonly ackTimeout: 10000;
    readonly electionTimeout: 2000;
    readonly electionJitter: 250;
    readonly isolateByAuth: true;
    readonly warnOnIdentityMismatch: true;
};
/** Every option resolved: the proxy's own with defaults applied, and the rest for socket.io. */
export interface ProxyConfig {
    url: string;
    /** Everything that is not a proxy option, passed to `io()` untouched — `autoConnect` included. */
    socketOptions: SocketIOOptions;
    debug: boolean;
    heartbeatInterval: number;
    heartbeatTimeout: number;
    ackTimeout: number;
    electionTimeout: number;
    electionJitter: number;
    isolateByAuth: boolean;
    warnOnIdentityMismatch: boolean;
    /** The connection intent this tab starts with; see {@link SocketIOProxyOptions.autoConnect}. */
    autoConnect: boolean;
}
/** Shared by the constructor and `channelNameFor`, so both reject the same input the same way. */
export declare function assertChannelArgs(channelId: unknown, url: unknown): asserts channelId is string;
export declare function resolveOptions(url: string, options: SocketIOProxyOptions): ProxyConfig;
