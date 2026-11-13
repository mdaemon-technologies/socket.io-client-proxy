import type { ConnectionStateData } from "../protocol/messages";
import type { ConnectionState } from "../types";
/** The parts of a socket the connection state is read from. */
export interface SocketStateSource {
    readonly connected: boolean;
    readonly active: boolean;
    readonly id: string | undefined;
}
/** A socket's live state as it goes on the wire, with `undefined` ids encoded as {@link NO_ID}. */
export declare function describeSocket(socket: SocketStateSource | null, wantsConnection: boolean): ConnectionStateData;
/**
 * This tab's copy of the shared connection state, plus the channel's
 * connection intent.
 *
 * On a secondary it is the only view of the primary's socket; on the primary
 * it is refreshed from the socket each time the state is broadcast.
 */
export declare class ConnectionStateStore {
    connected: boolean;
    active: boolean;
    id: string | undefined;
    /**
     * The channel's connection intent — whether the socket is *meant* to be open.
     * Channel-wide rather than per-tab, so that a tab promoted by failover opens
     * a socket the consumer asked for on some other tab, and does not open one
     * the consumer closed there.
     */
    intent: boolean;
    /**
     * @param intent this tab's own `autoConnect`. It is overwritten by the
     * channel's intent if a primary answers the election — an established
     * channel's decision outranks a newcomer's default.
     */
    constructor(intent: boolean);
    /** Adopts a state push from the wire. Extra fields (a PRIMARY_ALIVE's tabId, say) are ignored. */
    apply(data: ConnectionStateData): void;
    /** Refreshes the copy from the primary's own socket, and returns it ready for the wire. */
    capture(socket: SocketStateSource | null): ConnectionStateData;
    snapshot(): ConnectionState;
    /** Forgets the socket state. The intent is kept. */
    reset(): void;
}
