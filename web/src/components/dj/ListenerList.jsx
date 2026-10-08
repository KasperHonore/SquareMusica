import { UserAvatar } from '../UserAvatar';

/**
 * ListenerList - who is in the bot's voice channel right now (R7). Fed by
 * `initial:state` and every `voice:context`, so joins and leaves show without
 * a refresh. These are the only people the DJ can name.
 */
export function ListenerList({ listeners }) {
  if (!listeners || listeners.length === 0) {
    return (
      <p style={{ color: 'var(--color-text-muted)', fontSize: '13px', padding: '10px 0' }}>
        Nobody is listening right now.
      </p>
    );
  }

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Listeners">
      {listeners.map((member) => {
        const name = member.displayName || member.username;
        return (
          <li
            key={member.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '8px 0',
              borderBottom: '1px solid var(--color-border)'
            }}
          >
            <UserAvatar userId={member.id} avatarHash={member.avatar} username={name} size={20} />
            <span style={{ fontSize: '13px', color: 'var(--color-text-primary)' }}>{name}</span>
          </li>
        );
      })}
    </ul>
  );
}
