// =================== AI 场景指令（增强版） ===================

import { focusItem, highlightItem } from './camera.js';
import { items } from './scene.js';
import { playDingTone, playTapTone } from './audio.js';
import { emitStars } from './particles.js';

let _sceneCommandEl = null;
let _observer = null;
let _queue = [];
let _queueRunning = false;
const DEFAULT_FEEDBACK_STYLE = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%) scale(0.5);font-size:48px;opacity:0;transition:all 360ms ease;pointer-events:none;z-index:60';

function buildSkillModalFrameOptions() {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 10;
  const top = Math.max(8.8 * rem, 24);
  const bottom = Math.max(1.6 * rem, 16);
  const rightReserved = 36 * rem;
  const availableWidth = Math.max(window.innerWidth - rightReserved, 360);
  const availableHeight = Math.max(window.innerHeight - top - bottom, 320);
  const width = Math.min(Math.round(availableWidth * 0.8), 800);
  const height = Math.min(Math.round(availableHeight * 0.86), 700);
  const left = Math.max(16, Math.round((availableWidth - width) / 2));
  const modalTop = Math.max(top, Math.round(top + (availableHeight - height) / 2));

  return {
    left: `${left}px`,
    top: `${modalTop}px`,
    width,
    height,
    backdrop: 'rgba(0,0,0,0.35)',
  };
}

export function initAICommands(sceneCommandEl) {
  _sceneCommandEl = sceneCommandEl;

  _observer = new MutationObserver(() => {
    const raw = (_sceneCommandEl.textContent || '').trim();
    if (!raw) return;
    const commands = parseCommands(raw);
    if (commands.length > 0) {
      enqueueCommands(commands);
    }
  });
  _observer.observe(sceneCommandEl, { childList: true, characterData: true, subtree: true });
}

// =================== 容错解析 ===================

function parseCommands(raw) {
  // 尝试直接 parse
  let parsed = tryParse(raw);
  if (parsed !== null) {
    return Array.isArray(parsed) ? parsed.filter(c => c && c.action) : [parsed].filter(c => c && c.action);
  }
  // 容错：单引号→双引号
  let fixed = raw.replace(/'/g, '"');
  parsed = tryParse(fixed);
  if (parsed !== null) {
    return Array.isArray(parsed) ? parsed.filter(c => c && c.action) : [parsed].filter(c => c && c.action);
  }
  // 容错：去尾部逗号
  fixed = fixed.replace(/,\s*([\]}])/g, '$1');
  parsed = tryParse(fixed);
  if (parsed !== null) {
    return Array.isArray(parsed) ? parsed.filter(c => c && c.action) : [parsed].filter(c => c && c.action);
  }
  // 解析彻底失败 → 通知 parent
  window.parent.postMessage({
    type: 'dh:commandError',
    error: 'JSON parse failed',
    raw: raw.slice(0, 200)
  }, '*');
  return [];
}

function tryParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

// =================== 指令队列 ===================

function enqueueCommands(commands) {
  _queue.push(...commands);
  if (!_queueRunning) runQueue();
}

async function runQueue() {
  _queueRunning = true;
  while (_queue.length > 0) {
    const cmd = _queue.shift();
    executeCommand(cmd);
    if (_queue.length > 0) {
      await delay(800);
    }
  }
  _queueRunning = false;
  window.parent.postMessage({ type: 'dh:commandDone' }, '*');
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// =================== 指令执行 ===================

function executeCommand(cmd) {
  switch (cmd.action) {
    case 'focus':
      if (cmd.target) {
        focusItem(cmd.target);
        // 目标微微上浮 + 柔光晕
        addGlow(cmd.target);
        setTimeout(() => removeGlow(cmd.target), 2000);
      }
      break;

    case 'highlight':
      if (cmd.target) {
        highlightItem(cmd.target);
        playDingTone();
        // 星星粒子
        const el = document.getElementById(cmd.target);
        if (el) {
          const rect = el.getBoundingClientRect();
          emitStars(rect.left + rect.width / 2, rect.top + rect.height / 2, 3);
        }
        if (cmd.text) showSpeech(cmd.target, cmd.text);
      }
      break;

    case 'say':
      if (!cmd.text) {
        break;
      }
      if (cmd.target) {
        showSpeech(cmd.target, cmd.text);
      } else {
        showNarration(cmd.text);
      }
      break;

    case 'shake':
      if (cmd.target) shakeItem(cmd.target);
      break;

    case 'dim':
      showDimOverlay(cmd.target);
      break;

    case 'pan':
      if (typeof cmd.x === 'number') {
        const stage = document.getElementById('stage');
        if (stage) stage.scrollTo({ left: Math.max(0, cmd.x), behavior: 'smooth' });
      }
      break;

    case 'recall':
      if (cmd.target) showRecallBubble(cmd.target, cmd.text || '');
      break;

    case 'openSkill':
      openSkill(cmd);
      break;

    case 'clear':
      clearAllEffects();
      break;
  }
}

function openSkill(cmd) {
  const skillPath = cmd.skillPath || cmd.promptFile || cmd.path;
  if (!skillPath) return;
  const layout = cmd.layout || 'modal';
  window.keepwork?.minigame?.openSkill({
    skillPath,
    title: cmd.title || cmd.gameTitle || '',
    layout,
    restorePolicy: cmd.restorePolicy || 'resumeParent',
    frameOptions: cmd.frameOptions || (layout === 'modal' ? buildSkillModalFrameOptions() : undefined),
  });
}

// =================== 效果 ===================

function addGlow(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.transition = 'transform 400ms cubic-bezier(0.34,1.56,0.64,1), filter 400ms ease';
  el.style.filter = 'drop-shadow(0 0 12px rgba(255,228,181,0.8)) drop-shadow(0 12px 18px rgba(0,0,0,0.45))';
  el.style.transform = 'translate(-50%, -100%) translateY(-6px)';
  el.dataset.glowing = '1';
}

function removeGlow(id) {
  const el = document.getElementById(id);
  if (!el || !el.dataset.glowing) return;
  el.style.filter = '';
  el.style.transform = '';
  delete el.dataset.glowing;
}

function shakeItem(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.transition = 'none';
  const keyframes = [
    { transform: 'translate(-50%, -100%) rotate(0deg)' },
    { transform: 'translate(-50%, -100%) rotate(4deg)' },
    { transform: 'translate(-50%, -100%) rotate(-4deg)' },
    { transform: 'translate(-50%, -100%) rotate(3deg)' },
    { transform: 'translate(-50%, -100%) rotate(-3deg)' },
    { transform: 'translate(-50%, -100%) rotate(0deg)' },
  ];
  el.animate(keyframes, { duration: 500, easing: 'cubic-bezier(0.34,1.56,0.64,1)' });
}

let _dimOverlay = null;
function showDimOverlay(targetId) {
  removeDimOverlay();
  _dimOverlay = document.createElement('div');
  _dimOverlay.className = 'dim-overlay';
  _dimOverlay.style.cssText = `
    position:fixed;inset:0;z-index:50;
    background:rgba(90,60,20,0.4);
    transition:opacity 400ms ease;opacity:0;pointer-events:none;
  `;
  document.body.appendChild(_dimOverlay);
  requestAnimationFrame(() => { _dimOverlay.style.opacity = '1'; });
  // 目标区域光晕
  if (targetId) {
    const el = document.getElementById(targetId);
    if (el) {
      el.style.zIndex = '51';
      el.style.position = el.style.position || 'relative';
      addGlow(targetId);
    }
  }
}

function removeDimOverlay() {
  if (_dimOverlay) {
    _dimOverlay.style.opacity = '0';
    const ref = _dimOverlay;
    setTimeout(() => ref.remove(), 400);
    _dimOverlay = null;
  }
}

function showRecallBubble(targetId, text) {
  const el = document.getElementById(targetId);
  if (!el) return;
  // 移除旧的
  const old = el.querySelector('.recall-bubble');
  if (old) old.remove();

  const bubble = document.createElement('div');
  bubble.className = 'recall-bubble';
  bubble.style.cssText = `
    position:absolute;left:50%;top:-70px;transform:translateX(-50%) scale(0.8);
    background:#FFFDF7;border:2px solid #8B6914;border-radius:16px;
    padding:10px 14px;font-size:13px;color:#4a3520;line-height:1.4;
    box-shadow:0 8px 24px rgba(90,60,20,0.2);
    max-width:200px;text-align:center;
    opacity:0;transition:transform 400ms cubic-bezier(0.34,1.56,0.64,1),opacity 300ms ease;
    z-index:10;white-space:normal;
  `;
  bubble.innerHTML = `<span style="font-size:18px;margin-right:4px">💭</span>${text}`;
  el.appendChild(bubble);
  requestAnimationFrame(() => {
    bubble.style.opacity = '1';
    bubble.style.transform = 'translateX(-50%) scale(1)';
  });
  // 自动移除
  setTimeout(() => {
    bubble.style.opacity = '0';
    bubble.style.transform = 'translateX(-50%) scale(0.8)';
    setTimeout(() => bubble.remove(), 350);
  }, 5000);
}

function showSpeech(targetId, text) {
  const el = document.getElementById(targetId);
  if (!el) return;
  let bubble = el.querySelector('.speech');
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.className = 'speech';
    bubble.style.cssText = `
      position:absolute;left:50%;top:-52px;transform:translateX(-50%) scale(0.8);
      background:#FFFDF7;color:#4a3520;font-size:13px;
      padding:10px 14px;border-radius:16px;
      border:2px solid #8B6914;
      box-shadow:0 6px 18px rgba(90,60,20,0.2);
      max-width:240px;text-align:center;white-space:normal;
      opacity:0;transition:transform 350ms cubic-bezier(0.34,1.56,0.64,1),opacity 250ms ease;
      z-index:5;
    `;
    // 小尾巴
    const tail = document.createElement('div');
    tail.style.cssText = `
      position:absolute;left:50%;bottom:-8px;transform:translateX(-50%);
      width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;
      border-top:8px solid #FFFDF7;
    `;
    bubble.appendChild(tail);
    el.appendChild(bubble);
  }
  // 插入文本（保留尾巴）
  const tail = bubble.querySelector('div');
  bubble.textContent = text;
  if (tail) bubble.appendChild(tail);

  requestAnimationFrame(() => {
    bubble.style.opacity = '1';
    bubble.style.transform = 'translateX(-50%) scale(1)';
  });
  clearTimeout(bubble._t);
  bubble._t = setTimeout(() => {
    bubble.style.opacity = '0';
    bubble.style.transform = 'translateX(-50%) scale(0.8)';
    setTimeout(() => bubble.remove(), 350);
  }, 4000);
}

function showNarration(text) {
  const feedback = document.getElementById('feedback');
  if (!feedback) return;

  feedback.style.cssText = `
    position:fixed;right:24px;top:24px;left:auto;bottom:auto;
    max-width:320px;min-width:160px;
    padding:14px 18px;
    background:#FFFDF7;color:#4a3520;
    border:2px solid #8B6914;
    border-radius:26px 26px 26px 20px;
    box-shadow:0 10px 28px rgba(90,60,20,0.22);
    font-size:15px;line-height:1.6;font-weight:500;
    opacity:0;transform:translateY(-8px) scale(0.92);
    transition:transform 350ms cubic-bezier(0.34,1.56,0.64,1),opacity 250ms ease;
    pointer-events:none;z-index:60;
  `;

  feedback.textContent = '';
  const textEl = document.createElement('div');
  textEl.textContent = text;
  textEl.style.cssText = 'position:relative;z-index:2;white-space:normal;text-align:left;';

  const tail = document.createElement('div');
  tail.style.cssText = `
    position:absolute;right:22px;top:-11px;
    width:18px;height:18px;
    background:#FFFDF7;
    border-top:2px solid #8B6914;
    border-right:2px solid #8B6914;
    border-radius:0 8px 0 0;
    transform:rotate(-45deg);
    z-index:1;
  `;

  feedback.appendChild(tail);
  feedback.appendChild(textEl);
  feedback.style.opacity = '1';
  feedback.style.transform = 'translateY(0) scale(1)';

  clearTimeout(feedback._t);
  feedback._t = setTimeout(() => {
    feedback.style.opacity = '0';
    feedback.style.transform = 'translateY(-8px) scale(0.92)';
  }, 3200);
}

function clearAllEffects() {
  removeDimOverlay();
  // 移除所有 glow
  document.querySelectorAll('[data-glowing]').forEach(el => {
    el.style.filter = '';
    el.style.transform = '';
    el.style.zIndex = '';
    delete el.dataset.glowing;
  });
  // 移除所有气泡
  document.querySelectorAll('.speech, .recall-bubble').forEach(el => el.remove());
  const feedback = document.getElementById('feedback');
  if (feedback) {
    clearTimeout(feedback._t);
    feedback.style.cssText = DEFAULT_FEEDBACK_STYLE;
    feedback.style.opacity = '0';
    feedback.style.transform = 'translate(-50%,-50%) scale(0.5)';
    feedback.textContent = '';
  }
}
