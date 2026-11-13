export interface EventData {
    event: string;
    args: unknown[];
}
/**
 * The emission flags ride along only when set — a key present with an
 * undefined value survives structured cloning and would fail schema
 * validation. The schema cannot express an optional property, so they arrive
 * unchecked: read them with strict comparisons.
 */
interface FlagFields {
    volatile?: unknown;
    timeout?: unknown;
}
export interface EmitData extends EventData, FlagFields {
    /** Set on a peer-notifying emit: every tab but the sender also dispatches it. */
    notifyPeers?: unknown;
}
export interface EmitWithAckData extends EventData, FlagFields {
    id: string;
}
export interface AckResponseData {
    id: string;
    response?: unknown;
    /** A non-empty string fails the ack; anything else is ignored. */
    error?: unknown;
}
/**
 * The connection-state fields travel together in one message. Sent separately
 * they arrived as several events, and the first of them would carry a
 * `connected` that did not yet match the receiver's still-stale `id`.
 *
 * `wantsConnection` rides along for the same reason: it is adopted at exactly
 * the same moments as the rest, and a tab holding intent that disagreed with
 * the snapshot beside it would connect or stay closed for no visible reason.
 */
export interface ConnectionStateData {
    connected: boolean;
    active: boolean;
    /** The socket id, or {@link NO_ID}. */
    id: string;
    wantsConnection: boolean;
}
export interface MessageToPrimaryData {
    eventName: string;
    message?: unknown;
}
export interface TabIdData {
    tabId: string;
}
export interface ClaimData extends TabIdData {
    /** Not range-checked by the schema; may be NaN or Infinity. */
    epoch: number;
}
export interface PrimaryAliveData extends ClaimData, ConnectionStateData {
}
/**
 * Every message type and the payload it carries; `undefined` marks a type that
 * carries none. This map is the single list of message types: the validator
 * table and the handler table are both mapped over it, so a type added here
 * without a validator or a handler is a compile error.
 */
export interface MessagePayloads {
    PRIMARY_CHECK: undefined;
    PRIMARY_ALIVE: PrimaryAliveData;
    EMIT: EmitData;
    EMIT_WITH_ACK: EmitWithAckData;
    EMIT_WITH_ACK_RESPONSE: AckResponseData;
    EVENT: EventData;
    DISCONNECT: undefined;
    CONNECT: undefined;
    CONNECTION_STATE: ConnectionStateData;
    MESSAGE_TO_PRIMARY: MessageToPrimaryData;
    HEARTBEAT: ClaimData;
    PRIMARY_CLAIM: ClaimData;
    PRIMARY_YIELD: TabIdData;
    PRIMARY_LEAVING: TabIdData;
    PRIMARY_DEMAND: TabIdData;
    PRIMARY_STOOD_DOWN: TabIdData;
}
export type MessageType = keyof MessagePayloads;
/** A message as a sender hands it over, before the channel tag is added. */
export type OutgoingMessage = {
    [T in MessageType]: MessagePayloads[T] extends undefined ? {
        type: T;
        data?: undefined;
    } : {
        type: T;
        data: MessagePayloads[T];
    };
}[MessageType];
/** One handler per message type, each receiving that type's validated payload. */
export type MessageHandlers = {
    [T in MessageType]: (data: MessagePayloads[T]) => void;
};
/** Every message type, in the order {@link DATA_VALIDATORS} lists them. */
export declare const MESSAGE_TYPES: MessageType[];
export declare function isMessageType(value: unknown): value is MessageType;
/**
 * The tag every message on a channel carries.
 *
 * Derived deterministically so every tab on the channel shares it from
 * construction. This is a protocol/namespace tag that keeps unrelated
 * messages off the wire — it is NOT authentication. Any script on the
 * origin can derive it.
 */
export declare function deriveToken(channelName: string): string;
export type ValidatedMessage = {
    valid: true;
    type: MessageType;
    data: unknown;
} | {
    valid: false;
    type?: MessageType;
    errors: string[];
};
/** Checks a raw BroadcastChannel message: its type, its channel tag, then its payload. */
export declare function validateMessage(raw: unknown, token: string): ValidatedMessage;
export {};
