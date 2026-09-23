import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  EMPTY_RESOURCE_STATE,
  describeResource,
  formatDurationShort,
  nextResourceState,
  worstSample,
  type ResourceState,
} from './resource-alerts';

/**
 * The value here is entirely in *not* sending mail. Container metrics have been collected every
 * 15 seconds all along; the reason nothing used them is that a naive threshold would mail on
 * every start-up spike and every garbage collection. These tests are mostly about the readings
 * that must stay quiet.
 */

const memory = DEFAULT_THRESHOLDS.memory; // 90%, sustained 5 minutes, clears under 80%
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 23, 12, minutes, 0));
const sample = (percent: number) => ({ percent, containerName: 'pushify-shop-blue' });

/** Feed a series of readings, one per minute, and collect what it decided to send. */
function run(readings: number[], threshold = memory) {
  let state: ResourceState = EMPTY_RESOURCE_STATE;
  const sent: string[] = [];
  readings.forEach((percent, minute) => {
    const transition = nextResourceState(state, sample(percent), threshold, at(minute));
    state = transition.state;
    if (transition.notify) sent.push(`${minute}:${transition.notify}`);
  });
  return { state, sent };
}

describe('nextResourceState', () => {
  it('says nothing about a spike, however high', () => {
    // A container uses everything it can get for the first moments after it starts
    expect(run([100, 99, 40, 30]).sent).toEqual([]);
  });

  it('speaks up once the reading has stayed over the line for long enough', () => {
    const { sent } = run([95, 95, 95, 95, 95, 95]);
    // First reading at minute 0 starts the clock; 5 minutes later it counts
    expect(sent).toEqual(['5:pressure']);
  });

  it('says it once, not once a minute', () => {
    expect(run([95, 95, 95, 95, 95, 95, 95, 95, 95, 95]).sent).toEqual(['5:pressure']);
  });

  it('tells you when it is over, and how long it lasted', () => {
    let state: ResourceState = EMPTY_RESOURCE_STATE;
    for (let minute = 0; minute <= 5; minute++) {
      state = nextResourceState(state, sample(95), memory, at(minute)).state;
    }
    const recovered = nextResourceState(state, sample(40), memory, at(12));
    expect(recovered.notify).toBe('recovered');
    expect(formatDurationShort(recovered.underPressureForMs!)).toBe('12 minutes');
    expect(recovered.state).toEqual(EMPTY_RESOURCE_STATE);
  });

  it('does not announce a recovery nobody was warned about', () => {
    // Over the line for two minutes only, then back down — nothing was ever sent
    expect(run([95, 95, 20]).sent).toEqual([]);
  });

  it('will not flap for a reading sitting on the threshold', () => {
    // 89% is under the line but inside the margin: not a problem any more, not resolved either
    const { sent } = run([95, 95, 95, 95, 95, 95, 89, 91, 89, 91, 89]);
    expect(sent).toEqual(['5:pressure']);
  });

  it('clears only once it is properly back down', () => {
    const { sent } = run([95, 95, 95, 95, 95, 95, 85, 82, 79]);
    expect(sent).toEqual(['5:pressure', '8:recovered']);
  });

  it('starts the clock again after a recovery', () => {
    const { sent } = run([95, 95, 95, 95, 95, 95, 10, 95, 95, 95, 95, 95, 95]);
    expect(sent).toEqual(['5:pressure', '6:recovered', '12:pressure']);
  });

  it('gives CPU much longer than memory before it complains', () => {
    const cpu = DEFAULT_THRESHOLDS.cpu;
    expect(cpu.sustainMs).toBeGreaterThan(memory.sustainMs);
    // A ten-minute build at full CPU is not an incident
    expect(run(Array(11).fill(99), cpu).sent).toEqual([]);
    expect(run(Array(16).fill(99), cpu).sent).toEqual(['15:pressure']);
  });
});

describe('state left behind by a paused project', () => {
  /**
   * A project paused while over the line stops producing readings, so nothing ever clears its
   * state. Resumed a month later and perfectly healthy, the naive answer is "recovered, it was
   * over for 31 days" — which is both useless and frightening.
   */
  it('drops a stale condition silently instead of announcing a month-long outage', () => {
    const stale = { since: at(0), notifiedAt: at(5) };
    const muchLater = new Date(at(0).getTime() + 31 * 24 * 60 * 60 * 1000);
    const transition = nextResourceState(stale, sample(10), memory, muchLater);
    expect(transition.notify).toBeNull();
    expect(transition.state).toEqual(EMPTY_RESOURCE_STATE);
  });

  it('still reports a real recovery that lasted hours', () => {
    const real = { since: at(0), notifiedAt: at(5) };
    const hoursLater = new Date(at(0).getTime() + 6 * 60 * 60 * 1000);
    const transition = nextResourceState(real, sample(10), memory, hoursLater);
    expect(transition.notify).toBe('recovered');
    expect(formatDurationShort(transition.underPressureForMs!)).toBe('6 hours');
  });
});

describe('worstSample', () => {
  it('reports the worst container, so three replicas are one problem', () => {
    expect(
      worstSample([
        { percent: 40, containerName: 'a' },
        { percent: 95, containerName: 'b' },
        { percent: 91, containerName: 'c' },
      ])
    ).toEqual({ percent: 95, containerName: 'b' });
  });

  it('ignores readings that are not numbers, and has no answer for nothing', () => {
    expect(worstSample([{ percent: NaN, containerName: 'a' }])).toBeNull();
    expect(worstSample([])).toBeNull();
  });
});

describe('wording', () => {
  it('describes what the number means rather than printing it', () => {
    expect(describeResource('memory', 94.6, 'pushify-shop-blue')).toBe(
      'pushify-shop-blue is using 95% of the memory it is allowed'
    );
    expect(describeResource('cpu', 97.2, 'pushify-shop-blue')).toBe(
      'pushify-shop-blue has been running at 97% CPU'
    );
  });

  it('rounds a duration to something a person would say', () => {
    expect(formatDurationShort(30 * 1000)).toBe('1 minute');
    expect(formatDurationShort(25 * 60 * 1000)).toBe('25 minutes');
    expect(formatDurationShort(3 * 60 * 60 * 1000)).toBe('3 hours');
    expect(formatDurationShort(50 * 60 * 60 * 1000)).toBe('2 days');
  });
});
