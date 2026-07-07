import { Config } from '@remotion/cli/config';

// High-quality still frames for smooth video.
Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);

// Crisp text: render at full pixel density.
Config.setChromiumOpenGlRenderer('angle');
