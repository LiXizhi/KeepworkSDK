// =================== 新手引导系统 ===================

import { focusItem, moved } from './camera.js';
import { playDingTone } from './audio.js';
import { emitConfetti } from './particles.js';

const GUIDE_KEY = 'dh_home_guided';
const STEPS = [
  {
    text: '欢迎回家~ 试试左右滑动看看吧！👆',
    gesture: 'swipe',
    check: 'scroll',
  },
  {
    text: '点一点家里的物品，和我聊聊吧~',
    gesture: 'tap',
    check: 'click',
  },
  {
    text: '点这里可以编辑你的小窝哦~ ✏️',
    gesture: 'point',
    check: 'edit',
    target: 'btnEdit',
  },
];

let _currentStep = 0;
let _overlay = null;
let _card = null;
let _dots = null;
let _gestureEl = null;
let _state = null;
let _resolve = null;

// =================== 公开 API ===================

/**
 * 如果用户未完成引导则显示，否则跳过。
 * 返回 Promise，引导完成后 resolve。
 */
export function showGuideIfNeeded(state) {
  _state = state;
  if (localStorage.getItem(GUIDE_KEY) === '1') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    _resolve = resolve;
    _currentStep = 0;
    createOverlay();
    showStep(0);
    bindListeners();
  });
}

// =================== 内部实现 ===================

function createOverlay() {
  // 遮罩层
  _overlay = document.createElement('div');
  _overlay.className = 'guide-overlay';
  _overlay.style.cssText = `
    position:fixed;inset:0;z-index:500;
    background:rgba(90,60,20,0.4);
    transition:opacity 300ms ease;
    pointer-events:none;
  `;

  // 引导卡片
  _card = document.createElement('div');
  _card.className = 'guide-card';
  _card.style.cssText = `
    position:fixed;left:50%;bottom:80px;transform:translateX(-50%) translateY(20px);
    background:#FFFDF7;border:2px solid #8B6914;border-radius:24px;
    padding:20px 28px 16px;max-width:320px;width:85vw;
    box-shadow:0 12px 36px rgba(90,60,20,0.25);
    font-size:16px;color:#4a3520;line-height:1.6;text-align:center;
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
    opacity:0;transition:transform 400ms cubic-bezier(0.34,1.56,0.64,1),opacity 300ms ease;
    z-index:501;pointer-events:none;
  `;

  // 小尾巴
  const tail = document.createElement('div');
  tail.style.cssText = `
    position:absolute;left:50%;bottom:-10px;transform:translateX(-50%);
    width:0;height:0;border-left:10px solid transparent;border-right:10px solid transparent;
    border-top:10px solid #FFFDF7;filter:drop-shadow(0 2px 2px rgba(90,60,20,0.15));
  `;
  _card.appendChild(tail);

  // 文本
  const textEl = document.createElement('div');
  textEl.className = 'guide-text';
  _card.appendChild(textEl);

  // 手势提示
  _gestureEl = document.createElement('div');
  _gestureEl.className = 'guide-gesture';
  _gestureEl.style.cssText = 'margin-top:12px;font-size:32px;animation:guide-float 1.5s ease-in-out infinite';
  _card.appendChild(_gestureEl);

  // 步骤圆点
  _dots = document.createElement('div');
  _dots.style.cssText = 'display:flex;gap:8px;justify-content:center;margin-top:14px;';
  for (let i = 0; i < STEPS.length; i++) {
    const dot = document.createElement('div');
    dot.style.cssText = `
      width:10px;height:10px;border-radius:50%;
      background:${i === 0 ? '#A8E6CF' : '#d4d4d4'};
      transition:background 300ms ease;
    `;
    _dots.appendChild(dot);
  }
  _card.appendChild(_dots);

  // 动画 keyframes
  if (!document.getElementById('guide-keyframes')) {
    const style = document.createElement('style');
    style.id = 'guide-keyframes';
    style.textContent = `
      @keyframes guide-float {
        0%,100% { transform: translateY(0); }
        50% { transform: translateY(-8px); }
      }
      @keyframes guide-swipe {
        0%,100% { transform: translateX(0); }
        50% { transform: translateX(20px); }
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(_overlay);
  document.body.appendChild(_card);

  // 触发弹入动画
  requestAnimationFrame(() => {
    _card.style.opacity = '1';
    _card.style.transform = 'translateX(-50%) translateY(0)';
  });
}

function showStep(idx) {
  _currentStep = idx;
  const step = STEPS[idx];
  const textEl = _card.querySelector('.guide-text');
  textEl.textContent = step.text;

  // 更新圆点
  const dots = _dots.children;
  for (let i = 0; i < dots.length; i++) {
    dots[i].style.background = i === idx ? '#A8E6CF' : i < idx ? '#5A8F7B' : '#d4d4d4';
  }

  // 手势图标
  if (step.gesture === 'swipe') {
    _gestureEl.textContent = '👆';
    _gestureEl.style.animation = 'guide-swipe 1.5s ease-in-out infinite';
  } else if (step.gesture === 'tap') {
    _gestureEl.textContent = '👆';
    _gestureEl.style.animation = 'guide-float 1.5s ease-in-out infinite';
  } else if (step.gesture === 'point') {
    _gestureEl.textContent = '👉';
    _gestureEl.style.animation = 'guide-float 1.5s ease-in-out infinite';
  }

  // 高亮目标
  if (step.target) {
    const targetEl = document.getElementById(step.target);
    if (targetEl) {
      targetEl.style.position = targetEl.style.position || 'relative';
      targetEl.style.zIndex = '502';
      targetEl.style.boxShadow = '0 0 0 4px rgba(168,230,207,0.6), 0 0 20px rgba(168,230,207,0.4)';
      targetEl.style.borderRadius = '50%';
    }
  }
}

function advanceStep() {
  playDingTone();

  // 清除上一步高亮
  const prevStep = STEPS[_currentStep];
  if (prevStep && prevStep.target) {
    const el = document.getElementById(prevStep.target);
    if (el) {
      el.style.zIndex = '';
      el.style.boxShadow = '';
      el.style.borderRadius = '';
    }
  }

  if (_currentStep + 1 >= STEPS.length) {
    completeGuide();
    return;
  }

  _currentStep++;
  // 弹出动画
  _card.style.transform = 'translateX(-50%) translateY(10px)';
  _card.style.opacity = '0.5';
  setTimeout(() => {
    showStep(_currentStep);
    _card.style.transform = 'translateX(-50%) translateY(0)';
    _card.style.opacity = '1';
  }, 200);
}

function completeGuide() {
  localStorage.setItem(GUIDE_KEY, '1');

  // 庆祝粒子
  const rect = _card.getBoundingClientRect();
  emitConfetti(rect.left + rect.width / 2, rect.top);

  // 移除 UI
  _card.style.opacity = '0';
  _card.style.transform = 'translateX(-50%) translateY(20px)';
  _overlay.style.opacity = '0';
  setTimeout(() => {
    _overlay.remove();
    _card.remove();
    _overlay = null;
    _card = null;
  }, 400);

  unbindListeners();

  // 通知 parent 可以开始对话
  window.parent.postMessage({ type: 'dh:guideComplete' }, '*');

  if (_resolve) { _resolve(); _resolve = null; }
}

// =================== 事件监听 ===================

let _scrolled = false;
let _clicked = false;

function onScroll() {
  if (_currentStep !== 0) return;
  const stage = document.getElementById('stage');
  if (stage && stage.scrollLeft > 20) {
    _scrolled = true;
    advanceStep();
  }
}

function onClick(e) {
  if (_currentStep === 1) {
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    if (hit && hit.closest('.item')) {
      _clicked = true;
      advanceStep();
      return;
    }
  }
  if (_currentStep === 2 && e.target.closest('#btnEdit')) {
    advanceStep();
  }
}

// pointerup 兜底：pointer capture 可能阻止 click 合成
function onPointerUp(e) {
  if (_currentStep !== 1) return;
  if (_clicked) return;
  if (moved) return; // 拖拽中不算点击
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  if (hit && hit.closest('.item')) {
    _clicked = true;
    advanceStep();
  }
}

function bindListeners() {
  const stage = document.getElementById('stage');
  if (stage) stage.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('click', onClick, true);
  document.addEventListener('pointerup', onPointerUp, true);
}

function unbindListeners() {
  const stage = document.getElementById('stage');
  if (stage) stage.removeEventListener('scroll', onScroll);
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('pointerup', onPointerUp, true);
}
