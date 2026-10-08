import * as djService from '../../../services/dj/djService.js';
import { DjError, DJ_UNAVAILABLE } from '../../../services/dj/errors.js';
import { describeDjError, formatResetTime } from '../../../services/dj/messages.js';
import { logger } from '../../../utils/logger.js';

/**
 * /dj - thin adapter over djService (contracts §3). Settings changes reply
 * publicly like /loop; errors reply ephemerally with the shared table's text.
 * Never posts DJ line text (FR-001a): lines are speech only.
 */

function actorFrom(interaction) {
  return { id: interaction.user.id, name: interaction.user.username };
}

async function replyError(interaction, error) {
  const mapped = describeDjError(error, djService.getStateOrUnavailable());
  if (!mapped) throw error;
  await interaction.reply({ content: mapped.message, ephemeral: true });
}

/** The /dj status text: settings, health and today's caps. */
export function formatStatus(state) {
  const { lines, themedTracks } = state.caps;
  const resetsAt = formatResetTime(state);
  const capLine = (label, cap) =>
    `${label}: ${cap.used}/${cap.limit}` +
    (cap.reached ? ` (limit reached, resets at ${resetsAt})` : '');

  return [
    `**DJ:** ${state.enabled ? 'on' : 'off'}`,
    `**Interval:** every ${state.interval} ${state.interval === 1 ? 'track' : 'tracks'}`,
    `**Lookahead:** ${state.lookahead}`,
    `**Health:** ${state.health}`,
    `**Today:** ${capLine('lines', lines)} · ${capLine('themed tracks', themedTracks)}`,
    `Limits reset at ${resetsAt}.`
  ].join('\n');
}

/** Public confirmation for a settings change, read back from the new state. */
function describeChange(subcommand, state) {
  switch (subcommand) {
    case 'on':
      return `DJ enabled. Speaking every ${state.interval} ${state.interval === 1 ? 'track' : 'tracks'}.`;
    case 'off':
      return 'DJ disabled.';
    case 'interval':
      return `DJ will speak every ${state.interval} ${state.interval === 1 ? 'track' : 'tracks'}.`;
    case 'lookahead':
      return `DJ lookahead set to ${state.lookahead}.`;
    default:
      return 'DJ settings updated.';
  }
}

/** The setSettings partial for a settings subcommand. */
function settingsFor(subcommand, options) {
  switch (subcommand) {
    case 'on':
      return { enabled: true };
    case 'off':
      return { enabled: false };
    case 'interval':
      return { interval: options.getInteger('every') };
    case 'lookahead':
      return { lookahead: options.getInteger('size') };
    default:
      return null;
  }
}

export async function handleDj(interaction) {
  const subcommand = interaction.options.getSubcommand();

  try {
    if (subcommand === 'status') {
      const state = djService.getStateOrUnavailable();
      if (!state.available) {
        // Same reply as any other call while unconfigured.
        return await replyError(interaction, new DjError(DJ_UNAVAILABLE));
      }
      return await interaction.reply({ content: formatStatus(state), ephemeral: true });
    }

    const partial = settingsFor(subcommand, interaction.options);
    if (!partial) {
      logger.warn(`[DJ] Unknown /dj subcommand: ${subcommand}`);
      return await interaction.reply({ content: 'Unknown DJ command.', ephemeral: true });
    }

    const state = djService.setSettings(partial, actorFrom(interaction));
    await interaction.reply(describeChange(subcommand, state));
  } catch (error) {
    await replyError(interaction, error);
  }
}
