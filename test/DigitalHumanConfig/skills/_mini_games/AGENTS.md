# AI-Assisted Mini Game H5 Page Patterns

## Overview

Each mini game is a **single-page HTML app** designed to be driven by an AI assistant through Copilot App Tools (`type_in_app`, `click_element`). The user sees only the game UI; the AI interacts with **invisible control panels** containing textboxes and buttons that are hidden from the user but discoverable by App Tools via `data-ai-*` attributes.

## Architecture

```
┌─────────────────────────────────────────────┐
│  AI Assistant (Copilot App Tools)           │
│  ├─ type_in_app → hidden textboxes          │
│  └─ click_element → hidden buttons          │
└──────────┬──────────────────────┬───────────┘
           │                      │
    ┌──────▼──────┐       ┌──────▼──────┐
    │  AI Panel   │       │  Game UI    │
    │  (invisible)│──────>│  (visible)  │
    │  textbox,   │ state │  questions, │
    │  buttons    │ sync  │  choices,   │
    └─────────────┘       │  results    │
                          └──────┬──────┘
                                 │ postMessage
                          ┌──────▼──────┐
                          │ Parent page │
                          └─────────────┘
```

## Core Patterns

### 1. SDK Bootstrap

Always load the KeepworkSDK via URL param with CDN fallback. Support both IIFE and ES module modes:

```html
<script>
  (function() {
    var params = new URLSearchParams(window.location.search);
    var sdkUrl = params.get('sdk') || 'https://cdn.keepwork.com/sdk/keepworkSDK.iife.js';
    var isModule = params.get('module') === '1';
    var s = document.createElement('script');
    if (isModule) s.type = 'module';
    s.src = sdkUrl;
    document.head.appendChild(s);
  })();
</script>
```

After the SDK script is injected, use `waitForSdkGlobals()` to wait until `window.KeepworkSDK` is available before proceeding:

```js
// =================== Wait for SDK ===================
    function waitForSdkGlobals(timeoutMs) {
      timeoutMs = timeoutMs || 10000;
      var start = Date.now();
      return new Promise(function(resolve) {
        (function check() {
          if (typeof window.KeepworkSDK === 'function') return resolve();
          if (Date.now() - start >= timeoutMs) return resolve();
          setTimeout(check, 30);
        })();
      });
    }
```

After SDK loads, read `?token=` from URL and call `window.keepwork.setToken(token)` so the page can make authenticated API calls.

### 2. Invisible AI Panel

The AI panel contains elements that are **only operated by the AI** via App Tools. They are hidden from the user by default:

```html
<div id="inputWrapper" style="opacity:0;position:absolute;pointer-events:none;height:0;overflow:hidden">
  <div id="questionInput"
       data-ai-type="textbox"
       aria-label="题目JSON"
       data-ai-hint="Describe what the AI should write here and in what format">
  </div>
</div>
```

**Key attributes:**
- `data-ai-type="textbox"` — tells App Tools this is a writable text field.
- `aria-label` — short identifier for the element (App Tools uses this to find it).
- `data-ai-hint` — detailed instruction for the AI on what to write and the expected format.

Hidden buttons follow the same pattern:

```html
<div style="opacity:0;position:absolute;pointer-events:none">
  <button id="btnCorrect" aria-label="答对了" data-ai-hint="用户回答正确时AI点击此按钮计分">答对了</button>
  <button id="btnFinish" aria-label="结束" data-ai-hint="AI点击此按钮结束训练">结束</button>
</div>
```

**重要**：“下一题”按钮已废弃。AI 应直接通过 `type_in_app` 写入下一题的内容/JSON，界面会自动推进到下一题。题目数量由 `type_in_app` 调用次数决定。

### 3. Dev Mode

When `?dev=true` is in the URL, reveal the AI panel so developers can manually test:

```js
if (new URLSearchParams(window.location.search).get('dev') === 'true') {
  const wrapper = document.getElementById('inputWrapper');
  wrapper.style.opacity = '1';
  wrapper.style.position = 'static';
  wrapper.style.pointerEvents = 'auto';
  wrapper.style.height = 'auto';
  wrapper.style.overflow = 'visible';
  // Make textbox editable and styled
  questionInput.contentEditable = 'true';
  questionInput.style.cssText = 'border:2px dashed #94a3b8;border-radius:8px;padding:12px;...';
}
```

### 4. AI → Game Data Flow

There are two patterns for AI-driven content injection:

#### Pattern A: JSON via MutationObserver (simpleChoice)

The AI writes a JSON string into a hidden `div` via `type_in_app`. A `MutationObserver` watches for changes and parses + renders the content:

```js
const observer = new MutationObserver(() => {
  const raw = (questionInput.textContent || '').trim();
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    if (data && data.question && Array.isArray(data.choices)) {
      renderQuestion(data);
    }
  } catch (e) { /* ignore invalid JSON */ }
});
observer.observe(questionInput, { childList: true, characterData: true, subtree: true });
```

**Use this when:** the AI needs to send structured data (questions with choices, answers, configs).

#### Pattern B: Direct text via type_in_app (simpleQuestionBoard)

The AI writes plain text directly into a visible (to the user) element that doubles as the display:

```html
<div id="questionText"
     data-ai-type="textbox"
     aria-label="问题"
     data-ai-hint="AI用type_in_app填写当前问题内容">等待出题...</div>
```

**Use this when:** the AI content is simple text displayed as-is (no parsing needed).

#### Pattern C: Line-delimited text (findWords)

The AI writes multiple items separated by newlines. The game parses on mutation:

```html
<div id="wordsInput" data-ai-type="textbox" aria-label="单词列表"
     data-ai-hint="AI用type_in_app写入单词，每行一个，最多10行"></div>
```

**Use this when:** the AI provides a list of items (words, clues, etc.).

### 5. Game → AI Communication

#### User actions → dh:context to parent DigitalHuman

When the user performs a **major interaction** (selecting a choice, submitting an answer, completing a round, etc.), send a `dh:context` message to the parent window. This injects context into the AI's conversation so it can react naturally:

```js
window.parent.postMessage({
  type: 'dh:context',
  text: '用户选择了选项B "北京"',
  debounce: 2000
}, '*');
```

**Parameters:**
- `text` — A short, descriptive string of what happened (e.g. `'用户答对了第3题'`, `'用户选择了"苹果"'`, `'用户完成了本轮，正确率80%'`).
- `debounce` — Milliseconds to wait before auto-flushing context with a `"(continue)"` message. Use `2000`–`5000` for interactions where the AI should comment shortly after. Omit (defaults to Infinity) if the context should only be consumed with the user's next message.

**When to send `dh:context`:**
- User selects a choice / taps an answer
- User completes a question (correct or incorrect)
- A round or level finishes
- User triggers a notable UI action (e.g. reveals a hint, skips a question)

**When NOT to send:**
- Trivial UI interactions (scrolling, hovering)
- Rapid-fire events (debounce or throttle first)

**Debounce guidelines:**
- **In-game actions** (choice selected, answer judged, word found, pair matched, item swapped, hint used): use `debounce: 2000`–`3000` so the AI comments shortly after.
- **Game completion** (all words found, all pairs matched, order fully correct, result page shown): **omit `debounce`** (defaults to Infinity). The context waits for the user's next message — the AI should not auto-speak over the result screen.

Example patterns:

```js
// User picked a choice (debounce so AI reacts)
window.parent.postMessage({
  type: 'dh:context',
  text: `用户选择了第${idx + 1}个选项"${choices[idx]}"，${isCorrect ? '回答正确' : '回答错误，正确答案是"' + correctAnswer + '"'}`,
  debounce: 2000
}, '*');

// Round finished (debounce so AI comments on the round)
window.parent.postMessage({
  type: 'dh:context',
  text: `本轮结束，共${total}题，答对${correct}题，正确率${accuracy}%`,
  debounce: 3000
}, '*');

// Game finished — NO debounce (wait for user's next message)
window.parent.postMessage({
  type: 'dh:context',
  text: `游戏结束，共${total}题，答对${correct}题，正确率${accuracy}%。${comment}`
}, '*');
```

#### Game lifecycle events → postMessage to parent

Every game must send these messages:

| Event | When | Payload |
|-------|------|---------|
| `gameLoaded` | On initialization | `{}` |
| `gameFinished` | When user clicks Close on result page, **or automatically 5 seconds after the result page is shown** (whichever comes first) | `{ total, correct, accuracy, comment }` |

```js
// On init
window.parent.postMessage({ type: 'gameLoaded' }, '*');

// On close
window.parent.postMessage({
  type: 'gameFinished',
  data: { total, correct, accuracy, comment }
}, '*');
```

### 6. AI Flow Control Buttons

Each game provides hidden buttons for the AI to control the game flow. Common set:

| Button | aria-label | Purpose |
|--------|-----------|---------|
| `btnShowAnswer` | 显示答案 | Reveal the correct answer (optional, for quiz-type games) |
| `btnCorrect` | 答对了 | Mark current answer as correct (for voice/free-form answer games) |
| `btnNext` | 下一题 | **已废弃**：AI应直接通过 `type_in_app` 写入下一题内容，无需点击此按钮 |
| `btnFinish` | 结束 | End the game and show results |
| `btnClose` | 关闭 | Close the game (sends `gameFinished` to parent) |

**新流程**：AI 直接调用 `type_in_app` 写入下一题的内容/JSON，界面自动推进题号。题目数量由 `type_in_app` 调用次数决定。“答对了”按钮保留用于计分。

### 7. State Management

Keep a simple state object tracking game progress:

```js
const state = {
  currentIndex: 0,
  correctCount: 0,
  finished: false,
  // ... game-specific fields
};
```

State is local only (no persistence). The result summary is computed from state when the game finishes.

### 8. Result Page

Every game includes a result page that is hidden during gameplay and shown when `btnFinish` is clicked:

```html
<div id="resultPage" class="hidden text-center py-8 px-2.5">
  <div class="text-6xl mb-5">🎉</div>
  <h2>训练完成！</h2>
  <!-- Stats cards: total, correct, accuracy -->
  <!-- Comment / summary -->
  <!-- Close button (sends gameFinished to parent) -->
</div>
```

The close button on the result page is the **only user-visible button** that triggers `gameFinished`. Additionally, a **5-second auto-finish timer** starts when the result page is shown — if the user does not click Close within 5 seconds, `gameFinished` is sent automatically. Clicking Close cancels the timer to avoid duplicate messages.

### 9. Visual Feedback

Use a floating emoji overlay for instant feedback:

```html
<div id="feedback" class="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2
     text-5xl opacity-0 scale-50 pointer-events-none transition-all duration-400 z-50"></div>
```

```js
function showFeedback(emoji) {
  feedbackEl.textContent = emoji;
  feedbackEl.classList.remove('opacity-0', 'scale-50');
  feedbackEl.classList.add('opacity-100', 'scale-100');
  setTimeout(() => {
    feedbackEl.classList.remove('opacity-100', 'scale-100');
    feedbackEl.classList.add('opacity-0', 'scale-50');
  }, 800);
}
```

## Styling Conventions

- Use **Tailwind CSS** via CDN (`tailwindcss@3.4.16.js`).
- Custom CSS only for animations, game-specific visuals (hex grids, Kahoot-style buttons), and the feedback overlay.
- Mobile-first responsive: `max-w-[480px]`, touch-friendly tap targets (min 48px).
- Card container: `bg-white rounded-2xl shadow-lg px-6 py-7`.

## Checklist for New Mini Games

1. [ ] Single HTML file, no build step required
2. [ ] SDK bootstrap with `?sdk=` param and CDN fallback
3. [ ] Token passthrough from `?token=` URL param
4. [ ] Hidden AI panel with `data-ai-type`, `aria-label`, `data-ai-hint`
5. [ ] `?dev=true` reveals AI panel for manual testing
6. [ ] `MutationObserver` or direct text for AI → game data flow
7. [ ] Hidden flow-control buttons (`btnNext`, `btnFinish`, `btnClose`)
8. [ ] Send `dh:context` on major user interactions (choice selected, answer submitted, round complete)
9. [ ] Send `gameLoaded` on init, `gameFinished` on close (auto-sent after 5s if user doesn't click Close)
10. [ ] Container-level `data-ai-hint` describing the overall game interaction model
11. [ ] Result page with stats (total, correct, accuracy) and close button
12. [ ] Feedback overlay for correct/incorrect responses
13. [ ] Tailwind CSS via CDN, mobile-friendly layout
