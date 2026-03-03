const INACTIVITY_TIMEOUT = 2 * 60 * 1000; // 2 minutes
const timers = new Map();

export function startInactivityTimer(guildId, onTimeout) {
  cancelInactivityTimer(guildId);
  console.log(`[Inactivity] Starting 2-minute timer for guild ${guildId}`);
  const timerId = setTimeout(() => {
    timers.delete(guildId);
    console.log(`[Inactivity] Auto-leaving empty channel in guild ${guildId}`);
    onTimeout();
  }, INACTIVITY_TIMEOUT);
  timers.set(guildId, timerId);
}

export function cancelInactivityTimer(guildId) {
  const timerId = timers.get(guildId);
  if (timerId) {
    clearTimeout(timerId);
    timers.delete(guildId);
    console.log(`[Inactivity] Timer cancelled - user rejoined in guild ${guildId}`);
  }
}
