import * as djService from '../../../services/dj/djService.js';
import { DjError, DJ_UNAVAILABLE } from '../../../services/dj/errors.js';
import { describeDjError, formatResetTime } from '../../../services/dj/messages.js';
import { toActor } from '../../../shared/statsEvents.js';
import { logger } from '../../../utils/logger.js';

/**
 * Status text for `/dj status`. Settings, health and caps only: the DJ's
 * spoken lines are never posted to the channel (FR-001a).
 * @param {Object} state - DjState
 * @returns {string}
 */
function formatStatus(state) {
  const { lines, themedTracks, resetsAt } = state.caps;
  const capLine = (label, cap) =>
    `${label}: ${cap.used}/${cap.limit}${cap.reached ? ' (limit reached)' : ''}`;
  return [
    `**DJ:** ${state.enabled ? 'On' : 'Off'}`,
    `**Interval:** every ${state.interval} track${state.interval === 1 ? '' : 's'}`,
    `**Lookahead:** ${state.lookahead}`,
    `**Health:** ${state.health}`,
    `**Today:** ${capLine('lines', lines)}, ${capLine('themed tracks', themedTracks)}; resets at ${formatResetTime(resetsAt)}`
  ].join('\n');
}

/**
 * Apply a settings change and reply publicly, like `/loop`.
 */
async function applySettings(interaction, partial, confirmation) {
  const { id, name } = toActor(interaction.user) ?? {};
  djService.setSettings(partial, { id, name });
  await interaction.reply(confirmation);
}

/**
 * `/dj` — thin adapter over djService. Errors reply ephemerally with the
 * shared text from services/dj/messages.js.
 */
export async function handleDj(interaction) {
  const sub = interaction.options.getSubcommand();

  try {
    switch (sub) {
      case 'status': {
        const state = djService.getStateOrUnavailable();
        if (!state.available) throw new DjError(DJ_UNAVAILABLE);
        await interaction.reply({ content: formatStatus(state), ephemeral: true });
        return;
      }
      case 'on':
        await applySettings(interaction, { enabled: true }, 'The DJ is on.');
        return;
      case 'off':
        await applySettings(interaction, { enabled: false }, 'The DJ is off.');
        return;
      case 'interval': {
        const every = interaction.options.getInteger('every');
        await applySettings(
          interaction,
          { interval: every },
          `The DJ will speak every ${every} track${every === 1 ? '' : 's'}.`
        );
        return;
      }
      case 'lookahead': {
        const size = interaction.options.getInteger('size');
        await applySettings(interaction, { lookahead: size }, `DJ lookahead set to ${size}.`);
        return;
      }
      default:
        await interaction.reply({ content: 'Unknown DJ command.', ephemeral: true });
    }
  } catch (error) {
    const described = describeDjError(error, djService.getStateOrUnavailable());
    if (!described) logger.error('[DJ] /dj failed:', error);
    await interaction.reply({
      content: described ? described.message : 'Something went wrong changing the DJ.',
      ephemeral: true
    });
  }
}
