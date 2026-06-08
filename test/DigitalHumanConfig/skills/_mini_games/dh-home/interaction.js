// =================== 交互 / 结束逻辑 ===================

import { items } from './scene.js';
import { moved } from './camera.js';
import { playTapTone } from './audio.js';
import { emitStars } from './particles.js';
import { getStoriesFor, loadStories, appendMemory, saveStory } from './persistence.js';
import { showSkillBubble, hideSkillBubble } from './bubble.js';

let _state = null;
let _scene = null;
let _feedbackEl = null;
let _sessionStart = Date.now();
let _selectedItemEl = null; // 当前选中的物品 DOM

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

export function initInteraction(state, { scene, feedbackEl, btnFinish }) {
  _state = state;
  _scene = scene;
  _feedbackEl = feedbackEl;
  _sessionStart = Date.now();

  document.addEventListener('dh-home:scene-drag', clearSelection);

  // 预加载故事数据
  loadStories();

  // 点击物品 → dh:context（编辑模式下禁用）
  scene.addEventListener('click', onItemClick);

  // 点击空白区域 → 取消选中
  document.addEventListener('click', (e) => {
    if (_state.editMode) return;
    if (!e.target.closest('.item') && !e.target.closest('#catalog') && !e.target.closest('#btnEdit')) {
      clearSelection();
    }
  });

  // 结束按钮
  btnFinish.addEventListener('click', finishGame);
}

function showFeedback(emoji) {
  _feedbackEl.textContent = emoji;
  _feedbackEl.style.opacity = '1';
  _feedbackEl.style.transform = 'translate(-50%,-50%) scale(1)';
  setTimeout(() => {
    _feedbackEl.style.opacity = '0';
    _feedbackEl.style.transform = 'translate(-50%,-50%) scale(0.5)';
  }, 700);
}

function clearSelection() {
  if (_selectedItemEl) {
    _selectedItemEl.classList.remove('item-selected');
    // 恢复标签隐藏
    const label = _selectedItemEl.querySelector('.label');
    if (label) { label.style.opacity = '0'; label.style.display = ''; resetLabelPosition(label); }
    _selectedItemEl = null;
  }
  hideSkillBubble();
}

export { clearSelection as clearInteractionSelection };

/**
 * 根据物品在视口中的位置，动态调整标签方向：
 * 默认上方，上方空间不足则放下方，左右溢出则偏移。
 */
function adjustLabelPosition(label, itemEl) {
  const rect = itemEl.getBoundingClientRect();
  const labelH = 28; // 标签约高度（含间距）
  const margin = 8;

  if (rect.top < labelH + margin) {
    // 上方空间不足，放到物品下方
    label.style.top = 'auto';
    label.style.bottom = '-28px';
  }
}

function resetLabelPosition(label) {
  label.style.top = '';
  label.style.bottom = '';
}

function selectItem(el) {
  clearSelection();
  _selectedItemEl = el;
  el.classList.add('item-selected');
}

function onItemClick(e) {
  if (moved) return;
  if (_state.editMode) return;
  // 优先用 e.target，兜底用 elementFromPoint（防 pointer capture 残留）
  let itemEl = e.target.closest('.item');
  if (!itemEl) {
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    itemEl = hit?.closest('.item');
  }
  if (!itemEl) return;
  const id = itemEl.dataset.itemId;
  const item = items.find(x => x.id === id);
  if (!item) return;

  // 选中效果
  selectItem(itemEl);
  playTapTone();

  // 星星粒子
  const rect = itemEl.getBoundingClientRect();
  emitStars(rect.left + rect.width / 2, rect.top + rect.height / 2, 3);

  // 显示物品名称标签（动态位置：默认上方，溢出则下方）
  const label = itemEl.querySelector('.label');
  if (label) {
    adjustLabelPosition(label, itemEl);
    label.style.display = 'block';
    label.style.opacity = '1';
    setTimeout(() => {
      if (_selectedItemEl !== itemEl) {
        label.style.opacity = '0';
        setTimeout(() => { label.style.display = ''; resetLabelPosition(label); }, 200);
      }
    }, 3000);
  }

  if (!_state.interactedIds.has(id)) _state.interactedIds.add(id);
  _state.interactionCount++;
  // 3.3 获取物品故事
  const stories = getStoriesFor(id);
  const storyHint = stories.length > 0
    ? `（历史记忆：${stories[stories.length - 1].text}）`
    : '';
  // 这里暂时注释掉，感觉体验不是很好，很容易触发工具调用导致与用户自由操作冲突
  // window.parent.postMessage({
  //   type: 'dh:context',
  //   text: `${item.ctx}（物品：${item.label}${storyHint}）`,
  //   itemId: id,
  //   debounce: 2500,
  //   skipHistory: true
  // }, '*');

  // 如果物品绑定了 skill，弹出气泡框
  if (item.skill) {
    showSkillBubble(itemEl, item, () => {
      window.keepwork?.minigame?.openSkill({
        skillPath: item.skill.path,
        title: item.skill.name,
        layout: 'modal',
        restorePolicy: 'resumeParent',
        frameOptions: buildSkillModalFrameOptions(),
      });
    });
  }
}

function finishGame() {
  if (_state.finished) return;
  _state.finished = true;
  const total = items.length;
  const visited = _state.interactedIds.size;
  const accuracy = total > 0 ? Math.round((visited / total) * 100) : 0;
  const durationSec = Math.round((Date.now() - _sessionStart) / 1000);

  const summary = `你在家里探索了 ${visited} / ${total} 个角落，互动了 ${_state.interactionCount} 次，用时 ${durationSec} 秒。`;
  window.parent.postMessage({
    type: 'dh:context',
    text: `数字人之家体验结束。${summary}`,
    skipHistory: true
  }, '*');
  window.parent.postMessage({
    type: 'gameFinished',
    data: { total, correct: visited, accuracy, duration: durationSec, comment: summary }
  }, '*');
}

/**
 * 监听来自 parent 的消息：
 * - dh:saveMemory → AI 记忆写入（3.2）
 * - dh:saveStory → 物品故事绑定（3.3）
 */

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (!msg || !msg.type) return;

  // 3.2 AI 记忆写入
  if (msg.type === 'dh:saveMemory' && msg.text) {
    appendMemory(msg.text);
  }

  // 3.3 物品故事绑定
  if (msg.type === 'dh:saveStory' && msg.itemId && msg.text) {
    saveStory(msg.itemId, msg.text);
  }
});
