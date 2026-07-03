// Types
export type {
  Room,
  RoomParticipant,
  Recording,
  House,
  HouseMember,
  Series,
  SeriesEpisode,
  Recurrence,
  RoomTemplate,
  RoomAttachment,
  RoomAttachmentData,
  ParticipantsUpdateData,
  MuteUpdateData,
  SpeakerRequestData,
  RecordingStateData,
  StreamInfo,
  UserEntity,
  LiveTheme,
  HttpRequestConfig,
  HttpClient,
  FileDownloadService,
} from './types';

// Validation
export {
  ZRoom,
  ZRoomParticipant,
  ZHouse,
  ZHouseMember,
  ZSeries,
  ZRecurrence,
  ZRoomTemplate,
  ZSeriesEpisode,
  ZRoomAttachment,
  ZStartStreamResponse,
  ZGenerateStreamKeyResponse,
  ZStreamInfo,
  ZRecording,
  validateRoom,
  validateRooms,
  validateHouse,
  validateSeries,
  validateRecording,
  validateRecordings,
} from './validation';

// Context
export {
  LiveConfigProvider,
  useLiveConfig,
  type LiveConfig,
  type LiveConfigInternal,
} from './context/LiveConfigContext';
export { LiveRoomProvider, useLiveRoom } from './context/LiveRoomContext';

// Services
export {
  createRoomsService,
  type RoomsServiceInstance,
  type CreateRoomData,
  type PodcastResult,
  type EpisodeListItem,
} from './services/spacesService';
export { RoomSocketService } from './services/spaceSocketService';
export {
  createGetRoomToken,
  type GetRoomTokenFn,
} from './services/livekitService';

// Hooks
export { useRoomConnection } from './hooks/useRoomConnection';
export { useRoomAudio } from './hooks/useRoomAudio';
export { useRoomUsers, getDisplayName, getAvatarUrl } from './hooks/useRoomUsers';
export { useRoomManager } from './hooks/useRoomManager';
export { useActiveSpeakers } from './hooks/useActiveSpeakers';

// Components
export { RoomCard } from './components/RoomCard';
export { LiveRoomSheet } from './components/LiveRoomSheet';
export { MiniRoomBar, MINI_BAR_HEIGHT } from './components/MiniRoomBar';
export { StreamConfigModal } from './components/StreamConfigModal';
export { StreamConfigPanel } from './components/StreamConfigPanel';
export { InsightsPanel } from './components/InsightsPanel';
export { CreateRoomSheet, type CreateRoomSheetRef, type CreateRoomFormState } from './components/CreateRoomSheet';
export { RecordingsPanel } from './components/RecordingsPanel';
export { RecordingCard } from './components/RecordingCard';

// Assets
export { LiveRoomsIcon, LiveRoomsIconActive } from './assets/icons/spaces-icon';
