import * as djService from '../../../services/dj/djService.js';
import { DjError } from '../../../services/dj/errors.js';
import { formatResetTime, textFor } from '../../../services/dj/messages.js';
import { logger } from '../../../utils/logger.js';

/**
 * /dj: thin adapters over djService (contracts/dj-api.md §3). Settings changes
 * reply publicly like /loop; errors reply ephemerally with the shared texts.
 * Never posts DJ line text (FR-001a).
 */

function actorFrom(interaction) {
  return { id: interaction.user?.id ?? null, name: interaction.user?.username ?? null };
}

async function replyDjError(interaction, error) {
  const content = textFor(error.code, { resetsAt: djService.getState().caps?.resetsAt });
  await interaction.reply({ content, ephemeral: true });
}

function formatCap(label, cap, resetTime) {
  const reached = cap.reached ? ` (limit reached, resets at ${resetTime})` : '';
  return `${label}: ${cap.used} / ${cap.limit}${reached}`;
}

/** @param {Object} state - DjState with available: true */
export function formatStatus(state) {
  const resetTime = formatResetTime(state.caps.resetsAt) ?? 'midnight';
  return [
    `**DJ:** ${state.enabled ? 'On' : 'Off'}`,
    `**Interval:** every ${state.interval} track${state.interval === 1 ? '' : 's'}`,
    `**Lookahead:** ${state.lookahead}`,
    `**Health:** ${state.health}`,
    formatCap('**Lines today**', state.caps.lines, resetTime),
    formatCap('**Themed tracks today**', state.caps.themedTracks, resetTime),
    `Daily limits reset at ${resetTime}.`
  ].join('\n');
}

function describeChange(subcommand, state) {
  switch (subcommand) {
    case 'on':
      return `DJ enabled, speaking every ${state.interval} track${state.interval === 1 ? '' : 's'}.`;
    case 'off':
      return 'DJ disabled.';
    case 'interval':
      return `DJ will speak every ${state.interval} track${state.interval === 1 ? '' : 's'}.`;
    case 'lookahead':
      return `DJ lookahead set to ${state.lookahead}.`;
    default:
      return 'DJ settings updated.';
  }
}

/** The settings partial each changing subcommand maps to. */
function partialFor(subcommand, interaction) {
  switch (subcommand) {
    case 'on':
      return { enabled: true };
    case 'off':
      return { enabled: false };
    case 'interval':
      return { interval: interaction.options.getInteger('every') };
    case 'lookahead':
      return { lookahead: interaction.options.getInteger('size') };
    default:
      return null;
  }
}

export async function handleDj(interaction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'status') {
    const state = djService.getStateOrUnavailable();
    if (!state.available) {
      return interaction.reply({ content: textFor('DJ_UNAVAILABLE'), ephemeral: true });
    }
    return interaction.reply(formatStatus(state));
  }

  const partial = partialFor(subcommand, interaction);
  if (!partial) {
    return interaction.reply({ content: 'Unknown DJ command.', ephemeral: true });
  }

  try {
    const state = djService.setSettings(partial, actorFrom(interaction));
    await interaction.reply(describeChange(subcommand, state));
  } catch (error) {
    if (error instanceof DjError) return replyDjError(interaction, error);
    logger.error('[DJ] /dj command failed:', error);
    await interaction.reply({ content: 'Failed to change DJ settings.', ephemeral: true });
  }
}
