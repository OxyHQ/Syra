/**
 * Seed script to populate MongoDB with fake music data
 * Run with: npm run seed:music or ts-node --transpile-only src/scripts/seedMusicData.ts
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { connectToDatabase } from '../utils/database';
import { ArtistModel } from '../models/Artist';
import { AlbumModel } from '../models/Album';
import { TrackModel } from '../models/Track';
import { logger } from '../utils/logger';

dotenv.config();

// Fake data generators
const artistNames = [
  'The Weeknd', 'The Kid LAROI', 'Taylor Swift', 'Drake', 'Billie Eilish',
  'Post Malone', 'Ariana Grande', 'Ed Sheeran', 'Dua Lipa', 'The Weeknd',
  'Justin Bieber', 'Olivia Rodrigo', 'Doja Cat', 'Lil Nas X', 'The Chainsmokers',
  'Imagine Dragons', 'Coldplay', 'Maroon 5', 'Bruno Mars', 'The 1975'
];

const genres = [
  'Pop', 'R&B', 'Hip-Hop', 'Rock', 'Electronic', 'Indie', 'Country',
  'Jazz', 'Blues', 'Folk', 'Alternative', 'Dance', 'Reggae', 'Latin'
];

const albumTypes: ('album' | 'single' | 'ep' | 'compilation')[] = ['album', 'single', 'ep', 'compilation'];

const recordLabels = [
  'Universal Music', 'Sony Music', 'Warner Music', 'Republic Records',
  'Interscope Records', 'Atlantic Records', 'Columbia Records', 'RCA Records'
];

function getRandomElement<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

function getRandomElements<T>(array: T[], count: number): T[] {
  const shuffled = [...array].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDate(start: Date, end: Date): string {
  const date = new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
  return date.toISOString().split('T')[0];
}

function generateArtistName(index: number): string {
  // Use unique names to avoid duplicates
  const uniqueNames = [
    'The Weeknd', 'The Kid LAROI', 'Taylor Swift', 'Drake', 'Billie Eilish',
    'Post Malone', 'Ariana Grande', 'Ed Sheeran', 'Dua Lipa', 'Harry Styles',
    'Justin Bieber', 'Olivia Rodrigo', 'Doja Cat', 'Lil Nas X', 'The Chainsmokers',
    'Imagine Dragons', 'Coldplay', 'Maroon 5', 'Bruno Mars', 'The 1975'
  ];
  return uniqueNames[index] || `Artist ${index + 1}`;
}

function generateAlbumTitle(artistName: string, index: number): string {
  const albumTitles = [
    'Midnight Dreams', 'Electric Nights', 'Sunset Boulevard', 'City Lights',
    'Ocean Waves', 'Mountain Peaks', 'Desert Storm', 'Rainbow Colors',
    'Starlight', 'Moonbeam', 'Thunder', 'Lightning', 'Aurora', 'Nebula',
    'Galaxy', 'Cosmos', 'Eclipse', 'Solstice', 'Equinox', 'Horizon'
  ];
  return `${albumTitles[index % albumTitles.length]}`;
}

function generateTrackTitle(index: number): string {
  const trackTitles = [
    'Blinding Lights', 'Stay', 'Levitating', 'Watermelon Sugar', 'Good 4 U',
    'Industry Baby', 'Heat Waves', 'As It Was', 'About Damn Time', 'First Class',
    'Running Up That Hill', 'Unholy', 'Anti-Hero', 'Flowers', 'Calm Down',
    'Creepin', 'I\'m Good', 'Unstoppable', 'Bad Habit', 'Late Night Talking',
    'Sunroof', 'Something in the Orange', 'Big Energy', 'The Kind of Love We Make',
    'Glimpse of Us', 'Numb', 'Left and Right', 'Break My Soul', 'As It Was',
    'About Damn Time', 'Running Up That Hill', 'Heat Waves', 'First Class',
    'Wait for U', 'Me Porto Bonito', 'Tití Me Preguntó', 'Unholy', 'Anti-Hero'
  ];
  return trackTitles[index % trackTitles.length] || `Track ${index + 1}`;
}

async function seedMusicData() {
  try {
    // Connect to database
    await connectToDatabase();
    logger.info('✅ Connected to MongoDB');

    // Check if data already exists
    const existingArtists = await ArtistModel.countDocuments();
    if (existingArtists > 0) {
      logger.info(`⚠️  Found ${existingArtists} existing artists. Skipping seed.`);
      logger.info('   To reseed, clear the database first or delete existing records.');
      process.exit(0);
    }

    logger.info('🌱 Starting music data seed...');

    // Generate artists (~20)
    const artistCount = 20;
    const artists: any[] = [];
    const artistIds: string[] = [];

    logger.info(`📝 Creating ${artistCount} artists...`);
    for (let i = 0; i < artistCount; i++) {
      const artistGenres = getRandomElements(genres, randomInt(1, 3));
      const followers = randomInt(1000000, 100000000);
      const monthlyListeners = randomInt(500000, 50000000);
      
      const artist = new ArtistModel({
        name: generateArtistName(i),
        bio: `${generateArtistName(i)} is a talented musician known for their unique style blending ${artistGenres.join(' and ')}.`,
        image: `https://picsum.photos/seed/artist${i}/400/400`,
        genres: artistGenres,
        verified: Math.random() > 0.3, // 70% verified
        popularity: randomInt(50, 100),
        stats: {
          followers,
          albums: 0, // Will be updated after albums are created
          tracks: 0, // Will be updated after tracks are created
          totalPlays: randomInt(10000000, 5000000000),
          monthlyListeners,
        },
        source: 'upload',
      });

      const savedArtist = await artist.save();
      artists.push(savedArtist);
      artistIds.push(savedArtist._id.toString());
    }
    logger.info(`✅ Created ${artists.length} artists`);

    // Generate albums (~60, 2-4 per artist)
    const albums: any[] = [];
    const albumIds: string[] = [];
    let albumIndex = 0;

    logger.info(`📝 Creating albums...`);
    for (const artist of artists) {
      const albumsPerArtist = randomInt(2, 4);
      for (let j = 0; j < albumsPerArtist; j++) {
        const releaseDate = randomDate(new Date(2018, 0, 1), new Date(2024, 11, 31));
        const albumGenres = getRandomElements(genres, randomInt(1, 2));
        const albumType = j === 0 ? 'album' : getRandomElement(albumTypes);

        const album = new AlbumModel({
          title: generateAlbumTitle(artist.name, albumIndex),
          artistId: artist._id.toString(),
          artistName: artist.name,
          releaseDate,
          coverArt: `https://picsum.photos/seed/album${albumIndex}/600/600`,
          genre: albumGenres,
          totalTracks: 0, // Will be updated after tracks are created
          totalDuration: 0, // Will be updated after tracks are created
          type: albumType,
          label: getRandomElement(recordLabels),
          copyright: `© ${new Date(releaseDate).getFullYear()} ${getRandomElement(recordLabels)}`,
          popularity: randomInt(40, 95),
          isExplicit: Math.random() > 0.7, // 30% explicit
        });

        const savedAlbum = await album.save();
        albums.push(savedAlbum);
        albumIds.push(savedAlbum._id.toString());
        albumIndex++;
      }
    }
    logger.info(`✅ Created ${albums.length} albums`);

    // Generate tracks (~200, 3-5 per album)
    let trackIndex = 0;
    const tracks: any[] = [];

    logger.info(`📝 Creating tracks...`);
    for (const album of albums) {
      const artist = artists.find(a => a._id.toString() === album.artistId);
      if (!artist) continue;

      const tracksPerAlbum = randomInt(3, 5);
      for (let k = 0; k < tracksPerAlbum; k++) {
        const duration = randomInt(150, 300); // 2.5 to 5 minutes
        const trackNumber = k + 1;

        const track = new TrackModel({
          title: generateTrackTitle(trackIndex),
          artistId: album.artistId,
          artistName: artist.name,
          albumId: album._id.toString(),
          albumName: album.title,
          duration,
          trackNumber,
          discNumber: 1,
          // URL will be updated after saving to use MongoDB ID
          audioSource: {
            url: `/api/audio/temp-${trackIndex}`, // Temporary, will be updated
            format: 'mp3',
            bitrate: 320,
            duration,
          },
          coverArt: album.coverArt,
          metadata: {
            genre: album.genre,
            bpm: randomInt(100, 140),
            explicit: album.isExplicit,
          },
          isExplicit: album.isExplicit,
          popularity: randomInt(30, 90),
          playCount: randomInt(10000, 50000000),
          isAvailable: true,
          source: 'upload',
          status: 'ready',
        });

        const savedTrack = await track.save();

        // Update audioSource URL to use MongoDB ID
        if (savedTrack.audioSource) {
          savedTrack.audioSource.url = `/api/audio/${savedTrack._id}`;
          await savedTrack.save();
        }
        
        tracks.push(savedTrack);
        trackIndex++;
      }
    }
    logger.info(`✅ Created ${tracks.length} tracks`);

    // Update album totals
    logger.info(`📊 Updating album totals...`);
    for (const album of albums) {
      const albumTracks = tracks.filter(t => t.albumId === album._id.toString());
      const totalTracks = albumTracks.length;
      const totalDuration = albumTracks.reduce((sum, t) => sum + t.duration, 0);

      await AlbumModel.findByIdAndUpdate(album._id, {
        totalTracks,
        totalDuration,
      });
    }
    logger.info(`✅ Updated album totals`);

    // Update artist stats
    logger.info(`📊 Updating artist stats...`);
    for (const artist of artists) {
      const artistAlbums = albums.filter(a => a.artistId === artist._id.toString());
      const artistTracks = tracks.filter(t => t.artistId === artist._id.toString());

      await ArtistModel.findByIdAndUpdate(artist._id, {
        'stats.albums': artistAlbums.length,
        'stats.tracks': artistTracks.length,
      });
    }
    logger.info(`✅ Updated artist stats`);

    // Summary
    logger.info('\n🎉 Seed completed successfully!');
    logger.info(`   Artists: ${artists.length}`);
    logger.info(`   Albums: ${albums.length}`);
    logger.info(`   Tracks: ${tracks.length}`);

    process.exit(0);
  } catch (error: unknown) {
    logger.error('❌ Error seeding music data:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  seedMusicData()
    .then(() => {
      mongoose.connection.close();
    })
    .catch((error) => {
      logger.error('Fatal error:', error);
      mongoose.connection.close();
      process.exit(1);
    });
}

