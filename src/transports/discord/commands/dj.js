import { getStateOrUnavailable, setSettings } from '../../../services/dj/djService.js';
import { djErrorReply, formatResetTime, DJ_ERROR_MESSAGES } from '../../../services/dj/messages.js';
import { DJ_UNAVAILABLE } from '../../../services/dj/errors.js';

// /dj: thin adapters over djService (contracts §3). Settings changes reply
// publicly like /loop; errors reply ephemerally with the shared text. DJ line
// text is never posted here (FR-001a).

function actorFrom(interaction) {
  return { id: interaction.user.id, name: interaction.user.username };
}

/**
 * Run a settings change and reply. Returns after replying either way.
 * @param {Object} interaction
 * @param {Object} partial
 * @param {(state: Object) => string} describe - public confirmation text
 */
async function applySettings(interaction, partial, describe) {
  let state;
  try {
    state = setSettings(partial, actorFrom(interaction));
  } catch (error) {
    const reply = djErrorReply(error, getStateOrUnavailable());
    if (!reply) throw error;
    await interaction.reply({ content: reply.message, ephemeral: true });
    return;
  }
  await interaction.reply(describe(state));
}

/**
 * The /dj status text: enabled, interval, lookahead, health and caps.
 * @param {Object} state - DjState
 * @returns {string}
 */
export function formatStatus(state) {
  const resetsAt = formatResetTime(state.caps.resetsAt);
  const cap = (c) =>
    `${c.used}/${c.limit}${c.reached ? ` (limit reached, resets at ${resetsAt})` : ''}`;
  return [
    `**DJ:** ${state.enabled ? 'On' : 'Off'}`,
    `**Interval:** every ${state.interval} track${state.interval === 1 ? '' : 's'}`,
    `**Lookahead:** ${state.lookahead} tracks`,
    `**Health:** ${state.health === 'ok' ? 'OK' : 'Degraded'}`,
    `**Lines today:** ${cap(state.caps.lines)}`,
    `**Themed tracks today:** ${cap(state.caps.themedTracks)}`,
    `Limits reset at ${resetsAt}.`
  ].join('\n');
}

async function handleStatus(interaction) {
  const state = getStateOrUnavailable();
  if (!state.available) {
    await interaction.reply({ content: DJ_ERROR_MESSAGES[DJ_UNAVAILABLE].text, ephemeral: true });
    return;
  }
  await interaction.reply(formatStatus(state));
}

export async function handleDj(interaction) {
  const sub = interaction.options.getSubcommand();
  switch (sub) {
    case 'status':
      return handleStatus(interaction);
    case 'on':
      return applySettings(interaction, { enabled: true }, () => 'DJ enabled');
    case 'off':
      return applySettings(interaction, { enabled: false }, () => 'DJ disabled');
    case 'interval':
      return applySettings(
        interaction,
        { interval: interaction.options.getInteger('every') },
        (s) => `DJ will speak every ${s.interval} track${s.interval === 1 ? '' : 's'}`
      );
    case 'lookahead':
      return applySettings(
        interaction,
        { lookahead: interaction.options.getInteger('size') },
        (s) => `DJ lookahead set to ${s.lookahead} tracks`
      );
    default:
      await interaction.reply({ content: 'Unknown DJ command.', ephemeral: true });
  }
}
