/**
 * LoginWindow - login modal for KeepworkSDK.
 *
 * Features:
 * - Username/password login
 * - Registration (username/password)
 * - WeChat QR login on desktop
 * - WeChat OAuth redirect login inside WeChat browser
 * - Google OAuth login (opt-in via googleClientId option)
 * - English / Chinese i18n (auto-detected from system language)
 * - Mobile-responsive
 *
 * All UI, styles, and logic are self-contained in this file.
 */

import { detectWxEnvironment, normalizeWechatRedirectUri, setCookie } from '../wechat/WxUtils';
import WxAuth from '../wechat/WxAuth';
import VerifyHuman from './VerifyHuman';

const WECHAT_QR_AUTH_URL = 'https://open.weixin.qq.com/connect/qrconnect';
const WECHAT_QR_APP_ID = 'wxc97e44ce7c18725e';
const WECHAT_QR_STATE = 'login';
const GOOGLE_OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_OAUTH_CLIENT_ID = '143612303133-m6p8rpm9iao0bcaka9ath4fi1qv4mvq4.apps.googleusercontent.com';
const GOOGLE_OAUTH_SCOPE = 'openid email profile';
const GOOGLE_OAUTH_STATE = 'login';
// Google 要求 redirect_uri 必须在 Google Cloud Console 预先登记白名单，无法穷举
// 业务页面 URL，因此统一用一个固定入口承接回调（页面实现在 keepwork-nuxt 的
// pages/sso.vue），它再把 code 回传给发起登录的窗口。
const GOOGLE_OAUTH_REDIRECT_URI = 'https://keepwork.com/sso';
// const GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:3100/sso';
// 第三方登录「探测 → 设置账号 → 绑定」相关接口
const GOOGLE_PROBE_PATH = '/oauth_users/google/probe';
const WECHAT_PROBE_PATH = '/oauth_users/weixin/probe';
const OAUTH_BIND_PATH = '/oauth_users/oauth_bind';
const EMAIL_REG = /^([A-Za-z0-9_\-.])+@([A-Za-z0-9_\-.])+\.([A-Za-z]{2,})$/;
const PHONE_REG = /^1[3-9][0-9]{9}$/;

// i18n

type LoginStrings = Record<string, string>;
const TRANSLATIONS: Record<string, LoginStrings> = {
  zhCN: {
    login: '登录',
    register: '注册',
    registerTitle: '注册新用户',
    username: '请输入账号（推荐email或手机号）',
    password: '请输入密码',
    registerUsername: '用户名',
    confirmPassword: '确认密码',
    loginBtn: '登录',
    registerBtn: '注册账号',
    loggingIn: '登录中...',
    registering: '注册中...',
    noAccount: '没有账号？',
    goRegister: '点击注册',
    hasAccount: '已有账号？',
    goLogin: '立即登录',
    cancel: '取消',
    forgotPassword: '忘记密码？',
    passwordReset: '找回密码',
    phoneOrEmail: '请输入手机号或邮箱',
    verificationCode: '请输入验证码',
    sendCode: '发送验证码',
    countResend: '秒后重发',
    newPassword: '请输入新密码',
    confirmNewPassword: '请再次输入新密码',
    resetConfirm: '确定',
    resetting: '重置中...',
    resetSuccess: '密码重置成功',
    wechatQrLogin: '微信扫码登录',
    wechatQrSubtitle: '打开微信扫一扫，无需输入账号密码',
    wechatRedirectLogin: '使用微信登录',
    wechatRedirecting: '正在跳转微信授权...',
    wechatLoading: '登录中...',
    wechatLoadFailed: '微信二维码加载失败，请稍后重试',
    wechatAuthFailed: '微信授权失败，请稍后重试',
    wechatStateFailed: '微信登录状态校验失败，请稍后重试',
    wechatUnbound: '微信未绑定账号，请先完成注册',
    googleLogin: '使用 Google 登录',
    googlePopupBlocked: '弹出窗口被拦截，请允许弹窗后重试',
    googleAuthFailed: 'Google 授权失败，请稍后重试',
    googleStateFailed: 'Google 登录状态校验失败，请稍后重试',
    googleCancelled: '已取消 Google 登录',
    googleMissingConfig: 'Google 登录未配置',
    passwordLogin: '用户名 / 密码登录',
    // 第三方登录后设置账号
    oauthSetupTitle: '设置你的账号',
    oauthSetupSubtitleGoogle: '已通过 Google 登录，设置用户名和密码后下次也能直接用账号密码登录（均可修改）',
    oauthSetupSubtitleWechat: '已通过微信登录，设置用户名和密码后下次也能直接用账号密码登录（均可修改）',
    oauthSetupUsername: '用户名',
    oauthSetupPassword: '密码',
    oauthBindBtn: '完成并登录',
    oauthBinding: '提交中...',
    oauthSetupHint: '若该用户名+密码已是你的 keepwork 账号，将自动绑定到该账号',
    errOauthBindFailed: '绑定失败，请重试',
    // errors
    errUsername: '请输入用户名',
    errPassword: '请输入密码',
    errUsernameLen: '用户名需4-30个字符，仅支持字母、数字、下划线',
    errPasswordLen: '密码不能少于6位',
    errPasswordMatch: '两次输入的密码不一致',
    errBoth: '请输入用户名和密码',
    errPhoneOrEmail: '请输入正确的手机号或邮箱',
    errCode: '请输入验证码',
    errPasswordRange: '密码长度为4-24个字符',
    errPhoneNotBound: '该手机号未绑定账号',
    errSendCodeFailed: '验证码发送失败，请稍后重试',
    errSendingFrequent: '发送过于频繁，请稍后再试',
    errResetFailed: '密码重置失败',
    errVerificationCode: '验证码错误',
    errLoginFailed: '登录失败',
    errRegisterFailed: '注册失败',
    registerSuccess: '注册成功',
    loginCancelled: 'Login cancelled',
  },
  enUS: {
    login: 'Login',
    register: 'Register',
    registerTitle: 'Create Account',
    username: 'Username / Email',
    password: 'Password',
    registerUsername: 'Username',
    confirmPassword: 'Confirm Password',
    loginBtn: 'Login',
    registerBtn: 'Register',
    loggingIn: 'Logging in...',
    registering: 'Registering...',
    noAccount: "Don't have an account?",
    goRegister: 'Register',
    hasAccount: 'Already have an account?',
    goLogin: 'Login',
    cancel: 'Cancel',
    forgotPassword: 'Forgot password?',
    passwordReset: 'Reset Password',
    phoneOrEmail: 'Phone or email',
    verificationCode: 'Verification code',
    sendCode: 'Send code',
    countResend: 's to resend',
    newPassword: 'New password',
    confirmNewPassword: 'Confirm new password',
    resetConfirm: 'OK',
    resetting: 'Resetting...',
    resetSuccess: 'Password reset successful',
    wechatQrLogin: 'WeChat QR Login',
    wechatQrSubtitle: 'Scan with WeChat, no password needed',
    wechatRedirectLogin: 'Login with WeChat',
    wechatRedirecting: 'Redirecting to WeChat...',
    wechatLoading: 'Logging in...',
    wechatLoadFailed: 'Failed to load WeChat QR code. Please try again later.',
    wechatAuthFailed: 'WeChat authorization failed. Please try again later.',
    wechatStateFailed: 'WeChat login state check failed. Please try again later.',
    wechatUnbound: 'WeChat is not bound to an account. Please register first.',
    googleLogin: 'Continue with Google',
    googlePopupBlocked: 'Popup blocked. Please allow popups and try again.',
    googleAuthFailed: 'Google sign-in failed. Please try again later.',
    googleStateFailed: 'Google login state check failed. Please try again later.',
    googleCancelled: 'Google sign-in cancelled',
    googleMissingConfig: 'Google sign-in is not configured',
    passwordLogin: 'Sign in with username / password',
    oauthSetupTitle: 'Set up your account',
    oauthSetupSubtitleGoogle: 'Signed in with Google. Set a username and password so you can also sign in with them next time (both editable).',
    oauthSetupSubtitleWechat: 'Signed in with WeChat. Set a username and password so you can also sign in with them next time (both editable).',
    oauthSetupUsername: 'Username',
    oauthSetupPassword: 'Password',
    oauthBindBtn: 'Continue',
    oauthBinding: 'Submitting...',
    oauthSetupHint: 'If this username and password already match your keepwork account, it will be bound automatically.',
    errOauthBindFailed: 'Binding failed, please try again',
    errUsername: 'Please enter username',
    errPassword: 'Please enter password',
    errUsernameLen: 'Username: 4-30 characters, letters/numbers/underscore only',
    errPasswordLen: 'Password must be at least 6 characters',
    errPasswordMatch: 'Passwords do not match',
    errBoth: 'Please enter username and password',
    errPhoneOrEmail: 'Please enter a valid phone number or email',
    errCode: 'Please enter verification code',
    errPasswordRange: 'Password must be 4-24 characters',
    errPhoneNotBound: 'This phone number is not bound to an account',
    errSendCodeFailed: 'Failed to send code. Please try again later.',
    errSendingFrequent: 'Too many requests. Please try later.',
    errResetFailed: 'Password reset failed',
    errVerificationCode: 'Verification code is incorrect',
    errLoginFailed: 'Login failed',
    errRegisterFailed: 'Registration failed',
    registerSuccess: 'Registration successful',
    loginCancelled: 'Login cancelled',
  },
};

function detectLang(): string {
  if (typeof navigator === 'undefined') return 'enUS';
  const lang = navigator.language || (navigator as Navigator & { userLanguage?: string }).userLanguage || '';
  return lang.toLowerCase().startsWith('zh') ? 'zhCN' : 'enUS';
}

function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return true;
  // iPadOS 13+ reports as desktop Safari but exposes touch points.
  if (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document) return true;
  return false;
}

// CSS

const STYLES: string = `
  .kw-login-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 999999;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  }

  .kw-login-box {
    background: #fff;
    border-radius: 4px;
    width: min(92vw, 740px);
    max-height: 96vh;
    overflow-y: auto;
    box-shadow: 0 10px 36px rgba(0, 0, 0, 0.18);
    position: relative;
    animation: kwFadeIn 0.2s ease-out;
  }

  .kw-login-box.kw-login-has-wechat {
    width: min(96vw, 960px);
  }

  @keyframes kwFadeIn {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .kw-login-close {
    position: absolute;
    top: 24px;
    right: 24px;
    width: 36px;
    height: 36px;
    border: none;
    background: transparent;
    color: #999;
    cursor: pointer;
    font-size: 34px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2;
  }

  .kw-login-close:hover { color: #333; }

  .kw-login-content {
    display: grid;
    grid-template-columns: minmax(280px, 1fr);
    gap: 32px;
    padding: 72px 64px 56px;
  }

  .kw-login-has-wechat .kw-login-content {
    grid-template-columns: minmax(300px, 1fr) 360px;
    align-items: center;
    gap: 48px;
  }

  .kw-login-title {
    margin: 0 0 42px;
    font-size: 24px;
    font-weight: 700;
    color: #303133;
    letter-spacing: 0;
  }

  .kw-login-view { display: none; }
  .kw-login-view.active { display: block; }

  .kw-login-credentials { display: none; }
  .kw-login-credentials.active { display: block; }

  .kw-login-input {
    display: block;
    width: 100%;
    height: 54px;
    padding: 0 16px;
    margin-bottom: 24px;
    border: 1px solid #d8dde6;
    border-radius: 8px;
    font-size: 17px;
    color: #1f2329;
    box-sizing: border-box;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
    -webkit-appearance: none;
  }

  .kw-login-input:focus {
    border-color: #2f66ff;
    box-shadow: 0 0 0 3px rgba(47, 102, 255, 0.08);
  }

  .kw-login-input::placeholder { color: #a8b0bf; }

  .kw-login-code-row {
    display: flex;
    gap: 12px;
    margin-bottom: 24px;
  }

  .kw-login-code-row .kw-login-input {
    flex: 1;
    min-width: 0;
    margin-bottom: 0;
  }

  .kw-login-code-btn {
    width: 128px;
    min-height: 54px;
    padding: 0 12px;
    border: none;
    border-radius: 8px;
    background: #2f66ff;
    color: #fff;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .kw-login-code-btn:disabled {
    background: #e8e8e8;
    color: #909399;
    cursor: not-allowed;
  }

  .kw-login-btn {
    display: block;
    width: 100%;
    min-height: 56px;
    padding: 14px 0;
    background: #2f66ff;
    color: #fff;
    border: none;
    border-radius: 8px;
    font-size: 20px;
    font-weight: 700;
    cursor: pointer;
    transition: opacity 0.2s, background 0.2s;
  }

  .kw-login-btn:hover { opacity: 0.92; }

  .kw-login-btn:disabled {
    background: #9db8ff;
    cursor: not-allowed;
    opacity: 1;
  }

  .kw-login-error {
    color: #f56c6c;
    font-size: 13px;
    margin: -10px 0 14px;
    min-height: 18px;
    text-align: left;
    word-break: break-word;
  }

  .kw-login-oauth-subtitle {
    margin: -24px 0 28px;
    font-size: 15px;
    line-height: 1.5;
    color: #606266;
  }

  .kw-login-oauth-hint {
    margin: -12px 0 18px;
    font-size: 13px;
    line-height: 1.5;
    color: #909399;
  }

  .kw-login-footer {
    margin-top: 28px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    font-size: 16px;
    color: #606266;
  }

  .kw-login-footer-single {
    justify-content: flex-end;
  }

  .kw-login-link {
    color: #2f66ff;
    cursor: pointer;
    text-decoration: none;
    font-weight: 500;
  }

  .kw-login-link:hover { text-decoration: underline; }

  .kw-login-register-copy {
    white-space: nowrap;
  }

  .kw-login-wechat-panel {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 420px;
    padding: 28px 24px 32px;
    background: #f5f7fa;
    border-radius: 16px;
    color: #1f2329;
    box-sizing: border-box;
  }

  .kw-login-wechat-frame-wrap {
    position: relative;
    width: 280px;
    height: 280px;
    overflow: hidden;
    border-radius: 16px;
    background: #fff;
    box-shadow: 0 12px 28px rgba(31, 35, 41, 0.08);
  }

  .kw-login-wechat-frame {
    display: block;
    width: 300px;
    height: 300px;
    border: 0;
    transform: translate(-112px, 5px) scale(1.7);
    transform-origin: top left;
  }

  .kw-login-wechat-mask {
    position: absolute;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.9);
    color: #2f66ff;
    font-size: 16px;
    font-weight: 600;
    text-align: center;
    padding: 18px;
  }

  .kw-login-wechat-mask.active { display: flex; }

  .kw-login-wechat-caption {
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: 28px;
    font-size: 22px;
    font-weight: 700;
    color: #1f2329;
  }

  .kw-login-wechat-icon {
    width: 28px;
    height: 28px;
    margin-right: 10px;
    border-radius: 50%;
    background: #07c160;
    position: relative;
    flex-shrink: 0;
  }

  .kw-login-wechat-icon::before,
  .kw-login-wechat-icon::after {
    content: '';
    position: absolute;
    background: #fff;
    border-radius: 50%;
  }

  .kw-login-wechat-icon::before {
    width: 15px;
    height: 11px;
    left: 5px;
    top: 8px;
  }

  .kw-login-wechat-icon::after {
    width: 12px;
    height: 9px;
    right: 5px;
    bottom: 7px;
    box-shadow: -8px -2px 0 -4px #07c160;
  }

  .kw-login-wechat-subtitle {
    margin-top: 16px;
    font-size: 16px;
    color: #7b8494;
    font-weight: 600;
    text-align: center;
  }

  .kw-login-wechat-error {
    min-height: 18px;
    margin-top: 14px;
    color: #f56c6c;
    font-size: 13px;
    text-align: center;
  }

  .kw-login-wechat-redirect {
    margin-top: 12px;
  }

  .kw-login-social {
    margin-top: 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .kw-login-social-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    width: 100%;
    min-height: 54px;
    padding: 0 16px;
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    color: #1f2329;
    font-size: 17px;
    font-weight: 600;
    cursor: pointer;
    box-sizing: border-box;
    transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
  }

  .kw-login-social-btn:hover {
    background: #f9fafb;
    border-color: #d1d5db;
  }

  .kw-login-social-btn:disabled {
    cursor: not-allowed;
    opacity: 0.7;
  }

  .kw-login-social-icon {
    position: absolute;
    left: 20px;
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .kw-login-social-icon svg {
    width: 100%;
    height: 100%;
    display: block;
  }

  .kw-login-social-error {
    color: #f56c6c;
    font-size: 13px;
    text-align: center;
    min-height: 18px;
  }

  .kw-login-social-error:empty {
    display: none;
  }

  .kw-login-register-view {
    padding: 72px 64px 56px;
    max-width: 420px;
    margin: 0 auto;
  }

  .kw-login-reset-view {
    padding: 72px 64px 56px;
    max-width: 440px;
    margin: 0 auto;
  }

  @media (max-width: 768px) {
    .kw-login-box,
    .kw-login-box.kw-login-has-wechat {
      width: 94vw;
      max-height: 92vh;
      max-height: 92dvh;
      /* When _setupViewportHandling pins the overlay to the visual viewport,
         100% keeps the box (and its scrollable content) inside the area above
         the keyboard so every button stays reachable. */
      max-height: 100%;
      overscroll-behavior: contain;
      border-radius: 12px;
    }

    .kw-login-content,
    .kw-login-has-wechat .kw-login-content,
    .kw-login-register-view,
    .kw-login-reset-view {
      display: block;
      padding: 56px 24px 32px;
    }

    .kw-login-code-row {
      gap: 8px;
    }

    .kw-login-code-btn {
      width: 108px;
      font-size: 13px;
      padding: 0 8px;
    }

    .kw-login-title {
      margin-bottom: 28px;
      text-align: center;
      font-size: 24px;
    }

    .kw-login-footer {
      flex-direction: column;
      align-items: stretch;
      text-align: center;
    }

    .kw-login-wechat-panel {
      margin-top: 28px;
      min-height: auto;
      padding: 22px 18px 24px;
      border-radius: 12px;
    }

    .kw-login-wechat-frame-wrap {
      width: 240px;
      height: 240px;
    }

    .kw-login-wechat-caption {
      font-size: 18px;
    }
  }
`;

// LoginWindow class

/**
 * 宽松的 DOM 元素类型：登录弹窗内的元素可能是 input/button/div，
 * 这里用交叉类型统一暴露用到的属性（value/disabled/style/focus 等），
 * 避免在每个 querySelector 处分别断言。运行时行为与原 JS 一致。
 */
type LWEl = HTMLInputElement & HTMLButtonElement & HTMLElement & HTMLIFrameElement;

/** WxAuth 实例的最小调用表面 */
interface WxAuthLike {
  authorize(opts: Record<string, unknown>): unknown;
  [key: string]: unknown;
}

/** LoginWindow 依赖的 SDK 表面 */
interface LWSdk {
  wxAuth?: unknown;
  login(...args: unknown[]): Promise<Record<string, unknown>>;
  register?(...args: unknown[]): Promise<unknown>;
  request?(...args: unknown[]): Promise<unknown>;
  post(path: string, body?: unknown): Promise<Record<string, unknown>>;
  get(path: string, query?: unknown): Promise<Record<string, unknown>>;
  setToken(token: unknown): void;
  [key: string]: unknown;
}

export default class LoginWindow {
  sdk: LWSdk;
  _wxAuthInstance: unknown;
  _overlay: HTMLElement | null;
  _styleEl: HTMLStyleElement | null;
  _wechatPollingTimer: ReturnType<typeof setInterval> | null;
  _resetTimer: ReturnType<typeof setTimeout> | null;
  _processedWechatCodes: Set<string>;
  _googlePopup: Window | null;
  _googlePollingTimer: ReturnType<typeof setInterval> | null;
  _googleCodeHandled: boolean;
  _googleMessageHandler: ((e: MessageEvent) => void) | null;
  _googleSentState: string | null;
  _viewportHandler: (() => void) | null;
  _oauthBindCtx: Record<string, unknown> | null;
  // 运行时状态（show() 期间设置）
  _lang?: string;
  _strings?: LoginStrings;
  _title?: string;
  _platform?: unknown;
  _machineCode?: unknown;
  _resolve?: (v: Record<string, unknown>) => void;
  _reject?: (e: Error) => void;
  _wechatOptions?: Record<string, string>;
  _googleOptions?: Record<string, unknown>;
  [key: string]: unknown;

  constructor(sdk: unknown) {
    this.sdk = sdk as LWSdk;
    this._wxAuthInstance = null;
    this._overlay = null;
    this._styleEl = null;
    this._wechatPollingTimer = null;
    this._resetTimer = null;
    this._processedWechatCodes = new Set();
    this._googlePopup = null;
    this._googlePollingTimer = null;
    this._googleCodeHandled = false;
    this._googleMessageHandler = null;
    this._googleSentState = null;
    this._viewportHandler = null;
    // 第三方登录未绑定时，暂存探测阶段拿到的绑定上下文
    this._oauthBindCtx = null;
  }

  /**
   * Show the login window.
   * @param {Object} options
   * @param {string}  [options.title]          - Custom title
   * @param {string}  [options.lang]           - 'zhCN' | 'enUS' (auto-detected if omitted)
   * @param {boolean} [options.enableRegister=true] - Show register view
   * @param {boolean} [options.enableWechat=true]   - Show WeChat login
   * @param {string}  [options.wechatAppId]    - WeChat QR connect app id
   * @param {string}  [options.wechatRedirectUri] - Redirect URI for WeChat QR connect
   * @param {boolean} [options.enableGoogle]   - Show Google login button (requires googleClientId)
   * @param {string}  [options.googleClientId] - Google OAuth client id (web). Required to enable Google login.
   * @param {string}  [options.googleRedirectUri] - Redirect URI registered in Google Cloud Console
   * @param {string}  [options.googleScope]    - OAuth scope (default: 'openid email profile')
   * @param {string}  [options.googleState]    - OAuth state (default: 'login')
   * @param {string}  [options.platform]       - Platform tag forwarded to backend
   * @param {string}  [options.machineCode]    - Machine code forwarded to backend
   * @returns {Promise<Object>} Resolves with login/register response on success, rejects on cancel
   */
  show(options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this._overlay) this._destroy();

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const lang = (options.lang as string) || detectLang();
      this._lang = lang;
      this._strings = TRANSLATIONS[lang] || TRANSLATIONS.enUS;
      const t = (k: string): string => (this._strings as LoginStrings)[k] || k;

      const enableRegister = options.enableRegister !== false;
      const enableWechat = options.enableWechat !== false;
      const wxEnv = detectWxEnvironment();
      const isWeChat = wxEnv.isWeChat;
      const isWxMiniProgram = wxEnv.isMiniProgram;
      const isMobile = isMobileDevice();
      // QR scan login is meaningless on a phone (you can't scan your own screen), so hide it on mobile.
      const showWechatQr = enableWechat && !isWeChat && !isMobile && typeof window !== 'undefined';
      const showWechatRedirect = enableWechat && isWeChat;
      this._googleOptions = this._normalizeGoogleOptions(options);
      const showGoogle = !!(this._googleOptions && this._googleOptions.enabled) && typeof window !== 'undefined';
      // 移动端：当存在第三方登录时，把账号/密码表单折叠在「用户名 / 密码登录」
      // 按钮后，主打第三方登录；电脑端沿用原设计，直接显示账号/密码输入框。
      const collapseCredentials = isMobile && (showGoogle || showWechatRedirect);
      const title = (options.title as string) || t('login');

      this._title = title;
      this._resolve = resolve;
      this._reject = reject;
      this._platform = options.platform;
      this._machineCode = options.machineCode;
      this._wechatOptions = this._normalizeWechatOptions(options);
      this._wxAuthInstance = this.sdk.wxAuth || new WxAuth(this.sdk);

      // 微信小程序内：默认直接触发微信 OAuth 登录，跳过登录框。
      // 微信内置浏览器不在此自动触发——用户需点击「微信登录」按钮（见下方
      // showWechatRedirect 处理），登录成功后会自动刷新页面进入登录态。
      if (typeof window !== 'undefined' && isWxMiniProgram && !this.sdk.token) {
        const hasWechatCode = new URL(window.location.href).searchParams.get('code');
        if (!hasWechatCode) {
          (this._wxAuthInstance as WxAuthLike).authorize({ autoRegister: true });
          return;
        }
      }

      this._injectStyles();

      const overlay = document.createElement('div');
      overlay.className = 'kw-login-overlay';

      overlay.innerHTML = `
        <div class="kw-login-box${showWechatQr ? ' kw-login-has-wechat' : ''}">
          <button class="kw-login-close" data-kw="close" aria-label="${this._esc(t('cancel'))}">&times;</button>

          <div class="kw-login-view active" data-kw-view="account">
            <div class="kw-login-content">
              <div class="kw-login-account-panel">
                <h2 class="kw-login-title">${this._esc(title)}</h2>
                <div class="kw-login-credentials${collapseCredentials ? '' : ' active'}" data-kw="credentials">
                  <input class="kw-login-input" data-kw="acc-user" type="text"
                    placeholder="${this._esc(t('username'))}" autocomplete="username" inputmode="text" />
                  <input class="kw-login-input" data-kw="acc-pass" type="password"
                    placeholder="${this._esc(t('password'))}" autocomplete="current-password" />
                  <div class="kw-login-error" data-kw="acc-error"></div>
                  <button class="kw-login-btn" data-kw="acc-submit">${this._esc(t('loginBtn'))}</button>
                  ${enableRegister ? `
                  <div class="kw-login-footer">
                    <span class="kw-login-link" data-kw="forgot-password">${this._esc(t('forgotPassword'))}</span>
                    <span class="kw-login-register-copy">
                      ${this._esc(t('noAccount'))}
                      <span class="kw-login-link" data-kw="goto-register">${this._esc(t('goRegister'))}</span>
                    </span>
                  </div>` : `
                  <div class="kw-login-footer kw-login-footer-single">
                    <span class="kw-login-link" data-kw="forgot-password">${this._esc(t('forgotPassword'))}</span>
                  </div>`}
                </div>
                ${(showGoogle || showWechatRedirect) ? this._renderSocialPanel(t, { showGoogle, showWechatRedirect, showPasswordEntry: collapseCredentials }) : ''}
              </div>

              ${showWechatQr ? this._renderWechatQrPanel(t) : ''}
            </div>
          </div>

          ${enableRegister ? `
          <div class="kw-login-view kw-login-register-view" data-kw-view="register">
            <h2 class="kw-login-title">${this._esc(t('registerTitle'))}</h2>
            <input class="kw-login-input" data-kw="reg-user" type="text"
              placeholder="${this._esc(t('registerUsername'))}" autocomplete="username" inputmode="text" />
            <input class="kw-login-input" data-kw="reg-pass" type="password"
              placeholder="${this._esc(t('password'))}" autocomplete="new-password" />
            <input class="kw-login-input" data-kw="reg-pass2" type="password"
              placeholder="${this._esc(t('confirmPassword'))}" autocomplete="new-password" />
            <div class="kw-login-error" data-kw="reg-error"></div>
            <button class="kw-login-btn" data-kw="reg-submit">${this._esc(t('registerBtn'))}</button>
            <div class="kw-login-footer kw-login-footer-single">
              <span class="kw-login-register-copy">
                ${this._esc(t('hasAccount'))}
                <span class="kw-login-link" data-kw="goto-login">${this._esc(t('goLogin'))}</span>
              </span>
            </div>
          </div>` : ''}

          <div class="kw-login-view kw-login-reset-view" data-kw-view="reset">
            <h2 class="kw-login-title">${this._esc(t('passwordReset'))}</h2>
            <input class="kw-login-input" data-kw="reset-key" type="text"
              placeholder="${this._esc(t('phoneOrEmail'))}" autocomplete="username" inputmode="text" />
            <div class="kw-login-code-row">
              <input class="kw-login-input" data-kw="reset-code" type="text"
                placeholder="${this._esc(t('verificationCode'))}" autocomplete="one-time-code" inputmode="numeric" />
              <button class="kw-login-code-btn" data-kw="reset-send">${this._esc(t('sendCode'))}</button>
            </div>
            <input class="kw-login-input" data-kw="reset-pass" type="password"
              placeholder="${this._esc(t('newPassword'))}" autocomplete="new-password" />
            <input class="kw-login-input" data-kw="reset-pass2" type="password"
              placeholder="${this._esc(t('confirmNewPassword'))}" autocomplete="new-password" />
            <div class="kw-login-error" data-kw="reset-error"></div>
            <button class="kw-login-btn" data-kw="reset-submit">${this._esc(t('resetConfirm'))}</button>
            <div class="kw-login-footer kw-login-footer-single">
              <span class="kw-login-register-copy">
                ${this._esc(t('hasAccount'))}
                <span class="kw-login-link" data-kw="reset-goto-login">${this._esc(t('goLogin'))}</span>
              </span>
            </div>
          </div>

          <div class="kw-login-view kw-login-register-view" data-kw-view="oauth-setup">
            <h2 class="kw-login-title">${this._esc(t('oauthSetupTitle'))}</h2>
            <div class="kw-login-oauth-subtitle" data-kw="oauth-subtitle"></div>
            <input class="kw-login-input" data-kw="oauth-user" type="text"
              placeholder="${this._esc(t('oauthSetupUsername'))}" autocomplete="username" inputmode="text" />
            <input class="kw-login-input" data-kw="oauth-pass" type="text"
              placeholder="${this._esc(t('oauthSetupPassword'))}" autocomplete="off" />
            <div class="kw-login-oauth-hint">${this._esc(t('oauthSetupHint'))}</div>
            <div class="kw-login-error" data-kw="oauth-error"></div>
            <button class="kw-login-btn" data-kw="oauth-submit">${this._esc(t('oauthBindBtn'))}</button>
          </div>
        </div>
      `;

      const q = (sel: string): LWEl => overlay.querySelector(`[data-kw="${sel}"]`) as unknown as LWEl;

      const accUser = q('acc-user');
      const accPass = q('acc-pass');
      const accError = q('acc-error');
      const accSubmit = q('acc-submit');

      const doAccountLogin = async () => {
        const username = accUser.value.trim();
        const password = accPass.value;
        if (!username || !password) { accError.textContent = t('errBoth'); return; }
        accError.textContent = '';
        accSubmit.disabled = true;
        accSubmit.textContent = t('loggingIn');
        try {
          const response = await this.sdk.login({ username, password });
          this._finish(response);
        } catch (err) {
          accSubmit.disabled = false;
          accSubmit.textContent = t('loginBtn');
          accError.textContent = (err as Error)?.message || t('errLoginFailed');
        }
      };

      accSubmit.addEventListener('click', doAccountLogin);
      accPass.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') doAccountLogin(); });
      accUser.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') accPass.focus(); });

      const passwordEntry = q('password-entry');
      if (passwordEntry) {
        passwordEntry.addEventListener('click', () => {
          const credentials = q('credentials');
          if (credentials) credentials.classList.add('active');
          passwordEntry.style.display = 'none';
          accUser.focus();
        });
      }

      if (showWechatQr) {
        const frame = q('wechat-frame');
        if (frame) {
          frame.addEventListener('load', () => this._startWechatPolling(overlay));
          frame.addEventListener('error', () => {
            const errorEl = q('wechat-error');
            if (errorEl) errorEl.textContent = t('wechatLoadFailed');
          });
          this._startWechatPolling(overlay);
          this._maybeHandleWechatCodeFromCurrentUrl(overlay);
        }
      }

      if (showWechatRedirect) {
        const wxSubmit = q('wechat-submit');
        if (wxSubmit) {
          wxSubmit.addEventListener('click', () => {
            wxSubmit.disabled = true;
            wxSubmit.textContent = t('wechatRedirecting');
            if (this._wxAuthInstance) {
              (this._wxAuthInstance as WxAuthLike).authorize({ autoRegister: true });
            }
          });
        }
        this._maybeHandleWxAuthRedirectCode(overlay);
      }

      if (showGoogle) {
        const googleBtn = q('google-submit');
        if (googleBtn) {
          googleBtn.addEventListener('click', () => this._startGoogleLogin(overlay));
        }
        this._maybeHandleGoogleCodeFromCurrentUrl(overlay);
      }

      if (enableRegister) {
        const regUser = q('reg-user');
        const regPass = q('reg-pass');
        const regPass2 = q('reg-pass2');
        const regError = q('reg-error');
        const regSubmit = q('reg-submit');

        const doRegister = async () => {
          const username = regUser.value.trim();
          const password = regPass.value;
          const password2 = regPass2.value;
          if (!this._validateUsername(username)) { regError.textContent = t('errUsernameLen'); return; }
          if (password.length < 6) { regError.textContent = t('errPasswordLen'); return; }
          if (password !== password2) { regError.textContent = t('errPasswordMatch'); return; }
          regError.textContent = '';
          regSubmit.disabled = true;
          try {
            await VerifyHuman.verify({ lang: this._lang as 'zhCN' | 'enUS' | undefined });
          } catch {
            regSubmit.disabled = false;
            return;
          }
          regSubmit.textContent = t('registering');
          try {
            const channel = (options.channel != null) ? Number(options.channel) : 60;
            const response = await this.sdk.post('/users/register', {
              username, password, platform: 'WEB', channel
            });
            this._finishWithAuth(response);
          } catch (err) {
            regSubmit.disabled = false;
            regSubmit.textContent = t('registerBtn');
            let msg = t('errRegisterFailed');
            const errMsg = (err as Error)?.message;
            if (errMsg) {
              const jsonMatch = errMsg.match(/HTTP \d+:\s*(\{.*\})/);
              if (jsonMatch) {
                try { msg = JSON.parse(jsonMatch[1]).message || msg; } catch { /* ignore */ }
              } else {
                msg = errMsg;
              }
            }
            regError.textContent = msg;
          }
        };

        regSubmit.addEventListener('click', doRegister);
        regPass2.addEventListener('keydown', (e) => { if (e.key === 'Enter') doRegister(); });

        const gotoReg = q('goto-register');
        const gotoLogin = q('goto-login');
        if (gotoReg) gotoReg.addEventListener('click', () => this._switchView(overlay, 'register'));
        if (gotoLogin) gotoLogin.addEventListener('click', () => this._switchView(overlay, 'account'));
      }

      const forgotPassword = q('forgot-password');
      if (forgotPassword) {
        forgotPassword.addEventListener('click', () => this._switchView(overlay, 'reset'));
      }

      // 第三方登录后「设置账号」视图的提交
      const oauthSubmit = q('oauth-submit');
      const oauthPass = q('oauth-pass');
      if (oauthSubmit) {
        oauthSubmit.addEventListener('click', () => this._doOauthBind(overlay));
      }
      if (oauthPass) {
        oauthPass.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._doOauthBind(overlay); });
      }

      this._bindPasswordReset(overlay);

      const doCancel = () => {
        this._destroy();
        reject(new Error(t('loginCancelled')));
      };

      q('close').addEventListener('click', doCancel);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) doCancel();
      });

      document.body.appendChild(overlay);
      this._overlay = overlay;
      this._setupViewportHandling(overlay);
      if (!collapseCredentials) accUser.focus();
    });
  }

  /**
   * Close the login window if open.
   */
  close(): void {
    this._destroy();
  }

  /**
   * 打开登录弹窗并直接进入「设置账号」视图，用于微信回调全局识别后、
   * 探测到未绑定账号（needBind）时完成绑定登录。
   *
   * show() 内部同步创建并挂载 overlay 后才返回 Promise，因此可在返回后立即
   * 切换到 oauth-setup 视图（用户只会看到设置账号界面，不会看到账号/密码登录界面）。
   *
   * @param data    - codeToProbe 返回的 { ticket, suggestedUsername, provider, bindPath? }
   * @param options - 透传给 show() 的选项（title / lang 等）
   * @returns 与 show() 一致：绑定成功 resolve 登录结果，取消 reject
   */
  showWechatBindSetup(data: Record<string, unknown>, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const promise = this.show({ ...options, enableWechat: false, enableGoogle: false });
    if (this._overlay) {
      this._showOauthSetup(this._overlay, data, (data.bindPath as string) || OAUTH_BIND_PATH);
    }
    return promise;
  }

  _renderWechatQrPanel(t: (k: string) => string): string {
    return `
      <div class="kw-login-wechat-panel">
        <div class="kw-login-wechat-frame-wrap">
          <iframe
            class="kw-login-wechat-frame"
            data-kw="wechat-frame"
            title="${this._esc(t('wechatQrLogin'))}"
            sandbox="allow-scripts allow-same-origin allow-top-navigation allow-forms allow-popups"
            src="${this._esc(this._getWechatAuthUrl())}">
          </iframe>
          <div class="kw-login-wechat-mask" data-kw="wechat-mask">${this._esc(t('wechatLoading'))}</div>
        </div>
        <div class="kw-login-wechat-caption">
          <span class="kw-login-wechat-icon" aria-hidden="true"></span>
          <span>${this._esc(t('wechatQrLogin'))}</span>
        </div>
        <div class="kw-login-wechat-subtitle">${this._esc(t('wechatQrSubtitle'))}</div>
        <div class="kw-login-wechat-error" data-kw="wechat-error"></div>
      </div>
    `;
  }

  _renderSocialPanel(t: (k: string) => string, { showGoogle = false, showWechatRedirect = false, showPasswordEntry = false }: { showGoogle?: boolean; showWechatRedirect?: boolean; showPasswordEntry?: boolean } = {}): string {
    const googleIcon = `
      <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
        <path fill="#4285F4" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
        <path fill="#34A853" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
        <path fill="#EA4335" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
        <path fill="none" d="M0 0h48v48H0z"/>
      </svg>
    `;
    const wechatIcon = `
      <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
        <path fill="#07C160" d="M690.1 377.4c5.9 0 11.8.2 17.6.5-23.8-110.9-141.2-193.6-275.2-193.6C281.3 184.3 160 287.6 160 415.2c0 73.4 40.3 137.7 103.4 180.7l-25.9 78 90.5-45.5c32.4 6.4 58.4 12.9 90.8 12.9 5.9 0 11.8-.3 17.6-.7-3.7-12.6-5.8-25.8-5.8-39.5 0-122.8 105.5-222.7 235.7-222.7zm-179.2-122c19.4 0 32.3 12.9 32.3 32.4 0 19.3-12.9 32.3-32.3 32.3-19.3 0-38.7-12.9-38.7-32.3 0-19.5 19.4-32.4 38.7-32.4zm-203.8 64.7c-19.3 0-38.8-12.9-38.8-32.3 0-19.5 19.5-32.4 38.8-32.4 19.3 0 32.3 12.9 32.3 32.4 0 19.3-12.9 32.3-32.3 32.3z"/>
        <path fill="#07C160" d="M864 622.7c0-107.4-107.4-194.9-227.9-194.9-127.5 0-228 87.5-228 194.9 0 107.6 100.5 194.9 228 194.9 26.7 0 53.6-6.5 80.4-12.9l73.5 40.3-20.2-67c53.8-40.4 94.2-93.7 94.2-155.3zm-301.9-32.4c-12.9 0-25.9-12.9-25.9-25.9 0-12.9 13-25.9 25.9-25.9 19.5 0 32.4 13 32.4 25.9 0 13-12.9 25.9-32.4 25.9zm147.4 0c-12.9 0-25.8-12.9-25.8-25.9 0-12.9 12.9-25.9 25.8-25.9 19.4 0 32.4 13 32.4 25.9 0 13-13 25.9-32.4 25.9z"/>
      </svg>
    `;
    const googleBtn = showGoogle ? `
        <button type="button" class="kw-login-social-btn" data-kw="google-submit">
          <span class="kw-login-social-icon" aria-hidden="true">${googleIcon}</span>
          <span>${this._esc(t('googleLogin'))}</span>
        </button>` : '';
    const wechatBtn = showWechatRedirect ? `
        <button type="button" class="kw-login-social-btn" data-kw="wechat-submit">
          <span class="kw-login-social-icon" aria-hidden="true">${wechatIcon}</span>
          <span>${this._esc(t('wechatRedirectLogin'))}</span>
        </button>` : '';
    // Entry button that reveals the username/password form. Placed after the
    // WeChat button.
    const passwordBtn = showPasswordEntry ? `
        <button type="button" class="kw-login-social-btn" data-kw="password-entry">
          <span>${this._esc(t('passwordLogin'))}</span>
        </button>` : '';
    // Keep all error messages below the buttons so they never appear sandwiched
    // between the Google and WeChat buttons.
    const googleErr = showGoogle ? `<div class="kw-login-social-error" data-kw="google-error"></div>` : '';
    const wechatErr = showWechatRedirect ? `<div class="kw-login-social-error" data-kw="wechat-error"></div>` : '';
    return `
      <div class="kw-login-social">${googleBtn}${wechatBtn}${passwordBtn}${googleErr}${wechatErr}
      </div>
    `;
  }

  _switchView(overlay: HTMLElement, viewId: string): void {
    overlay.querySelectorAll('.kw-login-view').forEach((v) => v.classList.remove('active'));
    const view = overlay.querySelector(`[data-kw-view="${viewId}"]`);
    if (view) view.classList.add('active');
    const firstInput = view && view.querySelector('input');
    if (firstInput) firstInput.focus();
  }

  _normalizeWechatOptions(options: Record<string, unknown>): Record<string, string> {
    const appId = (options.wechatAppId as string) || (options.wechatClientId as string) || WECHAT_QR_APP_ID;
    const state = (options.wechatState as string) || WECHAT_QR_STATE;
    const redirectUri = normalizeWechatRedirectUri((options.wechatRedirectUri as string) || this._getDefaultWechatRedirectUri());
    return {
      appId,
      clientId: (options.wechatClientId as string) || appId,
      state,
      redirectUri,
      authUrl: (options.wechatAuthUrl as string) || WECHAT_QR_AUTH_URL,
      tokenPath: (options.wechatTokenPath as string) || '/oauth_users/weixin',
      probePath: (options.wechatProbePath as string) || WECHAT_PROBE_PATH,
      bindPath: (options.oauthBindPath as string) || OAUTH_BIND_PATH,
    };
  }

  _getDefaultWechatRedirectUri(): string {
    if (typeof window === 'undefined') return '';
    const url = new URL(window.location.href);
    url.searchParams.delete('code');
    url.searchParams.delete('state');
    url.searchParams.delete('error');
    url.searchParams.set('wxauth', '1');
    url.hash = '';
    return url.toString();
  }

  _getWechatAuthUrl(): string {
    const options = (this._wechatOptions as Record<string, string>) || this._normalizeWechatOptions({});
    const params = new URLSearchParams({
      appid: options.appId,
      scope: 'snsapi_login',
      login_type: 'jssdk',
      redirect_uri: options.redirectUri,
      state: options.state,
      self_redirect: 'true',
      styletype: '',
      sizetype: '',
      bgcolor: '',
      rst: '',
      ts: String(Date.now()),
      stylelite: '1',
      fast_login: '0',
    });
    return `${options.authUrl}?${params.toString()}#wechat_redirect`;
  }

  _startWechatPolling(overlay: HTMLElement): void {
    this._stopWechatPolling();
    const frame = overlay.querySelector('[data-kw="wechat-frame"]') as HTMLIFrameElement | null;
    if (!frame || typeof window === 'undefined') return;

    this._wechatPollingTimer = setInterval(() => {
      try {
        const href = frame.contentWindow && frame.contentWindow.location.href;
        if (!href || href === 'about:blank') return;

        const url = new URL(href);
        if (url.origin !== window.location.origin) return;

        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          this._stopWechatPolling();
          this._setWechatError(overlay, 'wechatAuthFailed');
          return;
        }

        if (code) {
          this._stopWechatPolling();
          this._handleWechatCode(code, state, overlay);
        }
      } catch (_) {
        // The QR page is cross-origin until WeChat redirects back to the current origin.
      }
    }, 500);
  }

  _stopWechatPolling(): void {
    if (this._wechatPollingTimer) {
      clearInterval(this._wechatPollingTimer);
      this._wechatPollingTimer = null;
    }
  }

  _maybeHandleWechatCodeFromCurrentUrl(overlay: HTMLElement): void {
    if (typeof window === 'undefined') return;
    try {
      const url = new URL(window.location.href);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const wxauth = url.searchParams.get('wxauth');
      if (code && (wxauth === '1' || state === ((this._wechatOptions as Record<string, string>) && (this._wechatOptions as Record<string, string>).state))) {
        this._stopWechatPolling();
        this._handleWechatCode(code, state, overlay);
      }
    } catch { /* ignore */ }
  }

  async _handleWechatCode(code: string, state: string | null, overlay: HTMLElement): Promise<void> {
    const options = (this._wechatOptions as Record<string, string>) || this._normalizeWechatOptions({});
    const t = (k: string): string => (this._strings as LoginStrings)[k] || k;
    const expectedState = options.state || WECHAT_QR_STATE;

    if (state && state !== expectedState) {
      this._setWechatError(overlay, 'wechatStateFailed');
      return;
    }

    if (this._isWechatCodeProcessed(code)) return;
    this._markWechatCodeProcessed(code);

    this._setWechatLoading(overlay, true);
    this._setWechatError(overlay, '');

    try {
      const payload: Record<string, unknown> = {
        code,
        clientId: options.clientId,
        redirectUri: options.redirectUri,
        // common 验证器要求 state 必填，缺省回退到期望值
        state: state || expectedState,
      };
      if (this._platform) payload.platform = this._platform;
      if (this._machineCode) payload.machineCode = this._machineCode;

      const response = await this.sdk.post(options.probePath, payload);
      // 已绑定账号：直接登录
      if (response && response.token) {
        this._clearWechatQueryFromCurrentUrl();
        this._finishWithAuth(response);
        return;
      }
      // 未绑定：进入「设置账号」视图
      if (response && response.needBind && response.ticket) {
        this._clearWechatQueryFromCurrentUrl();
        this._showOauthSetup(overlay, response, options.bindPath);
        return;
      }
      this._setWechatError(overlay, 'wechatUnbound');
    } catch (err) {
      this._setWechatError(overlay, (err as Error)?.message || t('wechatAuthFailed'));
    } finally {
      this._setWechatLoading(overlay, false);
    }
  }

  _isWechatCodeProcessed(code: string): boolean {
    if (this._processedWechatCodes.has(code)) return true;
    if (typeof sessionStorage === 'undefined') return false;
    return !!sessionStorage.getItem(`kwWxOauthCodeProcessed:${code}`);
  }

  _markWechatCodeProcessed(code: string): void {
    this._processedWechatCodes.add(code);
    try { sessionStorage.setItem(`kwWxOauthCodeProcessed:${code}`, '1'); } catch { /* ignore */ }
  }

  _clearWechatQueryFromCurrentUrl(): void {
    if (typeof window === 'undefined' || !window.history || !window.history.replaceState) return;
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has('code') && !url.searchParams.has('state') && !url.searchParams.has('wxauth')) return;
      url.searchParams.delete('code');
      url.searchParams.delete('state');
      url.searchParams.delete('wxauth');
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    } catch (_) {}
  }

  /**
   * Check if the current URL contains a WxAuth OAuth redirect code (wxauth=1).
   * If found, handle the code exchange via WxAuth.codeToToken.
   */
  _maybeHandleWxAuthRedirectCode(overlay: HTMLElement): void {
    if (typeof window === 'undefined') return;
    try {
      const url = new URL(window.location.href);
      const code = url.searchParams.get('code');
      const wxauth = url.searchParams.get('wxauth');
      if (code && wxauth === '1') {
        this._handleWxAuthRedirectCode(code, overlay);
      }
    } catch { /* ignore */ }
  }

  /**
   * Exchange a WxAuth OAuth code for a token using WxAuth.codeToToken.
   */
  async _handleWxAuthRedirectCode(code: string, overlay: HTMLElement): Promise<void> {
    const t = (k: string): string => (this._strings as LoginStrings)[k] || k;
    const wxAuth = this._wxAuthInstance as { codeToProbe(code: string): Promise<Record<string, unknown>> } | null;
    if (!wxAuth) {
      this._setWechatError(overlay, 'wechatAuthFailed');
      return;
    }

    if (this._isWechatCodeProcessed(code)) return;
    this._markWechatCodeProcessed(code);

    this._setWechatLoading(overlay, true);
    this._setWechatError(overlay, '');

    try {
      const result = await wxAuth.codeToProbe(code) as Record<string, unknown>;
      const data = (result && result.data) as Record<string, unknown> | undefined;

      // 已绑定账号：codeToProbe 已写入 token，直接完成登录
      if (result && result.success && data && data.token) {
        this._clearWechatQueryFromCurrentUrl();
        this._finishWithAuth(data);
        // 微信内置浏览器 / 小程序走整页跳转登录，登录态需整页刷新后才能生效
        // （与 Google 一致）。token 已写入 cookie，刷新后宿主页面即进入登录态。
        this._reloadAfterOAuthLogin();
        return;
      }
      // 未绑定：进入「设置账号」视图
      if (result && result.success && data && data.needBind && data.ticket) {
        this._clearWechatQueryFromCurrentUrl();
        this._showOauthSetup(overlay, data, OAUTH_BIND_PATH);
        return;
      }
      this._setWechatError(overlay, 'wechatUnbound');
    } catch (err) {
      this._setWechatError(overlay, (err as Error)?.message || t('wechatAuthFailed'));
    } finally {
      this._setWechatLoading(overlay, false);
    }
  }

  _setWechatLoading(overlay: HTMLElement, isLoading: boolean): void {
    const mask = overlay.querySelector('[data-kw="wechat-mask"]');
    if (!mask) return;
    mask.classList.toggle('active', !!isLoading);
  }

  _normalizeGoogleOptions(options: Record<string, unknown>): Record<string, unknown> {
    const clientId = (options.googleClientId as string) || GOOGLE_OAUTH_CLIENT_ID;
    const enabled = options.enableGoogle !== false && !!clientId;
    const state = (options.googleState as string) || GOOGLE_OAUTH_STATE;
    const scope = (options.googleScope as string) || GOOGLE_OAUTH_SCOPE;
    // 统一入口（必须与 Google Cloud Console 登记的 redirect_uri 完全一致）。
    // 仅在显式传入 googleRedirectUri 时覆盖（如本地调试自建回调页）。
    const redirectUri = options.googleRedirectUri || GOOGLE_OAUTH_REDIRECT_URI;
    return {
      enabled,
      clientId,
      state,
      scope,
      redirectUri,
      authUrl: options.googleAuthUrl || GOOGLE_OAUTH_AUTH_URL,
      tokenPath: options.googleTokenPath || '/oauth_users/google',
      probePath: options.googleProbePath || GOOGLE_PROBE_PATH,
      bindPath: options.oauthBindPath || OAUTH_BIND_PATH,
      platform: options.platform,
      machineCode: options.machineCode,
    };
  }

  _getGoogleAuthUrl(): string {
    const options = (this._googleOptions || {}) as Record<string, string>;
    // state 经统一入口 /sso 原样回传，承载三件事：
    //  s: 业务约定的 state（默认 'login'），供后端校验；
    //  n: 本次登录的一次性随机串，回传时严格比对，防 CSRF / 串号；
    //  u: 发起登录的页面地址，供 /sso 判断 postMessage 的 targetOrigin 及整页跳转兜底回跳。
    this._googleSentState = this._buildGoogleState();
    const params = new URLSearchParams({
      client_id: options.clientId,
      redirect_uri: options.redirectUri,
      response_type: 'code',
      scope: options.scope,
      state: this._googleSentState,
      access_type: 'online',
      include_granted_scopes: 'true',
      prompt: 'select_account',
    });
    return `${options.authUrl}?${params.toString()}`;
  }

  _buildGoogleState(): string {
    const base = (this._googleOptions && (this._googleOptions.state as string)) || GOOGLE_OAUTH_STATE;
    const nonce = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const payload = { s: base, n: nonce, u: this._getGoogleReturnUrl() };
    return this._b64urlEncode(JSON.stringify(payload));
  }

  // 发起登录的页面地址（清掉可能残留的 OAuth 回调参数，并标记 googleauth=1），
  // 供 /sso 在整页跳转兜底时精确回跳到原页面。
  _getGoogleReturnUrl() {
    if (typeof window === 'undefined') return '';
    try {
      const url = new URL(window.location.href);
      ['code', 'state', 'error', 'scope', 'authuser', 'prompt', 'googleauth'].forEach((k) => url.searchParams.delete(k));
      url.searchParams.set('googleauth', '1');
      url.hash = '';
      return url.toString();
    } catch (_) {
      return '';
    }
  }

  // 尝试把回传的 state 解析为 _buildGoogleState 写入的结构，失败返回 null（兼容裸 state）。
  _decodeGoogleState(state: string | null): Record<string, unknown> | null {
    if (!state || typeof state !== 'string') return null;
    try {
      const obj = JSON.parse(this._b64urlDecode(state));
      if (obj && typeof obj === 'object' && obj.s) return obj;
    } catch { /* ignore */ }
    return null;
  }

  _b64urlEncode(str: string): string {
    const NodeBuffer = (globalThis as { Buffer?: { from(s: string, e: string): { toString(e: string): string } } }).Buffer;
    const b64 = (typeof btoa === 'function')
      ? btoa(unescape(encodeURIComponent(str)))
      : NodeBuffer!.from(str, 'utf-8').toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  _b64urlDecode(b64url: string): string {
    let b64 = String(b64url).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const NodeBuffer = (globalThis as { Buffer?: { from(s: string, e: string): { toString(e: string): string } } }).Buffer;
    return (typeof atob === 'function')
      ? decodeURIComponent(escape(atob(b64)))
      : NodeBuffer!.from(b64, 'base64').toString('utf-8');
  }

  _startGoogleLogin(overlay: HTMLElement): void {
    const options = (this._googleOptions || {}) as Record<string, unknown>;
    const t = (k: string): string => (this._strings as LoginStrings)[k] || k;
    const btn = overlay.querySelector('[data-kw="google-submit"]') as HTMLButtonElement | null;
    if (!options || !options.enabled) {
      this._setGoogleError(overlay, 'googleMissingConfig');
      return;
    }
    this._setGoogleError(overlay, '');
    if (btn) (btn as HTMLButtonElement).disabled = true;

    this._googleCodeHandled = false;
    // 统一入口 /sso 与本页面通常跨域（/sso 固定在 keepwork.com），无法用轮询读取
    // 弹窗 URL，因此主路径改为监听 /sso 回传的 postMessage；轮询仅作同源时的兜底。
    this._startGoogleMessageListener(overlay);

    const authUrl = this._getGoogleAuthUrl();
    const popup = this._openGooglePopup(authUrl);
    if (!popup) {
      if (btn) btn.disabled = false;
      this._stopGoogleMessageListener();
      this._setGoogleError(overlay, 'googlePopupBlocked');
      return;
    }
    this._googlePopup = popup;
    this._startGooglePolling(overlay);
  }

  _startGoogleMessageListener(overlay: HTMLElement): void {
    if (typeof window === 'undefined') return;
    this._stopGoogleMessageListener();
    const options = (this._googleOptions || {}) as Record<string, unknown>;
    let expectedOrigin = '';
    try { expectedOrigin = new URL(options.redirectUri as string).origin; } catch { /* ignore */ }

    this._googleMessageHandler = (event: MessageEvent) => {
      // 仅接受来自统一入口（redirectUri）所在 origin 的消息。
      if (expectedOrigin && event.origin !== expectedOrigin) return;
      const data = event.data as Record<string, unknown>;
      if (!data || data.kwSso !== true || data.provider !== 'google') return;
      // 一次性 nonce 严格比对：必须与本次发起时下发的 state 完全一致。
      if (!data.state || data.state !== this._googleSentState) return;
      if (data.error) {
        this._stopGooglePolling();
        this._stopGoogleMessageListener();
        this._closeGooglePopup();
        const btn = overlay.querySelector('[data-kw="google-submit"]') as HTMLButtonElement | null;
        if (btn) btn.disabled = false;
        this._setGoogleError(overlay, 'googleAuthFailed');
        return;
      }
      if (data.code) {
        this._stopGooglePolling();
        this._stopGoogleMessageListener();
        this._closeGooglePopup();
        this._handleGoogleCode(data.code as string, data.state as string, overlay);
      }
    };
    window.addEventListener('message', this._googleMessageHandler);
  }

  _stopGoogleMessageListener() {
    if (this._googleMessageHandler && typeof window !== 'undefined') {
      window.removeEventListener('message', this._googleMessageHandler);
    }
    this._googleMessageHandler = null;
  }

  _openGooglePopup(url: string): Window | null {
    if (typeof window === 'undefined') return null;
    const width = 480;
    const height = 640;
    const left = Math.max(0, ((window.screen && window.screen.width) || width) / 2 - width / 2);
    const top = Math.max(0, ((window.screen && window.screen.height) || height) / 2 - height / 2);
    const features = `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes,status=no,toolbar=no,menubar=no,location=no`;
    try {
      const popup = window.open(url, 'kwGoogleLogin', features);
      if (!popup) return null;
      try { popup.focus(); } catch { /* ignore */ }
      return popup;
    } catch {
      return null;
    }
  }

  _startGooglePolling(overlay: HTMLElement): void {
    this._stopGooglePolling();
    const popup = this._googlePopup;
    if (!popup || typeof window === 'undefined') return;

    this._googlePollingTimer = setInterval(() => {
      if (!this._googlePopup || this._googlePopup.closed) {
        this._stopGooglePolling();
        const btn = overlay.querySelector('[data-kw="google-submit"]') as HTMLButtonElement | null;
        // /sso 回传 postMessage 后会立即自关弹窗，消息可能比「检测到关闭」稍晚到达，
        // 因此延迟一小段时间再判定为「已取消」，避免误报。
        setTimeout(() => {
          if (this._googleCodeHandled) return;
          if (btn) btn.disabled = false;
          this._stopGoogleMessageListener();
          this._setGoogleError(overlay, 'googleCancelled');
        }, 600);
        return;
      }
      try {
        const href = this._googlePopup.location && this._googlePopup.location.href;
        if (!href || href === 'about:blank') return;
        const url = new URL(href);
        if (url.origin !== window.location.origin) return;

        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          this._stopGooglePolling();
          this._closeGooglePopup();
          this._setGoogleError(overlay, 'googleAuthFailed');
          return;
        }

        if (code) {
          this._stopGooglePolling();
          this._closeGooglePopup();
          this._handleGoogleCode(code, state, overlay);
        }
      } catch {
        // Cross-origin until Google redirects back to our origin.
      }
    }, 500);
  }

  _stopGooglePolling(): void {
    if (this._googlePollingTimer) {
      clearInterval(this._googlePollingTimer);
      this._googlePollingTimer = null;
    }
  }

  _closeGooglePopup(): void {
    if (this._googlePopup && !this._googlePopup.closed) {
      try { this._googlePopup.close(); } catch { /* ignore */ }
    }
    this._googlePopup = null;
  }

  _maybeHandleGoogleCodeFromCurrentUrl(overlay: HTMLElement): void {
    if (typeof window === 'undefined') return;
    try {
      const url = new URL(window.location.href);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const googleauth = url.searchParams.get('googleauth');
      const expectedState = this._googleOptions && this._googleOptions.state;
      const decoded = this._decodeGoogleState(state);
      const baseState = decoded ? decoded.s : state;
      // 整页跳转兜底：/sso 把回调参数带回原页面（googleauth=1），此时是新实例，
      // 没有 _googleSentState 可比对，退而校验解析出的业务 state。
      if (code && (googleauth === '1' || (baseState && baseState === expectedState))) {
        this._handleGoogleCode(code, state, overlay);
      }
    } catch { /* ignore */ }
  }

  async _handleGoogleCode(code: string, state: string | null, overlay: HTMLElement): Promise<void> {
    if (this._googleCodeHandled) return;
    this._googleCodeHandled = true;

    const options = (this._googleOptions || {}) as Record<string, unknown>;
    const expectedState = (options.state as string) || GOOGLE_OAUTH_STATE;
    const decoded = this._decodeGoogleState(state);
    const baseState = decoded ? decoded.s : state;
    // 同一实例内发起的登录用一次性 nonce 严格比对；整页跳转回来的新实例
    // （无 _googleSentState）退化为校验业务 state。
    const stateValid = this._googleSentState
      ? (state === this._googleSentState)
      : (!baseState || baseState === expectedState);
    if (!stateValid) {
      this._setGoogleError(overlay, 'googleStateFailed');
      this._googleCodeHandled = false;
      return;
    }

    const btn = overlay.querySelector('[data-kw="google-submit"]') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    this._setGoogleError(overlay, '');

    try {
      const payload: Record<string, unknown> = {
        code,
        redirectUri: options.redirectUri,
        state: expectedState,
      };
      if (options.platform) payload.platform = options.platform;
      if (options.machineCode) payload.machineCode = options.machineCode;

      const response = await this.sdk.post(options.probePath as string, payload);
      // 已绑定账号：直接登录
      if (response && response.token) {
        this._clearGoogleQueryFromCurrentUrl();
        this._finishWithAuth(response);
        return;
      }
      // 未绑定：进入「设置账号」视图，让用户确认/修改用户名和密码后再绑定
      if (response && response.needBind && response.ticket) {
        this._clearGoogleQueryFromCurrentUrl();
        this._showOauthSetup(overlay, response, options.bindPath as string);
        return;
      }
      this._setGoogleError(overlay, 'googleAuthFailed');
      this._googleCodeHandled = false;
      if (btn) btn.disabled = false;
    } catch (err) {
      this._googleCodeHandled = false;
      if (btn) btn.disabled = false;
      const message = this._extractApiMessage(err) || ((err as Error)?.message) || '';
      this._setGoogleError(overlay, message || 'googleAuthFailed');
    }
  }

  _clearGoogleQueryFromCurrentUrl(): void {
    if (typeof window === 'undefined' || !window.history || !window.history.replaceState) return;
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has('code') && !url.searchParams.has('state') && !url.searchParams.has('googleauth')) return;
      url.searchParams.delete('code');
      url.searchParams.delete('state');
      url.searchParams.delete('googleauth');
      url.searchParams.delete('scope');
      url.searchParams.delete('authuser');
      url.searchParams.delete('prompt');
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    } catch (_) {}
  }

  _setGoogleError(overlay: HTMLElement, keyOrMessage: string): void {
    const el = overlay.querySelector('[data-kw="google-error"]');
    if (!el) return;
    if (!keyOrMessage) { el.textContent = ''; return; }
    const t = (k: string): string => (this._strings as LoginStrings)[k] || k;
    el.textContent = t(keyOrMessage);
  }

  _setWechatError(overlay: HTMLElement, keyOrMessage: string): void {
    const el = overlay.querySelector('[data-kw="wechat-error"]');
    if (!el) return;
    if (!keyOrMessage) {
      el.textContent = '';
      return;
    }
    const t = (k: string): string => (this._strings as LoginStrings)[k] || k;
    el.textContent = t(keyOrMessage);
  }

  _bindPasswordReset(overlay: HTMLElement): void {
    const q = (sel: string): LWEl => overlay.querySelector(`[data-kw="${sel}"]`) as unknown as LWEl;
    const t = (k: string): string => (this._strings as LoginStrings)[k] || k;
    const keyInput = q('reset-key');
    const codeInput = q('reset-code');
    const passInput = q('reset-pass');
    const pass2Input = q('reset-pass2');
    const sendBtn = q('reset-send');
    const submitBtn = q('reset-submit');
    const errorEl = q('reset-error');
    const backLogin = q('reset-goto-login');

    if (!keyInput || !codeInput || !passInput || !pass2Input || !sendBtn || !submitBtn || !errorEl) return;

    sendBtn.addEventListener('click', async () => {
      const key = keyInput.value.trim();
      if (!this._validatePhoneOrEmail(key)) {
        errorEl.textContent = t('errPhoneOrEmail');
        return;
      }

      errorEl.textContent = '';
      sendBtn.disabled = true;
      try {
        if (PHONE_REG.test(key)) {
          const users = await this.sdk.post('/users/getUsersByPhones', { phones: [key] });
          if (!Array.isArray(users) || users.length < 1) {
            errorEl.textContent = t('errPhoneNotBound');
            sendBtn.disabled = false;
            return;
          }
          await this.sdk.get('/users/cellphone_captcha', { cellphone: key });
        } else {
          await this.sdk.get('/users/email_captcha', { email: key });
        }
        this._startResetCountdown(sendBtn, 60);
      } catch (err) {
        sendBtn.disabled = false;
        const message = (err as Error)?.message || '';
        errorEl.textContent = message.includes('429') ? t('errSendingFrequent') : (this._extractApiMessage(err) || t('errSendCodeFailed'));
      }
    });

    const doReset = async () => {
      const key = keyInput.value.trim();
      const captcha = codeInput.value.trim();
      const password = passInput.value;
      const password2 = pass2Input.value;

      if (!this._validatePhoneOrEmail(key)) { errorEl.textContent = t('errPhoneOrEmail'); return; }
      if (!captcha) { errorEl.textContent = t('errCode'); return; }
      if (!this._validateResetPassword(password)) { errorEl.textContent = t('errPasswordRange'); return; }
      if (password !== password2) { errorEl.textContent = t('errPasswordMatch'); return; }

      errorEl.textContent = '';
      submitBtn.disabled = true;
      submitBtn.textContent = t('resetting');

      try {
        const result = await this.sdk.post('/users/reset_password', { key, captcha, password }) as unknown;
        if (result !== 'OK' && result !== true && !(result && (result as Record<string, unknown>).success)) {
          throw new Error(t('errResetFailed'));
        }
        const response = await this.sdk.login({ username: key, password });
        this._finish(response);
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = t('resetConfirm');
        const message = this._extractApiMessage(err) || ((err as Error)?.message) || t('errResetFailed');
        errorEl.textContent = this._isCaptchaError(err, message) ? t('errVerificationCode') : message;
      }
    };

    submitBtn.addEventListener('click', doReset);
    pass2Input.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') doReset(); });
    if (backLogin) backLogin.addEventListener('click', () => this._switchView(overlay, 'account'));
  }

  _startResetCountdown(btn: LWEl, seconds: number): void {
    const t = (k: string): string => (this._strings as LoginStrings)[k] || k;
    let remaining = seconds;
    btn.disabled = true;
    btn.textContent = `${remaining}${t('countResend')}`;
    this._clearResetTimer();
    this._resetTimer = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        this._clearResetTimer();
        btn.disabled = false;
        btn.textContent = t('sendCode');
      } else {
        btn.textContent = `${remaining}${t('countResend')}`;
      }
    }, 1000);
  }

  _clearResetTimer(): void {
    if (this._resetTimer) {
      clearInterval(this._resetTimer);
      this._resetTimer = null;
    }
  }

  _validatePhoneOrEmail(value: string): boolean {
    return PHONE_REG.test(value) || EMAIL_REG.test(value);
  }

  _validateResetPassword(password: string): boolean {
    return typeof password === 'string' && password.length >= 4 && password.length <= 24;
  }

  _extractApiMessage(err: unknown): string {
    const message = (err as Error)?.message ? String((err as Error).message) : '';
    const jsonMatch = message.match(/HTTP \d+:\s*(\{.*\})/);
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[1]);
        return data.message || data.error || '';
      } catch { /* ignore */ }
    }
    return '';
  }

  _isCaptchaError(err: unknown, message: string): boolean {
    if (err && (err as { status?: number }).status === 400) return true;
    return /code.?5|captcha|verification/i.test(String(message || ''));
  }

  _validateUsername(name: string): boolean {
    return /^[a-zA-Z0-9_]{4,30}$/.test(name);
  }

  /**
   * 第三方登录探测发现未绑定账号时，进入「设置账号」视图：用户名预填后端建议，
   * 密码本地生成一串明文显示，二者均可修改。
   * @param {HTMLElement} overlay
   * @param {Object} data - 探测返回 { ticket, suggestedUsername, provider, ... }
   * @param {string} bindPath - 绑定接口路径
   */
  _showOauthSetup(overlay: HTMLElement, data: Record<string, unknown>, bindPath: string): void {
    const t = (k: string): string => (this._strings as LoginStrings)[k] || k;
    this._oauthBindCtx = {
      ticket: data.ticket,
      bindPath: bindPath || OAUTH_BIND_PATH,
    };
    const userInput = overlay.querySelector('[data-kw="oauth-user"]') as HTMLInputElement | null;
    const passInput = overlay.querySelector('[data-kw="oauth-pass"]') as HTMLInputElement | null;
    const subtitle = overlay.querySelector('[data-kw="oauth-subtitle"]');
    const errorEl = overlay.querySelector('[data-kw="oauth-error"]');
    if (errorEl) errorEl.textContent = '';
    if (subtitle) {
      subtitle.textContent = data.provider === 'wechat'
        ? t('oauthSetupSubtitleWechat')
        : t('oauthSetupSubtitleGoogle');
    }
    if (userInput) userInput.value = (data.suggestedUsername as string) || '';
    if (passInput) passInput.value = this._generatePassword();
    this._switchView(overlay, 'oauth-setup');
    if (userInput) {
      // 默认选中用户名，方便直接修改
      try { userInput.focus(); userInput.select(); } catch { /* ignore */ }
    }
  }

  async _doOauthBind(overlay: HTMLElement): Promise<void> {
    const t = (k: string): string => (this._strings as LoginStrings)[k] || k;
    const ctx = this._oauthBindCtx;
    const userInput = overlay.querySelector('[data-kw="oauth-user"]') as HTMLInputElement | null;
    const passInput = overlay.querySelector('[data-kw="oauth-pass"]') as HTMLInputElement | null;
    const errorEl = overlay.querySelector('[data-kw="oauth-error"]');
    const submitBtn = overlay.querySelector('[data-kw="oauth-submit"]') as HTMLButtonElement | null;

    if (!ctx || !ctx.ticket) {
      if (errorEl) errorEl.textContent = t('errOauthBindFailed');
      return;
    }
    const username = userInput ? userInput.value.trim() : '';
    const password = passInput ? passInput.value : '';
    if (!username || !password) {
      if (errorEl) errorEl.textContent = t('errBoth');
      return;
    }
    if (errorEl) errorEl.textContent = '';
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = t('oauthBinding'); }

    try {
      const payload: Record<string, unknown> = { ticket: ctx.ticket, username, password };
      if (this._platform) payload.platform = this._platform;
      if (this._machineCode) payload.machineCode = this._machineCode;

      const response = await this.sdk.post(ctx.bindPath as string, payload);
      if (response && response.token) {
        this._finishWithAuth(response);
        return;
      }
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = t('oauthBindBtn'); }
      if (errorEl) errorEl.textContent = t('errOauthBindFailed');
    } catch (err) {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = t('oauthBindBtn'); }
      const message = this._extractApiMessage(err) || ((err as Error)?.message) || t('errOauthBindFailed');
      if (errorEl) errorEl.textContent = message;
    }
  }

  // 生成一个易读、满足后端 >=6 位要求的随机密码（去除易混淆字符）
  _generatePassword(len = 10): string {
    const lower = 'abcdefghijkmnpqrstuvwxyz';
    const digits = '23456789';
    const all = 'ABCDEFGHJKLMNPQRSTUVWXYZ' + lower + digits;
    let pwd = lower[Math.floor(Math.random() * lower.length)];
    pwd += digits[Math.floor(Math.random() * digits.length)];
    for (let i = pwd.length; i < len; i++) {
      pwd += all[Math.floor(Math.random() * all.length)];
    }
    return pwd;
  }

  /**
   * 登录/注册成功统一收尾：写 token + cookie，然后关窗口并 resolve。
   * 所有「直接持有 token 的路径」都走此方法，避免各处重复写 setToken + setCookie。
   * 若 response 不含 token（如账号登录走 sdk.login() 内部处理），退化为普通 _finish。
   */
  _finishWithAuth(response: Record<string, unknown>): void {
    if (response && response.token) {
      this.sdk.setToken(response.token);
      setCookie('token', response.token as string, 14);
      setCookie('token', response.token as string, 14, { sameSite: 'None', secure: true });
    }
    this._finish(response);
  }

  /**
   * 整页跳转式 OAuth 登录（微信浏览器 / 小程序）成功后刷新页面，
   * 使宿主页面以登录态重新初始化。SSR 等无 window 环境下静默跳过。
   */
  _reloadAfterOAuthLogin(): void {
    if (typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function') {
      window.location.reload();
    }
  }

  _finish(response: Record<string, unknown>): void {
    this._destroy();
    if (this._resolve) {
      this._resolve(response);
      this._resolve = undefined;
      this._reject = undefined;
    }
  }

  /**
   * Constrain the overlay to the visual viewport so the on-screen keyboard
   * never hides the lower part of the form (e.g. the third-party login
   * buttons). When the soft keyboard opens, the layout viewport stays the
   * same size but the visual viewport shrinks; by pinning the overlay to the
   * visual viewport the modal stays fully above the keyboard and its content
   * (which has overflow-y: auto) can be scrolled to reach every button.
   */
  _setupViewportHandling(overlay: HTMLElement): void {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const vv = window.visualViewport;
    const apply = () => {
      if (!this._overlay) return;
      overlay.style.bottom = 'auto';
      overlay.style.top = `${vv.offsetTop}px`;
      overlay.style.height = `${vv.height}px`;
    };
    this._viewportHandler = apply;
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    apply();
  }

  _teardownViewportHandling() {
    if (this._viewportHandler && typeof window !== 'undefined' && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this._viewportHandler);
      window.visualViewport.removeEventListener('scroll', this._viewportHandler);
    }
    this._viewportHandler = null;
  }

  _injectStyles() {
    if (this._styleEl) return;
    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);
    this._styleEl = style;
  }

  _destroy() {
    this._teardownViewportHandling();
    this._stopWechatPolling();
    this._stopGooglePolling();
    this._stopGoogleMessageListener();
    this._closeGooglePopup();
    this._googleCodeHandled = false;
    this._googleSentState = null;
    this._oauthBindCtx = null;
    this._wxAuthInstance = null;
    this._clearResetTimer();
    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
    }
    if (this._styleEl) {
      this._styleEl.remove();
      this._styleEl = null;
    }
  }

  _esc(str: unknown): string {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // Backward compat alias
  _escapeHTML(str: unknown): string { return this._esc(str); }
}
