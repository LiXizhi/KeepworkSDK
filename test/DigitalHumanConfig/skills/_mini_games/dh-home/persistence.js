// =================== 布局持久化（PersonalPageStore） ===================

const LAYOUT_FILE = 'config/digitalHumanHome.json';
const STORIES_FILE = 'config/digitalHumanHome_stories.json';

let _cachedStore = null;

function getStore() {
  if (_cachedStore) return _cachedStore;
  const base = window.keepwork && window.keepwork.personalPageStore;
  if (!base) return null;
  const ws = new URLSearchParams(window.location.search).get('workspace') || 'silvermind';
  _cachedStore = typeof base.withWorkspace === 'function' ? base.withWorkspace(ws) : base;
  return _cachedStore;
}

// =================== 布局 ===================

export async function loadSavedLayout() {
  const store = getStore();
  if (!store) return null;
  try {
    const text = await store.readFile(LAYOUT_FILE);
    if (!text) return null;
    const data = JSON.parse(text);
    if (Array.isArray(data) && data.length > 0) return data;
  } catch (e) {
    console.warn('[digitalHumanHome] loadSavedLayout failed', e);
  }
  return null;
}

let _saveLayoutTimer = null;

export function scheduleSaveLayout(items) {
  clearTimeout(_saveLayoutTimer);
  _saveLayoutTimer = setTimeout(() => saveLayout(items), 600);
}

export async function saveLayout(items) {
  const store = getStore();
  if (!store) return;
  try {
    const data = items.map(it => ({
      id: it.id,
      kind: it.kind,
      x: Math.round(it.x),
      yMeters: it.yMeters,
      heightMeters: it.heightMeters,
      floorAnchor: !!it.floorAnchor,
      image: it.image || null,
    }));
    await store.createFile(LAYOUT_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn('[digitalHumanHome] saveLayout failed', e);
  }
}

// =================== 3.3 物品故事（情感绑定） ===================

let _storiesCache = null;

export async function loadStories() {
  if (_storiesCache) return _storiesCache;
  const store = getStore();
  if (!store) return {};
  try {
    const text = await store.readFile(STORIES_FILE);
    if (text) {
      _storiesCache = JSON.parse(text);
      return _storiesCache;
    }
  } catch (e) {
    console.warn('[digitalHumanHome] loadStories failed', e);
  }
  _storiesCache = {};
  return _storiesCache;
}

export async function saveStory(itemId, story) {
  const stories = await loadStories();
  if (!stories[itemId]) stories[itemId] = [];
  stories[itemId].push({
    text: story,
    time: new Date().toISOString().slice(0, 10),
  });
  // 每物品最多保留 10 条
  if (stories[itemId].length > 10) {
    stories[itemId] = stories[itemId].slice(-10);
  }
  _storiesCache = stories;
  const store = getStore();
  if (!store) return;
  try {
    await store.createFile(STORIES_FILE, JSON.stringify(stories, null, 2));
  } catch (e) {
    console.warn('[digitalHumanHome] saveStory failed', e);
  }
}

export function getStoriesFor(itemId) {
  return (_storiesCache && _storiesCache[itemId]) || [];
}

// =================== 3.2 AI 记忆写入 ===================

export async function appendMemory(text) {
  const store = getStore();
  if (!store) return;
  const now = new Date();
  const monthFile = `memory/${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}.md`;
  const entry = `## ${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}\n- ${text}\n\n`;
  try {
    let existing = '';
    try { existing = await store.readFile(monthFile) || ''; } catch (e) {}
    await store.createFile(monthFile, existing + entry);
  } catch (e) {
    console.warn('[digitalHumanHome] appendMemory failed', e);
  }
}
