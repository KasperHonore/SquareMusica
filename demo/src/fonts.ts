/**
 * Load the exact SquareMusica typefaces via Remotion's Google Fonts helper so
 * they are embedded deterministically during render:
 *   - Instrument Serif  -> headings / wordmark
 *   - DM Sans           -> body / UI
 */
import { loadFont as loadInstrumentSerif } from '@remotion/google-fonts/InstrumentSerif';
import { loadFont as loadDMSans } from '@remotion/google-fonts/DMSans';

const serif = loadInstrumentSerif('normal', { subsets: ['latin'], weights: ['400'] });
const sans = loadDMSans('normal', { subsets: ['latin'], weights: ['400', '500', '600', '700'] });

export const fontHeading = serif.fontFamily;
export const fontBody = sans.fontFamily;

// Call inside a component render to guarantee fonts are ready before paint.
export const waitForFonts = () =>
  Promise.all([serif.waitUntilDone(), sans.waitUntilDone()]);
