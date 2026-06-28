/**
 * User avatar component with fallback to first letter
 * Shared component used by QueueItem and HistoryItem
 */
export function UserAvatar({ userId, avatarHash, username, size = 16 }) {
  if (avatarHash && userId) {
    const avatarUrl = `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png?size=${size * 2}`;
    return (
      <img
        src={avatarUrl}
        alt={username}
        className="rounded-full"
        style={{ width: size, height: size }}
        onError={(e) => {
          e.target.style.display = 'none';
          e.target.nextSibling.style.display = 'flex';
        }}
      />
    );
  }

  // Fallback to first letter
  const letter = username ? username.charAt(0).toUpperCase() : '?';
  return (
    <div
      className="rounded-full bg-accent-muted text-accent flex items-center justify-center text-xs font-medium"
      style={{ width: size, height: size }}
    >
      {letter}
    </div>
  );
}
