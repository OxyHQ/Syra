import { PlaybackContext, Queue, RepeatMode, Track } from '@syra/shared-types';
import { queueService } from '../services/queueService';
import { useQueueStore } from './queueStore';

jest.mock('../services/queueService', () => ({
  queueService: {
    addToQueue: jest.fn(),
    replaceQueue: jest.fn(),
    setCurrentIndex: jest.fn(),
  },
}));

const mockedQueueService = queueService as jest.Mocked<typeof queueService>;

const baseTrack: Track = {
  id: '6a34c2c5d1646e517424358f',
  title: 'Track One',
  artistId: '6a34c2c5d1646e5174243590',
  artistName: 'Artist One',
  duration: 180,
  isExplicit: false,
  isAvailable: true,
  source: 'upload',
  status: 'ready',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function track(id: string): Track {
  return {
    ...baseTrack,
    id,
    title: `Track ${id}`,
  };
}

function resetQueueStore(queue: Queue | null = null): void {
  useQueueStore.setState({
    queue,
    shuffle: 'off',
    repeat: RepeatMode.OFF,
    isLoading: false,
    error: null,
  });
}

describe('queueStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetQueueStore();
  });

  it('optimistically replaces the local queue and persists the ordered context', async () => {
    const context: PlaybackContext = {
      type: 'album',
      id: '6a34c2c5d1646e5174243591',
      name: 'Album One',
    };
    const queue: Queue = {
      current: 1,
      tracks: [
        track('6a34c2c5d1646e517424358f'),
        track('6a34c2c5d1646e5174243592'),
      ],
      context,
    };
    mockedQueueService.replaceQueue.mockResolvedValueOnce({ queue });

    const replacePromise = useQueueStore.getState().replaceQueue(queue);

    expect(useQueueStore.getState().queue).toEqual(queue);

    await replacePromise;

    expect(mockedQueueService.replaceQueue).toHaveBeenCalledWith(queue);
    expect(useQueueStore.getState().queue).toEqual(queue);
  });

  it('does not call the backend when the requested current index is already active', async () => {
    resetQueueStore({
      current: 0,
      tracks: [track('6a34c2c5d1646e517424358f')],
    });

    await useQueueStore.getState().setCurrentIndex(0);

    expect(mockedQueueService.setCurrentIndex).not.toHaveBeenCalled();
  });

  it.each(['Queue not found', 'Index out of bounds'] as const)(
    'repairs recoverable backend current-index drift: %s',
    async (message) => {
      const firstTrack = track('6a34c2c5d1646e517424358f');
      const secondTrack = track('6a34c2c5d1646e5174243592');
      const initialQueue: Queue = {
        current: 0,
        tracks: [firstTrack, secondTrack],
      };
      const repairedQueue: Queue = {
        ...initialQueue,
        current: 1,
      };
      resetQueueStore(initialQueue);
      mockedQueueService.setCurrentIndex.mockRejectedValueOnce({
        response: {
          status: 400,
          data: { error: message },
        },
      });
      mockedQueueService.replaceQueue.mockResolvedValueOnce({ queue: repairedQueue });
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        await useQueueStore.getState().setCurrentIndex(1);

        expect(mockedQueueService.setCurrentIndex).toHaveBeenCalledWith(1);
        expect(mockedQueueService.replaceQueue).toHaveBeenCalledWith(repairedQueue);
        expect(useQueueStore.getState().queue).toEqual(repairedQueue);
        expect(useQueueStore.getState().error).toBeNull();
        expect(consoleError).not.toHaveBeenCalled();
      } finally {
        consoleError.mockRestore();
      }
    },
  );

  it('keeps real current-index failures visible', async () => {
    const firstTrack = track('6a34c2c5d1646e517424358f');
    const secondTrack = track('6a34c2c5d1646e5174243592');
    const initialQueue: Queue = {
      current: 0,
      tracks: [firstTrack, secondTrack],
    };
    const error = new Error('Network unavailable');
    resetQueueStore(initialQueue);
    mockedQueueService.setCurrentIndex.mockRejectedValueOnce(error);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await useQueueStore.getState().setCurrentIndex(1);

      expect(mockedQueueService.setCurrentIndex).toHaveBeenCalledWith(1);
      expect(mockedQueueService.replaceQueue).not.toHaveBeenCalled();
      expect(useQueueStore.getState().queue).toEqual({ ...initialQueue, current: 1 });
      expect(useQueueStore.getState().error).toBe('Network unavailable');
      expect(consoleError).toHaveBeenCalledWith('[QueueStore] Error setting current index:', error);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('optimistically inserts tracks and persists the queue append', async () => {
    const firstTrack = track('6a34c2c5d1646e517424358f');
    const secondTrack = track('6a34c2c5d1646e5174243592');
    const initialQueue: Queue = {
      current: 0,
      tracks: [firstTrack],
    };
    const persistedQueue: Queue = {
      current: 0,
      tracks: [firstTrack, secondTrack],
    };
    resetQueueStore(initialQueue);
    mockedQueueService.addToQueue.mockResolvedValueOnce({ queue: persistedQueue, added: 1 });

    const addPromise = useQueueStore.getState().addTracksLocally([secondTrack], 'last');

    expect(useQueueStore.getState().queue).toEqual(persistedQueue);

    await addPromise;

    expect(mockedQueueService.addToQueue).toHaveBeenCalledWith([secondTrack.id], 'last');
    expect(useQueueStore.getState().queue).toEqual(persistedQueue);
  });
});
