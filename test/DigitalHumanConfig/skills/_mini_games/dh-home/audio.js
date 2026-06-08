// =================== 音效模块 ===================
// WebAudio 合成音效，无需外部资源

let _audioCtx = null;

function getCtx() {
  if (!_audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    _audioCtx = new Ctx();
  }
  if (_audioCtx.state === 'suspended') { _audioCtx.resume(); }
  return _audioCtx;
}

function playNotes(notes, volume = 0.18) {
  const ctx = getCtx();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
    notes.forEach(n => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = n.type || 'triangle';
      osc.frequency.setValueAtTime(n.f, now + n.t);
      g.gain.setValueAtTime(0.0001, now + n.t);
      g.gain.exponentialRampToValueAtTime(0.6, now + n.t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + n.t + (n.dur || 0.18));
      osc.connect(g);
      g.connect(master);
      osc.start(now + n.t);
      osc.stop(now + n.t + (n.dur || 0.2));
    });
  } catch (err) { /* ignore audio errors */ }
}

/** 拖拽开始音效：C5 → E5 双音 */
export function playDragTone() {
  playNotes([
    { f: 523.25, t: 0.00 },
    { f: 659.25, t: 0.06 },
  ]);
}

/** 放置成功音效：短促和弦 C5+E5 */
export function playPlaceTone() {
  playNotes([
    { f: 523.25, t: 0.00 },
    { f: 659.25, t: 0.00 },
  ], 0.12);
}

/** 点击物品音效：清脆木琴 C5 */
export function playTapTone() {
  playNotes([
    { f: 523.25, t: 0.00, dur: 0.12 },
  ], 0.15);
}

/** 删除/撤销音效：下降音 E4→C4 */
export function playDeleteTone() {
  playNotes([
    { f: 329.63, t: 0.00 },
    { f: 261.63, t: 0.08 },
  ], 0.12);
}

/** 引导推进 "叮" G5 */
export function playDingTone() {
  playNotes([
    { f: 783.99, t: 0.00, dur: 0.25 },
  ], 0.14);
}
