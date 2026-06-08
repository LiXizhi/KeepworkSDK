// =================== 相机 / 滚动控制 ===================

import { items } from './scene.js';

let _stage = null;
let _scene = null;
let _floorEl = null;
let _isDown = false;
let _startX = 0;
let _startScroll = 0;

// 公开标记：是否发生了拖动（用于抑制点击事件）
export let moved = false;

function notifySceneDrag() {
  document.dispatchEvent(new CustomEvent('dh-home:scene-drag'));
}

export function resetMoved() { moved = false; }

export function initCamera(stage, scene) {
  _stage = stage;
  _scene = scene;
  _floorEl = document.getElementById('floor');

  // 地板透视偏移
  let _floorRafPending = false;
  function updateFloorOffset() {
    _floorRafPending = false;
    if (!_floorEl) return;
    _floorEl.style.setProperty('--floor-ox', (-stage.scrollLeft) + 'px');
  }
  stage.addEventListener('scroll', () => {
    if (_floorRafPending) return;
    _floorRafPending = true;
    requestAnimationFrame(updateFloorOffset);
  }, { passive: true });
  updateFloorOffset();

  // 拖动滚动（不使用 setPointerCapture，避免 click target 被劫持到 stage）
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // 只响应主键
    _isDown = true;
    moved = false;
    _startX = e.clientX;
    _startScroll = stage.scrollLeft;
    stage.classList.add('dragging');
  });
  document.addEventListener('pointermove', (e) => {
    if (!_isDown) return;
    const dx = e.clientX - _startX;
    if (Math.abs(dx) > 5 && !moved) {
      moved = true;
      notifySceneDrag();
    }
    stage.scrollLeft = _startScroll - dx;
  });
  function endDrag(e) {
    if (!_isDown) return;
    _isDown = false;
    stage.classList.remove('dragging');
  }
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  // 鼠标滚轮 → 横向滚动
  stage.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      stage.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });
}

/** 平滑滚动到某物品 */
export function focusItem(id) {
  const item = items.find(x => x.id === id);
  if (!item || !_stage) return;
  const target = item.x - _stage.clientWidth / 2 + item.w / 2;
  _stage.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
}

/** 高亮物品（滚动 + 弹出动画） */
export function highlightItem(id) {
  const el = document.getElementById(id);
  if (!el) return;
  focusItem(id);
  el.classList.remove('tapped');
  void el.offsetWidth;
  el.classList.add('tapped');
}
