# voidrift-web-server

VoidRift Web UI backend — the SDK host: auth, per-user authorization, session ownership, the scoped event relay, transport security, and the HTTP + WebSocket surface (web-blueprint.md).

Part of VoidRift, a local-first, model-agnostic AI agent harness. Status: work in progress. Not yet usable or released. The VoidRift CLI and core are the current focus.

## Requirements
- Node.js >=24
- `@voidrift/core` `^0.1.0`, which is not published to npm yet. Until it is, link a local checkout of the core repository (`npm link @voidrift/core`).

## Build from source
```bash
git clone https://github.com/TylerJPresley/voidrift-web-server.git
cd voidrift-web-server
npm install
npm run build
npm test
```

## License
Apache-2.0. See [LICENSE](LICENSE).
