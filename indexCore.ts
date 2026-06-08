/**
 * KeepworkSDK Core Bundle — 核心 bundle 入口（TypeScript 版）
 *
 * 产物：keepworkSDK.core.iife.js（不含 AIChat / DigitalHuman 的轻量版本）
 * 对于需要 AI 功能的页面，可在此 bundle 之后加载 AIChat chunk，
 * 或调用 keepwork.loadAIChat() 按需加载。
 *
 * @module indexCore
 */

import SDKLogger from './src/utils/SDKLogger';
import KeepworkSDK from './src/core/keepworkSDK';
import AudioEngine from './src/audio/AudioEngine';
import PersonalPageStore from './src/store/PersonalPageStore';
import LocalStorageUtil, { StorageUtil } from './src/store/LocalStorageUtil';
import YMLParser from './src/store/YMLParser';
import { NPLUtil, NPLJS, ParacraftEvent } from './src/core/NPL';
import RemoteLog from './src/core/RemoteLog';
import WxLaunchApp from './src/wechat/WxLaunchApp';
import WxAuth from './src/wechat/WxAuth';
import WxUtils from './src/wechat/WxUtils';
import LoginWindow from './src/ui/LoginWindow';
import SandboxToolEnv from './src/ai-chat/SandboxToolEnv';
import CopilotTools from './src/ai-chat/CopilotTools';
import UserWorks from './src/user/UserWorks';
import SocialFriends from './src/user/SocialFriends';
import Translation, { installI18nGlobals } from './src/utils/translation';

// 仅命名导出，无默认导出（避免 Rollup IIFE 的 named/default 混用警告）
export {
  SDKLogger, KeepworkSDK, AudioEngine, PersonalPageStore, LocalStorageUtil, StorageUtil,
  YMLParser, NPLUtil, NPLJS, ParacraftEvent, RemoteLog,
  WxLaunchApp, WxAuth, WxUtils, LoginWindow,
  SandboxToolEnv, CopilotTools, UserWorks, SocialFriends,
  Translation, installI18nGlobals,
};

// 记录 bundle 自身 URL，供 DigitalHumanFrame 等在不硬编码 CDN 路径的情况下引用 SDK
(KeepworkSDK as { source?: string; sourceIsModule?: boolean }).source = import.meta.url;
(KeepworkSDK as { sourceIsModule?: boolean }).sourceIsModule = true;

if (typeof window !== 'undefined') {
  window.SDKLogger = SDKLogger;
  window.KeepworkSDK = KeepworkSDK;
  window.AudioEngine = AudioEngine;
  window.PersonalPageStore = PersonalPageStore;
  window.LocalStorageUtil = LocalStorageUtil;
  window.StorageUtil = StorageUtil;
  window.YMLParser = YMLParser;
  window.NPLUtil = NPLUtil;
  window.NPLJS = NPLJS;
  window.ParacraftEvent = ParacraftEvent;
  window.RemoteLog = RemoteLog;
  window.WxLaunchApp = WxLaunchApp;
  window.WxAuth = WxAuth;
  window.WxUtils = WxUtils;
  window.LoginWindow = LoginWindow;
  window.SandboxToolEnv = SandboxToolEnv;
  window.CopilotTools = CopilotTools;
  window.UserWorks = UserWorks;
  window.SocialFriends = SocialFriends;
  window.Translation = Translation;

  // 初始化 i18n 并注入向后兼容全局（window.i18n、window.t 等）
  const i18n = new Translation({ autoInit: true });
  installI18nGlobals(i18n);

  // 创建默认 SDK 实例
  window.keepwork = new KeepworkSDK();

  // 初始化 NPL 消息监听器
  NPLUtil.initializeMessageListeners();
}
