# @syra/shared-types

Shared TypeScript types for the Syra music streaming platform. This package contains all the interfaces, enums, and types that are shared between the frontend and backend applications to ensure type consistency.

## Overview

Syra is a modern music streaming platform inspired by Spotify, where users can discover, stream, and organize music. This package provides comprehensive type definitions for all core music streaming functionality including songs, playlists, artists, albums, and user libraries.

## Architecture

The platform uses **Oxy** for user authentication and user data management. All user-related data is linked to Oxy users via `oxyUserId` fields.

## Package Structure

```
src/
├── common.ts          # Common utility types and enums
├── song.ts           # Song and track types
├── playlist.ts       # Playlist types
├── artist.ts         # Artist types
├── album.ts          # Album types
├── library.ts        # User library types
├── search.ts         # Search and discovery types
├── playback.ts       # Audio playback types
├── media.ts          # Media content types
└── index.ts          # Main export file
```

## Core Types

### Song Types (`song.ts`)

- **Song**: Main song interface with metadata
- **SongMetadata**: Title, artist, album, duration, genre
- **AudioSource**: Audio file URL, format, bitrate
- **SongStatus**: Available, Processing, Unavailable

### Playlist Types (`playlist.ts`)

- **Playlist**: Main playlist interface
- **PlaylistType**: User Created, System Generated, Collaborative
- **PlaylistVisibility**: Public, Private, Unlisted
- **PlaylistItem**: Song reference with position and added date
- **PlaylistMetadata**: Name, description, cover image, track count

### Artist Types (`artist.ts`)

- **Artist**: Main artist interface
- **ArtistMetadata**: Name, bio, image, genres
- **ArtistStats**: Follower count, play count, album count

### Album Types (`album.ts`)

- **Album**: Main album interface
- **AlbumMetadata**: Title, artist, release date, cover art
- **AlbumType**: Album, EP, Single, Compilation
- **TrackListing**: Ordered list of songs

### Library Types (`library.ts`)

- **UserLibrary**: User's music library
- **LibraryItem**: Songs, albums, artists saved by user
- **LibrarySection**: Recently Played, Liked Songs, etc.
- **LibraryStats**: Total songs, albums, playlists count

### Search Types (`search.ts`)

- **SearchQuery**: Search parameters
- **SearchResult**: Unified search results
- **SearchType**: Songs, Artists, Albums, Playlists
- **SearchFilters**: Genre, year, duration filters

### Playback Types (`playback.ts`)

- **PlaybackState**: Playing, Paused, Stopped, Loading
- **PlaybackQueue**: Current queue of songs
- **PlaybackHistory**: Recently played songs
- **PlaybackControls**: Play, pause, skip, shuffle, repeat

### Media Types (`media.ts`)

- **Media**: Generic media interface
- **MediaType**: Audio, Image, Video
- **AudioMedia**: Audio-specific metadata (format, bitrate, duration)
- **ImageMedia**: Image metadata (cover art, artist images)

## Key Features

### Oxy Integration
All user-related data is linked to Oxy users via `oxyUserId` fields:
- User libraries are linked to Oxy users
- Playlists are created by Oxy users
- Playback history is tracked per Oxy user

### Comprehensive Music Features
- **Songs**: Complete song metadata and audio sources
- **Playlists**: User-created and system playlists
- **Artists**: Artist profiles with discography
- **Albums**: Album information with track listings
- **Library**: User's personal music library
- **Search**: Powerful search across all music content
- **Playback**: Audio playback state and queue management

### Production Ready
- **Type Safety**: Full TypeScript support with strict typing
- **Extensible**: Easy to extend with new features
- **Consistent**: Shared between frontend and backend
- **Documented**: Comprehensive JSDoc comments
- **Maintained**: Regular updates and improvements

## Usage

### Installation

```bash
npm install @syra/shared-types
```

### Import Types

```typescript
import { 
  Song, 
  Playlist, 
  Artist, 
  Album,
  PlaybackState,
  SearchResult 
} from '@syra/shared-types';
```

### Example Usage

```typescript
// Create a new playlist
const newPlaylist: CreatePlaylistRequest = {
  name: "My Favorite Songs",
  description: "A collection of my favorite tracks",
  isPublic: true
};

// Song with metadata
const song: Song = {
  id: "song123",
  title: "Example Song",
  artist: {
    id: "artist456",
    name: "Example Artist"
  },
  album: {
    id: "album789",
    title: "Example Album",
    coverUrl: "https://example.com/cover.jpg"
  },
  duration: 240, // seconds
  audioUrl: "https://example.com/audio.mp3",
  // ... other fields
};

// Playback state
const playbackState: PlaybackState = {
  currentSong: song,
  isPlaying: true,
  position: 120, // seconds
  queue: [song, /* ... more songs */]
};
```

## Development

### Building

```bash
npm run build
```

### Development Mode

```bash
npm run dev
```

### Linting

```bash
npm run lint
```

## Contributing

When adding new types:

1. Follow the existing naming conventions
2. Use `oxyUserId` for user references
3. Add comprehensive JSDoc comments
4. Update this README if adding new major features
5. Ensure all types are exported from `index.ts`

## License

UNLICENSED - Private package for Syra platform 