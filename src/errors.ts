/** Errors the public API raises, built in one place so every call site words them alike. */

export function closedError(action: string): Error {
  return new Error(`Cannot ${action} after closeChannel() has been called`);
}

export function reservedEventError(event: string): Error {
  return new Error(`"${event}" is a reserved event name`);
}
