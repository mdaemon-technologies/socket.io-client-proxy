import type { Socket } from "socket.io-client";
import type { SocketIOOptions } from "../options";
import {
  FORWARDED_LIFECYCLE_EVENTS,
  FORWARDED_MANAGER_EVENTS,
  STATE_CHANGING_EVENTS,
} from "../protocol/constants";
import { applyFlags, type FlagInput } from "../emit/flags";

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
export class PrimarySocket {
  private readonly socket: Socket;
  private managerListeners: [string, (...args: any[]) => void][] = [];

  constructor(
    url: string,
    options: SocketIOOptions,
    createSocket: SocketFactory,
    private readonly hooks: PrimarySocketHooks,
  ) {
    const socket = createSocket(url, options);
    this.socket = socket;

    socket.onAny((event: string, ...args: any[]) => {
      if (hooks.isCurrent()) {
        hooks.relay(event, args, "server");
      }
    });

    // onAny never fires for these, so they are forwarded explicitly.
    FORWARDED_LIFECYCLE_EVENTS.forEach((event) => {
      socket.on(event as any, (...args: any[]) => {
        if (!hooks.isCurrent()) {
          return;
        }
        if (STATE_CHANGING_EVENTS.has(event)) {
          hooks.stateChanged();
        }
        hooks.relay(event, args, "socket");
      });
    });

    // Reconnection events live on the Manager, not the socket. They are
    // attached separately and detached on dispose, because the Manager can
    // outlive the socket this tab was using.
    this.attachManagerListeners();
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  get active(): boolean {
    return this.socket.active;
  }

  get id(): string | undefined {
    return this.socket.id;
  }

  /** The socket.io Manager. */
  get manager(): any {
    return this.socket.io;
  }

  emit(event: string, args: unknown[], flags: FlagInput): void {
    applyFlags(this.socket, flags).emit(event, ...args);
  }

  emitWithAck(event: string, args: unknown[], flags: FlagInput): Promise<any> {
    return applyFlags(this.socket, flags).emitWithAck(event, ...args);
  }

  connect(): void {
    this.socket.connect();
  }

  disconnect(): void {
    this.socket.disconnect();
  }

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
  applyIntent(wantsConnection: boolean): void {
    const socket = this.socket;
    if (wantsConnection) {
      if (!socket.active) {
        socket.connect();
      }
    }
    else if (socket.active || socket.connected) {
      socket.disconnect();
    }
  }

  /** Stops relaying the Manager's reconnection events. */
  detachManager(): void {
    this.detachManagerListeners();
  }

  /** Detaches the Manager listeners, if that has not been done, and closes the socket. */
  dispose(): void {
    this.detachManagerListeners();
    this.socket.disconnect();
  }

  /**
   * Bridges the Manager's reconnection events onto the channel. `socket.io` is
   * the Manager; a browser build always has one, but it is guarded so a test
   * double without it does not break promotion.
   */
  private attachManagerListeners(): void {
    const manager = this.manager;
    if (!manager || typeof manager.on !== "function") {
      return;
    }

    FORWARDED_MANAGER_EVENTS.forEach((event) => {
      const handler = (...args: any[]) => {
        if (this.hooks.isCurrent()) {
          this.hooks.relay(event, args, "socket");
        }
      };
      manager.on(event, handler);
      this.managerListeners.push([event, handler]);
    });
  }

  private detachManagerListeners(): void {
    const manager = this.manager;
    if (manager && typeof manager.off === "function") {
      this.managerListeners.forEach(([event, handler]) => manager.off(event, handler));
    }
    this.managerListeners = [];
  }
}
