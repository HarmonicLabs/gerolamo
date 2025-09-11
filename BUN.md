# Why We Use Bun (and Why We Can't Yet Support Node.js)

## Overview

This project uses Bun as its runtime environment instead of Node.js. While both
are JavaScript runtimes, Bun provides specific features that are critical for
this codebase, particularly around WebAssembly (WASM) module handling. Below, we
explain the key reasons for choosing Bun and the features Node.js would need to
support this code as-is.

## Why Bun?

Bun is a modern JavaScript runtime that offers several advantages over Node.js
for this project:

1. **Native WebAssembly Support**: Bun has built-in support for importing
   WebAssembly modules directly as ES modules, allowing seamless integration
   with JavaScript code without additional boilerplate.

2. **Performance**: Bun's architecture provides faster startup times and better
   performance for certain workloads, which is beneficial for blockchain-related
   operations.

3. **Developer Experience**: Bun includes a fast package manager and bundler,
   making development more efficient.

## WebAssembly Module Import

The primary reason we use Bun is its support for importing WASM modules as ES
modules. In our code, we have:

```typescript
import * as wasm from "wasm-kes";
```

This import statement directly loads a WebAssembly module (`wasm-kes`) as if it
were a regular JavaScript module. This allows us to use WASM functions like
`wasm.verify()` directly in our code without any additional setup.

## What Node.js Needs

To support this code as-is, Node.js would need the following features:

### 1. Native ES Module Import for .wasm Files

Node.js currently does not support importing .wasm files directly as ES modules.
Instead, developers must:

1. Load the .wasm file using `fs.readFileSync()`
2. Instantiate it using `WebAssembly.instantiate()`
3. Handle the asynchronous nature of instantiation

This would require significant code changes, such as:

```javascript
// Current Bun code:
import * as wasm from "wasm-kes";

// Would need to become something like:
import { readFileSync } from "fs";
import { instantiate } from "webassembly";

const wasmBuffer = readFileSync("path/to/wasm-kes.wasm");
const wasmModule = await WebAssembly.instantiate(wasmBuffer);
const wasm = wasmModule.instance.exports;
```

### 2. Improved WebAssembly API

While Node.js has the global `WebAssembly` object (available since v8.0.0), it
lacks the seamless ES module integration that Bun provides. The current Node.js
WebAssembly support requires manual file loading and instantiation, which breaks
the simplicity of ES module imports.

## Relevant Links

- [**Bun Runtime Documentation**](https://bun.sh/docs/runtime)
- [**Bun Web APIs**](https://bun.sh/docs/runtime/web-apis)
- [**Node.js WebAssembly**](https://nodejs.org/api/globals.html#class-webassembly)
- [**Node.js ES Modules**](https://nodejs.org/api/esm.html)

## Conclusion

Bun's native support for WebAssembly ES module imports allows our code to remain
clean and straightforward. While Node.js has WebAssembly support, it requires
additional code for module loading and instantiation, making it less suitable
for our current implementation. As Node.js continues to evolve, we may revisit
compatibility in the future if native WASM ES module support is added.
