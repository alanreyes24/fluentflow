/**
 * Stand-in for `onnxruntime-react-native` when it is not installed.
 *
 * Making the real package optional is harder than it looks. A dynamic
 * `await import(name)` is rejected outright by Hermes ("Invalid expression
 * encountered"), so the native bundle will not even compile. A static
 * `require` inside try/catch does not help either, because Metro resolves
 * requires at bundle time and a missing module breaks the build before any
 * code runs.
 *
 * So the substitution happens in the resolver: `metro.config.js` maps
 * `onnxruntime-react-native` to this file when the real package is absent.
 * Application code always writes a plain static require and simply checks
 * whether `InferenceSession` came back.
 *
 * Keeping the model optional matters because ONNX Runtime is a native module:
 * it needs a development build, and Expo Go cannot load it.
 */

/** Absent, which is how callers detect the stub. */
export const InferenceSession = undefined;
export const Tensor = undefined;

/** Marker for diagnostics in the settings screen. */
export const __fluentflowStub = true;

export default { InferenceSession, Tensor, __fluentflowStub };
