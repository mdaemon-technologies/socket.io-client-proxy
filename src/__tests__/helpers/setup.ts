/**
 * jest's jsdom environment does not provide `structuredClone`, but the test
 * BroadcastChannel bus needs real structured-clone semantics: a payload the
 * proxy could not actually send between tabs must fail in tests too, not be
 * quietly mangled the way a JSON round-trip would.
 *
 * Node's v8.serialize/deserialize implements the same algorithm, throwing for
 * functions, DOM nodes and other uncloneable values. It is reached through a
 * local `require` declaration so the project does not need @types/node just
 * for this shim.
 */
declare const require: (id: string) => any;

if (typeof (globalThis as any).structuredClone !== "function") {
  const { serialize, deserialize } = require("v8");
  (globalThis as any).structuredClone = (value: unknown) => deserialize(serialize(value));
}

export {};
