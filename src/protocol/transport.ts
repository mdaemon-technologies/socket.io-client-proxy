import type { Logger } from "../util/log";
import {
  deriveToken,
  validateMessage,
  type MessageHandlers,
  type OutgoingMessage,
} from "./messages";

/** The part of `BroadcastChannel` the proxy uses. */
export interface ChannelLike {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

export type ChannelFactory = (name: string) => ChannelLike;

export type ErrorReporter = (context: string, error: unknown) => void;

/**
 * The proxy's BroadcastChannel, wrapped: tags outgoing messages, validates
 * incoming ones and routes each to its handler.
 *
 * Two ways to post, kept distinct on purpose:
 * - {@link post} lets failures reach the caller. It is for the calls a user
 *   drives directly, where a payload that cannot be structured-cloned is worth
 *   surfacing at the call site.
 * - {@link safePost} is for traffic nobody is waiting on — protocol messages,
 *   heartbeats, state broadcasts. Those run inside timers, socket.io's dispatch
 *   loop and the BroadcastChannel callback, where a throw would take down the
 *   tab or surface as an unhandled rejection, so failures are reported instead.
 */
export class ChannelTransport {
  readonly token: string;
  private readonly channel: ChannelLike;
  private isClosed = false;

  constructor(
    readonly name: string,
    createChannel: ChannelFactory,
    private readonly log: Logger,
    private readonly reportError: ErrorReporter,
  ) {
    this.token = deriveToken(name);
    this.channel = createChannel(name);
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * Installs the one message handler, for good. Elections are handled by this
   * same handler so no message is ever dropped mid-election.
   */
  listen(handlers: MessageHandlers): void {
    this.channel.onmessage = (event: MessageEvent) => this.receive(event.data, handlers);
  }

  post = (message: OutgoingMessage): void => {
    if (this.isClosed) {
      this.log("Dropped outgoing message on a closed channel:", message.type);
      return;
    }
    this.channel.postMessage({ ...message, token: this.token });
  };

  safePost = (message: OutgoingMessage, context?: string): void => {
    try {
      this.post(message);
    }
    catch (err) {
      this.reportError(context ?? `sending ${message.type}`, err);
    }
  };

  /** Stops posting and listening. Idempotent. */
  close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.channel.onmessage = null;
    this.channel.close();
  }

  /** A malformed or hostile message must never throw out of the channel callback. */
  private receive(raw: unknown, handlers: MessageHandlers): void {
    let validation;
    try {
      validation = validateMessage(raw, this.token);
    }
    catch (err) {
      this.reportError("validating a BroadcastChannel message", err);
      return;
    }

    if (!validation.valid) {
      this.log("BroadcastChannel message rejected:", validation.errors);
      return;
    }

    try {
      // The validator has matched `data` to `type`; TypeScript cannot follow
      // that correlation through the lookup.
      (handlers[validation.type] as (data: unknown) => void)(validation.data);
    }
    catch (err) {
      this.reportError(`handling a ${validation.type} message`, err);
    }
  }
}
