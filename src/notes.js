// Fast, non-mutating port of Basic Pitch's `outputToNotesPoly`.
//
// The original rescans the whole song to find the global maximum for every
// note added by the "melodia trick" (quadratic: seconds of freeze on a phone)
// and zeroes out-of-range pitches directly in the model output, so narrowing
// the note range and widening it again lost notes for good. This version
// works on flat Float32Array copies and walks the energy cells once, sorted
// from loudest to quietest, which gives the same notes in a fraction of the time.

const N_PITCHES = 88;
const MIDI_OFFSET = 21;
const MAX_FREQ_IDX = 87;

/** Flatten an array of 88-value rows into one Float32Array (row-major). */
export function toFlat(rows) {
  const out = new Float32Array(rows.length * N_PITCHES);
  for (let i = 0; i < rows.length; i++) out.set(rows[i], i * N_PITCHES);
  return out;
}

/**
 * @param {Float32Array} frames0 flat frames (nFrames * 88), not modified
 * @param {Float32Array} onsets0 flat onsets (nFrames * 88), not modified
 * @returns {{startFrame:number,durationFrames:number,pitchMidi:number,amplitude:number}[]}
 */
export function notesPoly(frames0, onsets0, {
  onsetThresh = 0.5,
  frameThresh = 0.3,
  minNoteLen = 5,
  minMidi = 21,
  maxMidi = 108,
  melodia = true,
  energyTolerance = 11,
} = {}) {
  const P = N_PITCHES;
  const n = frames0.length / P;
  const lo = Math.max(0, minMidi - MIDI_OFFSET);
  const hi = Math.min(P - 1, maxMidi - MIDI_OFFSET);

  // Copies restricted to the requested pitch range.
  const frames = new Float32Array(frames0.length);
  const onsets = new Float32Array(onsets0.length);
  for (let i = 0; i < n; i++) {
    const r = i * P;
    for (let c = lo; c <= hi; c++) {
      frames[r + c] = frames0[r + c];
      onsets[r + c] = onsets0[r + c];
    }
  }

  // Inferred onsets: max(onsets, scaled positive frame difference over 1-2 frames).
  // Kept in float64, like the original, so threshold comparisons match exactly.
  const frameDiff = (r, c) => {
    const x = frames[r + c];
    return Math.max(0, Math.min(x - frames[r - P + c], x - frames[r - 2 * P + c]));
  };
  let onsetMax = 0, diffMax = 0;
  for (let i = 0; i < n; i++) {
    const r = i * P;
    for (let c = 0; c < P; c++) {
      if (onsets[r + c] > onsetMax) onsetMax = onsets[r + c];
      if (i >= 2) { const d = frameDiff(r, c); if (d > diffMax) diffMax = d; }
    }
  }
  const inferred = new Float64Array(frames.length);
  for (let i = 0; i < n; i++) {
    const r = i * P;
    for (let c = 0; c < P; c++) {
      const d = i >= 2 && diffMax > 0 ? (onsetMax * frameDiff(r, c)) / diffMax : 0;
      inferred[r + c] = Math.max(onsets[r + c], d);
    }
  }

  // Onset peaks (strict local maxima in time) above the threshold.
  const starts = [];
  for (let i = 0; i < n; i++) {
    const r = i * P;
    for (let c = 0; c < P; c++) {
      const v = inferred[r + c];
      if (v <= onsetThresh) continue;
      if (i > 0 && !(v > inferred[r - P + c])) continue;
      if (i < n - 1 && !(v > inferred[r + P + c])) continue;
      starts.push(r + c);
    }
  }
  starts.reverse();

  const remaining = frames.slice();
  const clear = (i, c) => {
    const r = i * P;
    remaining[r + c] = 0;
    if (c < MAX_FREQ_IDX) remaining[r + c + 1] = 0;
    if (c > 0) remaining[r + c - 1] = 0;
  };
  const meanEnergy = (from, to, c) => {
    let s = 0;
    for (let j = from; j < to; j++) s += frames[j * P + c];
    return s / (to - from);
  };

  const notes = [];
  for (const idx of starts) {
    const start = Math.floor(idx / P);
    const c = idx % P;
    if (start >= n - 1) continue;
    let i = start + 1;
    let k = 0;
    while (i < n - 1 && k < energyTolerance) {
      k = remaining[i * P + c] < frameThresh ? k + 1 : 0;
      i += 1;
    }
    i -= k;
    if (i - start <= minNoteLen) continue;
    for (let j = start; j < i; j++) clear(j, c);
    notes.push({ startFrame: start, durationFrames: i - start, pitchMidi: c + MIDI_OFFSET, amplitude: meanEnergy(start, i, c) });
  }

  if (melodia) {
    // Cells only ever get zeroed, so "the current global max" is simply the next
    // cell, in descending order of energy, that hasn't been zeroed yet.
    let count = 0;
    for (let k = 0; k < remaining.length; k++) if (remaining[k] > frameThresh) count++;
    const cells = new Uint32Array(count);
    for (let k = 0, m = 0; k < remaining.length; k++) if (remaining[k] > frameThresh) cells[m++] = k;
    const energy = remaining.slice();
    cells.sort((a, b) => energy[b] - energy[a]);

    for (const idx of cells) {
      if (!(remaining[idx] > frameThresh)) continue; // already consumed by a previous note
      const mid = Math.floor(idx / P);
      const c = idx % P;
      remaining[idx] = 0;

      let i = mid + 1;
      let k = 0;
      while (i < n - 1 && k < energyTolerance) {
        k = remaining[i * P + c] < frameThresh ? k + 1 : 0;
        clear(i, c);
        i += 1;
      }
      const end = i - 1 - k;

      i = mid - 1;
      k = 0;
      while (i > 0 && k < energyTolerance) {
        k = remaining[i * P + c] < frameThresh ? k + 1 : 0;
        clear(i, c);
        i -= 1;
      }
      const start = i + 1 + k;

      if (end - start <= minNoteLen) continue;
      notes.push({ startFrame: start, durationFrames: end - start, pitchMidi: c + MIDI_OFFSET, amplitude: meanEnergy(start, end, c) });
    }
  }
  return notes;
}
