// =================== Skill 气泡框 ===================

let _bubbleEl = null;
let _cleanup = null;

/**
 * 根据物品在视口中的位置，选择空间最大的方向弹出气泡。
 * 右侧扣除数字人占位区域（约 30% 视口宽度），避免被遮挡。
 * @returns {'up'|'down'|'left'|'right'}
 */
function pickDirection(rect) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 数字人通常占据右侧约 30% 区域，计算有效右侧空间时扣除
  const dhReserved = vw * 0.3;

  const spaces = {
    up:    rect.top,
    down:  vh - rect.bottom,
    left:  rect.left,
    right: Math.max(0, vw - rect.right - dhReserved),
  };
  // 优先上、左，避免与右侧数字人重叠
  const priority = ['up', 'left', 'down', 'right'];
  let best = priority[0];
  for (const dir of priority) {
    if (spaces[dir] > spaces[best]) best = dir;
  }
  return best;
}

/**
 * 生成气泡文案
 */
function buildPromptText(item) {
  const skill = item.skill;
  if (skill.prompt) return skill.prompt;
  return `想在${item.label}这里体验一下「${skill.name}」吗？`;
}

/**
 * 显示 skill 气泡框
 * @param {HTMLElement} itemEl - 物品 DOM 元素
 * @param {Object} item - 物品数据（含 skill 字段）
 * @param {Function} onConfirm - 用户点"好呀"的回调
 */
export function showSkillBubble(itemEl, item, onConfirm) {
  // 同一时间只存在一个气泡
  hideSkillBubble();

  const rect = itemEl.getBoundingClientRect();
  const dir = pickDirection(rect);
  const promptText = buildPromptText(item);

  // 创建气泡 DOM
  const el = document.createElement('div');
  el.className = `skill-bubble skill-bubble-${dir}`;
  el.innerHTML = `
    <div class="sb-leaf sb-leaf-tl"></div>
    <div class="sb-leaf sb-leaf-tr"></div>
    <div class="sb-text">${promptText}</div>
    <div class="sb-actions">
      <button class="sb-btn sb-btn-yes" type="button">好呀 ✨</button>
      <button class="sb-btn sb-btn-no" type="button">算了</button>
    </div>
    <div class="sb-arrow"></div>
  `;

  // 定位（fixed 坐标系）
  document.body.appendChild(el);
  positionBubble(el, rect, dir);

  // 入场动画
  requestAnimationFrame(() => {
    el.classList.add('sb-enter');
  });

  // 按钮事件
  const btnYes = el.querySelector('.sb-btn-yes');
  const btnNo = el.querySelector('.sb-btn-no');

  const handleYes = (e) => {
    e.stopPropagation();
    const btnRect = btnYes.getBoundingClientRect();
    hideSkillBubble();
    if (onConfirm) onConfirm(btnRect);
  };
  const handleNo = (e) => {
    e.stopPropagation();
    hideSkillBubble();
  };

  btnYes.addEventListener('click', handleYes);
  btnNo.addEventListener('click', handleNo);

  // 阻止气泡自身点击冒泡到 scene（避免触发 clearSelection）
  el.addEventListener('click', (e) => e.stopPropagation());

  _bubbleEl = el;
  _cleanup = () => {
    btnYes.removeEventListener('click', handleYes);
    btnNo.removeEventListener('click', handleNo);
  };
}

/**
 * 隐藏并销毁当前气泡
 */
export function hideSkillBubble() {
  if (!_bubbleEl) return;
  if (_cleanup) { _cleanup(); _cleanup = null; }
  const el = _bubbleEl;
  _bubbleEl = null;
  el.classList.remove('sb-enter');
  el.classList.add('sb-leave');
  el.addEventListener('transitionend', () => el.remove(), { once: true });
  // 兜底移除（transitionend 可能不触发）
  setTimeout(() => { if (el.parentNode) el.remove(); }, 350);
}

/**
 * 根据方向定位气泡
 */
function positionBubble(el, rect, dir) {
  const gap = 14; // 气泡与物品的间距
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  // 先用 visibility:hidden 获取气泡尺寸
  el.style.visibility = 'hidden';
  const bw = el.offsetWidth;
  const bh = el.offsetHeight;
  el.style.visibility = '';

  let left, top;
  switch (dir) {
    case 'up':
      left = cx - bw / 2;
      top = rect.top - bh - gap;
      break;
    case 'down':
      left = cx - bw / 2;
      top = rect.bottom + gap;
      break;
    case 'left':
      left = rect.left - bw - gap;
      top = cy - bh / 2;
      break;
    case 'right':
      left = rect.right + gap;
      top = cy - bh / 2;
      break;
  }

  // 边界修正
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 8;
  left = Math.max(margin, Math.min(left, vw - bw - margin));
  top = Math.max(margin, Math.min(top, vh - bh - margin));

  el.style.left = left + 'px';
  el.style.top = top + 'px';
}
