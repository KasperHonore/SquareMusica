import { describe, it, expect } from 'vitest';
import { formatTime } from '../../shared/formatTime.js';

describe('formatTime', () => {
  it('formats a normal second count as m:ss', () => {
    expect(formatTime(65)).toBe('1:05');
  });

  it('zero-pads the seconds component', () => {
    expect(formatTime(5)).toBe('0:05');
    expect(formatTime(125)).toBe('2:05');
  });

  it('renders an exact minute with zero seconds', () => {
    expect(formatTime(60)).toBe('1:00');
  });

  it('returns the default empty value for 0 (falsy short-circuit)', () => {
    expect(formatTime(0)).toBe('0:00');
  });

  it('returns the default empty value for NaN', () => {
    expect(formatTime(NaN)).toBe('0:00');
  });

  it('returns the default empty value for undefined input', () => {
    expect(formatTime(undefined)).toBe('0:00');
  });

  it('honors a custom emptyValue for falsy/NaN input', () => {
    expect(formatTime(0, '--:--')).toBe('--:--');
    expect(formatTime(NaN, 'n/a')).toBe('n/a');
  });

  it('renders durations over an hour as raw minutes (no hour component)', () => {
    // 3661s = 61m 1s -> rendered as "61:01" rather than "1:01:01"
    expect(formatTime(3661)).toBe('61:01');
  });
});
