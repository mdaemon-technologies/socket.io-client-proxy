import type { ChannelFactory, ChannelLike } from "../protocol/transport";
import type { Logger } from "../util/log";
import { lobbyChannelName } from "./identity";

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
export class IdentityLobby {
  private channel: ChannelLike | null;
  private readonly warned = new Set<string>();

  constructor(
    private readonly channelId: string,
    private readonly self: LobbyIdentity,
    createChannel: ChannelFactory,
    private readonly log: Logger,
  ) {
    this.channel = createChannel(lobbyChannelName(channelId));
  }

  /** Starts listening and announces this tab. */
  open(): void {
    if (!this.channel) {
      return;
    }
    this.channel.onmessage = (event: MessageEvent) => this.handle(event.data);
    this.post("announce");
  }

  close(): void {
    if (!this.channel) {
      return;
    }
    this.channel.onmessage = null;
    this.channel.close();
    this.channel = null;
  }

  private post(kind: "announce" | "reply"): void {
    if (!this.channel) {
      return;
    }
    try {
      this.channel.postMessage({
        kind,
        tabId: this.self.tabId,
        fingerprint: this.self.fingerprint,
        keys: this.self.keys,
      });
    }
    catch (err) {
      // Diagnostics must never be able to break a working proxy.
      this.log("Could not announce identity:", err);
    }
  }

  /**
   * Hand-checked rather than schema-validated: this is a diagnostics
   * side-channel, not part of the wire protocol, and anything unrecognised is
   * simply ignored.
   */
  private handle(raw: any): void {
    try {
      if (!raw || typeof raw !== "object") {
        return;
      }
      const { kind, tabId, fingerprint, keys } = raw;
      if (kind !== "announce" && kind !== "reply") {
        return;
      }
      if (typeof tabId !== "string" || typeof fingerprint !== "string" || tabId === this.self.tabId) {
        return;
      }
      if (!Array.isArray(keys) || !keys.every((k: unknown) => typeof k === "string")) {
        return;
      }

      // Answer an announcement so the newcomer learns about this tab too.
      // Replies are never answered, so the exchange cannot ping-pong.
      if (kind === "announce") {
        this.post("reply");
      }

      if (fingerprint === this.self.fingerprint) {
        return;
      }
      this.reportMismatch(keys as string[]);
    }
    catch (err) {
      this.log("Error while handling an identity announcement:", err);
    }
  }

  /**
   * Warns only when the two identities are described by different *key sets*.
   * Matching keys with differing values means two principals, which is the
   * whole point of the isolation and must stay silent.
   */
  private reportMismatch(peerKeys: string[]): void {
    const mine = this.self.keys;
    const onlyHere = mine.filter((k) => !peerKeys.includes(k));
    const onlyThere = peerKeys.filter((k) => !mine.includes(k));

    if (onlyHere.length === 0 && onlyThere.length === 0) {
      return;
    }

    const signature = `${onlyHere.join(",")}|${onlyThere.join(",")}`;
    if (this.warned.has(signature)) {
      return;
    }
    this.warned.add(signature);

    const differences = [
      onlyHere.length ? `only here: ${onlyHere.join(", ")}` : null,
      onlyThere.length ? `only there: ${onlyThere.join(", ")}` : null,
    ].filter(Boolean).join("; ");

    console.warn(
      `[SocketIOProxy] Another tab on channel "${this.channelId}" is using a different `
      + `connection identity, so the two are NOT sharing a socket (${differences}). `
      + `Tabs that differ deliberately — different signed-in users — are meant to get separate `
      + `connections, but the option keys differ here, which usually means one principal is being `
      + `described inconsistently. Compare the options every SocketIOProxy for this channel is `
      + `constructed with; SocketIOProxy.channelNameFor() will tell you whether two call sites `
      + `agree. Pass warnOnIdentityMismatch: false to silence this.`,
    );
  }
}
