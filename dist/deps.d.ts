import type { SocketFactory } from "./connection/primary-socket";
import { type PageTarget } from "./primacy/page-lifecycle";
import type { ChannelFactory } from "./protocol/transport";
import { type Timers } from "./util/timers";
/**
 * Everything the proxy reaches outside itself for. The parts take these as
 * constructor arguments rather than touching the globals, so each part can be
 * tested with plain fakes; the proxy passes the real ones.
 */
export interface ProxyDeps {
    createChannel: ChannelFactory;
    createSocket: SocketFactory;
    timers: Timers;
    /** A number in [0, 1). */
    random: () => number;
    /** `bytes` random bytes as hex. */
    randomId: (bytes: number) => string;
    page: () => PageTarget | undefined;
}
/**
 * The real dependencies. Each looks its global up when called, not when this
 * module loads, so a global replaced afterwards (by a test, say) is honoured.
 */
export declare const defaultDeps: ProxyDeps;
