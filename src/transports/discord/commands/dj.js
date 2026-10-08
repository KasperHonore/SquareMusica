import { musicManager } from '../../../core/musicManager.js';
import * as djService from '../../../services/dj/djService.js';
import { DjError } from '../../../services/dj/errors.js';
import { formatResetTime, textFor } from '../../../services/dj/messages.js';
import { logger } from '../../../utils/logger.js';
import { client } from '../client.js';

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

/** Plain-language reasons for a stalled theme (FR-029). */
const STALL_TEXT = {
  NO_LISTENERS: 'nobody is in the voice channel',
  NOT_IN_VOICE: "I'm not in a voice channel",
  CAP_REACHED: "I've hit today's limit for themed tracks",
  SERVICE_UNAVAILABLE: "the DJ's music brain is unavailable right now",
  THEME_EXHAUSTED: "I can't find any more tracks for this theme"
};

/** The stall notice posted to the channel a theme was started from. */
export function stallMessage(themeState) {
  const why = STALL_TEXT[themeState.reason] ?? 'something went wrong';
  return `Themed mode "${themeState.theme}" paused: ${why}. I'll pick up again once that clears.`;
}

// Theme sessions started from Discord: the last status seen, so each stall is
// posted once (FR-029). A Discord-only affordance; every surface also shows the
// status from dj:state.
let lastTheme = null;

/**
 * Mediator `dj:state` listener: post one message per stall of a theme that
 * was started from Discord, to the channel it was started in.
 * @param {Object} state - DjState
 */
export function onDjState(state) {
  const theme = state?.theme ?? null;
  const previous = lastTheme;
  lastTheme = theme;
  if (!theme || theme.status !== 'stalled') return;
  const sameSession = previous && previous.startedAt === theme.startedAt;
  if (sameSession && previous.status === 'stalled' && previous.reason === theme.reason) return;
  const origin = djService.getThemeOrigin?.();
  if (origin?.transport !== 'discord' || !origin.channelId) return;

  Promise.resolve()
    .then(() => client.channels.fetch(origin.channelId))
    .then((channel) => channel?.send?.(stallMessage(theme)))
    .catch((error) => logger.warn('[DJ] Could not post themed-mode stall notice:', error?.message));
}

/**
 * Subscribe the stall notices to the mediator. Called once from the Discord
 * bootstrap; calling it again does not add a second listener.
 */
export function registerDjStateListener() {
  musicManager.off('dj:state', onDjState);
  musicManager.on('dj:state', onDjState);
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
    state.theme
      ? `**Theme:** "${state.theme.theme}" (${state.theme.status}${
          state.theme.reason ? `: ${STALL_TEXT[state.theme.reason] ?? state.theme.reason}` : ''
        })`
      : '**Theme:** off',
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

/** /dj theme: may take up to 20 s for the first pick, so the reply is deferred. */
async function handleTheme(interaction) {
  const input = { theme: interaction.options.getString('description') };
  const lookahead = interaction.options.getInteger('lookahead');
  if (lookahead !== null && lookahead !== undefined) input.lookahead = lookahead;
  const wasOn = djService.getStateOrUnavailable().theme != null;

  await interaction.deferReply();
  try {
    const state = await djService.startTheme(input, actorFrom(interaction), {
      transport: 'discord',
      channelId: interaction.channelId
    });
    if (!state.theme) {
      // The queue was cleared or playback stopped before the first pick landed.
      return interaction.editReply('Themed mode stopped before it started: the queue was cleared.');
    }
    await interaction.editReply(
      wasOn
        ? `Theme changed to "${state.theme.theme}".`
        : `Themed mode on: "${state.theme.theme}", keeping ${state.lookahead} tracks queued ahead.`
    );
  } catch (error) {
    if (error instanceof DjError) {
      // Errors are ephemeral (contracts §2), but the deferred reply is already
      // public: drop it and answer privately instead.
      const content = textFor(error.code, { resetsAt: djService.getState().caps?.resetsAt });
      await interaction.deleteReply().catch(() => {});
      return interaction.followUp({ content, ephemeral: true });
    }
    logger.error('[DJ] /dj theme failed:', error);
    await interaction.editReply('Failed to start themed mode.');
  }
}

async function handleThemeStop(interaction) {
  try {
    const wasOn = djService.getStateOrUnavailable().theme != null;
    djService.stopTheme(actorFrom(interaction));
    await interaction.reply(
      wasOn ? 'Themed mode stopped. Queued picks stay.' : 'Themed mode is not on.'
    );
  } catch (error) {
    if (error instanceof DjError) return replyDjError(interaction, error);
    logger.error('[DJ] /dj theme-stop failed:', error);
    await interaction.reply({ content: 'Failed to stop themed mode.', ephemeral: true });
  }
}

export async function handleDj(interaction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'theme') return handleTheme(interaction);
  if (subcommand === 'theme-stop') return handleThemeStop(interaction);

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
