import * as tf from '@tensorflow/tfjs';
import {
  BasicPitch,
  outputToNotesPoly,
  addPitchBendsToNoteEvents,
  noteFramesToTime,
} from '@spotify/basic-pitch';
import { Midi } from '@tonejs/midi';
import { Soundfont } from 'smplr';

const $ = (s) => document.querySelector(s);
const SR = 22050;

const state = {
  file: null,
  origUrl: null,
  audioBuffer: null, // original (for playback)
  frames: null,
  onsets: null,
  contours: null,
  notes: [], // NoteEventTime[]
  playing: null,
};

let basicPitch = null;
function getModel() {
  if (!basicPitch) basicPitch = new BasicPitch('model/model.json');
  return basicPitch;
}

/* ---------- UI helpers ---------- */
function show(id) {
  ['#step-drop', '#step-work', '#step-result'].forEach((s) =>
    $(s).classList.toggle('hidden', s !== id),
  );
}
function setProgress(p, label) {
  $('#bar').style.width = `${Math.round(p * 100)}%`;
  $('#pct').textContent = `${Math.round(p * 100)} %`;
  if (label) $('#work-label').textContent = label;
}
const funny = [
  'L’IA tend l’oreille… 👂',
  'Chasse aux notes en cours 🎯',
  'On démêle les accords 🧶',
  'Traduction du son en petits carrés 🟪',
  'Presque fini, promis 🤞',
];

/* ---------- Audio decoding ---------- */
async function decodeFile(file) {
  const buf = await file.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await ctx.decodeAudioData(buf);
  ctx.close();
  return decoded;
}

async function resampleMono(audioBuffer) {
  const length = Math.ceil(audioBuffer.duration * SR);
  const off = new OfflineAudioContext(1, length, SR);
  const src = off.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(off.destination);
  src.start();
  return off.startRendering();
}

/* ---------- Pipeline ---------- */
async function handleFile(file) {
  if (!file) return;
  if (state.origUrl) URL.revokeObjectURL(state.origUrl);
  state.origUrl = null;
  state.file = file;
  show('#step-work');
  setProgress(0, 'Décodage de l’audio… 🎧');
  try {
    state.audioBuffer = await decodeFile(file);
    const mono = await resampleMono(state.audioBuffer);
    setProgress(0, 'Chargement de l’IA… 🧠');
    const bp = getModel();
    await bp.model;
    const frames = [], onsets = [], contours = [];
    let i = 0;
    const t0 = performance.now();
    await bp.evaluateModel(
      mono,
      (f, o, c) => {
        frames.push(...f);
        onsets.push(...o);
        contours.push(...c);
      },
      (p) => {
        if (p > (i + 1) / funny.length) i = Math.min(i + 1, funny.length - 1);
        setProgress(p, funny[i]);
      },
    );
    state.frames = frames;
    state.onsets = onsets;
    state.contours = contours;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    $('#file-info').textContent =
      `${file.name} · ${fmtTime(state.audioBuffer.duration)} · analysé en ${secs} s`;
    $('#base-name').value = file.name.replace(/\.[^.]+$/, '');
    show('#step-result');
    recompute();
    loadInstrument(settings().program);
  } catch (e) {
    console.error(e);
    show('#step-drop');
    toast(`Oups, impossible de lire ce fichier 😵 (${e.message || e})`);
  }
}

function settings() {
  return {
    onset: 1 - parseFloat($('#sens').value), // higher sensitivity → lower threshold
    frame: parseFloat($('#frameT').value),
    minLenMs: parseFloat($('#minLen').value),
    minAmp: parseFloat($('#minAmp').value),
    minMidi: parseInt($('#minNote').value, 10),
    maxMidi: parseInt($('#maxNote').value, 10),
    melodia: $('#melodia').checked,
    bends: $('#bends').checked,
    bpm: Math.min(300, Math.max(30, parseFloat($('#bpm').value) || 120)),
    quant: parseInt($('#quant').value, 10), // 0 = off, else subdivisions per beat
    program: parseInt($('#program').value, 10),
  };
}

const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

function recompute() {
  if (!state.frames) return;
  const s = settings();
  // frames are ~11.6 ms each (256 hop @ 22050)
  const minLenFrames = Math.max(1, Math.round(s.minLenMs / (1000 * 256 / SR)));
  let ev = outputToNotesPoly(
    state.frames,
    state.onsets,
    s.onset,
    s.frame,
    minLenFrames,
    true,
    midiToHz(s.maxMidi + 0.5),
    midiToHz(s.minMidi - 0.5),
    s.melodia,
  );
  if (s.bends) ev = addPitchBendsToNoteEvents(state.contours, ev);
  let notes = noteFramesToTime(ev).filter(
    (n) => n.pitchMidi >= s.minMidi && n.pitchMidi <= s.maxMidi && n.amplitude >= s.minAmp,
  );
  if (s.quant > 0) {
    const step = 60 / s.bpm / s.quant;
    notes = notes.map((n) => {
      const st = Math.round(n.startTimeSeconds / step) * step;
      const end = Math.max(st + step, Math.round((n.startTimeSeconds + n.durationSeconds) / step) * step);
      return { ...n, startTimeSeconds: st, durationSeconds: end - st };
    });
  }
  notes.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds || a.pitchMidi - b.pitchMidi);
  state.notes = notes;
  $('#note-count').textContent = `${notes.length} note${notes.length > 1 ? 's' : ''} détectée${notes.length > 1 ? 's' : ''}`;
  drawRoll();
}

/* ---------- MIDI export ---------- */
function buildMidi() {
  const s = settings();
  const midi = new Midi();
  midi.header.setTempo(s.bpm);
  midi.header.name = $('#base-name').value || 'midifieur';
  const track = midi.addTrack();
  track.name = midi.header.name;
  track.instrument.number = s.program;
  track.channel = s.program === -1 ? 9 : 0;
  for (const n of state.notes) {
    track.addNote({
      midi: n.pitchMidi,
      time: n.startTimeSeconds,
      duration: Math.max(0.01, n.durationSeconds),
      velocity: Math.min(1, Math.max(0.15, n.amplitude)),
    });
    if (s.bends && n.pitchBends && n.pitchBends.length) {
      // pitchBends are in 1/3 semitone bins, one per frame; default bend range ±2 semitones
      const fr = 256 / SR;
      n.pitchBends.forEach((b, k) => {
        track.addPitchBend({ time: n.startTimeSeconds + k * fr, value: Math.max(-1, Math.min(1, b / 3 / 2)) });
      });
      track.addPitchBend({ time: n.startTimeSeconds + n.durationSeconds, value: 0 });
    }
  }
  return midi.toArray();
}

function download() {
  if (!state.notes.length) return toast('Aucune note à exporter 🤷');
  const data = buildMidi();
  const blob = new Blob([data], { type: 'audio/midi' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${($('#base-name').value || 'midifieur').trim()}.mid`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('MIDI téléchargé 🎉');
}

/* ---------- Piano roll ---------- */
function drawRoll(playhead = null) {
  const cv = $('#roll');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== W * dpr || cv.height !== H * dpr) {
    cv.width = W * dpr;
    cv.height = H * dpr;
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const notes = state.notes;
  const dur = state.audioBuffer ? state.audioBuffer.duration : 1;
  let lo = 127, hi = 0;
  for (const n of notes) { lo = Math.min(lo, n.pitchMidi); hi = Math.max(hi, n.pitchMidi); }
  if (lo > hi) { lo = 48; hi = 72; }
  lo -= 2; hi += 2;
  const rows = hi - lo + 1;
  const rh = H / rows;
  // background rows (black keys darker)
  for (let p = lo; p <= hi; p++) {
    const black = [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
    g.fillStyle = black ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.05)';
    g.fillRect(0, H - (p - lo + 1) * rh, W, rh - 0.5);
    if (p % 12 === 0 && rh > 6) {
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.font = '10px system-ui';
      g.fillText(`Do${p / 12 - 1}`, 3, H - (p - lo) * rh - 2);
    }
  }
  const xs = W / dur;
  for (const n of notes) {
    const x = n.startTimeSeconds * xs;
    const w = Math.max(2, n.durationSeconds * xs);
    const y = H - (n.pitchMidi - lo + 1) * rh;
    const hue = 260 + (n.pitchMidi % 12) * 8;
    g.fillStyle = `hsla(${hue}, 85%, ${45 + n.amplitude * 25}%, 0.95)`;
    g.beginPath();
    g.roundRect ? g.roundRect(x, y + 0.5, w, Math.max(1.5, rh - 1), 2) : g.rect(x, y + 0.5, w, Math.max(1.5, rh - 1));
    g.fill();
  }
  if (playhead != null) {
    g.fillStyle = '#ffd166';
    g.fillRect(playhead * xs, 0, 2, H);
  }
}

/* ---------- Playback ---------- */
// iOS: Web Audio is muted by the silent switch unless the audio session is
// "playback". Safari 16.4+ exposes navigator.audioSession; older versions get
// the same effect while an <audio> element is playing, so we loop a silent one.
const SILENT_WAV = (() => {
  const n = 2205, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 22050, true); v.setUint32(28, 44100, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
})();
let silentEl = null;
function unlockAudioSession() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  if (!silentEl) {
    silentEl = new Audio(SILENT_WAV);
    silentEl.loop = true;
    silentEl.setAttribute('playsinline', '');
  }
  silentEl.play().catch(() => {});
}

let audioCtx = null;
function getCtx(resume = true) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AC();
  if (resume && audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function stop() {
  if (!state.playing) return;
  const p = state.playing;
  state.playing = null;
  cancelAnimationFrame(p.raf);
  if (p.out) {
    try {
      p.out.gain.setTargetAtTime(0, p.ctx.currentTime, 0.01);
      setTimeout(() => p.out.disconnect(), 100);
    } catch {}
  }
  if (p.inst) { try { p.inst.stop(); } catch {} }
  if (p.audio) { p.audio.pause(); p.audio.currentTime = 0; }
  if (silentEl) silentEl.pause();
  $('#play-midi').textContent = '▶️ Écouter le MIDI';
  $('#play-orig').textContent = '🎧 Écouter l’original';
  drawRoll();
}

function startPlayhead(getTime) {
  const tick = () => {
    if (!state.playing) return;
    const t = getTime();
    drawRoll(t);
    if (t > state.audioBuffer.duration + 0.3) return stop();
    state.playing.raf = requestAnimationFrame(tick);
  };
  tick();
}

// Real instrument samples (General MIDI soundfonts), one per program.
const GM_NAMES = {
  0: 'acoustic_grand_piano', 4: 'electric_piano_1', 24: 'acoustic_guitar_nylon',
  29: 'overdriven_guitar', 33: 'electric_bass_finger', 48: 'string_ensemble_1',
  52: 'choir_aahs', 73: 'flute', 80: 'lead_1_square',
};
const instruments = {}; // program -> { inst, ready: Promise<boolean> }
function loadInstrument(program) {
  const name = GM_NAMES[program];
  if (!name) return null;
  const ctx = getCtx(false);
  if (!instruments[program] || instruments[program].ctx !== ctx) {
    const inst = Soundfont(ctx, { instrument: name, kit: 'MusyngKite' });
    const ready = inst.ready.then(() => true).catch((e) => { console.warn('soundfont', e); return false; });
    instruments[program] = { inst, ready, ctx, ok: null };
    ready.then((ok) => { instruments[program].ok = ok; });
  }
  return instruments[program];
}

function playSynth(ctx, out, now) {
  const master = ctx.createGain();
  master.gain.value = 0.25;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp).connect(out);
  for (const n of state.notes) {
    const t = now + n.startTimeSeconds;
    const d = Math.max(0.05, n.durationSeconds);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midiToHz(n.pitchMidi);
    const gn = ctx.createGain();
    const v = 0.2 + n.amplitude * 0.6;
    gn.gain.setValueAtTime(0, t);
    gn.gain.linearRampToValueAtTime(v, t + 0.008);
    gn.gain.exponentialRampToValueAtTime(v * 0.4, t + Math.min(d, 0.3));
    gn.gain.setValueAtTime(v * 0.4, t + d);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.12);
    o.connect(gn).connect(master);
    o.start(t);
    o.stop(t + d + 0.15);
  }
}

async function playMidi() {
  if (state.playing) { const was = state.playing.kind; stop(); if (was === 'midi') return; }
  if (!state.notes.length) return toast('Aucune note à jouer 🤷');
  unlockAudioSession();
  const ctx = getCtx();
  const token = {};
  state.playing = { ctx, kind: 'midi', token };
  $('#play-midi').textContent = '⏹️ Stop';
  const entry = loadInstrument(settings().program);
  let inst = null;
  if (entry) {
    if (entry.ok === null) {
      $('#play-midi').textContent = '⏳ Chargement…';
      toast('On sort le vrai instrument du placard… 🎻');
    }
    if (await entry.ready) inst = entry.inst;
    else toast('Sons introuvables (connexion ?), on joue la version synthé 🤖');
    if (!state.playing || state.playing.token !== token) return; // stopped meanwhile
    $('#play-midi').textContent = '⏹️ Stop';
  }
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const now = ctx.currentTime + 0.1;
  if (inst) {
    for (const n of state.notes) {
      inst.start({
        note: n.pitchMidi,
        velocity: Math.round(30 + Math.min(1, n.amplitude) * 97),
        time: now + n.startTimeSeconds,
        duration: Math.max(0.05, n.durationSeconds),
      });
    }
  } else {
    playSynth(ctx, out, now);
  }
  Object.assign(state.playing, { out, inst });
  startPlayhead(() => ctx.currentTime - now);
}

function playOrig() {
  if (state.playing) { const was = state.playing.kind; stop(); if (was === 'orig') return; }
  // A plain <audio> element plays even with the iPhone silent switch on.
  if (!state.origUrl) state.origUrl = URL.createObjectURL(state.file);
  const audio = new Audio(state.origUrl);
  audio.setAttribute('playsinline', '');
  audio.onended = () => stop();
  audio.play().catch((e) => { stop(); toast(`Lecture impossible 😵 (${e.message || e})`); });
  state.playing = { audio, kind: 'orig' };
  $('#play-orig').textContent = '⏹️ Stop';
  startPlayhead(() => audio.currentTime);
}

/* ---------- Misc ---------- */
function fmtTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
const NOTE_NAMES = ['Do', 'Do#', 'Ré', 'Ré#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
const noteName = (m) => `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 3200);
}

const PRESETS = {
  piano: { sens: 0.5, frameT: 0.3, minLen: 58, minAmp: 0.4, minNote: 21, maxNote: 108, melodia: true },
  voix: { sens: 0.4, frameT: 0.35, minLen: 90, minAmp: 0.35, minNote: 40, maxNote: 84, melodia: true },
  guitare: { sens: 0.5, frameT: 0.3, minLen: 58, minAmp: 0.35, minNote: 40, maxNote: 88, melodia: true },
  basse: { sens: 0.45, frameT: 0.3, minLen: 80, minAmp: 0.35, minNote: 28, maxNote: 60, melodia: true },
  tout: { sens: 0.55, frameT: 0.25, minLen: 46, minAmp: 0.25, minNote: 21, maxNote: 108, melodia: true },
};
function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  for (const k of ['sens', 'frameT', 'minLen', 'minAmp', 'minNote', 'maxNote']) $(`#${k}`).value = p[k];
  $('#melodia').checked = p.melodia;
  updateLabels();
  recompute();
}

function updateLabels() {
  $('#sens-v').textContent = `${Math.round(parseFloat($('#sens').value) * 100)} %`;
  $('#frameT-v').textContent = parseFloat($('#frameT').value).toFixed(2);
  $('#minLen-v').textContent = `${$('#minLen').value} ms`;
  $('#minAmp-v').textContent = `${Math.round(parseFloat($('#minAmp').value) * 100)} %`;
  let lo = parseInt($('#minNote').value, 10), hi = parseInt($('#maxNote').value, 10);
  if (lo > hi) { $('#maxNote').value = lo; hi = lo; }
  $('#minNote-v').textContent = noteName(lo);
  $('#maxNote-v').textContent = noteName(hi);
}

/* ---------- Wiring ---------- */
function init() {
  const drop = $('#drop');
  const input = $('#file');
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => handleFile(input.files[0]));
  ['dragenter', 'dragover'].forEach((e) =>
    drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over'); }),
  );
  ['dragleave', 'drop'].forEach((e) =>
    drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove('over'); }),
  );
  drop.addEventListener('drop', (ev) => handleFile(ev.dataTransfer.files[0]));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  let deb;
  document.querySelectorAll('#controls input, #controls select').forEach((el) =>
    el.addEventListener('input', () => {
      updateLabels();
      if (['sens', 'frameT', 'minLen', 'minAmp', 'minNote', 'maxNote', 'melodia'].includes(el.id)) $('#preset').value = 'perso';
      clearTimeout(deb);
      deb = setTimeout(recompute, 60);
    }),
  );
  $('#preset').addEventListener('change', (e) => applyPreset(e.target.value));
  $('#program').addEventListener('change', () => loadInstrument(settings().program));
  $('#download').addEventListener('click', download);
  $('#play-midi').addEventListener('click', playMidi);
  $('#play-orig').addEventListener('click', playOrig);
  $('#again').addEventListener('click', () => {
    stop();
    if (state.origUrl) URL.revokeObjectURL(state.origUrl);
    Object.assign(state, { frames: null, onsets: null, contours: null, notes: [], origUrl: null });
    input.value = '';
    show('#step-drop');
  });
  window.addEventListener('resize', () => drawRoll());
  updateLabels();
  // preload the model while the user picks a file
  tf.ready().then(() => getModel().model).catch(() => {});
}

init();
window.__midifieur = { state, handleFile, recompute, buildMidi };
