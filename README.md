# PonsWarp Desktop

**Warp Speed. Zero Limits. Secured & Intelligent.**

PonsWarp is a high-performance desktop application for transferring files of any size directly between devices. Powered by Tauri (v2), Rust, and QUIC, it bypasses server limits to offer secure, unlimited, and blazing-fast peer-to-peer transfers.

> **Current Status**: Beta (~82% Complete) - Security & AI Modules in active development.

## 🚀 Key Features

- **Unlimited File Size**: Transfer 100GB+ files without memory crashes using direct disk-to-disk streaming.
- **Hyper-Fast P2P**: Utilizes **QUIC (quinn)** and **WebRTC** for multiplexed high-speed connections.
- **Local Discovery**: Automatic peer discovery via mDNS/UDP broadcast on LAN.
- **Cross-Platform**: Native performance on Windows, macOS, and Linux via Tauri v2.
- **Modern UI**: Built with React 19, TypeScript, and Tailwind CSS v4.

## 🚧 Roadmap to RC1

We are currently working on Phase 1 & 2 to reach Release Candidate status:

- **Phase 1: Security Core** (In Progress)
  - [ ] Handshake Approval (prevent unsolicited transfers)
  - [ ] SHA-256 Integrity Verification
  - [ ] E2EE Encryption Enforcement

- **Phase 2: Intelligence** (Planned)
  - [ ] Local AI (Ollama) Integration for file summarization
  - [ ] Automatic content analysis upon receipt

- **Phase 3: Optimization**
  - [ ] In-memory ZIP streaming for small file clusters

## 🛠️ Tech Stack

- **Frontend**: React 19, TypeScript 5.9, Vite 7, Zustand 5, Tailwind CSS 4
- **Backend**: Rust (1.77+), Tauri 2.9
- **Networking**: QUIC (quinn 0.11), WebRTC, mDNS
- **Storage**: SQLite (rusqlite) for transfer history

## 📦 Getting Started

### Prerequisites

- Node.js v20+
- pnpm
- Rust (latest stable)

### Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/ponswarp/ponswarp-desktop.git
   cd ponswarp-desktop
   ```

2. **Install dependencies**

   ```bash
   pnpm install
   ```

3. **Run in Development Mode**

   ```bash
   pnpm tauri dev
   ```

4. **Build for Production**

   ```bash
   pnpm tauri build
   ```

## 🔄 CI/CD & Versioning

- **CI**: Automated builds and tests via GitHub Actions (`ci.yml`).
- **Release**: Automated multi-platform release builds (`release.yml`) triggered by version tags.
- **Versioning**: Managed via `scripts/release.js`, ensuring `package.json` and `tauri.conf.json` synchronization.

## 🤝 Contributing

Contributions are welcome! Please check `COMPLETION_PLAN_v2.md` for the current development roadmap.

## 📄 License

Distributed under MIT License.
