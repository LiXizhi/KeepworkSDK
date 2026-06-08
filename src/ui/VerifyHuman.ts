/**
 * VerifyHuman.ts — 纯客户端滑块验证码（"滑动验证"，完整 TypeScript 实现）
 *
 * 显示一个滑块拼图，用户需把滑块拖到轨道末端。这是轻量级机器人拦截，
 * **不**替代服务端限流，但能提高自动化表单提交的门槛。
 *
 * @example
 *   const ok = await VerifyHuman.verify({ lang: 'zhCN' });
 *   // ok === true → 通过；reject → 用户取消
 */

// ──────────────────── 类型 ────────────────────

/** verify() 选项 */
export interface VerifyHumanOptions {
  /** 语言：'zhCN' | 'enUS'（省略时自动检测） */
  lang?: 'zhCN' | 'enUS';
}

/** 单语言文案 */
interface VerifyStrings {
  title: string;
  slide: string;
  success: string;
  fail: string;
  cancel: string;
}

// ──────────────────── 样式与文案 ────────────────────

const VERIFY_STYLES = `
  .kw-verify-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999999;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  .kw-verify-box {
    background: #fff;
    border-radius: 12px;
    padding: 24px 24px 20px;
    width: 340px;
    max-width: 92vw;
    box-shadow: 0 8px 32px rgba(0,0,0,0.22);
    animation: kwvFadeIn 0.2s ease-out;
    user-select: none;
  }
  @keyframes kwvFadeIn {
    from { opacity: 0; transform: scale(0.95); }
    to   { opacity: 1; transform: scale(1); }
  }
  .kw-verify-title {
    font-size: 15px;
    font-weight: 600;
    color: #333;
    margin: 0 0 16px;
    text-align: center;
  }
  .kw-verify-track {
    position: relative;
    height: 44px;
    background: #f0f2f5;
    border-radius: 22px;
    overflow: hidden;
    border: 1px solid #e0e4e8;
    touch-action: none;
  }
  .kw-verify-track-label {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    color: #b0b8c1;
    pointer-events: none;
    transition: opacity 0.2s;
  }
  .kw-verify-fill {
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 0;
    background: linear-gradient(135deg, #67c23a, #4caf50);
    border-radius: 22px;
    transition: none;
  }
  .kw-verify-fill.success {
    transition: width 0.15s ease;
  }
  .kw-verify-thumb {
    position: absolute;
    top: 2px;
    left: 0;
    width: 40px;
    height: 40px;
    background: #fff;
    border-radius: 50%;
    box-shadow: 0 2px 8px rgba(0,0,0,0.18);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    cursor: grab;
    transition: none;
    touch-action: none;
  }
  .kw-verify-thumb:active { cursor: grabbing; }
  .kw-verify-thumb.success {
    background: #67c23a;
    color: #fff;
    cursor: default;
    transition: background 0.2s;
  }
  .kw-verify-thumb.fail {
    transition: left 0.3s ease;
  }
  .kw-verify-cancel {
    display: block;
    margin: 12px auto 0;
    border: none;
    background: none;
    color: #999;
    font-size: 13px;
    cursor: pointer;
    padding: 4px 8px;
  }
  .kw-verify-cancel:hover { color: #666; }
`;

const I18N: Record<'zhCN' | 'enUS', VerifyStrings> = {
  zhCN: {
    title: '安全验证',
    slide: '向右滑动完成验证',
    success: '验证通过',
    fail: '请重试',
    cancel: '取消',
  },
  enUS: {
    title: 'Security Check',
    slide: 'Slide to verify',
    success: 'Verified',
    fail: 'Try again',
    cancel: 'Cancel',
  },
};

let _styleInjected = false;

/** 注入样式（仅一次）。 */
function injectStyles(): void {
  if (_styleInjected) return;
  const el = document.createElement('style');
  el.textContent = VERIFY_STYLES;
  document.head.appendChild(el);
  _styleInjected = true;
}

/** HTML 转义。 */
function esc(str: string): string {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ──────────────────── VerifyHuman ────────────────────

export default class VerifyHuman {
  /**
   * 显示滑块验证码并返回 Promise。
   * @returns 成功时 resolve(true)，用户取消时 reject。
   */
  static verify(options: VerifyHumanOptions = {}): Promise<true> {
    injectStyles();

    const langKey: 'zhCN' | 'enUS' = options.lang || (
      typeof navigator !== 'undefined' && (navigator.language || '').toLowerCase().startsWith('zh')
        ? 'zhCN' : 'enUS'
    );
    const t = I18N[langKey] || I18N.enUS;

    return new Promise<true>((resolve, reject) => {
      const overlay = document.createElement('div');
      overlay.className = 'kw-verify-overlay';

      overlay.innerHTML = `
        <div class="kw-verify-box">
          <div class="kw-verify-title">${esc(t.title)}</div>
          <div class="kw-verify-track" data-v="track">
            <div class="kw-verify-fill" data-v="fill"></div>
            <div class="kw-verify-track-label" data-v="label">${esc(t.slide)}</div>
            <div class="kw-verify-thumb" data-v="thumb">➜</div>
          </div>
          <button class="kw-verify-cancel" data-v="cancel">${esc(t.cancel)}</button>
        </div>
      `;

      const q = (s: string): HTMLElement => overlay.querySelector(`[data-v="${s}"]`) as HTMLElement;
      const track = q('track');
      const fill = q('fill');
      const thumb = q('thumb');
      const label = q('label');
      const cancelBtn = q('cancel');

      let dragging = false;
      let startX = 0;
      let thumbLeft = 0;
      let resolved = false;

      const THUMB_W = 40;
      const getMaxLeft = (): number => track.offsetWidth - THUMB_W - 4; // 4 = 两侧各 2px padding
      const SUCCESS_THRESHOLD = 0.95; // 需拖动 ≥ 95% 才通过

      let cleanup = (): void => {
        if (overlay.parentNode) overlay.remove();
      };

      function doCancel(): void {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(new Error('Verification cancelled'));
      }

      function doSuccess(): void {
        if (resolved) return;
        resolved = true;
        const maxLeft = getMaxLeft();
        thumb.style.left = maxLeft + 'px';
        fill.style.width = (maxLeft + THUMB_W) + 'px';
        fill.classList.add('success');
        thumb.classList.add('success');
        thumb.innerHTML = '✓';
        label.textContent = t.success;
        label.style.color = '#fff';
        label.style.fontWeight = '600';
        setTimeout(() => {
          cleanup();
          resolve(true);
        }, 400);
      }

      function resetThumb(): void {
        thumb.classList.add('fail');
        label.textContent = t.fail;
        label.style.color = '#f56c6c';
        thumb.style.left = '0px';
        fill.style.width = '0px';
        fill.classList.remove('success');
        setTimeout(() => {
          thumb.classList.remove('fail');
          label.textContent = t.slide;
          label.style.color = '';
        }, 600);
      }

      // ── pointer 事件（鼠标与触摸通用）──
      function onDown(e: PointerEvent): void {
        if (resolved) return;
        dragging = true;
        startX = e.clientX ?? 0;
        thumbLeft = 0;
        thumb.setPointerCapture?.(e.pointerId);
        e.preventDefault();
      }

      function onMove(e: PointerEvent): void {
        if (!dragging || resolved) return;
        const clientX = e.clientX ?? 0;
        const dx = clientX - startX;
        const maxLeft = getMaxLeft();
        thumbLeft = Math.max(0, Math.min(dx, maxLeft));
        thumb.style.left = thumbLeft + 'px';
        fill.style.width = (thumbLeft + THUMB_W / 2) + 'px';
        // 拖动时淡出文案
        label.style.opacity = String(1 - thumbLeft / maxLeft);
      }

      function onUp(): void {
        if (!dragging || resolved) return;
        dragging = false;
        const maxLeft = getMaxLeft();
        if (maxLeft > 0 && thumbLeft / maxLeft >= SUCCESS_THRESHOLD) {
          doSuccess();
        } else {
          resetThumb();
        }
      }

      thumb.addEventListener('pointerdown', onDown);
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);

      cancelBtn.addEventListener('click', doCancel);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) doCancel();
      });

      // 完成时清理监听器
      const origCleanup = cleanup;
      cleanup = (): void => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        origCleanup();
      };

      document.body.appendChild(overlay);
    });
  }
}
