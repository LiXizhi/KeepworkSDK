// =================== Digital Human Home — 物品目录 / SVG 资源 ===================
// 将所有 catalog 定义和内联 SVG 集中在此文件，便于维护和替换素材。
//
// 关键概念：
//   - 整个场景（房间）的纵向视野约定为 ROOM_HEIGHT_METERS 米（默认 3 米）。
//   - 每个物品的“默认尺寸”使用相对单位 defaultHeight（米）描述其真实高度。
//   - 运行时根据 scene 的实际像素高度计算 pxPerMeter，再换算每个物品的像素尺寸：
//       heightPx = defaultHeight * pxPerMeter
//       widthPx  = heightPx * intrinsicRatio // intrinsicRatio 来自 image 或 SVG 的实际宽高比
//   - 这样当窗口高度变化时，物品尺寸保持“真实世界比例”相对一致。
//
// 渲染优先级： item.image (URL) > catalog 入口的 image > 内联 SVG > 占位灰块。
// 替换素材时：
//   1) 在 CATALOG 对应条目里设置 image: 'https://...'
//   2) 或在 SVGS 中替换内联 SVG
//
// 该文件以普通 <script> 形式加载，挂到 window.DH_HOME_CATALOG。

(function () {
  // 整个场景（房间）的纵向视野，单位：米
  const ROOM_HEIGHT_METERS = 3;

  // 参考像素高度（仅用于编辑器/调试中像素↔米换算的历史保留量）
  const REFERENCE_HEIGHT_PX = 800;

  // 横向场景宽度（像素）
  const SCENE_WIDTH = 4200;

  // 地板物品的底部锚点（像素，距 scene 顶部，保留供编辑器吸附使用）
  const FLOOR_Y = 800;

  // =================== 物品目录 ===================
  // 每条目字段：
  //   kind:           物品种类标识（首实例 id 与之相同）
  //   type:           'photo' | 'object'
  //   label:          中文显示名
  //   defaultHeight:  默认高度（米），相对房间 3 米的比例
  //   宽高比：         不再在 catalog 中手填，运行时根据 image 或 SVG 自动推导
  //   ctx:            被点击时发给数字人的上下文文案
  //   image:          可选，外部图片 URL；为 null 时使用内联 SVG
  //   maxCount:       该种类在场景中允许的最大实例数
  const CATALOG = [
    // 墙上照片
    { kind: 'photo-family',  type: 'photo',  label: '全家福',   defaultHeight: 0.5,  ctx: '用户走到墙边看了一张全家福照片', image: null, maxCount: 10 },
    { kind: 'photo-travel',  type: 'photo',  label: '旅行照',   defaultHeight: 0.75, ctx: '用户看了一张山间旅行的照片，似乎在回忆出游', image: null, maxCount: 10 },
    { kind: 'photo-pet',     type: 'photo',  label: '宠物照',   defaultHeight: 0.5,  ctx: '用户看了一张可爱的金毛狗狗照片', image: null, maxCount: 10 },
    // 客厅区
    { kind: 'sofa',          type: 'object', label: '沙发',     defaultHeight: 0.75, ctx: '用户走到客厅沙发前，似乎想坐下休息', image: null, maxCount: 1 },
    { kind: 'lamp',          type: 'object', label: '落地灯',   defaultHeight: 1.5,  ctx: '用户走到落地灯旁，灯光很温暖', image: null, maxCount: 1 },
    { kind: 'tv',            type: 'object', label: '电视',     defaultHeight: 0.85, ctx: '用户站在电视前，似乎想看个节目', image: null, maxCount: 1,
      skill: { path: 'skills/lifeQuiz/SKILL.md', name: '时光机问答' } },
    { kind: 'plant',         type: 'object', label: '绿植',     defaultHeight: 1.0,  ctx: '用户走到一盆绿植旁，似乎在欣赏', image: null, maxCount: 1 },
    // 书房 / 电脑区
    { kind: 'bookshelf',     type: 'object', label: '书架',     defaultHeight: 1.8,  ctx: '用户走到书架前，看了看书脊', image: null, maxCount: 1,
      skill: { path: 'skills/lifeTimeline/SKILL.md', name: '人生时间线' } },
    { kind: 'computer-desk', type: 'object', label: '电脑桌',   defaultHeight: 1.6,  ctx: '用户走到电脑桌前，似乎想用电脑做点什么', image: null, maxCount: 1,
      skill: { path: 'skills/findWords/SKILL.md', name: '找单词' } },
    { kind: 'window',        type: 'object', label: '窗户',     defaultHeight: 1.2,  ctx: '用户走到窗边，望向窗外的景色', image: null, maxCount: 1 },
    // 厨房区
    { kind: 'kitchen-island',type: 'object', label: '厨房中岛', defaultHeight: 0.9,  ctx: '用户走到厨房中岛旁，似乎想做点吃的', image: null, maxCount: 1,
      skill: { path: 'skills/familyMatch/SKILL.md', name: '亲情连连看' } },
    { kind: 'fridge',        type: 'object', label: '冰箱',     defaultHeight: 1.7,  ctx: '用户打开冰箱看了看', image: null, maxCount: 1 },
  ];

  // =================== 初始场景布局 ===================
  // 只描述位置与 kind 引用，物品的尺寸由 catalog 中的 defaultHeight × 运行时 pxPerMeter 决定。
  // x、y 均为米（相对 scene 左上角）。运行时换算：xPx = x * pxPerMeter，yPx = y * pxPerMeter。
  const INITIAL_PLACEMENTS = [
    // 墙上照片
    { kind: 'photo-family',   x: 1.448,  y: 0.842 },
    { kind: 'photo-travel',   x: 2.336,  y: 0.976 },
    { kind: 'photo-pet',      x: 3.165,  y: 0.842 },
    { kind: 'photo-family',   x: 12.128, y: 0.636 },
    // 客厅区
    { kind: 'sofa',           x: 2.348,  y: 2.053 },
    { kind: 'lamp',           x: 3.986,  y: 1.996 },
    { kind: 'tv',             x: 5.231,  y: 1.198 },
    { kind: 'plant',          x: 6.308,  y: 1.842 },
    // 书房 / 电脑区
    { kind: 'bookshelf',      x: 7.174,  y: 2.024 },
    { kind: 'computer-desk',  x: 8.936,  y: 2.101 },
    { kind: 'window',         x: 10.691, y: 1.283 },
    // 厨房区
    { kind: 'kitchen-island', x: 12.244, y: 1.996 },
    { kind: 'fridge',         x: 13.684, y: 1.943 },
  ];

  // 可选的全局素材覆盖： id -> URL（item.image 优先级更高）
  const ASSET_OVERRIDES = {
    // 'photo-family': 'https://cdn.example.com/photo-family.webp',
  };

  // =================== SVG 资源 ===================
  // 每个 SVG 按自身 viewBox 比例设计，通过 width/height 100% 自动缩放填充
  const SVGS = {
    'photo-family': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 130" preserveAspectRatio="xMidYMid slice">
      <rect width="180" height="130" fill="#d9ecf6"/>
      <rect y="86" width="180" height="44" fill="#86b07a"/>
      <circle cx="50" cy="60" r="13" fill="#f3c89a"/><rect x="40" y="73" width="20" height="30" rx="3" fill="#5b8def"/>
      <circle cx="92" cy="52" r="16" fill="#f3c89a"/><rect x="78" y="68" width="28" height="38" rx="3" fill="#d9534f"/>
      <circle cx="132" cy="64" r="11" fill="#f3c89a"/><rect x="124" y="75" width="16" height="26" rx="3" fill="#f0ad4e"/>
    </svg>`,
    'photo-travel': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 200" preserveAspectRatio="xMidYMid slice">
      <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fcd7a3"/><stop offset="1" stop-color="#9ec9e8"/></linearGradient></defs>
      <rect width="150" height="200" fill="url(#sky)"/>
      <circle cx="105" cy="55" r="18" fill="#fff3a8"/>
      <polygon points="0,140 40,70 75,120 95,90 150,140 150,160 0,160" fill="#5d6e7a"/>
      <polygon points="20,140 45,90 70,140" fill="#fff" opacity="0.85"/>
      <rect y="155" width="150" height="45" fill="#3d6f8a"/>
      <rect y="180" width="150" height="20" fill="#2c5773"/>
    </svg>`,
    'photo-pet': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 130" preserveAspectRatio="xMidYMid slice">
      <rect width="160" height="130" fill="#e8d8b0"/>
      <rect y="95" width="160" height="35" fill="#9bb56a"/>
      <ellipse cx="80" cy="92" rx="44" ry="20" fill="#d99c52"/>
      <circle cx="115" cy="78" r="20" fill="#d99c52"/>
      <ellipse cx="105" cy="65" rx="6" ry="10" fill="#a87436"/>
      <ellipse cx="125" cy="65" rx="6" ry="10" fill="#a87436"/>
      <circle cx="120" cy="80" r="2" fill="#222"/><circle cx="112" cy="80" r="2" fill="#222"/>
      <ellipse cx="116" cy="86" rx="3" ry="2" fill="#222"/>
      <rect x="55" y="100" width="6" height="14" fill="#a87436"/><rect x="72" y="100" width="6" height="14" fill="#a87436"/>
      <rect x="92" y="100" width="6" height="14" fill="#a87436"/><rect x="108" y="100" width="6" height="14" fill="#a87436"/>
    </svg>`,
    'sofa': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 200" preserveAspectRatio="xMidYMax meet">
      <rect x="10" y="60" width="500" height="110" rx="22" fill="#7c5d8a"/>
      <rect x="0" y="70" width="40" height="120" rx="18" fill="#6a4f76"/>
      <rect x="480" y="70" width="40" height="120" rx="18" fill="#6a4f76"/>
      <rect x="40" y="40" width="440" height="70" rx="14" fill="#9577a3"/>
      <rect x="55" y="100" width="135" height="50" rx="10" fill="#a98ab6"/>
      <rect x="195" y="100" width="135" height="50" rx="10" fill="#a98ab6"/>
      <rect x="335" y="100" width="135" height="50" rx="10" fill="#a98ab6"/>
      <rect x="60" y="115" width="50" height="35" rx="8" fill="#f4d976"/>
      <rect x="380" y="115" width="50" height="35" rx="8" fill="#f08a6e"/>
      <rect x="40" y="170" width="20" height="20" fill="#3a2a40"/>
      <rect x="460" y="170" width="20" height="20" fill="#3a2a40"/>
    </svg>`,
    'lamp': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 340" preserveAspectRatio="xMidYMax meet">
      <ellipse cx="45" cy="80" rx="38" ry="16" fill="#fff3b0" opacity="0.5"/>
      <path d="M20 50 L70 50 L62 95 L28 95 Z" fill="#d4a04a"/>
      <rect x="43" y="95" width="4" height="220" fill="#3d2c1a"/>
      <ellipse cx="45" cy="320" rx="28" ry="8" fill="#2a1c10"/>
    </svg>`,
    'tv': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 220" preserveAspectRatio="xMidYMid meet">
      <rect x="6" y="6" width="368" height="208" rx="10" fill="#1a1a1a"/>
      <rect x="18" y="18" width="344" height="184" rx="4" fill="#2c5b8a"/>
      <circle cx="120" cy="100" r="32" fill="#f9c270"/>
      <rect x="60" y="150" width="260" height="36" fill="#3a7aa8"/>
      <rect x="170" y="200" width="40" height="10" fill="#1a1a1a"/>
      <rect x="155" y="208" width="70" height="6" rx="2" fill="#1a1a1a"/>
    </svg>`,
    'plant': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 270" preserveAspectRatio="xMidYMax meet">
      <ellipse cx="70" cy="200" rx="54" ry="14" fill="#7a4a2a"/>
      <path d="M70 210 L25 200 L35 270 L105 270 L115 200 Z" fill="#a26136"/>
      <path d="M70 200 Q40 140 25 80 Q55 120 70 180 Z" fill="#3d8049"/>
      <path d="M70 200 Q100 140 115 80 Q85 120 70 180 Z" fill="#4a9657"/>
      <path d="M70 200 Q70 130 70 60 Q90 100 80 180 Z" fill="#5dab68"/>
      <path d="M70 200 Q50 150 55 100 Q65 140 70 180 Z" fill="#3d8049"/>
    </svg>`,
    'bookshelf': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 440" preserveAspectRatio="xMidYMax meet">
      <rect width="280" height="440" fill="#5a3a22"/>
      <rect x="10" y="10" width="260" height="420" fill="#7a5532"/>
      <g fill="#5a3a22"><rect x="10" y="105" width="260" height="6"/><rect x="10" y="210" width="260" height="6"/><rect x="10" y="315" width="260" height="6"/></g>
      <!-- shelf 1 -->
      <g><rect x="20" y="30" width="18" height="75" fill="#c9472f"/><rect x="40" y="35" width="14" height="70" fill="#f0a04a"/><rect x="56" y="40" width="20" height="65" fill="#3a6fa3"/><rect x="78" y="32" width="16" height="73" fill="#5b8a3a"/><rect x="100" y="50" width="60" height="55" fill="#8a6230"/><rect x="165" y="36" width="14" height="69" fill="#a83a5a"/><rect x="181" y="42" width="20" height="63" fill="#2a4a6a"/><rect x="203" y="38" width="16" height="67" fill="#d9a93a"/><rect x="221" y="34" width="18" height="71" fill="#5a3a8a"/></g>
      <!-- shelf 2 -->
      <g><rect x="22" y="138" width="16" height="72" fill="#3a8a6a"/><rect x="40" y="135" width="14" height="75" fill="#d9534f"/><rect x="56" y="145" width="18" height="65" fill="#e8c14a"/><rect x="76" y="140" width="16" height="70" fill="#5a6aa3"/><circle cx="115" cy="195" r="14" fill="#c9a06a"/><rect x="135" y="142" width="14" height="68" fill="#7a3a5a"/><rect x="151" y="138" width="20" height="72" fill="#4a8a3a"/><rect x="173" y="148" width="14" height="62" fill="#d97a3a"/><rect x="189" y="140" width="18" height="70" fill="#3a4a7a"/><rect x="209" y="144" width="16" height="66" fill="#8a3a3a"/><rect x="227" y="140" width="14" height="70" fill="#3a6a8a"/></g>
      <!-- shelf 3 -->
      <g><rect x="20" y="240" width="22" height="75" fill="#6a4a8a"/><rect x="44" y="245" width="14" height="70" fill="#d9a04a"/><rect x="60" y="240" width="18" height="75" fill="#3a7a8a"/><rect x="80" y="248" width="14" height="67" fill="#a8543a"/><rect x="96" y="244" width="20" height="71" fill="#5a8a3a"/><rect x="118" y="240" width="14" height="75" fill="#3a3a6a"/><rect x="135" y="270" width="50" height="45" fill="#c9a06a"/><rect x="190" y="244" width="16" height="71" fill="#d94a4a"/><rect x="208" y="240" width="14" height="75" fill="#3a8a4a"/><rect x="224" y="248" width="14" height="67" fill="#8a6a3a"/></g>
      <!-- shelf 4 (decor) -->
      <g><circle cx="50" cy="380" r="22" fill="#3a6a8a"/><rect x="90" y="345" width="40" height="75" fill="#d4a04a"/><rect x="140" y="360" width="14" height="60" fill="#a8543a"/><path d="M170 420 L185 360 L200 420 Z" fill="#5a8a3a"/><rect x="215" y="350" width="30" height="70" rx="4" fill="#7a3a5a"/></g>
    </svg>`,
    'computer-desk': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 300" preserveAspectRatio="xMidYMax meet">
      <!-- chair -->
      <rect x="40" y="170" width="80" height="60" rx="6" fill="#2a2a2a"/>
      <rect x="48" y="120" width="64" height="60" rx="6" fill="#3a3a3a"/>
      <rect x="76" y="230" width="6" height="40" fill="#1a1a1a"/>
      <ellipse cx="80" cy="280" rx="36" ry="6" fill="#1a1a1a"/>
      <!-- desk top -->
      <rect x="130" y="180" width="240" height="14" fill="#a87a4a"/>
      <rect x="130" y="194" width="240" height="6" fill="#7a5532"/>
      <rect x="138" y="200" width="10" height="90" fill="#7a5532"/>
      <rect x="352" y="200" width="10" height="90" fill="#7a5532"/>
      <!-- monitor -->
      <rect x="180" y="60" width="160" height="105" rx="4" fill="#1a1a1a"/>
      <rect x="188" y="68" width="144" height="89" fill="#3a7ac9"/>
      <rect x="220" y="100" width="80" height="6" fill="#fff" opacity="0.7"/>
      <rect x="220" y="112" width="60" height="4" fill="#fff" opacity="0.5"/>
      <rect x="220" y="120" width="70" height="4" fill="#fff" opacity="0.5"/>
      <rect x="252" y="165" width="16" height="14" fill="#1a1a1a"/>
      <rect x="240" y="178" width="40" height="4" rx="2" fill="#1a1a1a"/>
      <!-- keyboard / mouse -->
      <rect x="200" y="200" width="110" height="14" rx="3" fill="#d4d4d4"/>
      <rect x="320" y="204" width="20" height="12" rx="6" fill="#d4d4d4"/>
      <!-- mug -->
      <rect x="155" y="158" width="22" height="22" rx="2" fill="#c9472f"/>
      <path d="M177 162 q10 0 10 8 t-10 8" fill="none" stroke="#c9472f" stroke-width="3"/>
    </svg>`,
    'window': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 320" preserveAspectRatio="xMidYMid slice">
      <rect width="300" height="320" fill="#6a4a30"/>
      <rect x="14" y="14" width="272" height="292" fill="#cfe7f5"/>
      <defs><linearGradient id="wsky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9ed6f5"/><stop offset="1" stop-color="#dff1fa"/></linearGradient></defs>
      <rect x="14" y="14" width="272" height="200" fill="url(#wsky)"/>
      <circle cx="220" cy="70" r="26" fill="#fff5b0"/>
      <ellipse cx="80" cy="90" rx="40" ry="12" fill="#fff" opacity="0.85"/>
      <ellipse cx="170" cy="120" rx="32" ry="10" fill="#fff" opacity="0.75"/>
      <rect x="14" y="214" width="272" height="92" fill="#86b07a"/>
      <polygon points="14,214 80,160 150,214" fill="#5d8a5a"/>
      <polygon points="120,214 200,140 280,214" fill="#4a7a4a"/>
      <!-- mullions -->
      <rect x="146" y="14" width="8" height="292" fill="#6a4a30"/>
      <rect x="14" y="156" width="272" height="8" fill="#6a4a30"/>
      <!-- sill -->
      <rect x="0" y="300" width="300" height="20" fill="#8a6240"/>
    </svg>`,
    'kitchen-island': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 200" preserveAspectRatio="xMidYMax meet">
      <rect x="20" y="50" width="420" height="130" fill="#e8e2d4"/>
      <rect x="20" y="40" width="420" height="20" rx="4" fill="#3a3a3a"/>
      <g stroke="#bcb39d" stroke-width="1" fill="none"><line x1="120" y1="60" x2="120" y2="180"/><line x1="240" y1="60" x2="240" y2="180"/><line x1="360" y1="60" x2="360" y2="180"/></g>
      <g fill="#a8a8a8"><circle cx="80" cy="100" r="6"/><circle cx="80" cy="125" r="6"/><circle cx="180" cy="100" r="6"/><circle cx="180" cy="125" r="6"/></g>
      <!-- countertop items -->
      <rect x="270" y="10" width="50" height="40" rx="3" fill="#c9472f"/>
      <ellipse cx="295" cy="10" rx="25" ry="5" fill="#8a3a2a"/>
      <rect x="340" y="20" width="30" height="30" rx="4" fill="#d4d4d4"/>
      <circle cx="380" cy="35" r="14" fill="#f4d976"/>
      <!-- stools -->
      <circle cx="60" cy="190" r="14" fill="#3a3a3a"/>
      <circle cx="200" cy="190" r="14" fill="#3a3a3a"/>
      <circle cx="340" cy="190" r="14" fill="#3a3a3a"/>
    </svg>`,
    'fridge': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 400" preserveAspectRatio="xMidYMax meet">
      <rect x="6" y="6" width="188" height="388" rx="10" fill="#dcdcdc"/>
      <rect x="14" y="14" width="172" height="120" rx="6" fill="#c8c8c8"/>
      <rect x="14" y="142" width="172" height="246" rx="6" fill="#c8c8c8"/>
      <line x1="100" y1="14" x2="100" y2="134" stroke="#a8a8a8" stroke-width="2"/>
      <rect x="22" y="50" width="6" height="40" rx="2" fill="#7a7a7a"/>
      <rect x="172" y="50" width="6" height="40" rx="2" fill="#7a7a7a"/>
      <rect x="22" y="220" width="6" height="80" rx="2" fill="#7a7a7a"/>
      <!-- LCD panel -->
      <rect x="60" y="30" width="80" height="22" rx="3" fill="#1a3a4a"/>
      <rect x="68" y="36" width="40" height="4" fill="#5fd9c9"/>
      <rect x="68" y="44" width="28" height="3" fill="#5fd9c9" opacity="0.7"/>
      <!-- magnets -->
      <circle cx="50" cy="180" r="8" fill="#d9534f"/>
      <rect x="80" y="170" width="40" height="22" fill="#fff" stroke="#aaa"/>
    </svg>`,
  };

  window.DH_HOME_CATALOG = {
    ROOM_HEIGHT_METERS,
    REFERENCE_HEIGHT_PX,
    SCENE_WIDTH,
    FLOOR_Y,
    CATALOG,
    INITIAL_PLACEMENTS,
    ASSET_OVERRIDES,
    SVGS,
  };
})();
