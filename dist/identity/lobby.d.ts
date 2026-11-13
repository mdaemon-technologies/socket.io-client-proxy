import type { ChannelFactory } from "../protocol/transport";
import type { Logger } from "../util/log";
/** What this tab tells the lobby about itself: names only, never values. */
export interface LobbyIdentity {
    tabId: string;
    fingerprint: string;
    keys: string[];
}
/**
 * The identity-diagnostics side channel, shared by every tab on the same raw
 * `channelId` whatever its identity. Tabs announce their identity's key paths
 * there, and a tab warns when a peer's identity differs in its *key set*.
 *
 * Diagnostics only: nothing here can affect, or break, a working proxy.
 */
export declare class IdentityLobby {
    private readonly channelId;
    private readonly self;
    private readonly log;
    private channel;
    private readonly warned;
    constructor(channelId: string, self: LobbyIdentity, createChannel: ChannelFactory, log: Logger);
    /** Starts listening and announces this tab. */
    open(): void;
    close(): void;
    private post;
    /**
     * Hand-checked rather than schema-validated: this is a diagnostics
     * side-channel, not part of the wire protocol, and anything unrecognised is
     * simply ignored.
     */
    private handle;
    /**
     * Warns only when the two identities are described by different *key sets*.
     * Matching keys with differing values means two principals, which is the
     * whole point of the isolation and must stay silent.
     */
    private reportMismatch;
}
