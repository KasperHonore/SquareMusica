import { musicManager } from '../../../core/musicManager.js';
import {
  getStateOrUnavailable,
  getShoutouts,
  getThemeOrigin,
  setSettings,
  setShoutouts,
  startTheme,
  stopTheme
} from '../../../services/dj/djService.js';
import { DjError, DJ_UNAVAILABLE } from '../../../services/dj/errors.js';
import { describeDjError, formatResetTime } from '../../../services/dj/messages.js';
import { logger } from '../../../utils/logger.js';

// /dj: thin adapters over djService (contracts §3). Settings changes reply
// publicly like /loop; errors reply ephemerally with the shared text. No reply
// ever carries DJ line text (FR-001a).

function actorFrom(user) {
  return { id: user?.id ?? null, name: user?.globalName || user?.username || null };
}

function djErrorText(error) {
  const described = describeDjError(error.code, {
    resetsAt: getStateOrUnavailable().caps?.resetsAt
  });
  return described?.text ?? error.message;
}

async function replyError(interaction, error) {
  if (!(error instanceof DjError)) throw error;
  await interaction.reply({ content: djErrorText(error), ephemeral: true });
}

async function applySettings(interaction, partial, describeChange) {
  let state;
  try {
    state = setSettings(partial, actorFrom(interaction.user));
  } catch (error) {
    return replyError(interaction, error);
  }
  await interaction.reply(describeChange(state));
}

// Why themed mode stalled, as told in the channel it was started from (FR-029).
const STALL_TEXT = {
  NO_LISTENERS: 'Themed mode is paused: nobody is listening.',
  NOT_IN_VOICE: "Themed mode is paused: I'm not in a voice channel.",
  CAP_REACHED: "Themed mode is paused: the DJ has hit today's limit.",
  SERVICE_UNAVAILABLE: "Themed mode is paused: the DJ's music brain is unavailable right now.",
  THEME_EXHAUSTED: "Themed mode is paused: I can't find any more tracks for this theme."
};

/** Human-readable stall reason, shared with /dj status. */
export function stallText(reason, resetsAt) {
  const text = STALL_TEXT[reason] ?? 'Themed mode is paused.';
  return reason === 'CAP_REACHED' ? `${text} It resets at ${formatResetTime(resetsAt)}.` : text;
}

// The client of the last /dj theme, used to post stall notices to its channel.
let noticeClient = null;
let lastStall = null; // `${startedAt}|${reason}` of the last notice posted

/**
 * One message per stall to the channel themed mode was started from, when it
 * was started from Discord (FR-029; a transport affordance only).
 */
function onDjState(state) {
  const theme = state?.theme;
  if (!theme || theme.status !== 'stalled') {
    lastStall = null;
    return;
  }
  const origin = getThemeOrigin();
  if (origin?.transport !== 'discord' || !origin.channelId || !noticeClient) return;
  const stallKey = `${theme.startedAt}|${theme.reason}`;
  if (stallKey === lastStall) return;
  lastStall = stallKey;
  const content = stallText(theme.reason, state.caps?.resetsAt);
  Promise.resolve()
    .then(() => noticeClient.channels.fetch(origin.channelId))
    .then((channel) => channel?.send?.({ content }))
    .catch((error) =>
      logger.warn('[DJ] Could not post themed-mode notice:', error?.message ?? error)
    );
}
musicManager.on('dj:state', onDjState);

/**
 * `/dj theme description:<text> [lookahead]`: start themed mode or change the
 * theme. The first top-up can take up to 20 s, so the reply is deferred.
 */
async function handleTheme(interaction) {
  const theme = interaction.options.getString('description');
  const lookahead = interaction.options.getInteger('lookahead') ?? undefined;
  const wasRunning = Boolean(getStateOrUnavailable().theme);
  await interaction.deferReply();
  noticeClient = interaction.client ?? noticeClient;
  let state;
  try {
    state = await startTheme({ theme, lookahead }, actorFrom(interaction.user), {
      transport: 'discord',
      channelId: interaction.channelId
    });
  } catch (error) {
    if (!(error instanceof DjError)) throw error;
    return interaction.editReply({ content: djErrorText(error) });
  }
  const name = state.theme?.theme ?? theme.trim();
  await interaction.editReply(
    wasRunning
      ? `Theme changed to "${name}".`
      : `Themed mode is on: "${name}", keeping ${state.lookahead} tracks queued ahead.`
  );
}

/** `/dj theme-stop`: no more picks are added; queued ones stay. */
async function handleThemeStop(interaction) {
  const wasRunning = Boolean(getStateOrUnavailable().theme);
  try {
    stopTheme(actorFrom(interaction.user));
  } catch (error) {
    return replyError(interaction, error);
  }
  await interaction.reply(
    wasRunning
      ? 'Themed mode is off. Tracks already queued will still play.'
      : 'Themed mode is not running.'
  );
}

function capLine(label, cap, resetsAt) {
  const base = `${label}: ${cap.used} / ${cap.limit}`;
  return cap.reached ? `${base} (limit reached, resets at ${formatResetTime(resetsAt)})` : base;
}

/** The `/dj status` text: settings, health and today's caps. */
export function formatStatus(state) {
  const theme = state.theme;
  const themeLine = theme
    ? `Theme: "${theme.theme}"${theme.startedBy?.name ? ` (started by ${theme.startedBy.name})` : ''}` +
      (theme.status === 'stalled' ? ` — ${stallText(theme.reason, state.caps.resetsAt)}` : '')
    : 'Theme: off';
  return [
    `DJ: ${state.enabled ? 'on' : 'off'}`,
    `Interval: every ${state.interval} track${state.interval === 1 ? '' : 's'}`,
    `Lookahead: ${state.lookahead}`,
    themeLine,
    `Health: ${state.health}`,
    capLine('Lines today', state.caps.lines, state.caps.resetsAt),
    capLine('Themed tracks today', state.caps.themedTracks, state.caps.resetsAt),
    `Limits reset at ${formatResetTime(state.caps.resetsAt)}`
  ].join('\n');
}

async function handleStatus(interaction) {
  const state = getStateOrUnavailable();
  if (!state.available) {
    return replyError(interaction, new DjError(DJ_UNAVAILABLE));
  }
  await interaction.reply({ content: formatStatus(state), ephemeral: true });
}

/**
 * `/dj shoutouts [enabled]`: set or read the caller's own preference. Personal,
 * so the reply is ephemeral and always states the current value.
 */
async function handleShoutouts(interaction) {
  const enabled = interaction.options.getBoolean('enabled');
  let result;
  try {
    result =
      enabled === null
        ? getShoutouts(interaction.user.id)
        : setShoutouts(interaction.user.id, enabled);
  } catch (error) {
    return replyError(interaction, error);
  }
  const content = result.enabled
    ? 'Shout-outs about you are on: the DJ may mention you by name.'
    : 'Shout-outs about you are off: the DJ will not mention you by name.';
  await interaction.reply({ content, ephemeral: true });
}

const SUBCOMMANDS = {
  status: handleStatus,
  shoutouts: handleShoutouts,
  theme: handleTheme,
  'theme-stop': handleThemeStop,
  on: (interaction) => applySettings(interaction, { enabled: true }, () => 'The DJ is on.'),
  off: (interaction) => applySettings(interaction, { enabled: false }, () => 'The DJ is off.'),
  interval: (interaction) =>
    applySettings(
      interaction,
      { interval: interaction.options.getInteger('every') },
      (state) =>
        `The DJ will speak every ${state.interval} track${state.interval === 1 ? '' : 's'}.`
    ),
  lookahead: (interaction) =>
    applySettings(
      interaction,
      { lookahead: interaction.options.getInteger('size') },
      (state) => `Themed mode will keep ${state.lookahead} tracks queued ahead.`
    )
};

export async function handleDj(interaction) {
  const handler = SUBCOMMANDS[interaction.options.getSubcommand()];
  if (!handler) {
    return interaction.reply({ content: 'Unknown DJ command.', ephemeral: true });
  }
  return handler(interaction);
}
