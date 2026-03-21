# @syra/frontend

> The frontend package of the Syra monorepo - A modern, cross-platform music streaming app built with Expo, React Native, and TypeScript.

---

## Table of Contents
- [About](#about)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Development Scripts](#development-scripts)
- [Contributing](#contributing)
- [License](#license)

---

## About

This is the **frontend package** of the **Syra** monorepo. **Syra** is a modern music streaming platform inspired by Spotify, designed for mobile and web. It features music library management, playlists, artist pages, album browsing, search, audio playback, and more. Built with Expo and React Native, it supports file-based routing, multi-language support, and a beautiful Spotify-like UI.

This package contains the complete React Native application that runs on Android, iOS, and Web platforms.

## Features
- Universal app: Android, iOS, and Web
- Music library with songs, albums, artists, and playlists
- Playlist creation and management
- Artist and album pages
- Music search and discovery
- Audio playback with player controls
- User library and saved music
- Responsive design and theming
- Modern UI with custom icons and animations

## Tech Stack
- [Expo](https://expo.dev/) & React Native
- TypeScript
- NativeWind (Tailwind CSS for React Native)
- Zustand (state management)
- i18next (internationalization)
- Expo Router (file-based routing)
- Expo Audio (audio playback)
- Custom SVG icons
- Expo Notifications, Secure Store

## Project Structure
```
├── app/                # App entry, screens, and routing
│   ├── search/         # Music search and discovery
│   ├── library/        # User's music library
│   ├── playlist/       # Playlist management
│   └── ...
├── components/         # UI components (Player, Playlist, LibrarySidebar, etc.)
├── assets/             # Images, icons, fonts
├── constants/          # App-wide constants
├── context/            # React context providers
├── features/           # Feature modules
├── hooks/              # Custom React hooks
├── interfaces/         # TypeScript interfaces
├── lib/                # Library code (e.g., reactQuery)
├── locales/            # i18n translation files
├── scripts/            # Utility scripts
├── store/              # State management (Zustand)
├── styles/             # Global styles and colors
├── utils/              # Utility functions
├── app.config.js       # Expo app configuration
├── package.json        # Project metadata and dependencies
└── ...
```

## Getting Started

### Prerequisites
- Node.js 18+ and npm 8+
- Expo CLI (optional, but recommended)
- For iOS development: macOS with Xcode
- For Android development: Android Studio

### Development Setup

#### Option 1: From the Monorepo Root (Recommended)
```bash
# Clone the repository
git clone https://github.com/OxyHQ/Syra.git
cd Syra

# Install all dependencies
npm run install:all

# Start frontend development
npm run dev:frontend
```

#### Option 2: From This Package Directory
```bash
# Navigate to this package
cd packages/frontend

# Install dependencies
npm install

# Start the app
npm start
```

### Running the App

Once the development server is running, you can:

- **Web**: Press `w` in the terminal or run `npm run web`
- **iOS**: Press `i` in the terminal or run `npm run ios` (requires macOS)
- **Android**: Press `a` in the terminal or run `npm run android`
- **Expo Go**: Scan the QR code with the Expo Go app on your device

### Environment Setup

The app uses environment variables for configuration. Create a `.env` file in this package directory:

```env
# API Configuration
EXPO_PUBLIC_API_URL=http://localhost:3000
EXPO_PUBLIC_WS_URL=ws://localhost:3000

# Analytics and Monitoring
EXPO_PUBLIC_POSTHOG_KEY=your_posthog_key
EXPO_PUBLIC_BITDRIFT_KEY=your_bitdrift_key
```

## Development Scripts

- `npm start` — Start Expo development server
- `npm run dev` — Start Expo development server (alias for start)
- `npm run android` — Run on Android device/emulator
- `npm run ios` — Run on iOS simulator
- `npm run web` — Run in web browser
- `npm run build-web` — Build static web output
- `npm run build-web:prod` — Build static web output for production
- `npm run reset-project` — Reset to a fresh project state
- `npm run clear-cache` — Clear Expo cache
- `npm run lint` — Lint codebase
- `npm run test` — Run tests
- `npm run clean` — Clean build artifacts

## Monorepo Integration

This package is part of the Syra monorepo and integrates with:

- **@syra/backend**: API server for music data and authentication
- **@syra/shared-types**: Shared TypeScript type definitions

### Shared Dependencies
- Uses `@syra/shared-types` for type safety across packages
- Integrates with `@oxyhq/services` for common functionality

## Audio Playback

- Uses `expo-audio` for music playback functionality
- Supports playlists, albums, and individual tracks
- Player controls integrated throughout the app

## Contributing

Contributions are welcome! Please see the [main README](../../README.md) for the complete contributing guidelines.

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and linting: `npm run test && npm run lint`
5. Submit a pull request

## License

This project is licensed under the MIT License.
