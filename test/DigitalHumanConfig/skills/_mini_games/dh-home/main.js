// =================== 数字人之家 — 入口模块 ===================

import { initScene, recomputePxPerMeter, buildTemplates, items, buildInitialItems, buildItemsFromSaved, applyMetersToItem } from './scene.js';
import { createItemEl, applyItemEl } from './items.js';
import { initCamera } from './camera.js';
import { loadSavedLayout } from './persistence.js';
import { initEditMode } from './edit-mode.js';
import { initAICommands } from './ai-commands.js';
import { initInteraction } from './interaction.js';
import { showGuideIfNeeded } from './guide.js';

// =================== 等待 SDK ===================

function waitForSdkGlobals(timeoutMs = 10000) {
  const start = Date.now();
  return new Promise((resolve) => {
    (function check() {
      if (typeof window.KeepworkSDK === 'function') return resolve();
      if (Date.now() - start >= timeoutMs) return resolve();
      setTimeout(check, 30);
    })();
  });
}

// =================== 主入口 ===================

(async function main() {
  await waitForSdkGlobals();

  const token = new URLSearchParams(window.location.search).get('token');
  if (window.KeepworkSDK) {
    if (!window.keepwork) window.keepwork = new KeepworkSDK();
    if (token) window.keepwork.setToken(token);
  }

  // 获取 catalog 数据
  const CATALOG_DATA = window.DH_HOME_CATALOG;
  if (!CATALOG_DATA) {
    console.error('[digitalHumanHome] DH_HOME_CATALOG 未加载');
    return;
  }

  // DOM 引用
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const scene = $('scene');
  const feedbackEl = $('feedback');
  const sceneCommand = $('sceneCommand');
  const btnFinish = $('btnFinish');
  const btnEdit = $('btnEdit');
  const catalogEl = $('catalog');
  const catalogList = $('catalogList');

  // 初始化场景
  initScene(scene, CATALOG_DATA);
  await buildTemplates();

  // 加载布局
  const savedLayout = await loadSavedLayout();
  if (savedLayout) {
    buildItemsFromSaved(savedLayout);
  } else {
    buildInitialItems();
  }

  // 渲染物品 DOM
  items.forEach(item => createItemEl(item, scene));

  // 窗口 resize → 重新计算
  let _resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      recomputePxPerMeter();
      items.forEach(item => {
        applyMetersToItem(item);
        const el = document.getElementById(item.id);
        if (el) applyItemEl(el, item);
      });
    }, 50);
  });

  // 状态对象（共享给各模块）
  const state = {
    finished: false,
    interactedIds: new Set(),
    interactionCount: 0,
    editMode: false,
  };

  // 初始化各模块
  initCamera(stage, scene);
  initEditMode(state, { stage, scene, btnEdit, catalogEl, catalogList, feedbackEl });
  initAICommands(sceneCommand);
  initInteraction(state, { scene, feedbackEl, btnFinish });

  // =================== Dev 模式 ===================
  if (new URLSearchParams(window.location.search).get('dev') === 'true') {
    const wrapper = $('aiPanel');
    wrapper.style.cssText = 'position:fixed;left:14px;bottom:30px;z-index:20;background:rgba(255,255,255,0.95);padding:10px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,0.3);width:340px;display:flex;flex-direction:column;gap:8px;opacity:1;pointer-events:auto;height:auto;overflow:visible';
    sceneCommand.contentEditable = 'true';
    sceneCommand.style.cssText = 'border:2px dashed #94a3b8;border-radius:6px;padding:8px;min-height:48px;font-family:monospace;font-size:12px;background:#f8fafc;outline:none;color:#1f2937';
    sceneCommand.textContent = '{"action":"focus","target":"computer-desk"}';
    btnFinish.style.cssText = 'padding:6px 12px;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px';
  }

  // =================== 初始化完成 ===================
  stage.scrollLeft = 0;
  window.parent.postMessage({ type: 'gameLoaded' }, '*');

  // 新手引导（首次访问时触发）
  await showGuideIfNeeded(state);
})();
