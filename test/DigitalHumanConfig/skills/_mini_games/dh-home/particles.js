// =================== 粒子特效 ===================

const POOL_SIZE = 40;
let _container = null;
const _particles = [];

function ensureContainer() {
  if (_container) return _container;
  _container = document.createElement('div');
  _container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:200;overflow:hidden';
  document.body.appendChild(_container);
  return _container;
}

function getParticle() {
  let p = _particles.find(x => !x._active);
  if (!p) {
    if (_particles.length >= POOL_SIZE) return null;
    p = document.createElement('div');
    p.style.cssText = 'position:absolute;pointer-events:none;will-change:transform,opacity;font-size:16px';
    p._active = false;
    _particles.push(p);
    ensureContainer().appendChild(p);
  }
  p._active = true;
  p.style.opacity = '1';
  p.style.transform = 'none';
  return p;
}

function releaseParticle(p) {
  p._active = false;
  p.style.opacity = '0';
}

// =================== 公开 API ===================

/** 星星散射（点击物品时） */
export function emitStars(x, y, count = 3) {
  const symbols = ['⭐', '✨', '🌟'];
  for (let i = 0; i < count; i++) {
    const p = getParticle();
    if (!p) break;
    p.textContent = symbols[i % symbols.length];
    p.style.fontSize = (14 + Math.random() * 8) + 'px';
    p.style.left = x + 'px';
    p.style.top = y + 'px';
    const angle = (Math.PI * 2 / count) * i + (Math.random() - 0.5) * 0.6;
    const dist = 40 + Math.random() * 50;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist - 30;
    p.style.transition = 'transform 600ms cubic-bezier(0.2,0.8,0.3,1), opacity 600ms ease-out';
    requestAnimationFrame(() => {
      p.style.transform = `translate(${dx}px, ${dy}px) scale(0.3) rotate(${Math.random()*120-60}deg)`;
      p.style.opacity = '0';
    });
    setTimeout(() => releaseParticle(p), 650);
  }
}

/** 涟漪扩散（放置物品时） */
export function emitRipple(x, y) {
  const p = getParticle();
  if (!p) return;
  p.textContent = '';
  p.style.left = (x - 30) + 'px';
  p.style.top = (y - 30) + 'px';
  p.style.width = '60px';
  p.style.height = '60px';
  p.style.borderRadius = '50%';
  p.style.border = '3px solid rgba(168,230,207,0.7)';
  p.style.background = 'transparent';
  p.style.transition = 'transform 500ms ease-out, opacity 500ms ease-out';
  requestAnimationFrame(() => {
    p.style.transform = 'scale(2.5)';
    p.style.opacity = '0';
  });
  setTimeout(() => {
    releaseParticle(p);
    p.style.width = '';
    p.style.height = '';
    p.style.borderRadius = '';
    p.style.border = '';
    p.style.background = '';
  }, 550);
}

/** 彩纸庆祝（引导完成/成功操作） */
export function emitConfetti(x, y, count = 8) {
  const colors = ['#FFB7B2', '#A8E6CF', '#B4D8E7', '#FFE4B5', '#DDA0DD'];
  for (let i = 0; i < count; i++) {
    const p = getParticle();
    if (!p) break;
    p.textContent = '';
    p.style.left = x + 'px';
    p.style.top = y + 'px';
    p.style.width = (6 + Math.random() * 6) + 'px';
    p.style.height = (4 + Math.random() * 4) + 'px';
    p.style.borderRadius = '2px';
    p.style.background = colors[i % colors.length];
    const angle = (Math.PI * 2 / count) * i + Math.random() * 0.4;
    const dist = 50 + Math.random() * 80;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist - 40;
    const rot = Math.random() * 360;
    p.style.transition = 'transform 800ms cubic-bezier(0.2,0.8,0.3,1), opacity 800ms ease-out';
    requestAnimationFrame(() => {
      p.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
      p.style.opacity = '0';
    });
    setTimeout(() => {
      releaseParticle(p);
      p.style.width = '';
      p.style.height = '';
      p.style.borderRadius = '';
      p.style.background = '';
    }, 850);
  }
}

/** 烟雾消散（删除物品时） */
export function emitSmoke(x, y, count = 4) {
  for (let i = 0; i < count; i++) {
    const p = getParticle();
    if (!p) break;
    p.textContent = '';
    p.style.left = (x - 10) + 'px';
    p.style.top = (y - 10) + 'px';
    p.style.width = '20px';
    p.style.height = '20px';
    p.style.borderRadius = '50%';
    p.style.background = 'rgba(180,160,140,0.5)';
    const angle = (Math.PI * 2 / count) * i;
    const dx = Math.cos(angle) * (20 + Math.random() * 20);
    const dy = Math.sin(angle) * (20 + Math.random() * 20) - 20;
    p.style.transition = 'transform 500ms ease-out, opacity 500ms ease-out';
    requestAnimationFrame(() => {
      p.style.transform = `translate(${dx}px, ${dy}px) scale(2)`;
      p.style.opacity = '0';
    });
    setTimeout(() => {
      releaseParticle(p);
      p.style.width = '';
      p.style.height = '';
      p.style.borderRadius = '';
      p.style.background = '';
    }, 550);
  }
}
