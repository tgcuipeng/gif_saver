# base64.wasm

WebAssembly port of Base64 and Base64URL

```bash
npm i @hazae41/base64.wasm
```

[**Node Package 📦**](https://www.npmjs.com/package/@hazae41/base64.wasm)

## Features
- Reproducible building
- Pre-bundled and streamed
- Zero-copy memory slices

## Modules
- base64ct

## Algorithms
- Base64
- Base64URL

## Usage

```typescript
import { Base64Wasm, base64_encode_padded, base64_decode_padded } from "@hazae41/base64.wasm";

// Wait for WASM to load
await Base64Wasm.initBundled();

const bytes = crypto.getRandomValues(new Uint8Array(256))
using memory = new Memory(bytes)

const text = base64_encode_padded(memory)
using memory2 = base64_decode_padded(text)

console.log(memory2.bytes)
```

## Building

### Unreproducible building

You need to install [Rust](https://www.rust-lang.org/tools/install)

Then, install [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)

```bash
cargo install wasm-pack
```

Finally, do a clean install and build

```bash
npm ci && npm run build
```

### Reproducible building

You can build the exact same bytecode using Docker, just be sure you're on a `linux/amd64` host

```bash
docker compose up --build
```

Then check that all the files are the same using `npm diff`

```bash
npm diff
```

If the output is empty then the bytecode is the same as the one I commited

### Automated checks

Each time I release a new version on GitHub, the GitHub's CI clones the GitHub repository, reproduces the build, and throws an error if the NPM release is different. If a version is present on NPM but not on GitHub, do not use it!
