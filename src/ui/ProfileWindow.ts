/**
 * ProfileWindow - Self-contained user profile modal for KeepworkSDK.
 *
 * Features:
 * - Display username, phone (masked), email
 * - Change password (old + new + confirm)
 * - VIP / SVIP status display with expiration dates
 * - Activation code input for VIP redemption
 * - English / Chinese i18n (auto-detected from system language)
 * - Mobile-responsive (full-screen on small viewports)
 *
 * All UI, styles, and logic are self-contained in this file.
 */

// ── 类型声明 ──

/** show() 选项 */
export interface ProfileWindowShowOptions {
  /** 自定义标题 */
  title?: string;
  /** 语言：'zhCN' | 'enUS'（省略时自动检测） */
  lang?: 'zhCN' | 'enUS';
  /** 是否显示修改密码区（默认 true） */
  enablePassword?: boolean;
  /** 是否显示 VIP 区与激活码（默认 true） */
  enableVip?: boolean;
}

/** 单语言文案表 */
type ProfileStrings = Record<string, string>;

/** sdk 需提供的最小接口 */
interface ProfileWindowSdk {
  token?: string;
  getUserProfile(options?: { forceRefresh?: boolean }): Promise<Record<string, unknown>>;
  getAuthHeaders(): Record<string, string>;
  extractMainDomain(hostname: string): string;
  put(path: string, body?: unknown): Promise<unknown>;
  logout(): Promise<unknown>;
  [key: string]: unknown;
}

// ── i18n ──

const TRANSLATIONS = {
  zhCN: {
    profile: '个人信息',
    username: '用户名',
    phone: '手机号',
    email: '邮箱',
    notSet: '未设置',
    changePassword: '修改密码',
    oldPassword: '当前密码',
    newPassword: '新密码',
    confirmPassword: '确认新密码',
    changeBtn: '修改密码',
    changing: '修改中...',
    passwordChanged: '密码修改成功',
    vipStatus: '会员状态',
    vip: 'VIP会员',
    svip: 'SVIP会员',
    notVip: '非会员',
    expiresOn: '到期时间',
    activationCode: '激活码',
    activationPlaceholder: '请输入激活码',
    activateBtn: '激活',
    activating: '激活中...',
    activateSuccess: '激活成功',
    close: '关闭',
    loading: '加载中...',
    notLoggedIn: '请先登录',
    // errors
    errOldPassword: '请输入当前密码',
    errNewPassword: '新密码不能少于6位',
    errPasswordMatch: '两次输入的密码不一致',
    errPasswordSame: '新密码不能与当前密码相同',
    errChangeFailed: '修改密码失败',
    errActivationEmpty: '请输入激活码',
    errActivateFailed: '激活失败',
    errLoadProfile: '加载用户信息失败',
    signOut: '退出登录',
    cancelled: 'Cancelled',
    editNickname: '编辑昵称',
    nickname: '昵称',
    saveNickname: '保存',
    cancelEdit: '取消',
    errNicknameEmpty: '昵称不能为空',
    errNicknameFailed: '昵称更新失败',
    nicknameSaved: '昵称已更新',
    // token usage
    tokenUsage: 'Token用量',
    tokenUsageLink: '（查看详情）',
    tokenUsed: '本周期已使用',
    tokenQuota: '积分',
    tokenResetDate: '流量重置日期',
    tokenNoQuota: '暂无月度额度',
  },
  enUS: {
    profile: 'Profile',
    username: 'Username',
    phone: 'Phone',
    email: 'Email',
    notSet: 'Not set',
    changePassword: 'Change Password',
    oldPassword: 'Current Password',
    newPassword: 'New Password',
    confirmPassword: 'Confirm New Password',
    changeBtn: 'Change Password',
    changing: 'Changing...',
    passwordChanged: 'Password changed successfully',
    vipStatus: 'Membership',
    vip: 'VIP Member',
    svip: 'SVIP Member',
    notVip: 'Free',
    expiresOn: 'Expires',
    activationCode: 'Activation Code',
    activationPlaceholder: 'Enter activation code',
    activateBtn: 'Activate',
    activating: 'Activating...',
    activateSuccess: 'Activated successfully',
    close: 'Close',
    loading: 'Loading...',
    notLoggedIn: 'Please log in first',
    errOldPassword: 'Please enter current password',
    errNewPassword: 'New password must be at least 6 characters',
    errPasswordMatch: 'Passwords do not match',
    errPasswordSame: 'New password must differ from current password',
    errChangeFailed: 'Failed to change password',
    errActivationEmpty: 'Please enter an activation code',
    errActivateFailed: 'Activation failed',
    errLoadProfile: 'Failed to load profile',
    signOut: 'Sign Out',
    cancelled: 'Cancelled',
    editNickname: 'Edit Nickname',
    nickname: 'Nickname',
    saveNickname: 'Save',
    cancelEdit: 'Cancel',
    errNicknameEmpty: 'Nickname cannot be empty',
    errNicknameFailed: 'Failed to update nickname',
    nicknameSaved: 'Nickname updated',
    // token usage
    tokenUsage: 'Token Usage',
    tokenUsageLink: ' (View Details)',
    tokenUsed: 'used this cycle',
    tokenQuota: 'tokens',
    tokenResetDate: 'Resets on',
    tokenNoQuota: 'No monthly quota',
  },
};

function detectLang(): 'zhCN' | 'enUS' {
  if (typeof navigator === 'undefined') return 'enUS';
  const lang = navigator.language || (navigator as Navigator & { userLanguage?: string }).userLanguage || '';
  return lang.toLowerCase().startsWith('zh') ? 'zhCN' : 'enUS';
}

// ── CSS ──

const STYLES: string = `
  .kw-profile-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 999999;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  }
  .kw-profile-box {
    background: #fff;
    border-radius: 12px;
    padding: 32px 28px;
    width: 420px;
    max-width: 92vw;
    max-height: 96vh;
    overflow-y: auto;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
    position: relative;
    animation: kwProfileFadeIn 0.2s ease-out;
  }
  @keyframes kwProfileFadeIn {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @media (max-width: 480px) {
    .kw-profile-box {
      width: 94vw;
      max-width: 94vw;
      max-height: 92vh;
      max-height: 92dvh;
      border-radius: 12px;
      padding: 24px 20px;
      box-sizing: border-box;
    }
  }
  .kw-profile-title {
    margin: 0 0 24px;
    font-size: 22px;
    font-weight: 700;
    text-align: center;
    color: #1a1a2e;
  }
  .kw-profile-close {
    position: absolute;
    top: 16px;
    right: 16px;
    background: #f5f5f5;
    border: none;
    font-size: 28px;
    color: #999;
    cursor: pointer;
    line-height: 1;
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    transition: background 0.2s, color 0.2s;
  }
  .kw-profile-close:hover {
    color: #333;
    background: #e8e8e8;
  }
  .kw-profile-section {
    margin-bottom: 24px;
  }
  .kw-profile-section-title {
    font-size: 15px;
    font-weight: 600;
    color: #1a1a2e;
    margin: 0 0 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid #f0f0f0;
  }
  .kw-profile-row {
    display: flex;
    align-items: center;
    padding: 8px 0;
    font-size: 14px;
    color: #333;
  }
  .kw-profile-label {
    width: 80px;
    flex-shrink: 0;
    color: #999;
    font-weight: 500;
  }
  .kw-profile-value {
    flex: 1;
    word-break: break-all;
  }
  .kw-profile-input {
    display: block;
    width: 100%;
    padding: 12px 14px;
    margin-bottom: 12px;
    border: 1px solid #dcdfe6;
    border-radius: 8px;
    font-size: 16px;
    box-sizing: border-box;
    outline: none;
    transition: border-color 0.2s;
    -webkit-appearance: none;
    min-height: 44px;
  }
  .kw-profile-input:focus {
    border-color: #409eff;
    box-shadow: 0 0 0 3px rgba(64, 158, 255, 0.08);
  }
  .kw-profile-input::placeholder { color: #b0b8c1; }
  .kw-profile-btn {
    display: block;
    width: 100%;
    padding: 12px 0;
    background: linear-gradient(135deg, #409eff, #337ecc);
    color: #fff;
    border: none;
    border-radius: 8px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.2s;
    min-height: 44px;
  }
  .kw-profile-btn:hover { opacity: 0.9; }
  .kw-profile-btn:disabled {
    background: #a0cfff;
    cursor: not-allowed;
    opacity: 1;
  }
  .kw-profile-btn.kw-profile-btn-sm {
    width: auto;
    min-width: 100px;
    padding: 10px 20px;
    font-size: 14px;
    min-height: 40px;
  }
  .kw-profile-error {
    color: #f56c6c;
    font-size: 13px;
    margin-bottom: 8px;
    min-height: 18px;
    text-align: center;
    word-break: break-word;
  }
  .kw-profile-success {
    color: #67c23a;
    font-size: 13px;
    margin-bottom: 8px;
    min-height: 18px;
    text-align: center;
    word-break: break-word;
  }
  .kw-profile-vip-badge {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 13px;
    font-weight: 600;
  }
  .kw-profile-vip-badge.vip {
    background: linear-gradient(135deg, #f7d774, #f0c040);
    color: #7a5c00;
  }
  .kw-profile-vip-badge.svip {
    background: linear-gradient(135deg, #ff9a56, #ff6b35);
    color: #fff;
  }
  .kw-profile-vip-badge.none {
    background: #f0f0f0;
    color: #999;
  }
  .kw-profile-activate-row {
    display: flex;
    gap: 10px;
    align-items: stretch;
  }
  .kw-profile-activate-row .kw-profile-input {
    flex: 1;
    margin-bottom: 0;
  }
  .kw-profile-loading {
    text-align: center;
    padding: 40px 0;
    color: #999;
    font-size: 15px;
  }
  .kw-profile-btn-outline {
    display: block;
    width: 100%;
    padding: 12px 0;
    background: #fff;
    color: #409eff;
    border: 1px solid #409eff;
    border-radius: 8px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s, color 0.2s;
    min-height: 44px;
  }
  .kw-profile-btn-outline:hover {
    background: #ecf5ff;
  }
  .kw-profile-btn-outline.kw-profile-btn-danger {
    color: #f56c6c;
    border-color: #f56c6c;
  }
  .kw-profile-btn-outline.kw-profile-btn-danger:hover {
    background: #fef0f0;
  }
  .kw-profile-edit-icon {
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 4px;
    margin-left: 6px;
    color: #999;
    display: inline-flex;
    align-items: center;
    vertical-align: middle;
    border-radius: 4px;
    transition: color 0.2s, background 0.2s;
    flex-shrink: 0;
  }
  .kw-profile-edit-icon:hover {
    color: #409eff;
    background: #ecf5ff;
  }
  .kw-profile-nickname-edit {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
  }
  .kw-profile-nickname-input {
    flex: 1;
    padding: 4px 8px;
    border: 1px solid #409eff;
    border-radius: 6px;
    font-size: 14px;
    outline: none;
    min-height: 32px;
    box-sizing: border-box;
  }
  .kw-profile-nickname-save {
    padding: 4px 10px;
    background: #409eff;
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    min-height: 32px;
    white-space: nowrap;
  }
  .kw-profile-nickname-save:hover { background: #337ecc; }
  .kw-profile-nickname-save:disabled { background: #a0cfff; cursor: not-allowed; }
  .kw-profile-nickname-cancel {
    padding: 4px 10px;
    background: #fff;
    color: #666;
    border: 1px solid #dcdfe6;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    min-height: 32px;
    white-space: nowrap;
  }
  .kw-profile-nickname-cancel:hover { background: #f5f5f5; }
  .kw-profile-usage {
    display: block;
    padding: 16px;
    border-radius: 10px;
    background: #f8f9fb;
    border: 1px solid #eef0f3;
    color: inherit;
    text-decoration: none;
    transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s;
  }
  .kw-profile-usage:hover,
  .kw-profile-usage:focus {
    border-color: #409eff;
    box-shadow: 0 4px 14px rgba(64, 158, 255, 0.16);
    outline: none;
    transform: translateY(-1px);
  }
  .kw-profile-usage-header {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #1a1a2e;
    margin-bottom: 10px;
  }
  .kw-profile-usage-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 8px;
  }
  .kw-profile-usage-label {
    font-size: 14px;
    font-weight: 500;
    color: #333;
  }
  .kw-profile-usage-percent {
    font-size: 14px;
    font-weight: 700;
    color: #1a1a2e;
  }
  .kw-profile-usage-bar {
    width: 100%;
    height: 6px;
    border-radius: 999px;
    background: #e5e7eb;
    overflow: hidden;
    margin-bottom: 8px;
  }
  .kw-profile-usage-bar-fill {
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #1a1a2e 0%, #4f647b 100%);
    transition: width 0.4s ease;
    min-width: 4px;
  }
  .kw-profile-usage-detail {
    font-size: 12px;
    color: #999;
  }
  .kw-profile-pw-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000000;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  .kw-profile-pw-box {
    background: #fff;
    border-radius: 12px;
    padding: 32px 28px;
    width: 380px;
    max-width: 92vw;
    max-height: 96vh;
    overflow-y: auto;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
    position: relative;
    animation: kwProfileFadeIn 0.2s ease-out;
  }
  @media (max-width: 480px) {
    .kw-profile-pw-box {
      width: 94vw;
      max-width: 94vw;
      max-height: 92vh;
      max-height: 92dvh;
      border-radius: 12px;
      padding: 24px 20px;
      box-sizing: border-box;
    }
  }
`;

// ── ProfileWindow class ──

export default class ProfileWindow {
  sdk: ProfileWindowSdk;
  private _overlay: HTMLElement | null;
  private _styleEl: HTMLStyleElement | null;
  private _pwOverlay: HTMLElement | null;
  private _lang: 'zhCN' | 'enUS';
  private _strings: ProfileStrings;
  private _resolve: ((value?: unknown) => void) | null;

  constructor(sdk: unknown) {
    this.sdk = sdk as ProfileWindowSdk;
    this._overlay = null;
    this._styleEl = null;
    this._pwOverlay = null;
    this._lang = 'enUS';
    this._strings = TRANSLATIONS.enUS;
    this._resolve = null;
  }

  /**
   * Show the profile window.
   * @param {Object} options
   * @param {string}  [options.title]               - Custom title
   * @param {string}  [options.lang]                - 'zhCN' | 'enUS' (auto-detected if omitted)
   * @param {boolean} [options.enablePassword=true] - Show change password section
   * @param {boolean} [options.enableVip=true]      - Show VIP section with activation code
   * @returns {Promise<void>} Resolves when the window is closed
   */
  show(options: ProfileWindowShowOptions = {}): Promise<unknown> {
    if (this._overlay) this._destroy();

    return new Promise((resolve) => {
      const lang = options.lang || detectLang();
      this._lang = lang;
      this._strings = (TRANSLATIONS as Record<string, ProfileStrings>)[lang] || TRANSLATIONS.enUS;
      const t = (k: string): string => this._strings[k] || k;

      const enablePassword = options.enablePassword !== false;
      const enableVip = options.enableVip !== false;
      const title = options.title || t('profile');

      this._resolve = resolve;
      this._injectStyles();

      const overlay = document.createElement('div');
      overlay.className = 'kw-profile-overlay';

      overlay.innerHTML = `
        <div class="kw-profile-box">
          <button class="kw-profile-close" data-kw-p="close">&times;</button>
          <h2 class="kw-profile-title">${this._esc(title)}</h2>
          <div class="kw-profile-loading" data-kw-p="loading">${this._esc(t('loading'))}</div>
          <div data-kw-p="content" style="display:none;">

            <!-- Profile info section -->
            <div class="kw-profile-section">
              <div class="kw-profile-row">
                <span class="kw-profile-label">${this._esc(t('username'))}</span>
                <span class="kw-profile-value" data-kw-p="val-username">-</span>
                <button class="kw-profile-edit-icon" data-kw-p="edit-nickname" title="${this._esc(t('editNickname'))}">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
              </div>
              <div class="kw-profile-row">
                <span class="kw-profile-label">${this._esc(t('phone'))}</span>
                <span class="kw-profile-value" data-kw-p="val-phone">-</span>
              </div>
              <div class="kw-profile-row">
                <span class="kw-profile-label">${this._esc(t('email'))}</span>
                <span class="kw-profile-value" data-kw-p="val-email">-</span>
              </div>
            </div>

            ${enableVip ? `
            <!-- VIP section -->
            <div class="kw-profile-section">
              <h3 class="kw-profile-section-title">${this._esc(t('vipStatus'))}</h3>
              <div class="kw-profile-row" data-kw-p="vip-info"></div>
              <div style="margin-top:12px;">
                <div class="kw-profile-activate-row">
                  <input class="kw-profile-input" data-kw-p="vip-code" type="text"
                    placeholder="${this._esc(t('activationPlaceholder'))}" />
                  <button class="kw-profile-btn kw-profile-btn-sm" data-kw-p="vip-submit">
                    ${this._esc(t('activateBtn'))}
                  </button>
                </div>
                <div class="kw-profile-error" data-kw-p="vip-error" style="display:none;"></div>
                <div class="kw-profile-success" data-kw-p="vip-success" style="display:none;"></div>
              </div>
            </div>` : ''}

            <!-- Token usage section -->
            <div class="kw-profile-section" data-kw-p="token-usage-section">
              <a class="kw-profile-usage" data-kw-p="usage-link" href="${this._esc(this._getTokenPlanUrl())}" target="_blank" rel="noopener noreferrer">
                <div class="kw-profile-usage-header" data-kw-p="usage-title"></div>
                <div class="kw-profile-usage-row">
                  <span class="kw-profile-usage-label" data-kw-p="usage-label"></span>
                  <span class="kw-profile-usage-percent" data-kw-p="usage-percent"></span>
                </div>
                <div class="kw-profile-usage-bar">
                  <div class="kw-profile-usage-bar-fill" data-kw-p="usage-bar-fill" style="width:0%"></div>
                </div>
                <div class="kw-profile-usage-detail" data-kw-p="usage-detail"></div>
              </a>
            </div>

            <!-- Action buttons row -->
            <div class="kw-profile-section" style="display:flex;gap:12px;">
              ${enablePassword ? `<button class="kw-profile-btn-outline" data-kw-p="pw-open" style="flex:1;">${this._esc(t('changePassword'))}</button>` : ''}
              <button class="kw-profile-btn-outline kw-profile-btn-danger" data-kw-p="sign-out" style="flex:1;">${this._esc(t('signOut'))}</button>
            </div>

          </div>
        </div>
      `;

      const q = (sel: string): HTMLElement | null => overlay.querySelector(`[data-kw-p="${sel}"]`);

      // ── Close ──
      const doClose = (): void => {
        this._destroy();
        resolve(undefined);
      };

      q('close')?.addEventListener('click', doClose);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) doClose();
      });

      // ── Sign out ──
      const signOutBtn = q('sign-out') as HTMLButtonElement | null;
      if (signOutBtn) {
        signOutBtn.addEventListener('click', async () => {
          signOutBtn.disabled = true;
          try { await this.sdk.logout(); } catch { /* ignore */ }
          this._destroy();
          resolve({ action: 'logout' });
        });
      }

      document.body.appendChild(overlay);
      this._overlay = overlay;

      // ── Load profile ──
      this._loadProfile(overlay, { enablePassword, enableVip });
    });
  }

  /**
   * Close the profile window if open
   */
  close(): void {
    this._destroy();
    if (this._resolve) { this._resolve(); this._resolve = null; }
  }

  // ── Load and render profile data ──

  private async _loadProfile(overlay: HTMLElement, { enablePassword, enableVip }: { enablePassword: boolean; enableVip: boolean }): Promise<void> {
    const t = (k: string): string => this._strings[k] || k;
    const q = (sel: string): HTMLElement => overlay.querySelector(`[data-kw-p="${sel}"]`) as HTMLElement;

    if (!this.sdk.token) {
      q('loading').textContent = t('notLoggedIn');
      return;
    }

    try {
      const profile = await this.sdk.getUserProfile({ forceRefresh: true });

      // Populate info
      const username = (profile.username as string) || '-';
      const nickname = profile.nickname as string | undefined;
      const showNickname = nickname && nickname !== profile.username;
      q('val-username').textContent = showNickname ? `${username}(${nickname})` : username;
      this._bindNicknameEdit(overlay, profile);
      q('val-phone').textContent = this._maskPhone(profile.cellphone) || t('notSet');
      q('val-email').textContent = (profile.email as string) || t('notSet');

      // VIP display
      if (enableVip) {
        this._renderVipInfo(q('vip-info'), profile);
        this._bindVipActivation(overlay, profile);
      }

      // Password change button
      if (enablePassword) {
        const pwOpenBtn = q('pw-open');
        if (pwOpenBtn) {
          pwOpenBtn.addEventListener('click', () => this._showPasswordPopup());
        }
      }

      // Fetch and render token usage
      this._loadTokenUsage(overlay);

      // Show content, hide loading
      q('loading').style.display = 'none';
      q('content').style.display = '';
    } catch (err) {
      q('loading').textContent = t('errLoadProfile');
    }
  }

  // ── Nickname edit ──

  private _bindNicknameEdit(overlay: HTMLElement, profile: Record<string, unknown>): void {
    const t = (k: string): string => this._strings[k] || k;
    const q = (sel: string): HTMLElement | null => overlay.querySelector(`[data-kw-p="${sel}"]`);

    const editBtn = q('edit-nickname') as HTMLButtonElement | null;
    const valEl = q('val-username');
    if (!editBtn || !valEl) return;

    editBtn.addEventListener('click', () => {
      editBtn.style.display = 'none';
      const currentNickname = (profile.nickname as string) || '';

      const editContainer = document.createElement('div');
      editContainer.className = 'kw-profile-nickname-edit';
      editContainer.innerHTML = `
        <input class="kw-profile-nickname-input" type="text" value="${this._esc(currentNickname)}"
          placeholder="${this._esc(t('nickname'))}" maxlength="30" />
        <button class="kw-profile-nickname-save">${this._esc(t('saveNickname'))}</button>
        <button class="kw-profile-nickname-cancel">${this._esc(t('cancelEdit'))}</button>
      `;

      const input = editContainer.querySelector('.kw-profile-nickname-input') as HTMLInputElement;
      const saveBtn = editContainer.querySelector('.kw-profile-nickname-save') as HTMLButtonElement;
      const cancelBtn = editContainer.querySelector('.kw-profile-nickname-cancel') as HTMLButtonElement;

      const restore = (): void => {
        editContainer.remove();
        editBtn.style.display = '';
      };

      cancelBtn.addEventListener('click', restore);

      const doSave = async (): Promise<void> => {
        const newNickname = input.value.trim();
        saveBtn.disabled = true;
        try {
          await this.sdk.put('/users/modify', { nickname: newNickname });
          profile.nickname = newNickname;
          const username = (profile.username as string) || '-';
          const showNickname = newNickname && newNickname !== profile.username;
          valEl.textContent = showNickname ? `${username}(${newNickname})` : username;
          restore();
        } catch {
          saveBtn.disabled = false;
          input.style.borderColor = '#f56c6c';
          input.title = t('errNicknameFailed');
        }
      };

      saveBtn.addEventListener('click', doSave);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSave();
        if (e.key === 'Escape') restore();
      });

      valEl.after(editContainer);
      valEl.textContent = '';
      input.focus();
      input.select();
    });
  }

  // ── VIP display ──

  private _renderVipInfo(container: HTMLElement, profile: Record<string, unknown>): void {
    const t = (k: string): string => this._strings[k] || k;
    const isVip = !!(profile.commonVip || profile.vip);
    const isSvip = !!profile.vip;

    let badgeClass: string, badgeText: string;
    if (isSvip) {
      badgeClass = 'svip';
      badgeText = t('svip');
    } else if (isVip) {
      badgeClass = 'vip';
      badgeText = t('vip');
    } else {
      badgeClass = 'none';
      badgeText = t('notVip');
    }

    let html = `<span class="kw-profile-vip-badge ${badgeClass}">${this._esc(badgeText)}</span>`;

    if (isSvip && profile.vipDeadline) {
      html += `<span style="margin-left:12px;font-size:13px;color:#999;">${this._esc(t('expiresOn'))}: ${this._formatDate(profile.vipDeadline as string)}</span>`;
    } else if (isVip && profile.commonVipDeadline) {
      html += `<span style="margin-left:12px;font-size:13px;color:#999;">${this._esc(t('expiresOn'))}: ${this._formatDate(profile.commonVipDeadline as string)}</span>`;
    }

    container.innerHTML = html;
  }

  // ── Token usage ──

  private async _loadTokenUsage(overlay: HTMLElement): Promise<void> {
    const t = (k: string): string => this._strings[k] || k;
    const q = (sel: string): HTMLElement => overlay.querySelector(`[data-kw-p="${sel}"]`) as HTMLElement;

    try {
      const hostname = typeof window !== 'undefined' ? window.location.hostname : 'keepwork.com';
      const domain = this.sdk.extractMainDomain(hostname);
      const apiBase = `https://api.${domain}`;
      const res = await fetch(`${apiBase}/core/v0/tokenBilling/dashboard`, {
        headers: this.sdk.getAuthHeaders(),
      });
      if (!res.ok) return;
      const data = await res.json();

      const section = q('token-usage-section');
      if (!section) return;

      const monthlyQuota = Number(data.monthlyQuota) || 0;
      const monthlyUsed = Number(data.monthlyUsed) || 0;

      q('usage-title').innerHTML = `${this._esc(t('tokenUsage'))}<span style="font-weight:400;color:#409eff;font-size:12px;text-transform:none;letter-spacing:0;">${this._esc(t('tokenUsageLink'))}</span>`;

      if (monthlyQuota <= 0) {
        q('usage-label').textContent = t('tokenNoQuota');
        q('usage-percent').textContent = '';
        q('usage-bar-fill').style.width = '0%';
        q('usage-detail').textContent = '';
        return;
      }

      const percent = Math.min(Math.max(Math.round((monthlyUsed / monthlyQuota) * 100), 0), 100);
      q('usage-label').textContent = `${this._formatNumber(monthlyUsed)} / ${this._formatNumber(monthlyQuota)} ${t('tokenQuota')}`;
      q('usage-percent').textContent = `${percent}%`;
      q('usage-bar-fill').style.width = `${percent}%`;

      const resetDate = data.cycleEndDate ? `${t('tokenResetDate')}: ${this._formatDate(data.cycleEndDate)}` : '';
      q('usage-detail').textContent = resetDate;
    } catch {
      // silently ignore – usage section remains hidden
    }
  }

  // ── VIP activation ──

  private _bindVipActivation(overlay: HTMLElement, _profile: Record<string, unknown>): void {
    const t = (k: string): string => this._strings[k] || k;
    const q = (sel: string): HTMLElement => overlay.querySelector(`[data-kw-p="${sel}"]`) as HTMLElement;
    const codeInput = q('vip-code') as HTMLInputElement;
    const submitBtn = q('vip-submit') as HTMLButtonElement;
    const errorEl = q('vip-error');
    const successEl = q('vip-success');

    const doActivate = async (): Promise<void> => {
      const code = codeInput.value.replace(/[^a-zA-Z0-9]/g, '');
      if (!code) { errorEl.textContent = t('errActivationEmpty'); errorEl.style.display = ''; successEl.textContent = ''; successEl.style.display = 'none'; return; }
      errorEl.textContent = ''; errorEl.style.display = 'none';
      successEl.textContent = ''; successEl.style.display = 'none';
      submitBtn.disabled = true;
      submitBtn.textContent = t('activating');
      try {
        const hostname = typeof window !== 'undefined' ? window.location.hostname : 'keepwork.com';
        const domain = this.sdk.extractMainDomain(hostname);
        const apiBase = `https://api.${domain}`;
        const res = await fetch(`${apiBase}/core/v0/activateCodes/activate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.sdk.getAuthHeaders(),
          },
          body: JSON.stringify({ key: code }),
        });
        if (!res.ok) {
          const errText = await res.text();
          const err = new Error(`HTTP ${res.status}: ${errText}`) as Error & { status?: number };
          err.status = res.status;
          throw err;
        }
        const response = await res.json() as { role?: { zhName?: string } };
        successEl.textContent = (response && response.role && response.role.zhName)
          ? `${response.role.zhName} ${t('activateSuccess')}`
          : t('activateSuccess');
        successEl.style.display = '';
        codeInput.value = '';
        // Refresh profile to update VIP status
        const updated = await this.sdk.getUserProfile({ forceRefresh: true });
        this._renderVipInfo(q('vip-info'), updated);
      } catch (err) {
        let msg = t('errActivateFailed');
        const errMessage = (err as Error)?.message;
        if (errMessage) {
          const jsonMatch = errMessage.match(/HTTP \d+:\s*(\{.*\})/);
          if (jsonMatch) {
            try { msg = JSON.parse(jsonMatch[1]).message || msg; } catch { /* ignore */ }
          } else {
            msg = errMessage;
          }
        }
        errorEl.textContent = msg;
        errorEl.style.display = '';
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = t('activateBtn');
      }
    };

    submitBtn.addEventListener('click', doActivate);
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doActivate(); });
  }

  // ── Password change popup ──

  private _showPasswordPopup(): void {
    const t = (k: string): string => this._strings[k] || k;

    // Remove existing popup if any
    if (this._pwOverlay) { this._pwOverlay.remove(); this._pwOverlay = null; }

    const pwOverlay = document.createElement('div');
    pwOverlay.className = 'kw-profile-pw-overlay';
    pwOverlay.innerHTML = `
      <div class="kw-profile-pw-box">
        <button class="kw-profile-close" data-kw-pw="close">&times;</button>
        <h2 class="kw-profile-title">${this._esc(t('changePassword'))}</h2>
        <input class="kw-profile-input" data-kw-pw="old" type="password"
          placeholder="${this._esc(t('oldPassword'))}" autocomplete="current-password" />
        <input class="kw-profile-input" data-kw-pw="new" type="password"
          placeholder="${this._esc(t('newPassword'))}" autocomplete="new-password" />
        <input class="kw-profile-input" data-kw-pw="confirm" type="password"
          placeholder="${this._esc(t('confirmPassword'))}" autocomplete="new-password" />
        <div class="kw-profile-error" data-kw-pw="error"></div>
        <div class="kw-profile-success" data-kw-pw="success"></div>
        <button class="kw-profile-btn" data-kw-pw="submit">${this._esc(t('changeBtn'))}</button>
      </div>
    `;

    const q = (sel: string): HTMLElement => pwOverlay.querySelector(`[data-kw-pw="${sel}"]`) as HTMLElement;
    const oldPw = q('old') as HTMLInputElement;
    const newPw = q('new') as HTMLInputElement;
    const confirmPw = q('confirm') as HTMLInputElement;
    const errorEl = q('error');
    const successEl = q('success');
    const submitBtn = q('submit') as HTMLButtonElement;

    const closePw = (): void => {
      pwOverlay.remove();
      this._pwOverlay = null;
    };

    q('close').addEventListener('click', closePw);
    pwOverlay.addEventListener('click', (e) => { if (e.target === pwOverlay) closePw(); });

    const doChange = async (): Promise<void> => {
      const oldVal = oldPw.value;
      const newVal = newPw.value;
      const confirmVal = confirmPw.value;

      errorEl.textContent = '';
      successEl.textContent = '';

      if (!oldVal) { errorEl.textContent = t('errOldPassword'); return; }
      if (newVal.length < 6) { errorEl.textContent = t('errNewPassword'); return; }
      if (newVal !== confirmVal) { errorEl.textContent = t('errPasswordMatch'); return; }
      if (oldVal === newVal) { errorEl.textContent = t('errPasswordSame'); return; }

      submitBtn.disabled = true;
      submitBtn.textContent = t('changing');
      try {
        await this.sdk.put('/users/password', {
          oldPassword: oldVal,
          newPassword: newVal,
        });
        successEl.textContent = t('passwordChanged');
        oldPw.value = '';
        newPw.value = '';
        confirmPw.value = '';
        // Auto-close after success
        setTimeout(closePw, 1500);
      } catch (err) {
        let msg = t('errChangeFailed');
        const errMessage = (err as Error)?.message;
        if (errMessage) {
          const jsonMatch = errMessage.match(/HTTP \d+:\s*(\{.*\})/);
          if (jsonMatch) {
            try { msg = JSON.parse(jsonMatch[1]).message || msg; } catch { /* ignore */ }
          } else {
            msg = errMessage;
          }
        }
        errorEl.textContent = msg;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = t('changeBtn');
      }
    };

    submitBtn.addEventListener('click', doChange);
    confirmPw.addEventListener('keydown', (e) => { if (e.key === 'Enter') doChange(); });

    document.body.appendChild(pwOverlay);
    this._pwOverlay = pwOverlay;
    oldPw.focus();
  }

  // ── Helpers ──

  private _maskPhone(phone: unknown): string | null {
    if (!phone) return null;
    const s = String(phone);
    if (s.length >= 7) {
      return s.slice(0, 3) + '****' + s.slice(-4);
    }
    return s;
  }

  private _formatNumber(num: number): string {
    return Number(num).toLocaleString();
  }

  private _formatDate(dateStr: string): string {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '-';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private _getTokenPlanUrl(): string {
    const token = this.sdk && this.sdk.token ? encodeURIComponent(this.sdk.token) : '';
    return `https://keepwork.com/plan/tokenPlan/subscription?token=${token}`;
  }

  private _injectStyles(): void {
    if (this._styleEl) return;
    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);
    this._styleEl = style;
  }

  private _destroy(): void {
    if (this._pwOverlay) { this._pwOverlay.remove(); this._pwOverlay = null; }
    if (this._overlay) { this._overlay.remove(); this._overlay = null; }
    if (this._styleEl) { this._styleEl.remove(); this._styleEl = null; }
  }

  private _esc(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
