import type { ManagerOptions, SocketOptions } from "socket.io-client";
import type { SocketIOProxyOptions } from "./types";

export type SocketIOOptions = Partial<ManagerOptions & SocketOptions>;

/** Defaults for the proxy's own options. */
export const DEFAULTS = {
  debug: false,
  heartbeatInterval: 3000,
  heartbeatTimeout: 10000,
  ackTimeout: 10000,
  electionTimeout: 2000,
  electionJitter: 250,
  isolateByAuth: true,
  warnOnIdentityMismatch: true,
} as const;

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
export function assertChannelArgs(channelId: unknown, url: unknown): asserts channelId is string {
  if (!channelId || typeof channelId !== "string") {
    throw new Error("channelId is required and must be a non-empty string");
  }
  if (!url || typeof url !== "string") {
    throw new Error("url is required and must be a non-empty string");
  }
}

export function resolveOptions(url: string, options: SocketIOProxyOptions): ProxyConfig {
  const {
    debug,
    heartbeatInterval,
    heartbeatTimeout,
    ackTimeout,
    electionTimeout,
    electionJitter,
    isolateByAuth,
    warnOnIdentityMismatch,
    ...socketOptions
  } = options;

  return {
    url,
    socketOptions,
    debug: debug ?? DEFAULTS.debug,
    heartbeatInterval: heartbeatInterval ?? DEFAULTS.heartbeatInterval,
    heartbeatTimeout: heartbeatTimeout ?? DEFAULTS.heartbeatTimeout,
    ackTimeout: ackTimeout ?? DEFAULTS.ackTimeout,
    electionTimeout: electionTimeout ?? DEFAULTS.electionTimeout,
    electionJitter: electionJitter ?? DEFAULTS.electionJitter,
    isolateByAuth: isolateByAuth ?? DEFAULTS.isolateByAuth,
    warnOnIdentityMismatch: warnOnIdentityMismatch ?? DEFAULTS.warnOnIdentityMismatch,
    autoConnect: options.autoConnect !== false,
  };
}
