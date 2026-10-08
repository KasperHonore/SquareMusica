import { musicManager } from '../../../core/musicManager.js';
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

// Human text per stall reason, for the notice posted where themed mode started.
const STALL_TEXT = {
  NO_LISTENERS: 'nobody is listening in the voice channel',
  NOT_IN_VOICE: "I'm not in a voice channel",
  CAP_REACHED: "today's themed-track limit is reached",
  SERVICE_UNAVAILABLE: "the DJ's music brain is unavailable right now",
  THEME_EXHAUSTED: "I can't find any more tracks for this theme"
};

// The Discord client, captured from the last /dj interaction, so stall
// notices can be posted without this module importing client.js.
let discordClient = null;
let lastStall = null;

/**
 * FR-029, Discord's own affordance: when a session started from Discord
 * stalls, post one message per stall to the channel it was started from.
 * @param {Object} state - DjState from the dj:state broadcast
 */
export async function onDjState(state) {
  const theme = state?.theme ?? null;
  if (!theme || theme.status !== 'stalled') {
    lastStall = null;
    return;
  }
  const origin = djService.getThemeOrigin?.();
  const stallKey = `${theme.startedAt}|${theme.reason}`;
  if (origin?.transport !== 'discord' || !origin.channelId || lastStall === stallKey) return;
  lastStall = stallKey;

  try {
    const channel = await discordClient?.channels?.fetch(origin.channelId);
    await channel?.send?.(
      `Themed mode ("${theme.theme}") has paused: ${STALL_TEXT[theme.reason] ?? 'something went wrong'}.`
    );
  } catch (error) {
    logger.warn('[DJ] Could not post the themed-mode stall notice', { detail: error?.message });
  }
}
musicManager.on('dj:state', (state) => {
  onDjState(state);
});

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
  if (interaction.client) discordClient = interaction.client;

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
      case 'theme': {
        const description = interaction.options.getString('description');
        const lookahead = interaction.options.getInteger('lookahead');
        const params = { theme: description };
        if (lookahead !== null && lookahead !== undefined) params.lookahead = lookahead;
        // The first top-up can take up to 20 s, past Discord's 3 s limit.
        await interaction.deferReply();
        const { id, name } = toActor(interaction.user) ?? {};
        const state = await djService.startTheme(
          params,
          { id, name },
          { transport: 'discord', channelId: interaction.channelId }
        );
        await interaction.editReply(
          `Themed mode is on: **${state.theme?.theme ?? description.trim()}**. Keeping ${state.lookahead} DJ picks queued.`
        );
        return;
      }
      case 'theme-stop': {
        const { id, name } = toActor(interaction.user) ?? {};
        djService.stopTheme({ id, name });
        await interaction.reply('Themed mode is off. Queued picks stay.');
        return;
      }
      default:
        await interaction.reply({ content: 'Unknown DJ command.', ephemeral: true });
    }
  } catch (error) {
    const described = describeDjError(error, djService.getStateOrUnavailable());
    if (!described) logger.error('[DJ] /dj failed:', error);
    const content = described ? described.message : 'Something went wrong changing the DJ.';
    // A deferred reply can only be edited, and its visibility is already set.
    if (interaction.deferred) {
      await interaction.editReply(content);
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  }
}
