import type { Socket } from "socket.io-client";
import type { SocketIOOptions } from "../options";
import { type FlagInput } from "../emit/flags";
export type SocketFactory = (url: string, options: SocketIOOptions) => Socket;
/** What a {@link PrimarySocket} reports to the tab that owns it. */
export interface PrimarySocketHooks {
    /**
     * Whether this socket still speaks for the channel. Handlers stay attached
     * to a socket the tab has since let go of, so each one checks this before
     * reporting anything.
     */
    isCurrent(): boolean;
    /**
     * An event to pass on to every tab: one from the server, or one of the
     * socket's lifecycle or Manager events, which can carry `Error` objects.
     */
    relay(event: string, args: unknown[], source: "server" | "socket"): void;
    /** The socket connected or disconnected, so the shared state is stale. */
    stateChanged(): void;
}
/**
 * The real socket.io socket, held only by the primary, with every listener the
 * channel needs wired onto it. {@link dispose} undoes everything the
 * constructor set up, so a demotion cannot leave a stale listener behind.
 */
export declare class PrimarySocket {
    private readonly hooks;
    private readonly socket;
    private managerListeners;
    constructor(url: string, options: SocketIOOptions, createSocket: SocketFactory, hooks: PrimarySocketHooks);
    get connected(): boolean;
    get active(): boolean;
    get id(): string | undefined;
    /** The socket.io Manager. */
    get manager(): any;
    emit(event: string, args: unknown[], flags: FlagInput): void;
    emitWithAck(event: string, args: unknown[], flags: FlagInput): Promise<any>;
    connect(): void;
    disconnect(): void;
    /**
     * Brings a newly created socket in line with the channel's connection intent.
     *
     * `io()` opens the socket itself under the default autoConnect, so this is
     * a no-op for most consumers. With autoConnect false nothing else ever
     * opens it: a tab promoted by failover would hold a socket that never
     * connects, report `connected: false` forever, and never raise an error —
     * because nothing was attempted. Promotion is the point at which the
     * channel's intent has to be applied to a brand new socket.
     *
     * The `else` covers a Manager cached by an earlier `io()` call, whose
     * autoConnect was fixed before this proxy existed and which may therefore
     * have opened the socket against the channel's wishes.
     */
    applyIntent(wantsConnection: boolean): void;
    /** Stops relaying the Manager's reconnection events. */
    detachManager(): void;
    /** Detaches the Manager listeners, if that has not been done, and closes the socket. */
    dispose(): void;
    /**
     * Bridges the Manager's reconnection events onto the channel. `socket.io` is
     * the Manager; a browser build always has one, but it is guarded so a test
     * double without it does not break promotion.
     */
    private attachManagerListeners;
    private detachManagerListeners;
}
