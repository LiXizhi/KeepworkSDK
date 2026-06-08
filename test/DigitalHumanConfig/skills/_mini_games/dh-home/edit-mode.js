// =================== 编辑模式 ===================

import { items, TEMPLATES, getCatalogData, getPxPerMeter, applyMetersToItem, nextInstanceId, countByKind } from './scene.js';
import { renderItemArt, createItemEl, applyItemEl } from './items.js';
import { focusItem } from './camera.js';
import { scheduleSaveLayout } from './persistence.js';
import { playDragTone, playPlaceTone, playDeleteTone } from './audio.js';
import { emitRipple, emitSmoke } from './particles.js';
import { clearInteractionSelection } from './interaction.js';

// =================== 常量 ===================
const MIN_W = 50, MIN_H = 50;
const MAX_W = 900, MAX_H = 700;
const DRAG_THRESHOLD = 5;
const MAX_UNDO = 20;

// =================== 模块状态 ===================
let _state = null;
let _stage = null;
let _scene = null;
let _btnEdit = null;
let _catalogEl = null;
let _catalogList = null;
let _feedbackEl = null;

let editDrag = null;
let pendingDrag = null;
let catalogDrag = null;
let suppressNextClearClick = false;

// 撤销/重做栈
let _undoStack = [];
let _redoStack = [];

// =================== 初始化 ===================

export function initEditMode(state, { stage, scene, btnEdit, catalogEl, catalogList, feedbackEl }) {
  _state = state;
  _stage = stage;
  _scene = scene;
  _btnEdit = btnEdit;
  _catalogEl = catalogEl;
  _catalogList = catalogList;
  _feedbackEl = feedbackEl;

  btnEdit.addEventListener('click', () => setEditMode(!_state.editMode));
  document.getElementById('btnCloseCatalog').addEventListener('click', () => setEditMode(false));

  // 编辑模式下的物品拖拽
  scene.addEventListener('pointerdown', onScenePointerDown);
  scene.addEventListener('pointermove', onScenePointerMove);
  scene.addEventListener('pointerup', endEditDrag);
  scene.addEventListener('pointercancel', endEditDrag);

  // 点击空白取消选中
  stage.addEventListener('click', onStageClick);

  // 键盘快捷键：Ctrl+Z / Ctrl+Shift+Z
  document.addEventListener('keydown', onKeyDown);
}

// =================== 公开 API ===================

export function setEditMode(on) {
  _state.editMode = !!on;
  document.body.classList.toggle('edit-mode', _state.editMode);
  _btnEdit.classList.toggle('active', _state.editMode);
  _btnEdit.textContent = _state.editMode ? '✓' : '✏️';
  _btnEdit.setAttribute('aria-label', _state.editMode ? '完成编辑' : '编辑场景');
  _btnEdit.title = _state.editMode ? '完成编辑' : '编辑场景';
  if (_state.editMode) {
    clearInteractionSelection(); // 清除交互选中状态
    renderCatalog();
    pushUndoSnapshot(); // 进入编辑时保存初始快照
  } else {
    clearSelection();
    _undoStack = [];
    _redoStack = [];
  }
}

// =================== 选择 ===================

function clearSelection() {
  _scene.querySelectorAll('.item.selected').forEach(n => n.classList.remove('selected'));
}

function selectItem(id) {
  clearSelection();
  const el = document.getElementById(id);
  if (el) el.classList.add('selected');
}

// =================== 反馈 ===================

function showFeedback(emoji) {
  _feedbackEl.textContent = emoji;
  _feedbackEl.style.opacity = '1';
  _feedbackEl.style.transform = 'translate(-50%,-50%) scale(1)';
  setTimeout(() => {
    _feedbackEl.style.opacity = '0';
    _feedbackEl.style.transform = 'translate(-50%,-50%) scale(0.5)';
  }, 700);
}

// =================== 目录 ===================

function renderCatalog() {
  _catalogList.innerHTML = '';
  Object.values(TEMPLATES).forEach(tpl => {
    const count = countByKind(tpl.kind);
    const full = count >= tpl.maxCount;
    const card = document.createElement('div');
    card.className = 'cat-item' + (full ? ' full' : '');
    card.dataset.kind = tpl.kind;
    card.title = tpl.label;
    card.innerHTML = `
      <span class="cat-count">${count}/${tpl.maxCount}</span>
      <div class="cat-thumb">${renderItemArt(tpl)}</div>
      <div class="cat-label">${tpl.label}</div>
    `;
    card.addEventListener('pointerdown', (ev) => onCatalogPointerDown(card, tpl.kind, ev));
    _catalogList.appendChild(card);
  });
}

function refreshCatalogCounts() {
  if (!_state.editMode) return;
  _catalogList.querySelectorAll('.cat-item').forEach(card => {
    const kind = card.dataset.kind;
    const tpl = TEMPLATES[kind];
    if (!tpl) return;
    const count = countByKind(kind);
    const full = count >= tpl.maxCount;
    card.classList.toggle('full', full);
    const badge = card.querySelector('.cat-count');
    if (badge) badge.textContent = count + '/' + tpl.maxCount;
  });
}

// =================== 物品增删缩放 ===================

function clampItemToViewport(item) {
  const SCENE_WIDTH = getCatalogData().SCENE_WIDTH;
  const margin = 8;
  const visLeft = _stage.scrollLeft + item.w / 2 + margin;
  const visRight = _stage.scrollLeft + _stage.clientWidth - item.w / 2 - margin;
  if (visRight > visLeft) {
    item.x = Math.max(visLeft, Math.min(visRight, item.x));
  }
  item.x = Math.max(item.w / 2, Math.min(SCENE_WIDTH - item.w / 2, item.x));
  item.y = Math.max(item.h, Math.min(_scene.clientHeight, item.y));
  const pxPerMeter = getPxPerMeter();
  if (!item.floorAnchor && pxPerMeter > 0) {
    item.yMeters = item.y / pxPerMeter;
  }
}

function spawnInstanceAt(kind, sceneX, sceneY) {
  const tpl = TEMPLATES[kind];
  if (!tpl) return null;
  if (countByKind(kind) >= tpl.maxCount) {
    showFeedback('⛔');
    return null;
  }
  const pxPerMeter = getPxPerMeter();
  const inst = {
    id: nextInstanceId(kind),
    kind, type: tpl.type, label: tpl.label, ctx: tpl.ctx, image: tpl.image,
    heightMeters: tpl.defaultHeight,
    aspectRatio: tpl.aspectRatio,
    floorAnchor: false,
    yMeters: 1.0,
    x: sceneX, y: sceneY, w: tpl.w, h: tpl.h,
  };
  applyMetersToItem(inst);
  inst.x = sceneX;
  inst.y = Math.max(inst.h, Math.min(_scene.clientHeight, sceneY));
  if (pxPerMeter > 0) inst.yMeters = inst.y / pxPerMeter;
  items.push(inst);
  createItemEl(inst, _scene);
  selectItem(inst.id);
  refreshCatalogCounts();
  return inst;
}

function spawnInstance(kind) {
  const SCENE_WIDTH = getCatalogData().SCENE_WIDTH;
  const ROOM_HEIGHT_METERS = getCatalogData().ROOM_HEIGHT_METERS;
  const tpl = TEMPLATES[kind];
  if (!tpl) return;
  if (countByKind(kind) >= tpl.maxCount) {
    showFeedback('⛔');
    return;
  }
  const centerX = Math.round(_stage.scrollLeft + _stage.clientWidth / 2);
  const x = Math.max(tpl.w / 2 + 10, Math.min(SCENE_WIDTH - tpl.w / 2 - 10, centerX));
  const floorAnchor = tpl.type !== 'photo';
  const inst = {
    id: nextInstanceId(kind),
    kind, type: tpl.type, label: tpl.label, ctx: tpl.ctx, image: tpl.image,
    heightMeters: tpl.defaultHeight,
    aspectRatio: tpl.aspectRatio,
    floorAnchor,
    yMeters: floorAnchor ? ROOM_HEIGHT_METERS : 1.0,
    x, y: 0, w: tpl.w, h: tpl.h,
  };
  applyMetersToItem(inst);
  clampItemToViewport(inst);
  items.push(inst);
  createItemEl(inst, _scene);
  selectItem(inst.id);
  focusItem(inst.id);
  refreshCatalogCounts();
  saveWithUndo(items);
}

function deleteInstance(id) {
  const idx = items.findIndex(x => x.id === id);
  if (idx < 0) return;
  items.splice(idx, 1);
  const el = document.getElementById(id);
  if (el) el.remove();
  refreshCatalogCounts();
  saveWithUndo(items);
}

function scaleInstance(item, factor) {
  let f = factor;
  if (item.w * f < MIN_W) f = Math.max(f, MIN_W / item.w);
  if (item.h * f < MIN_H) f = Math.max(f, MIN_H / item.h);
  if (item.w * f > MAX_W) f = Math.min(f, MAX_W / item.w);
  if (item.h * f > MAX_H) f = Math.min(f, MAX_H / item.h);
  if (Math.abs(f - 1) < 0.001) return;
  item.heightMeters = item.heightMeters * f;
  applyMetersToItem(item);
  const el = document.getElementById(item.id);
  if (el) applyItemEl(el, item);
  saveWithUndo(items);
}

// =================== 目录区域命中 ===================

function isPointOverCatalog(clientX, clientY) {
  if (!_state.editMode) return false;
  const r = _catalogEl.getBoundingClientRect();
  return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
}

function setCatalogDropTarget(on) {
  _catalogEl.classList.toggle('drop-target', !!on);
}

// =================== 从目录拖拽创建 ===================

function onCatalogPointerDown(card, kind, e) {
  if (card.classList.contains('full')) return;
  if (e.button !== undefined && e.button !== 0) return;
  catalogDrag = {
    kind, pointerId: e.pointerId,
    startX: e.clientX, startY: e.clientY,
    started: false, instId: null,
    card,
  };
  e.preventDefault();
  try { card.setPointerCapture(e.pointerId); } catch (err) {}
  card.addEventListener('pointermove', onCatalogPointerMove);
  card.addEventListener('pointerup', onCatalogPointerUp);
  card.addEventListener('pointercancel', onCatalogPointerUp);
}

function onCatalogPointerMove(e) {
  if (!catalogDrag) return;
  const SCENE_WIDTH = getCatalogData().SCENE_WIDTH;
  const pxPerMeter = getPxPerMeter();
  const dx = e.clientX - catalogDrag.startX;
  const dy = e.clientY - catalogDrag.startY;
  if (!catalogDrag.started) {
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
    const sceneRect = _scene.getBoundingClientRect();
    const sceneX = e.clientX - sceneRect.left;
    const sceneY = e.clientY - sceneRect.top;
    const inst = spawnInstanceAt(catalogDrag.kind, sceneX, sceneY);
    if (!inst) { catalogDrag = null; return; }
    catalogDrag.started = true;
    catalogDrag.instId = inst.id;
    document.body.classList.add('catalog-dragging');
    const el = document.getElementById(inst.id);
    if (el) {
      document.body.appendChild(el);
      el.classList.add('dragging-edit');
      playDragTone();
    }
  }
  const inst = items.find(x => x.id === catalogDrag.instId);
  if (!inst) return;
  const sceneRect = _scene.getBoundingClientRect();
  inst.x = Math.max(inst.w / 2, Math.min(SCENE_WIDTH - inst.w / 2, e.clientX - sceneRect.left));
  inst.y = Math.max(inst.h, Math.min(_scene.clientHeight, e.clientY - sceneRect.top));
  inst.floorAnchor = false;
  if (pxPerMeter > 0) inst.yMeters = inst.y / pxPerMeter;
  const el = document.getElementById(inst.id);
  if (el) {
    el.style.width = inst.w + 'px';
    el.style.height = inst.h + 'px';
    el.style.left = e.clientX + 'px';
    el.style.top = e.clientY + 'px';
  }
  const overCatalog = isPointOverCatalog(e.clientX, e.clientY);
  setCatalogDropTarget(overCatalog);
  if (el) el.classList.toggle('will-discard', overCatalog);
}

function onCatalogPointerUp(e) {
  const card = catalogDrag && catalogDrag.card;
  if (card) {
    card.removeEventListener('pointermove', onCatalogPointerMove);
    card.removeEventListener('pointerup', onCatalogPointerUp);
    card.removeEventListener('pointercancel', onCatalogPointerUp);
    try { card.releasePointerCapture(catalogDrag.pointerId); } catch (err) {}
  }
  if (!catalogDrag) return;
  if (!catalogDrag.started) {
    spawnInstance(catalogDrag.kind);
  } else {
    const inst = items.find(x => x.id === catalogDrag.instId);
    const droppedOnCatalog = isPointOverCatalog(e.clientX, e.clientY);
    if (inst && droppedOnCatalog) {
      const idx = items.findIndex(x => x.id === inst.id);
      if (idx >= 0) items.splice(idx, 1);
      const el = document.getElementById(inst.id);
      if (el) el.remove();
      refreshCatalogCounts();
    } else if (inst) {
      clampItemToViewport(inst);
      const el = document.getElementById(inst.id);
      if (el) {
        if (el.parentElement !== _scene) _scene.appendChild(el);
        applyItemEl(el, inst);
        el.classList.remove('dragging-edit');
        el.classList.remove('will-discard');
      }
      saveWithUndo(items);
    }
  }
  setCatalogDropTarget(false);
  catalogDrag = null;
  document.body.classList.remove('catalog-dragging');
}

// =================== 场景内物品拖拽 ===================

const LONG_PRESS_MS = 300;
let _longPressTimer = null;

function vibrate() {
  try { navigator.vibrate && navigator.vibrate(10); } catch (e) {}
}

function onScenePointerDown(e) {
  if (!_state.editMode) return;
  const handle = e.target.closest('.handle');
  const itemEl = e.target.closest('.item');
  if (!itemEl) return;
  e.preventDefault();
  try { window.getSelection && window.getSelection().removeAllRanges(); } catch (err) {}
  suppressNextClearClick = true;
  const id = itemEl.dataset.itemId;
  const item = items.find(x => x.id === id);
  if (!item) return;
  if (handle) {
    const kind = handle.dataset.handle;
    if (kind === 'scale-up') scaleInstance(item, 1.2);
    else if (kind === 'scale-down') scaleInstance(item, 1 / 1.2);
    e.stopPropagation();
    return;
  }
  const _rect = itemEl.getBoundingClientRect();
  const _anchorX = _rect.left + _rect.width / 2;
  const _anchorY = _rect.top + _rect.height;
  pendingDrag = {
    id, itemEl,
    startClientX: e.clientX, startClientY: e.clientY,
    grabOffsetX: e.clientX - _anchorX,
    grabOffsetY: e.clientY - _anchorY,
    orig: { x: item.x, y: item.y, w: item.w, h: item.h },
    pointerId: e.pointerId,
    longPressed: false,
  };
  // 长按 300ms 自动进入拖拽（触屏优化）
  clearTimeout(_longPressTimer);
  _longPressTimer = setTimeout(() => {
    if (!pendingDrag || editDrag) return;
    pendingDrag.longPressed = true;
    vibrate();
    startDrag(pendingDrag);
  }, LONG_PRESS_MS);
  e.stopPropagation();
  _scene.setPointerCapture(e.pointerId);
}

function startDrag(pending) {
  clearTimeout(_longPressTimer);
  clearSelection();
  editDrag = {
    mode: 'move', id: pending.id,
    startClientX: pending.startClientX,
    startClientY: pending.startClientY,
    grabOffsetX: pending.grabOffsetX,
    grabOffsetY: pending.grabOffsetY,
    orig: pending.orig,
  };
  const el = pending.itemEl;
  el.classList.add('dragging-edit');
  document.body.classList.add('scene-item-dragging');
  document.body.appendChild(el);
  playDragTone();
  vibrate();
}

function onScenePointerMove(e) {
  const SCENE_WIDTH = getCatalogData().SCENE_WIDTH;
  const pxPerMeter = getPxPerMeter();
  if (pendingDrag && !editDrag) {
    const dx0 = e.clientX - pendingDrag.startClientX;
    const dy0 = e.clientY - pendingDrag.startClientY;
    if (Math.hypot(dx0, dy0) < DRAG_THRESHOLD) return;
    startDrag(pendingDrag);
  }
  if (!editDrag) return;
  const item = items.find(x => x.id === editDrag.id);
  if (!item) return;
  const dx = e.clientX - editDrag.startClientX;
  const dy = e.clientY - editDrag.startClientY;
  item.x = Math.max(item.w / 2, Math.min(SCENE_WIDTH - item.w / 2, editDrag.orig.x + dx));
  item.y = Math.max(item.h, Math.min(_scene.clientHeight, editDrag.orig.y + dy));
  item.floorAnchor = false;
  item.yMeters = pxPerMeter > 0 ? item.y / pxPerMeter : item.yMeters;
  const el = document.getElementById(item.id);
  if (el) {
    el.style.width = item.w + 'px';
    el.style.height = item.h + 'px';
    el.style.left = (e.clientX - editDrag.grabOffsetX) + 'px';
    el.style.top = (e.clientY - editDrag.grabOffsetY) + 'px';
  }
  const overCatalog = isPointOverCatalog(e.clientX, e.clientY);
  setCatalogDropTarget(overCatalog);
  if (el) el.classList.toggle('will-discard', overCatalog);
}

function endEditDrag(e) {
  clearTimeout(_longPressTimer);
  if (pendingDrag && !editDrag) {
    const id = pendingDrag.id;
    try { _scene.releasePointerCapture(pendingDrag.pointerId); } catch (err) {}
    pendingDrag = null;
    const itemEl = document.getElementById(id);
    if (itemEl && !itemEl.classList.contains('selected')) {
      selectItem(id);
    }
    return;
  }
  if (!editDrag) return;
  const droppedOnCatalog = isPointOverCatalog(e.clientX, e.clientY);
  const item = items.find(x => x.id === editDrag.id);
  const el = document.getElementById(editDrag.id);
  if (droppedOnCatalog && item) {
    // 删除：烟雾 + 音效
    emitSmoke(e.clientX, e.clientY);
    playDeleteTone();
    vibrate();
    deleteInstance(item.id);
  } else if (item) {
    clampItemToViewport(item);
    if (el) {
      if (el.parentElement !== _scene) _scene.appendChild(el);
      applyItemEl(el, item);
      // 放置涟漪 + 音效
      const rect = el.getBoundingClientRect();
      emitRipple(rect.left + rect.width / 2, rect.top + rect.height);
      playPlaceTone();
    }
  }
  if (el) {
    el.classList.remove('dragging-edit');
    el.classList.remove('will-discard');
  }
  setCatalogDropTarget(false);
  document.body.classList.remove('scene-item-dragging');
  clearSelection();
  editDrag = null;
  pendingDrag = null;
  try { _scene.releasePointerCapture(e.pointerId); } catch (err) {}
  if (!droppedOnCatalog) saveWithUndo(items);
}

function onStageClick(e) {
  if (!_state.editMode) return;
  if (suppressNextClearClick) { suppressNextClearClick = false; return; }
  if (e.target.closest('.item')) return;
  if (e.target.closest('#catalog')) return;
  if (e.target.closest('#btnEdit')) return;
  clearSelection();
}

// =================== 2.4 撤销/重做 ===================

function snapshotItems() {
  return items.map(it => ({
    id: it.id, kind: it.kind,
    x: it.x, yMeters: it.yMeters,
    heightMeters: it.heightMeters,
    floorAnchor: it.floorAnchor,
    aspectRatio: it.aspectRatio,
    image: it.image || null,
  }));
}

function pushUndoSnapshot() {
  _undoStack.push(snapshotItems());
  if (_undoStack.length > MAX_UNDO) _undoStack.shift();
  _redoStack = [];
}

function restoreFromSnapshot(snapshot) {
  // 清除现有 DOM
  items.forEach(it => {
    const el = document.getElementById(it.id);
    if (el) el.remove();
  });
  items.length = 0;
  // 重建
  snapshot.forEach(p => {
    const tpl = TEMPLATES[p.kind];
    if (!tpl) return;
    const inst = {
      id: p.id, kind: p.kind,
      type: tpl.type, label: tpl.label, ctx: tpl.ctx,
      image: p.image || tpl.image,
      heightMeters: p.heightMeters,
      aspectRatio: p.aspectRatio || tpl.aspectRatio,
      floorAnchor: !!p.floorAnchor,
      yMeters: p.yMeters,
      x: p.x, y: 0, w: tpl.w, h: tpl.h,
    };
    applyMetersToItem(inst);
    items.push(inst);
    createItemEl(inst, _scene);
  });
  refreshCatalogCounts();
  scheduleSaveLayout(items); // 直接存盘，不推 undo 栈
}

function undo() {
  if (_undoStack.length <= 1) return; // 需至少有初始快照+一次变更
  _redoStack.push(_undoStack.pop());
  const prev = _undoStack[_undoStack.length - 1];
  if (prev) restoreFromSnapshot(prev);
  playDeleteTone();
}

function redo() {
  if (_redoStack.length === 0) return;
  const next = _redoStack.pop();
  _undoStack.push(next);
  restoreFromSnapshot(next);
  playPlaceTone();
}

function onKeyDown(e) {
  if (!_state.editMode) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  }
}

// 在每次修改操作前自动推快照（供外部使用）
// 在 endEditDrag 和 spawnInstance 中已调用 scheduleSaveLayout，
// 我们在这些位置前 hook pushUndoSnapshot
const _origScheduleSave = scheduleSaveLayout;
// 重写内部使用的 save 调用以自动推栈
function saveWithUndo(itemsArr) {
  pushUndoSnapshot();
  _origScheduleSave(itemsArr);
}
