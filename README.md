# Syra

> A modern, cross-platform music streaming app built with Expo, React Native, TypeScript, and a Node.js/Express backend in a monorepo structure.

---

## Table of Contents
- [About](#about)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Development Scripts](#development-scripts)
- [API Documentation](#api-documentation)
- [Contributing](#contributing)
- [License](#license)

---

## About

**Syra** is a modern music streaming platform inspired by Spotify, designed for mobile and web. It features music library management, playlists, artist pages, album browsing, search, and more. Built with Expo, React Native, and a Node.js backend in a modern monorepo structure, it supports file-based routing and a beautiful Spotify-like UI.

## Project Structure

This is a **monorepo** using bun workspaces with the following structure:

```
/
├── packages/            # All code packages
│   ├── frontend/        # Expo React Native app
│   │   ├── app/         # App entry, screens, and routing
│   │   │   ├── search/      # Music search and discovery
│   │   │   ├── library/     # User's music library
│   │   │   ├── playlist/   # Playlist management
│   │   │   └── ...
│   │   ├── components/  # UI components (Player, Playlist, etc.)
│   │   ├── assets/      # Images, icons, fonts
│   │   ├── constants/   # App-wide constants
│   │   ├── context/     # React context providers
│   │   ├── features/    # Feature modules
│   │   ├── hooks/       # Custom React hooks
│   │   ├── interfaces/  # TypeScript interfaces
│   │   ├── lib/         # Library code
│   │   ├── locales/     # i18n translation files
│   │   ├── scripts/     # Utility scripts
│   │   ├── store/       # State management
│   │   ├── styles/      # Global styles and colors
│   │   └── utils/       # Utility functions
│   ├── backend/         # Node.js/Express API server
│   │   ├── src/         # Backend source code
│   │   │   ├── controllers/ # API controllers (songs, playlists, artists)
│   │   │   ├── middleware/  # Express middleware
│   │   │   ├── models/      # MongoDB models
│   │   │   ├── routes/      # API routes
│   │   │   ├── scripts/     # Utility scripts
│   │   │   ├── sockets/     # WebSocket handlers
│   │   │   ├── types/       # TypeScript types
│   │   │   └── utils/       # Utility functions
│   │   └── ...
│   └── shared-types/    # Shared TypeScript types
│       ├── src/         # Type definitions
│       └── dist/        # Compiled types
├── package.json         # Root package.json with workspaces
├── tsconfig.json        # Root TypeScript config
└── ...
```

## Getting Started

### Prerequisites
- Node.js 18+ and bun 1.3+
- MongoDB instance
- Expo CLI for mobile development

### Initial Setup
1. **Clone the repository**
   ```bash
   git clone https://github.com/OxyHQ/Syra.git
   cd Syra
   ```

2. **Install all dependencies**
   ```bash
   bun run install:all
   ```

### Development

#### Start All Services
```bash
bun run dev
```

#### Start Individual Services
```bash
# Frontend only
bun run dev:frontend

# Backend only
bun run dev:backend
```

#### Frontend Development
The frontend is an Expo React Native app that can run on:
- **Web**: `bun run web` (or `bun run dev:frontend` then press 'w')
- **iOS**: `bun run ios` (requires macOS and Xcode)
- **Android**: `bun run android` (requires Android Studio)

#### Backend Development
The backend runs on the development server with hot reload:
```bash
bun run dev:backend
```

## Development Scripts

### Root Level (Monorepo)
- `bun run dev` — Start all services in development mode
- `bun run dev:frontend` — Start frontend development server
- `bun run dev:backend` — Start backend development server
- `bun run build` — Build all packages
- `bun run build:shared-types` — Build shared types package
- `bun run build:frontend` — Build frontend for production
- `bun run build:backend` — Build backend for production
- `bun run test` — Run tests across all packages
- `bun run lint` — Lint all packages
- `bun run clean` — Clean all build artifacts
- `bun run install:all` — Install dependencies for all packages

### Frontend (`@syra/frontend`)
- `bun run start` — Start Expo development server
- `bun run android` — Run on Android device/emulator
- `bun run ios` — Run on iOS simulator
- `bun run web` — Run in web browser
- `bun run build-web` — Build static web output
- `bun run lint` — Lint codebase
- `bun run clean` — Clean build artifacts

### Backend (`@syra/backend`)
- `bun run dev` — Start development server with hot reload
- `bun run build` — Build the project
- `bun run start` — Start production server
- `bun run lint` — Lint codebase
- `bun run clean` — Clean build artifacts
- `bun run migrate` — Run database migrations
- `bun run migrate:dev` — Run database migrations in development

### Shared Types (`@syra/shared-types`)
- `bun run build` — Build TypeScript types
- `bun run dev` — Watch and rebuild types
- `bun run clean` — Clean build artifacts

## Documentation

### Project Documentation

All project documentation is available in the [`docs/`](./docs/) folder:

- [Theme Quick Reference](./docs/THEME_QUICK_REFERENCE.md) - Quick reference for developers
- [Theming Troubleshooting](./docs/THEMING_TROUBLESHOOTING.md) - Common theming issues and solutions
- [Performance Guide](./docs/PERFORMANCE_GUIDE.md) - Performance optimization guide

### API Documentation

The Syra API is a robust backend service built with Express.js and TypeScript, providing functionality for music streaming including song management, playlists, artists, albums, user library, search, and audio playback.

For detailed API information, see the [Backend README](packages/backend/README.md).

## Contributing

Contributions are welcome! Please open issues or pull requests for bug fixes, features, or improvements.

### Development Workflow
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and linting: `bun run test && bun run lint`
5. Submit a pull request

## License

This project is licensed under the MIT License.