import validate from "@mdaemon/validate";
import type { ISchema } from "@mdaemon/validate";
import { digest } from "../util/hash";
import { PROTOCOL_VERSION } from "./constants";

const { createSchemaValidator } = validate;

// --- payloads ----------------------------------------------------------------

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

export interface PrimaryAliveData extends ClaimData, ConnectionStateData {}

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
  [T in MessageType]: MessagePayloads[T] extends undefined
    ? { type: T; data?: undefined }
    : { type: T; data: MessagePayloads[T] };
}[MessageType];

/** One handler per message type, each receiving that type's validated payload. */
export type MessageHandlers = {
  [T in MessageType]: (data: MessagePayloads[T]) => void;
};

// --- schemas -----------------------------------------------------------------

type DataValidator = (data: unknown) => { valid: boolean; errors: string[] };

const NON_EMPTY_STRING: ISchema = { type: "string", required: true, minLength: 1 };
const BOOLEAN: ISchema = { type: "boolean", required: true };

const EVENT_FIELDS = {
  event: NON_EMPTY_STRING,
  args: { type: "array", required: true },
} satisfies Record<string, ISchema>;

const TAB_ID_FIELDS = { tabId: NON_EMPTY_STRING } satisfies Record<string, ISchema>;

const CLAIM_FIELDS = {
  ...TAB_ID_FIELDS,
  epoch: { type: "number", required: true },
} satisfies Record<string, ISchema>;

const CONNECTION_STATE_FIELDS = {
  connected: BOOLEAN,
  active: BOOLEAN,
  id: { type: "string", required: true },
  wantsConnection: BOOLEAN,
} satisfies Record<string, ISchema>;

function payloadValidator(name: string, properties: Record<string, ISchema>): DataValidator {
  return createSchemaValidator(name, { type: "object", required: true, properties });
}

const validateTabIdData = payloadValidator("TabIdData", TAB_ID_FIELDS);
const validateClaimData = payloadValidator("ClaimData", CLAIM_FIELDS);

/**
 * How each message type's payload is validated; `null` for a type with no
 * payload. Mapped over {@link MessagePayloads}, so it cannot miss a type, and
 * a payload type cannot be paired with a `null` validator.
 */
const DATA_VALIDATORS: {
  readonly [T in MessageType]: MessagePayloads[T] extends undefined ? null : DataValidator;
} = {
  PRIMARY_CHECK: null,
  DISCONNECT: null,
  CONNECT: null,
  EMIT: payloadValidator("EmitData", EVENT_FIELDS),
  EMIT_WITH_ACK: payloadValidator("EmitWithAckData", { ...EVENT_FIELDS, id: NON_EMPTY_STRING }),
  EMIT_WITH_ACK_RESPONSE: payloadValidator("EmitWithAckResponseData", { id: NON_EMPTY_STRING }),
  EVENT: payloadValidator("EventData", EVENT_FIELDS),
  CONNECTION_STATE: payloadValidator("ConnectionStateData", CONNECTION_STATE_FIELDS),
  MESSAGE_TO_PRIMARY: payloadValidator("MessageToPrimaryData", { eventName: NON_EMPTY_STRING }),
  PRIMARY_ALIVE: payloadValidator("PrimaryAliveData", { ...CLAIM_FIELDS, ...CONNECTION_STATE_FIELDS }),
  PRIMARY_CLAIM: validateClaimData,
  HEARTBEAT: validateClaimData,
  PRIMARY_YIELD: validateTabIdData,
  PRIMARY_LEAVING: validateTabIdData,
  PRIMARY_DEMAND: validateTabIdData,
  PRIMARY_STOOD_DOWN: validateTabIdData,
};

/** Every message type, in the order {@link DATA_VALIDATORS} lists them. */
export const MESSAGE_TYPES = Object.keys(DATA_VALIDATORS) as MessageType[];

const MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(MESSAGE_TYPES);

export function isMessageType(value: unknown): value is MessageType {
  return typeof value === "string" && MESSAGE_TYPE_SET.has(value);
}

// --- channel tag and validation ----------------------------------------------

/**
 * The tag every message on a channel carries.
 *
 * Derived deterministically so every tab on the channel shares it from
 * construction. This is a protocol/namespace tag that keeps unrelated
 * messages off the wire — it is NOT authentication. Any script on the
 * origin can derive it.
 */
export function deriveToken(channelName: string): string {
  return `v${PROTOCOL_VERSION}.${digest(`${PROTOCOL_VERSION}:${channelName}`)}`;
}

export type ValidatedMessage =
  | { valid: true; type: MessageType; data: unknown }
  | { valid: false; type?: MessageType; errors: string[] };

/** Checks a raw BroadcastChannel message: its type, its channel tag, then its payload. */
export function validateMessage(raw: unknown, token: string): ValidatedMessage {
  if (raw == null || typeof raw !== "object") {
    return { valid: false, errors: ["Message is not an object"] };
  }

  const { type, data, token: tag } = raw as Record<string, unknown>;

  if (!isMessageType(type)) {
    return { valid: false, errors: [`Invalid message type: ${type}`] };
  }

  // Every message — elections included — carries the channel tag. Because it
  // is derived from the channel id rather than generated per tab, tabs that
  // elect themselves independently can still reconcile with one another.
  if (tag !== token) {
    return { valid: false, errors: ["Invalid or missing message token"] };
  }

  const validator: DataValidator | null = DATA_VALIDATORS[type];
  if (validator) {
    const result = validator(data);
    if (!result.valid) {
      return { valid: false, type, errors: result.errors };
    }
  }

  return { valid: true, type, data };
}
