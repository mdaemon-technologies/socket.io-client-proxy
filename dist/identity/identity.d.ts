import type { SocketIOProxyOptions } from "../types";
/**
 * Suffix for the diagnostics lobby — a second channel keyed on the *raw*
 * channel id. Tabs whose identity differs land on different main channels by
 * construction and can never hear each other, which is exactly what makes a
 * misconfigured identity invisible; the lobby is the only place they meet.
 */
export declare const IDENTITY_LOBBY_SUFFIX = "::sioproxy-identity";
export declare function lobbyChannelName(channelId: string): string;
/** The options that decide which server principal a connection speaks for. */
export declare function connectionIdentity(url: string, options: SocketIOProxyOptions): Record<string, unknown>;
/**
 * The key *paths* of an identity — `["auth.token", "auth.user", "url"]` — with
 * no values. Two identities that differ in their values are two principals,
 * which is what the isolation is for; two that differ in their key sets are
 * almost always one principal described inconsistently, which is a bug.
 *
 * Only names ever go on the wire, never values.
 */
export declare function identityKeys(identity: Record<string, unknown>): string[];
export declare function fingerprintOf(identity: Record<string, unknown>): string;
export interface ChannelIdentity {
    /** The effective BroadcastChannel name. */
    name: string;
    fingerprint: string;
    keyPaths: string[];
}
/**
 * The channel a configuration resolves to. Tabs whose connection identity
 * differs must not share a socket, so with `isolate` the identity is folded
 * into the channel name; tabs with matching identity derive the same name and
 * share.
 *
 * The constructor and `channelNameFor()` both go through here, so the two
 * cannot disagree.
 */
export declare function resolveIdentity(channelId: string, url: string, options: SocketIOProxyOptions, isolate: boolean): ChannelIdentity;
