import { getStateOrUnavailable, setSettings } from '../../../services/dj/djService.js';
import { DjError, DJ_UNAVAILABLE } from '../../../services/dj/errors.js';
import { describeDjError, formatResetTime } from '../../../services/dj/messages.js';

// /dj: thin adapters over djService (contracts §3). Settings changes reply
// publicly like /loop; errors reply ephemerally with the shared text. No reply
// ever carries DJ line text (FR-001a).

function actorFrom(user) {
  return { id: user?.id ?? null, name: user?.globalName || user?.username || null };
}

async function replyError(interaction, error) {
  if (!(error instanceof DjError)) throw error;
  const described = describeDjError(error.code, {
    resetsAt: getStateOrUnavailable().caps?.resetsAt
  });
  await interaction.reply({ content: described?.text ?? error.message, ephemeral: true });
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

function capLine(label, cap, resetsAt) {
  const base = `${label}: ${cap.used} / ${cap.limit}`;
  return cap.reached ? `${base} (limit reached, resets at ${formatResetTime(resetsAt)})` : base;
}

/** The `/dj status` text: settings, health and today's caps. */
export function formatStatus(state) {
  return [
    `DJ: ${state.enabled ? 'on' : 'off'}`,
    `Interval: every ${state.interval} track${state.interval === 1 ? '' : 's'}`,
    `Lookahead: ${state.lookahead}`,
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

const SUBCOMMANDS = {
  status: handleStatus,
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
