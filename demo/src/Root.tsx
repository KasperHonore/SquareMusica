import React from 'react';
import { Composition } from 'remotion';
import { VIDEO } from './theme';
import { Demo, DemoGif, DEMO_DURATION, DEMO_GIF_DURATION } from './Demo';

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="Demo"
      component={Demo}
      durationInFrames={DEMO_DURATION}
      fps={VIDEO.fps}
      width={VIDEO.width}
      height={VIDEO.height}
    />
    <Composition
      id="DemoGif"
      component={DemoGif}
      durationInFrames={DEMO_GIF_DURATION}
      fps={VIDEO.fps}
      width={VIDEO.width}
      height={VIDEO.height}
    />
  </>
);
