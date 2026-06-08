// =================== 场景配置 ===================
// 管理 pxPerMeter 计算、模板构建、物品实例列表

let pxPerMeter = 0;
let _catalogData = null;
let _sceneEl = null;

// 导出的物品模板表
export const TEMPLATES = {};
// 导出的物品实例列表
export const items = [];

export function getCatalogData() { return _catalogData; }
export function getPxPerMeter() { return pxPerMeter; }

export function initScene(sceneEl, catalogData) {
  _sceneEl = sceneEl;
  _catalogData = catalogData;
  sceneEl.style.width = catalogData.SCENE_WIDTH + 'px';
  recomputePxPerMeter();
}

export function recomputePxPerMeter() {
  if (!_catalogData || !_sceneEl) return;
  const h = _sceneEl.clientHeight || window.innerHeight || _catalogData.REFERENCE_HEIGHT_PX;
  pxPerMeter = h / _catalogData.ROOM_HEIGHT_METERS;
}

export function metersToPx(meters) {
  return Math.max(1, Math.round(meters * pxPerMeter));
}

// =================== 宽高比解析 ===================

function parseSvgViewBoxRatio(svgText) {
  if (!svgText || typeof svgText !== 'string') return null;
  const m = svgText.match(/viewBox\s*=\s*['\"]\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*['\"]/i);
  if (!m) return null;
  const w = parseFloat(m[3]);
  const h = parseFloat(m[4]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || h <= 0) return null;
  return w / h;
}

const _imageRatioCache = Object.create(null);
function loadImageRatio(url) {
  if (!url) return Promise.resolve(null);
  if (_imageRatioCache[url]) return _imageRatioCache[url];
  _imageRatioCache[url] = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || 0;
      const h = img.naturalHeight || 0;
      resolve(h > 0 ? (w / h) : null);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
  return _imageRatioCache[url];
}

async function resolveAspectRatioFromSources(imageUrl, svgKey) {
  const SVGS = _catalogData.SVGS;
  const imgRatio = await loadImageRatio(imageUrl);
  if (Number.isFinite(imgRatio) && imgRatio > 0) return imgRatio;
  const svgRatio = parseSvgViewBoxRatio(SVGS[svgKey]);
  if (Number.isFinite(svgRatio) && svgRatio > 0) return svgRatio;
  return 1;
}

// =================== 模板构建 ===================

export async function buildTemplates() {
  const { CATALOG, ASSET_OVERRIDES } = _catalogData;
  await Promise.all(CATALOG.map(async (c) => {
    const imageUrl = c.image || ASSET_OVERRIDES[c.kind] || null;
    const aspectRatio = await resolveAspectRatioFromSources(imageUrl, c.kind);
    const h = metersToPx(c.defaultHeight);
    const w = Math.max(1, Math.round(h * aspectRatio));
    TEMPLATES[c.kind] = {
      kind: c.kind,
      type: c.type,
      label: c.label,
      ctx: c.ctx,
      image: c.image,
      defaultHeight: c.defaultHeight,
      aspectRatio,
      w, h,
      maxCount: c.maxCount,
      skill: c.skill || null,
    };
  }));
}

// =================== 物品实例管理 ===================

export function applyMetersToItem(item) {
  item.h = metersToPx(item.heightMeters);
  item.w = Math.max(1, Math.round(item.h * item.aspectRatio));
  if (item.floorAnchor) {
    item.y = _sceneEl.clientHeight;
  } else {
    item.y = Math.round(item.yMeters * pxPerMeter);
  }
}

export function nextInstanceId(kind) {
  if (!items.some(i => i.id === kind)) return kind;
  let n = 2;
  while (items.some(i => i.id === kind + '-' + n)) n++;
  return kind + '-' + n;
}

export function countByKind(kind) {
  return items.reduce((s, i) => s + (i.kind === kind ? 1 : 0), 0);
}

export function buildInitialItems() {
  const { INITIAL_PLACEMENTS, ROOM_HEIGHT_METERS } = _catalogData;
  items.length = 0;
  INITIAL_PLACEMENTS.forEach(p => {
    const tpl = TEMPLATES[p.kind];
    if (!tpl) return;
    const inst = {
      id: nextInstanceId(p.kind),
      kind: p.kind,
      type: tpl.type,
      label: tpl.label,
      ctx: tpl.ctx,
      image: tpl.image,
      heightMeters: tpl.defaultHeight,
      aspectRatio: tpl.aspectRatio,
      floorAnchor: false,
      yMeters: p.y,
      x: Math.round(p.x * pxPerMeter),
      y: 0, w: tpl.w, h: tpl.h,
      skill: tpl.skill,
    };
    applyMetersToItem(inst);
    items.push(inst);
  });
}

export function buildItemsFromSaved(saved) {
  const { ROOM_HEIGHT_METERS, SCENE_WIDTH } = _catalogData;
  items.length = 0;
  saved.forEach(p => {
    const tpl = TEMPLATES[p.kind];
    if (!tpl) return;
    const floorAnchor = !!p.floorAnchor;
    const heightMeters = (typeof p.heightMeters === 'number' && p.heightMeters > 0)
      ? p.heightMeters : tpl.defaultHeight;
    const yMeters = (typeof p.yMeters === 'number')
      ? p.yMeters : (floorAnchor ? ROOM_HEIGHT_METERS : 1.0);
    const inst = {
      id: p.id || p.kind,
      kind: p.kind,
      type: tpl.type,
      label: tpl.label,
      ctx: tpl.ctx,
      image: p.image || tpl.image,
      heightMeters,
      aspectRatio: (typeof p.aspectRatio === 'number' && p.aspectRatio > 0) ? p.aspectRatio : tpl.aspectRatio,
      floorAnchor,
      yMeters,
      x: typeof p.x === 'number' ? p.x : SCENE_WIDTH / 2,
      y: 0, w: tpl.w, h: tpl.h,
      skill: tpl.skill,
    };
    applyMetersToItem(inst);
    items.push(inst);
  });
}
