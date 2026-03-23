const KEYS = [
    { note: 'B4',  freq: 493.88,  color: '#7B68EE', label: 'B4',  kbd: ['1', 'a'] },
    { note: 'C#5', freq: 554.37,  color: '#4A6CF7', label: 'C#5', kbd: ['2', 's'] },
    { note: 'D#5', freq: 622.25,  color: '#4A90D9', label: 'D#5', kbd: ['3', 'd'] },
    { note: 'E5',  freq: 659.25,  color: '#42D4E8', label: 'E5',  kbd: ['4', 'f'] },
    { note: 'F#5', freq: 739.99,  color: '#48C774', label: 'F#5', kbd: ['5', 'g'] },
    { note: 'G#5', freq: 830.61,  color: '#FFD93D', label: 'G#5', kbd: ['6', 'h'] },
    { note: 'A5',  freq: 880.00,  color: '#FF9F43', label: 'A5',  kbd: ['7', 'j'] },
    { note: 'B5',  freq: 987.77,  color: '#FF6B6B', label: 'B5',  kbd: ['8', 'k'] },
    { note: 'C#6', freq: 1108.73, color: '#EE5A9F', label: 'C#6', kbd: ['9', 'l'] },
    { note: 'E6',  freq: 1318.51, color: '#CC66CC', label: 'E6',  kbd: ['0', ';'] },
];

const NOTE_FREQ = {};
KEYS.forEach(k => { NOTE_FREQ[k.note] = k.freq; });

// Bluey Theme Song — Key of E major
// Transcribed from the Joff Bush original (main melody, simplified for keyboard)
const BLUEY_THEME = [
    // Phrase 1 — iconic descending opening
    { note: 'G#5', dur: 0.20, gap: 0.26 },
    { note: 'F#5', dur: 0.20, gap: 0.26 },
    { note: 'E5',  dur: 0.20, gap: 0.26 },
    { note: 'D#5', dur: 0.55, gap: 0.78 },
    { note: 'B4',  dur: 0.15, gap: 0.20 },
    { note: 'C#5', dur: 0.42, gap: 0.56 },
    { note: 'E5',  dur: 0.26, gap: 0.36 },
    { note: 'C#5', dur: 0.20, gap: 0.26 },

    // Phrase 2 — quick pickup into repeat
    { note: 'E5',  dur: 0.10, gap: 0.13 },
    { note: 'C#5', dur: 0.10, gap: 0.13 },
    { note: 'B4',  dur: 0.26, gap: 0.42 },
    { note: 'G#5', dur: 0.20, gap: 0.26 },
    { note: 'F#5', dur: 0.20, gap: 0.26 },
    { note: 'E5',  dur: 0.20, gap: 0.26 },
    { note: 'D#5', dur: 0.55, gap: 0.78 },
    { note: 'C#5', dur: 0.42, gap: 0.62 },

    // Bridge — lyrical middle section
    { note: 'E5',  dur: 0.32, gap: 0.42 },
    { note: 'C#5', dur: 0.32, gap: 0.42 },
    { note: 'B4',  dur: 0.20, gap: 0.30 },
    { note: 'C#5', dur: 0.32, gap: 0.42 },
    { note: 'E5',  dur: 0.32, gap: 0.42 },
    { note: 'B4',  dur: 0.26, gap: 0.46 },

    // Phrase 3 — reprise of opening
    { note: 'G#5', dur: 0.20, gap: 0.26 },
    { note: 'F#5', dur: 0.20, gap: 0.26 },
    { note: 'E5',  dur: 0.20, gap: 0.26 },
    { note: 'D#5', dur: 0.55, gap: 0.78 },
    { note: 'B4',  dur: 0.15, gap: 0.20 },
    { note: 'C#5', dur: 0.42, gap: 0.56 },
    { note: 'E5',  dur: 0.26, gap: 0.36 },
    { note: 'C#5', dur: 0.20, gap: 0.32 },

    // Ascending run — the exciting ending
    { note: 'C#5', dur: 0.14, gap: 0.16 },
    { note: 'E5',  dur: 0.11, gap: 0.13 },
    { note: 'D#5', dur: 0.11, gap: 0.13 },
    { note: 'E5',  dur: 0.11, gap: 0.13 },
    { note: 'F#5', dur: 0.11, gap: 0.13 },
    { note: 'E5',  dur: 0.11, gap: 0.13 },
    { note: 'F#5', dur: 0.11, gap: 0.13 },
    { note: 'G#5', dur: 0.11, gap: 0.13 },
    { note: 'F#5', dur: 0.11, gap: 0.13 },
    { note: 'G#5', dur: 0.11, gap: 0.13 },
    { note: 'A5',  dur: 0.11, gap: 0.13 },
    { note: 'G#5', dur: 0.11, gap: 0.13 },
    { note: 'A5',  dur: 0.11, gap: 0.13 },
    { note: 'B5',  dur: 0.11, gap: 0.13 },
    { note: 'A5',  dur: 0.11, gap: 0.13 },
    { note: 'B5',  dur: 0.18, gap: 0.23 },
    { note: 'C#6', dur: 0.24, gap: 0.30 },
    { note: 'C#6', dur: 0.24, gap: 0.30 },
    { note: 'E6',  dur: 0.55, gap: 0.60 },
];

let audioCtx = null;
let mode = 'free';       // 'free' | 'play' | 'learn'
let learnIndex = 0;
let score = 0;
let highscore = parseInt(localStorage.getItem('bluey-hs')) || 0;
let sleepReject = null;

const $ = id => document.getElementById(id);
const messageEl = $('message');
const scoreEl   = $('score');
const hsEl      = $('highscore');
const playBtn   = $('play-btn');
const learnBtn  = $('learn-btn');
const stopBtn   = $('stop-btn');
const keyboardEl = $('keyboard');

// ── Audio engine ────────────────────────────────────────────────

function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
}

function playNote(freq, duration = 0.3) {
    ensureAudio();
    const t = audioCtx.currentTime;

    // Fundamental
    const osc1 = audioCtx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.value = freq;

    // 4th partial for marimba-like brightness
    const osc2 = audioCtx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = freq * 4;

    const g1 = audioCtx.createGain();
    g1.gain.setValueAtTime(0.38, t);
    g1.gain.exponentialRampToValueAtTime(0.001, t + duration + 0.12);

    const g2 = audioCtx.createGain();
    g2.gain.setValueAtTime(0.07, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + duration * 0.35);

    osc1.connect(g1).connect(audioCtx.destination);
    osc2.connect(g2).connect(audioCtx.destination);

    osc1.start(t);
    osc2.start(t);
    osc1.stop(t + duration + 0.15);
    osc2.stop(t + duration * 0.35 + 0.05);
}

// ── Keyboard rendering ──────────────────────────────────────────

function renderKeyboard() {
    keyboardEl.innerHTML = '';
    KEYS.forEach(kd => {
        const el = document.createElement('button');
        el.className = 'piano-key';
        el.id = keyId(kd.note);
        el.style.backgroundColor = kd.color;
        el.style.setProperty('--key-color', kd.color);
        el.innerHTML =
            `<span class="note-label">${kd.label}</span>` +
            `<span class="key-shortcut">${kd.kbd[1].toUpperCase()}</span>`;
        el.addEventListener('mousedown', () => onPress(kd));
        el.addEventListener('touchstart', e => { e.preventDefault(); onPress(kd); });
        keyboardEl.appendChild(el);
    });
}

function keyId(note) { return 'k-' + note.replace('#', 's'); }

function flashKey(note, ms = 300) {
    const el = document.getElementById(keyId(note));
    if (!el) return;
    el.classList.add('glow');
    setTimeout(() => el.classList.remove('glow'), ms);
}

function hintKey(note) {
    const el = document.getElementById(keyId(note));
    if (el) el.classList.add('hint');
}

function clearHints() {
    keyboardEl.querySelectorAll('.piano-key').forEach(el =>
        el.classList.remove('hint', 'glow')
    );
}

// ── UI helpers ──────────────────────────────────────────────────

function msg(text, color) {
    messageEl.textContent = text || '\u00a0';
    if (color) messageEl.style.color = color;
}

function refreshScore() {
    scoreEl.textContent = score;
    if (score > highscore) {
        highscore = score;
        localStorage.setItem('bluey-hs', highscore);
    }
    hsEl.textContent = highscore;
}

function showControls(playing) {
    playBtn.style.display  = playing ? 'none' : '';
    learnBtn.style.display = playing ? 'none' : '';
    stopBtn.style.display  = playing ? '' : 'none';
}

// ── Key press handler ───────────────────────────────────────────

function onPress(kd) {
    ensureAudio();
    playNote(kd.freq, 0.3);
    flashKey(kd.note, 280);

    if (mode === 'learn') checkLearn(kd.note);
}

// ── Play Bluey Theme (auto) ─────────────────────────────────────

async function playBluey() {
    if (mode !== 'free') return;
    mode = 'play';
    showControls(true);
    msg('Playing Bluey Theme...', '#1B4F72');

    try {
        for (const { note, dur, gap } of BLUEY_THEME) {
            if (mode !== 'play') break;
            playNote(NOTE_FREQ[note], dur);
            flashKey(note, dur * 1000);
            await sleep(gap * 1000);
        }
        if (mode === 'play') msg('Bluey!', '#4A90D9');
    } catch (_) { /* cancelled */ }

    setTimeout(() => { if (mode !== 'learn') stopAll(); }, 800);
}

// ── Learn Mode ──────────────────────────────────────────────────

function startLearn() {
    if (mode !== 'free') return;
    mode = 'learn';
    learnIndex = 0;
    score = 0;
    refreshScore();
    showControls(true);
    promptNext();
}

function promptNext() {
    clearHints();
    if (learnIndex >= BLUEY_THEME.length) {
        msg(`Complete! ${score} / ${BLUEY_THEME.length}`, '#27AE60');
        setTimeout(stopAll, 1600);
        return;
    }
    const { note } = BLUEY_THEME[learnIndex];
    msg(`${learnIndex + 1}/${BLUEY_THEME.length}  —  Play ${note}`, '#1B4F72');
    hintKey(note);
}

function checkLearn(pressed) {
    const expected = BLUEY_THEME[learnIndex].note;
    if (pressed === expected) {
        score++;
        learnIndex++;
        refreshScore();
        promptNext();
    } else {
        msg(`Oops! Play ${expected}`, '#E74C3C');
    }
}

// ── Stop / reset ────────────────────────────────────────────────

function stopAll() {
    const wasPlaying = mode !== 'free';
    mode = 'free';
    if (sleepReject) { sleepReject(); sleepReject = null; }
    clearHints();
    showControls(false);
    if (wasPlaying) msg('');
}

// ── Utility ─────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise((resolve, reject) => {
        sleepReject = reject;
        const id = setTimeout(() => { sleepReject = null; resolve(); }, ms);
        sleepReject = () => { clearTimeout(id); reject(new Error('cancelled')); };
    });
}

// ── Keyboard input ──────────────────────────────────────────────

document.addEventListener('keydown', e => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    const kd = KEYS.find(x => x.kbd.includes(k));
    if (kd) { e.preventDefault(); onPress(kd); }
});

// ── Button handlers ─────────────────────────────────────────────

playBtn.addEventListener('click', playBluey);
learnBtn.addEventListener('click', startLearn);
stopBtn.addEventListener('click', stopAll);

// ── Init ────────────────────────────────────────────────────────

hsEl.textContent = highscore;
renderKeyboard();
