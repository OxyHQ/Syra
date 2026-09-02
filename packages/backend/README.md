# @syra/backend

> The backend package of the Syra monorepo - A robust API service built with Express.js and TypeScript.

---

## Overview

This is the **backend package** of the **Syra** monorepo. The Syra API is a robust backend service built with Express.js and TypeScript, providing functionality for music streaming including song management, playlists, artists, albums, user library, search, audio file storage, and real-time communications.

## Tech Stack

- Node.js with TypeScript
- Express.js for REST API
- PostgreSQL with Drizzle ORM for data storage
- Socket.IO for real-time features
- JWT for authentication

## Getting Started

### Prerequisites

- Node.js 18+ and Bun
- PostgreSQL 17 (`docker compose -f ../../docker-compose.postgres.yml up -d postgres`)
- Git

### Development Setup

#### Option 1: From the Monorepo Root (Recommended)
```bash
# Clone the repository
git clone https://github.com/OxyHQ/Syra.git
cd Syra

# Install all dependencies
bun run install:all

# Start backend development
bun run dev:backend
```

#### Option 2: From This Package Directory
```bash
# Navigate to this package
cd packages/backend

# Install dependencies
bun install

# Start development server
bun run dev
```

### Environment Configuration

Create a `.env` file in this package directory with the following variables:

```env
# Database — see .env.example for the full annotated list
DATABASE_URL=postgres://syra:syra@127.0.0.1:5434/syra_dev

# Authentication
# WE USE OXY FOR AUTHENTICATION

# Server Configuration
# 4120 is Syra's slot in the per-app local dev port map (the code default too),
# so several Oxy backends can run side by side on one machine.
PORT=4120
NODE_ENV=development

# Optional operational notifications
TELEGRAM_BOT_TOKEN=your_telegram_bot_token

# S3 Configuration (for audio file storage)
# Supports AWS S3, DigitalOcean Spaces, LocalStack, MinIO, and other S3-compatible services

AWS_REGION=us-east-1  # For DigitalOcean Spaces, use the region (e.g., ams3, nyc3)
AWS_S3_BUCKET_NAME=syra-bucket

# Credential Options (supports both formats):
# Option 1: DigitalOcean Spaces (recommended when using Spaces)
SPACES_KEY=your_spaces_access_key
SPACES_SECRET=your_spaces_secret_key

# Option 2: AWS S3 or generic S3-compatible services
AWS_ACCESS_KEY_ID=your_aws_access_key_id
AWS_SECRET_ACCESS_KEY=your_aws_secret_access_key

# Endpoint Configuration
# For DigitalOcean Spaces: https://<REGION>.digitaloceanspaces.com (e.g., https://ams3.digitaloceanspaces.com)
# For LocalStack: http://localhost:4566
# For MinIO: http://localhost:9000
# For AWS S3: Leave unset (uses default AWS endpoints)
AWS_ENDPOINT_URL=https://ams3.digitaloceanspaces.com  # Optional: Custom endpoint

S3_AUDIO_PREFIX=audio
```

### Running the API

#### Development Mode
```bash
bun run dev
```

#### Production Mode
```bash
bun run build
bun run start
```

### Database Setup

The API uses PostgreSQL with Drizzle ORM. Start a local instance and point
`DATABASE_URL` at it:

```bash
docker compose -f ../../docker-compose.postgres.yml up -d postgres
```

#### Running Migrations

`--phase` and `--target-database` are both required — `src/db/migrate.ts`
documents what each phase means and why neither has a default.

```bash
# Local / CI: nothing is serving against the database, so apply everything
bun run db:migrate --phase=all --target-database=syra_dev

# Generate a migration from a schema change (never hand-write the SQL)
bun run db:generate
```

Deployed environments are staged: `--phase=pre` runs while the previous image is
still serving, `--phase=post` once the new one is live.

## API Endpoints

### Authentication

The API uses **Oxy** for user authentication and user data management. All user-related data is linked to Oxy users.

### Music Library

#### GET /api/songs
- Retrieves songs
- Query params: `limit`, `offset`, `search`
- Returns list of songs with metadata

#### GET /api/songs/:id
- Retrieves a specific song
- Returns song details including audio URL, metadata, artist, album

### Playlists

#### GET /api/playlists
- Retrieves user's playlists
- Authentication: Bearer token required
- Returns list of playlists

#### POST /api/playlists
- Creates a new playlist
- Authentication: Bearer token required
- Body: `{ name: string, description?: string, coverArt?: string, visibility?: 'public' | 'private' | 'unlisted' }`

#### GET /api/playlists/:id
- Retrieves playlist details including songs
- Returns playlist with song list

#### PUT /api/playlists/:id
- Updates playlist details
- Authentication: Bearer token required

#### DELETE /api/playlists/:id
- Deletes a playlist
- Authentication: Bearer token required

### Artists

#### GET /api/artists
- Retrieves artists
- Query params: `limit`, `offset`, `search`
- Returns list of artists

#### GET /api/artists/:id
- Retrieves artist details
- Returns artist info, albums, and songs

### Albums

#### GET /api/albums
- Retrieves albums
- Query params: `limit`, `offset`, `search`
- Returns list of albums

#### GET /api/albums/:id
- Retrieves album details
- Returns album info and track list

### Search

#### GET /api/search
- Search across songs, artists, albums, and playlists
- Query params: `q` (search query), `type` (songs|artists|albums|playlists), `limit`
- Returns search results

## Database Schema Relationships

```mermaid
erDiagram
    User ||--o{ Playlist : creates
    User ||--o{ Library : has
    Song ||--o{ PlaylistItem : "included in"
    Album ||--o{ Song : contains
    Artist ||--o{ Album : creates
    Artist ||--o{ Song : performs
    
    User {
        string id PK
        string oxyUserId FK
        datetime createdAt
    }
    
    Song {
        string id PK
        string title
        string artistId FK
        string albumId FK
        string audioUrl
        number duration
        datetime createdAt
    }
    
    Album {
        string id PK
        string title
        string artistId FK
        string coverUrl
        datetime releaseDate
    }
    
    Artist {
        string id PK
        string name
        string imageUrl
    }
    
    Playlist {
        string id PK
        string userId FK
        string name
        string description
        string visibility
        datetime createdAt
    }
```

## Development Scripts

- `bun run dev` — Start development server with hot reload
- `bun run build` — Build the project
- `bun run start` — Start production server
- `bun run lint` — Lint codebase
- `bun run clean` — Clean build artifacts
- `bun run migrate` — Run database migrations
- `bun run migrate:dev` — Run database migrations in development
- `bun run test` — Run tests (placeholder)

## Monorepo Integration

This package is part of the Syra monorepo and integrates with:

- **@syra/frontend**: React Native application
- **@syra/shared-types**: Shared TypeScript type definitions

### Shared Dependencies
- Uses `@syra/shared-types` for type safety across packages
- Integrates with `@oxyhq/services` for common functionality

## Performance Optimization

### Caching Strategy
- Implement Redis caching for:
  - Popular songs (TTL: 15 minutes)
  - Artist and album data (TTL: 1 hour)
  - User playlists (TTL: 30 minutes)
  - Search results (TTL: 5 minutes)

### Database Indexing
```javascript
// Song Collection Indexes
db.songs.createIndex({ "title": "text", "artist": "text" })
db.songs.createIndex({ "artistId": 1, "albumId": 1 })
db.songs.createIndex({ "createdAt": -1 })

// Album Collection Indexes
db.albums.createIndex({ "title": "text" })
db.albums.createIndex({ "artistId": 1, "releaseDate": -1 })

// Artist Collection Indexes
db.artists.createIndex({ "name": "text" })

// Playlist Collection Indexes
db.playlists.createIndex({ "userId": 1, "createdAt": -1 })
```

## Monitoring and Logging

### Health Check Endpoint
```
GET /health
Response: {
  "status": "healthy",
  "timestamp": "2026-08-08T00:00:00.000Z",
  "services": {
    "database": { "engine": "postgres", "state": "connected", "connected": true },
    "redis": { "connected": true }
  },
  "performance": { },
  "memory": { "used": 128, "total": 256, "rss": 320 },
  "uptime": 1000
}
```

`status` is `healthy` only when both are up, `degraded` when Redis is down, and
`unhealthy` (503) when Postgres is. `services.database.engine` is what the
cutover made worth reading: it reported Mongoose's `readyState` until the last
model was removed, and a health endpoint answering about a database the service
no longer opens reads as green forever.

### Logging
- Use Winston for structured logging
- Log levels: error, warn, info, debug
- Include request ID in all logs

## Deployment

### Docker Deployment
```bash
# Build the Docker image
docker build -t syra-api .

# Run the container
docker run -p 4120:3000 -e DATABASE_URL=your_postgres_url syra-api
```

### Cloud Deployment (AWS ECS)

See `AGENTS.md` for AWS ECS deployment with Fargate. The workflow at `.github/workflows/deploy-aws.yml` builds a `linux/arm64` Docker image, pushes to ECR, and deploys to ECS.

## Audio File Storage

Audio files are stored in S3-compatible storage (AWS S3, DigitalOcean Spaces, LocalStack, MinIO, etc.). The API handles:
- Uploading audio files to S3
- Generating presigned URLs for secure audio streaming
- Managing audio file metadata

### S3 Configuration

The configuration supports multiple S3-compatible services with automatic detection:

#### Environment Variables

Set these env vars in `packages/backend/.env`:

**Required:**
- `AWS_REGION` - Region for your S3 service (e.g., `us-east-1` for AWS, `ams3` for DigitalOcean Spaces)
- `AWS_S3_BUCKET_NAME` - Your bucket name

**Credentials (choose one format):**
- **DigitalOcean Spaces**: `SPACES_KEY` and `SPACES_SECRET`
- **AWS S3 / Generic**: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`

**Optional:**
- `AWS_ENDPOINT_URL` - Custom endpoint URL (required for DigitalOcean Spaces, LocalStack, MinIO, etc.)
- `S3_AUDIO_PREFIX` - Prefix for audio files in bucket (default: `audio`)

#### Auto-Detection Features

- **DigitalOcean Spaces**: Automatically detected by endpoint URL (`*.digitaloceanspaces.com`). Uses virtual-hosted-style addressing.
- **LocalStack/MinIO**: Automatically configured with path-style addressing for compatibility.
- **AWS S3**: Uses default AWS endpoints when no custom endpoint is provided.

Example configurations:

```env
# DigitalOcean Spaces
AWS_REGION=ams3
AWS_S3_BUCKET_NAME=syra-bucket
SPACES_KEY=your_spaces_key
SPACES_SECRET=your_spaces_secret
AWS_ENDPOINT_URL=https://ams3.digitaloceanspaces.com

# AWS S3
AWS_REGION=us-east-1
AWS_S3_BUCKET_NAME=syra-audio
AWS_ACCESS_KEY_ID=your_aws_key
AWS_SECRET_ACCESS_KEY=your_aws_secret

# LocalStack (for local development)
AWS_REGION=us-east-1
AWS_S3_BUCKET_NAME=syra-bucket
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
AWS_ENDPOINT_URL=http://localhost:4566
```

## Troubleshooting Guide

### Common Issues

1. Connection Timeouts
```
Error: CONNECT_TIMEOUT / ECONNREFUSED from postgres
Solution: Check DATABASE_URL and network connectivity. In production the
process refuses to boot when DATABASE_URL is unset or is not a postgres:// URL.
```

2. Authentication Failures
```
Error: JsonWebTokenError
Solution: Verify token expiration and secret keys
```

3. Rate Limit Exceeded
```
Error: 429 Too Many Requests
Solution: Implement exponential backoff in client
```

## Contributing

Contributions are welcome! Please see the [main README](../../README.md) for the complete contributing guidelines.

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and linting: `bun run test && bun run lint`
5. Submit a pull request

## License

This project is licensed under the AGPL License.
