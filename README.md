# PonsWarp Desktop

**File Transfer at Warp Speed. Zero Limits.**

PonsWarp is a high-performance desktop application for transferring files of any size directly between devices. Powered by Tauri, Rust, and WebRTC, it bypasses server limits to offer secure, unlimited, and blazing-fast peer-to-peer transfers.

## 🚀 Key Features

- **Unlimited File Size**: Transfer 100GB+ files without memory crashes. Direct disk-to-disk streaming.
- **Hyper-Fast P2P**: Utilizes WebRTC for direct connections. Gigabit speeds on LAN.
- **End-to-End Encryption**: AES-256-GCM encryption powered by Rust (WASM) ensures your data remains private.
- **Cross-Platform**: Built with Tauri for a lightweight, native experience on Windows, macOS, and Linux.
- **No Cloud Storage**: Files go directly from sender to receiver. No intermediate servers.

## 🛠️ Tech Stack

- **Frontend**: React 19, TypeScript, Vite
- **Backend/Core**: Rust (Tauri), WebAssembly
- **Networking**: WebRTC, UDP/QUIC
- **Styling**: Tailwind CSS 4

## 📦 Getting Started

### Prerequisites

- Node.js v20+
- pnpm
- Rust (latest stable)

### Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/pons-dev/ponswarp-desktop.git
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

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

Distributed under the MIT License.
