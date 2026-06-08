// =================== 物品 DOM 操作 ===================

import { getCatalogData } from './scene.js';

// =================== SVG / 图片渲染 ===================

export function getItemSVG(id) {
  const { SVGS } = getCatalogData();
  return SVGS[id] || `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#888"/></svg>`;
}

export function renderItemArt(item) {
  const { ASSET_OVERRIDES } = getCatalogData();
  const url = item.image || ASSET_OVERRIDES[item.id] || ASSET_OVERRIDES[item.kind];
  if (url) {
    return `<img class="art-img" src="${url}" alt="${item.label}" loading="lazy" draggable="false" />`;
  }
  return getItemSVG(item.kind || item.id);
}

// =================== DOM 操作 ===================

export function applyItemEl(el, item) {
  el.style.left = item.x + 'px';
  el.style.top = item.y + 'px';
  el.style.width = item.w + 'px';
  el.style.height = item.h + 'px';
  el.style.zIndex = Math.round(item.y);
}

export function createItemEl(item, sceneEl) {
  const el = document.createElement('div');
  el.className = 'item' + (item.type === 'photo' ? ' photo-frame' : '');
  el.id = item.id;
  el.dataset.itemId = item.id;
  el.setAttribute('aria-label', item.label);
  el.innerHTML = `
    <span class="label">${item.label}</span>
    <div class="art" role="img" aria-label="${item.label}">${renderItemArt(item)}</div>
    <div class="handle scale-up" data-handle="scale-up" title="放大">+</div>
    <div class="handle scale-down" data-handle="scale-down" title="缩小">−</div>
  `;
  applyItemEl(el, item);
  sceneEl.appendChild(el);
  return el;
}
