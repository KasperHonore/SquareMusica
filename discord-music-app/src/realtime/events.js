/**
 * Socket.io event type constants for real-time communication
 */

// Events sent from server to clients
export const ServerEvents = {
  QUEUE_UPDATE: 'queue:update',
  TRACK_CHANGE: 'track:change',
  PLAYER_STATE: 'player:state',
  TRACK_PROGRESS: 'track:progress',
  INITIAL_STATE: 'initial:state',
  RESOLUTION_PROGRESS: 'resolution:progress',
  VOICE_CONTEXT: 'voice:context'
};

// Events sent from clients to server
export const ClientEvents = {
  QUEUE_ADD: 'queue:add',
  QUEUE_REMOVE: 'queue:remove',
  QUEUE_REORDER: 'queue:reorder',
  PLAYER_CONTROL: 'player:control'
};
