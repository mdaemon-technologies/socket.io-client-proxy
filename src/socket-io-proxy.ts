import { io, Socket, ManagerOptions, SocketOptions } from "socket.io-client";
import validate from "@mdaemon/validate";

const { createSchemaValidator } = validate;

const MESSAGE_TYPES = [
  "PRIMARY_CHECK",
  "PRIMARY_ALIVE",
  "EMIT",
  "EMIT_WITH_ACK",
  "EMIT_WITH_ACK_RESPONSE",
  "EVENT",
  "DISCONNECT",
  "CONNECT",
  "CONNECTION_STATUS",
  "SOCKET_ID_UPDATE",
  "ACTIVE_STATUS_UPDATE",
  "GET_SOCKET_ID",
  "SOCKET_ID_RESPONSE",
  "MESSAGE_TO_PRIMARY",
  "HEARTBEAT",
  "PRIMARY_CLAIM",
  "PRIMARY_YIELD",
] as const;

type MessageType = typeof MESSAGE_TYPES[number];

// Schema validators for each message type's data payload
const validateEmitData = createSchemaValidator("EmitData", {
  type: "object",
  required: true,
  properties: {
    event: { type: "string", required: true, minLength: 1 },
    args: { type: "array", required: true },
    volatile: { type: "boolean" },
    timeout: { type: "number" },
  },
});

const validateEmitWithAckData = createSchemaValidator("EmitWithAckData", {
  type: "object",
  required: true,
  properties: {
    event: { type: "string", required: true, minLength: 1 },
    args: { type: "array", required: true },
    id: { type: "string", required: true, minLength: 1 },
  },
});

const validateEmitWithAckResponseData = createSchemaValidator("EmitWithAckResponseData", {
  type: "object",
  required: true,
  properties: {
    id: { type: "string", required: true, minLength: 1 },
  },
});

const validateEventData = createSchemaValidator("EventData", {
  type: "object",
  required: true,
  properties: {
    event: { type: "string", required: true, minLength: 1 },
    args: { type: "array", required: true },
  },
});

const validateConnectionStatusData = createSchemaValidator("ConnectionStatusData", {
  type: "object",
  required: true,
  properties: {
    connected: { type: "boolean", required: true },
  },
});

const validateSocketIdUpdateData = createSchemaValidator("SocketIdUpdateData", {
  type: "object",
  required: true,
  properties: {
    id: { type: "string" },
  },
});

const validateActiveStatusUpdateData = createSchemaValidator("ActiveStatusUpdateData", {
  type: "object",
  required: true,
  properties: {
    active: { type: "boolean", required: true },
  },
});

const validateSocketIdResponseData = createSchemaValidator("SocketIdResponseData", {
  type: "object",
  required: true,
  properties: {
    id: { type: "string" },
  },
});

const validateMessageToPrimaryData = createSchemaValidator("MessageToPrimaryData", {
  type: "object",
  required: true,
  properties: {
    eventName: { type: "string", required: true, minLength: 1 },
  },
});

const validatePrimaryClaimData = createSchemaValidator("PrimaryClaimData", {
  type: "object",
  required: true,
  properties: {
    tabId: { type: "string", required: true, minLength: 1 },
  },
});

const DATA_VALIDATORS: Partial<Record<MessageType, (data: any) => { valid: boolean; errors: string[] }>> = {
  EMIT: validateEmitData,
  EMIT_WITH_ACK: validateEmitWithAckData,
  EMIT_WITH_ACK_RESPONSE: validateEmitWithAckResponseData,
  EVENT: validateEventData,
  CONNECTION_STATUS: validateConnectionStatusData,
  SOCKET_ID_UPDATE: validateSocketIdUpdateData,
  ACTIVE_STATUS_UPDATE: validateActiveStatusUpdateData,
  SOCKET_ID_RESPONSE: validateSocketIdResponseData,
  MESSAGE_TO_PRIMARY: validateMessageToPrimaryData,
  PRIMARY_CLAIM: validatePrimaryClaimData,
};

// Messages that carry no data payload
const NO_DATA_TYPES: MessageType[] = [
  "PRIMARY_CHECK",
  "PRIMARY_ALIVE",
  "DISCONNECT",
  "CONNECT",
  "GET_SOCKET_ID",
  "HEARTBEAT",
  "PRIMARY_YIELD",
];

export interface SocketIOProxyOptions extends Partial<ManagerOptions & SocketOptions> {
  debug?: boolean;
  heartbeatInterval?: number;
  heartbeatTimeout?: number;
  ackTimeout?: number;
}

function generateToken(): string {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export default class SocketIOProxy {
  private socket: Socket | null;
  private listeners: { [key: string]: ((...args: any[]) => void)[] };
  private options: Partial<ManagerOptions & SocketOptions>;
  private url: string;
  private channel: BroadcastChannel;
  private isConnected: boolean;
  private handlePrimaryCheck: (...args: any[]) => void;
  private token: string;
  private ackTimeout: number;
  private debug: boolean;
  private tabId: string;
  private _useVolatile: boolean;
  private _timeout: number | null;
  private heartbeatInterval: number;
  private heartbeatTimeout: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null;
  private heartbeatMonitorTimer: ReturnType<typeof setInterval> | null;
  private lastHeartbeat: number;
  public isPrimary: boolean;

  constructor(channelId: string, url: string, options: SocketIOProxyOptions = {}) {
    if (!channelId) {
      throw new Error("channelId is required and must be a non-empty string");
    }

    this.channel = new BroadcastChannel(channelId);
    this.isPrimary = false;
    this.url = url;
    const { debug, heartbeatInterval, heartbeatTimeout, ackTimeout, ...socketOptions } = options;
    this.options = socketOptions;
    this.socket = null;
    this.listeners = {};
    this.isConnected = false;
    this.handlePrimaryCheck = () => {};
    this.token = generateToken();
    this.ackTimeout = ackTimeout ?? 10000;
    this.debug = debug ?? false;
    this.tabId = generateToken();
    this._useVolatile = false;
    this._timeout = null;
    this.heartbeatInterval = heartbeatInterval ?? 3000;
    this.heartbeatTimeout = heartbeatTimeout ?? 10000;
    this.heartbeatTimer = null;
    this.heartbeatMonitorTimer = null;
    this.lastHeartbeat = Date.now();
  }

  private validateMessage(raw: any): { valid: boolean; type?: MessageType; data?: any; token?: string; errors?: string[] } {
    if (raw == null || typeof raw !== "object") {
      return { valid: false, errors: ["Message is not an object"] };
    }

    const { type, data, token } = raw;

    // Type check first
    if (!type || typeof type !== "string" || !MESSAGE_TYPES.includes(type as MessageType)) {
      return { valid: false, errors: [`Invalid message type: ${type}`] };
    }

    const msgType = type as MessageType;

    // Handshake messages skip token validation (token is exchanged during handshake)
    const isHandshake = msgType === "PRIMARY_CHECK" || msgType === "PRIMARY_ALIVE";

    // Token check (skip for handshake messages)
    if (!isHandshake) {
      if (!token || typeof token !== "string" || token !== this.token) {
        return { valid: false, errors: ["Invalid or missing message token"] };
      }
    }

    // No-data messages should not require data validation
    if (NO_DATA_TYPES.includes(msgType)) {
      return { valid: true, type: msgType, data, token };
    }

    // Validate data payload against per-type schema
    const validator = DATA_VALIDATORS[msgType];
    if (validator) {
      const result = validator(data);
      if (!result.valid) {
        return { valid: false, type: msgType, errors: result.errors };
      }
    }

    return { valid: true, type: msgType, data, token };
  }

  private postMessage(msg: { type: string; data?: any }): void {
    this.channel.postMessage({ ...msg, token: this.token });
  }

  private log(...args: any[]): void {
    if (this.debug) {
      console.log("[SocketIOProxy]", ...args);
    }
  }

  private installMessageHandler = (): void => {
    this.channel.onmessage = (event: MessageEvent) => {
      const validation = this.validateMessage(event.data);
      if (!validation.valid) {
        this.log("BroadcastChannel message rejected:", validation.errors);
        return;
      }

      const { type, data } = validation;

      switch (type) {
        case "PRIMARY_CHECK":
          if (this.isPrimary) {
            this.postMessage({ type: "PRIMARY_ALIVE" });
            if (this.socket?.connected) {
              this.connectionUpdate();
              this.postMessage({ type: "EVENT", data: { event: "connect", args: [] }});
            }
            this.handlePrimaryCheck();
          }
          break;
        case "EVENT":
          if (this.listeners[data.event]) {
            this.listeners[data.event].forEach(callback => callback(...data.args));
          }
          break;
        case "EMIT":
          if (this.isPrimary && this.socket) {
            let target: Socket = this.socket;
            if (data.timeout != null) {
              target = target.timeout(data.timeout) as unknown as Socket;
            }
            if (data.volatile) {
              target = target.volatile as unknown as Socket;
            }
            target.emit(data.event, ...data.args);
          }
          break;
        case "EMIT_WITH_ACK":
          if (this.isPrimary && this.socket) {
            (async () => {
              try {
                const response = await this.socket!.emitWithAck(data.event, ...data.args);
                this.postMessage({
                  type: "EMIT_WITH_ACK_RESPONSE",
                  data: { id: data.id, response }
                });
              } catch (err) {
                this.postMessage({
                  type: "EMIT_WITH_ACK_RESPONSE",
                  data: { id: data.id, response: undefined, error: String(err) }
                });
              }
            })();
          }
          break;
        case "CONNECTION_STATUS":
          this.isConnected = data.connected;
          break;
        case "DISCONNECT":
          if (this.isPrimary && this.socket) {
            this.socket.disconnect();
          }
          break;
        case "CONNECT":
          if (this.isPrimary && this.socket) {
            this.socket.connect();
          }
          break;
        case "MESSAGE_TO_PRIMARY":
          if (this.isPrimary) {
            this.publishMessage(data.eventName, data.message);
          }
          break;
        case "GET_SOCKET_ID":
          if (this.isPrimary && this.socket) {
            this.postMessage({
              type: "SOCKET_ID_RESPONSE",
              data: { id: this.socket.id }
            });
          }
          break;
        case "SOCKET_ID_UPDATE":
          this.socketId = data.id;
          break;
        case "ACTIVE_STATUS_UPDATE":
          this.socketActive = data.active;
          break;
        case "HEARTBEAT":
          if (!this.isPrimary) {
            this.lastHeartbeat = Date.now();
          }
          break;
        case "PRIMARY_CLAIM":
          if (this.isPrimary && data.tabId !== this.tabId) {
            // Another tab also claims primary — resolve by tabId comparison
            if (data.tabId > this.tabId) {
              // Other tab wins, we demote
              this.log("Duplicate primary detected, yielding to", data.tabId);
              this.demotePrimary();
            } else {
              // We win, tell other tab to yield
              this.postMessage({ type: "PRIMARY_YIELD" });
            }
          }
          break;
        case "PRIMARY_YIELD":
          if (this.isPrimary) {
            this.log("Received PRIMARY_YIELD, demoting");
            this.demotePrimary();
          }
          break;
      }
    };
  }

  public initialize = async (): Promise<void> => {
    await this.checkPrimary();
    this.installMessageHandler();
  }

  private checkPrimary = (): Promise<void> => {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.becomePrimary();
        resolve();
      }, 2000);

      this.channel.onmessage = (event: MessageEvent) => {
        const validation = this.validateMessage(event.data);
        if (!validation.valid) {
          return;
        }

        if (validation.type === "PRIMARY_ALIVE") {
          clearTimeout(timeout);
          this.isPrimary = false;
          // Adopt the primary's token for future message validation
          if (validation.token) {
            this.token = validation.token;
          }
          this.startHeartbeatMonitor();
          resolve();
        }
      };

      this.postMessage({ type: "PRIMARY_CHECK" });
    });
  }

  private connectionUpdate = (): void => {
    this.isConnected = !!this.socket?.connected;
    this.socketId = this.socket?.id;
    this.socketActive = !!this.socket?.active;
    this.postMessage({
      type: "CONNECTION_STATUS",
      data: { connected: this.socket?.connected }
    });
    this.postMessage({
      type: "SOCKET_ID_UPDATE",
      data: { id: this.socket?.id }
    });
    this.postMessage({
      type: "ACTIVE_STATUS_UPDATE",
      data: { active: this.socket?.active }
    });
  }

  private dispatchToLocalListeners = (event: string, ...args: any[]): void => {
    if (this.listeners[event]) {
      this.listeners[event].forEach(callback => callback(...args));
    }
  }

  private handleBeforeUnload = (): void => {
    if (this.isPrimary) {
      this.stopHeartbeat();
      this.postMessage({ type: "PRIMARY_YIELD" });
    }
  }

  private becomePrimary = (): void => {
    this.isPrimary = true;
    this.socket = io(this.url, this.options);
    
    this.socket.onAny((event: string, ...args: any[]) => {
      this.postMessage({
        type: "EVENT",
        data: { event, args }
      });
      this.dispatchToLocalListeners(event, ...args);
    });

    this.socket.on("connect", () => {
      this.connectionUpdate();
      this.postMessage({ type: "EVENT", data: { event: "connect", args: [] } });
      this.dispatchToLocalListeners("connect");
    });

    this.socket.on("disconnect", (reason: string) => {
      this.connectionUpdate();
      this.postMessage({ type: "EVENT", data: { event: "disconnect", args: [reason] } });
      this.dispatchToLocalListeners("disconnect", reason);
    });

    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", this.handleBeforeUnload);
    }

    this.startHeartbeat();
    this.stopHeartbeatMonitor();
    this.postMessage({ type: "PRIMARY_CLAIM", data: { tabId: this.tabId } });
    this.log("Became primary, tabId:", this.tabId);
  }

  private demotePrimary = (): void => {
    this.log("Demoting from primary");
    this.stopHeartbeat();
    if (typeof window !== "undefined") {
      window.removeEventListener("beforeunload", this.handleBeforeUnload);
    }
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.isPrimary = false;
    this.startHeartbeatMonitor();
  }

  private startHeartbeat = (): void => {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.postMessage({ type: "HEARTBEAT" });
    }, this.heartbeatInterval);
  }

  private stopHeartbeat = (): void => {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startHeartbeatMonitor = (): void => {
    this.stopHeartbeatMonitor();
    this.lastHeartbeat = Date.now();
    this.heartbeatMonitorTimer = setInterval(() => {
      if (Date.now() - this.lastHeartbeat > this.heartbeatTimeout) {
        this.log("Primary heartbeat lost, initiating re-election");
        this.stopHeartbeatMonitor();
        this.checkPrimary().then(() => {
          this.installMessageHandler();
        });
      }
    }, this.heartbeatInterval);
  }

  private stopHeartbeatMonitor = (): void => {
    if (this.heartbeatMonitorTimer) {
      clearInterval(this.heartbeatMonitorTimer);
      this.heartbeatMonitorTimer = null;
    }
  }

  private socketId: string | undefined;
  private socketActive: boolean = false;

  public on = (event: string, callback: (...args: any[]) => void): void => {
    if (this.isPrimary && this.socket) {
      this.socket.on(event, callback);
    }
    else {
      if (!this.listeners[event]) {
        this.listeners[event] = [];
      }
      this.listeners[event].push(callback);
    }
  }

  public once = (event: string, callback: (...args: any[]) => void): void => {
    if (this.isPrimary && this.socket) {
      this.socket.once(event, callback);
    } 
    else {
      const wrappedCallback = (...args: any[]) => {
        this.off(event, wrappedCallback);
        callback(...args);
      };
      this.on(event, wrappedCallback);
    }
  }

  public off = (event: string, callback?: (...args: any[]) => void): void => {
    if (this.isPrimary && this.socket) {
      this.socket.off(event, callback);
    }
    else if (this.listeners[event] && callback) {
      this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    }
    else if (!callback) {
      delete this.listeners[event];
    }
  }

  public emit = (event: string, ...args: any[]): void => {
    if (this.isPrimary && this.socket) {
      let target: Socket = this.socket;
      if (this._timeout !== null) {
        target = target.timeout(this._timeout) as unknown as Socket;
        this._timeout = null;
      }
      if (this._useVolatile) {
        target = target.volatile as unknown as Socket;
        this._useVolatile = false;
      }
      target.emit(event, ...args);
    }
    else {
      this.postMessage({
        type: "EMIT",
        data: {
          event,
          args,
          volatile: this._useVolatile || undefined,
          timeout: this._timeout ?? undefined,
        }
      });
      this._useVolatile = false;
      this._timeout = null;
    }
  }

  public emitWithAck = (event: string, ...args: any[]): Promise<any> => {
    if (this.isPrimary && this.socket) {
      return this.socket.emitWithAck(event, ...args);
    }
    
    return new Promise((resolve, reject) => {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
      const timer = setTimeout(() => {
        this.channel.removeEventListener("message", handler);
        reject(new Error("emitWithAck timed out waiting for primary response"));
      }, this.ackTimeout);
      const handler = (e: MessageEvent) => {
        const validation = this.validateMessage(e.data);
        if (!validation.valid) {
          return;
        }

        if (validation.type === "EMIT_WITH_ACK_RESPONSE" && validation.data.id === id) {
          clearTimeout(timer);
          resolve(validation.data.response);
          this.channel.removeEventListener("message", handler);
        }
      };
      this.channel.addEventListener("message", handler);
      this.postMessage({
        type: "EMIT_WITH_ACK",
        data: { event, args, id }
      });
    });
  }

  public onPrimaryCheck = (callback: (...args: any[]) => void) => {
    this.handlePrimaryCheck = callback;
  };

  public get connected(): boolean {
    return this.isConnected;
  }

  public get disconnected(): boolean {
    return !this.isConnected;
  }

  public get io(): any {
    return this.isPrimary ? this.socket?.io : null;
  }

  public get active(): boolean {
    return this.isPrimary ? !!this.socket?.active : this.socketActive;
  }

  public get id(): string | undefined {
    if (this.isPrimary && this.socket) {
      return this.socket.id;
    }
    return this.socketId;
  }

  public disconnect = (): void => {
    if (this.isPrimary && this.socket) {
      this.socket.disconnect();
    }
    else {
      this.postMessage({
        type: "DISCONNECT"
      });
    }
  }

  public connect = (): void => {
    if (this.isPrimary && this.socket) {
      this.socket.connect();
    }
    else {
      this.postMessage({
        type: "CONNECT"
      });
    }
  }

  public volatile = (): this => {
    this._useVolatile = true;
    return this;
  }

  public timeout = (timeout: number): this => {
    this._timeout = timeout;
    return this;
  }

  public sendMessageToPrimary = (message: any): void => {
    this.postMessage({
      type: "MESSAGE_TO_PRIMARY",
      data: message
    });
  }

  private messageSubscribers: Map<string, Set<(message: any) => void>> = new Map()

  public onProxyMessage = (eventName: string, subscriber: (message: any) => void) => {
    if (!this.messageSubscribers.has(eventName)) {
      this.messageSubscribers.set(eventName, new Set())
    }
    this.messageSubscribers.get(eventName)?.add(subscriber)
    return () => {
      this.messageSubscribers.get(eventName)?.delete(subscriber)
      if (this.messageSubscribers.get(eventName)?.size === 0) {
        this.messageSubscribers.delete(eventName)
      }
    }
  };

  private publishMessage = (eventName: string, message: any) => {
    this.messageSubscribers.get(eventName)?.forEach(subscriber => subscriber(message))
  };
  
  public closeChannel = (): void => {
    this.stopHeartbeat();
    this.stopHeartbeatMonitor();
    if (typeof window !== "undefined") {
      window.removeEventListener("beforeunload", this.handleBeforeUnload);
    }
    if (this.isPrimary && this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.channel.close();
  };

  public directChannelEmit = (event: string, ...args: any[]) => {
    this.postMessage({
      type: "EVENT",
      data: { event, args }
    });
  };
}