# Bundled model

This directory holds the on-device language model. It is empty in version
control on purpose: a quantised TinyLlama is around 600 MB and an fp32 export
is over 4 GB, which does not belong in a git history.

Populate it with:

```
npm run prepare-model            # TinyLlama 1.1B, int8  (~620 MB)
npm run prepare-model -- --model phi2   # Phi-2 2.7B, int8 (~1.6 GB)
```

That produces three files, all of which the app needs:

| File             | Used for                                                   |
| ---------------- | ---------------------------------------------------------- |
| `model.onnx`     | the graph ONNX Runtime executes                            |
| `tokenizer.json` | vocabulary and BPE merges, read by `BpeTokenizer` in core   |
| `config.json`    | layer and head counts, which size the KV cache             |

A large export also writes `*.onnx_data` sidecar files. They must sit next to
`model.onnx` under their original names — the graph refers to them by name.

## The app works without this

`src/ai/assets.ts` treats a missing model as a normal state, not an error.
Examples then come from `fallbackExamples` in core: grammatical carrier
sentences that quote the word rather than inflecting it. The study screen labels
them "Offline examples" and Settings says the model is not installed, so nobody
mistakes a template for generated output.

## Requirements beyond the weights

- `onnxruntime-react-native` must be installed in `apps/mobile`. It is optional
  and dynamically imported precisely so the app builds without it.
- It is a native module, so it needs a development build (`npx expo prebuild`
  then `expo run:ios` / `run:android`). Expo Go cannot load it.
- The desktop (Electron) and web builds have no native ONNX Runtime and always
  use the fallback.
