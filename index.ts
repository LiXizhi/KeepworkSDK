/**
 * KeepworkSDK — 全量 bundle 入口（TypeScript 版）
 *
 * 产物：keepworkSDK.iife.js（向后兼容的单文件 bundle）
 * 包含核心模块 + AIChat / DigitalHuman 全部模块。
 * 已加载此 bundle 的页面无需任何改动。
 *
 * @module index
 */

// ── 核心模块 ──
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
import ProfileWindow from './src/ui/ProfileWindow';
import SandboxToolEnv from './src/ai-chat/SandboxToolEnv';
import CopilotTools from './src/ai-chat/CopilotTools';
import CloudDrive from './src/store/CloudDrive';
import LocalAPIKeySettings from './src/ui/LocalAPIKeySettings';
import AIGenerators from './src/ai-chat/AIGenerators';
import UserWorks from './src/user/UserWorks';
import SocialFriends from './src/user/SocialFriends';

// ── AIChat / DigitalHuman 模块 ──
import AIChat from './src/ai-chat/AIChat';
import AIChatRTC from './src/rtc/AIChatRTC';
import AIChatRTCLocal from './src/rtc/AIChatRTCLocal';
import SpeechRTC from './src/rtc/SpeechRTC';
import DigitalHuman from './src/digital-human/DigitalHuman';
import DigitalHumanFrame from './src/digital-human/DigitalHumanFrame';
import AgentConfig from './src/core/AgentConfig';
import { WorkspaceViewer, createWorkspaceViewer } from './src/ui/WorkspaceViewer';
import SummarizeTool, { SummarizeAgent } from './src/tools/SummarizeTool';
import MinigameTools from './src/tools/MinigameTools';
import Translation, { installI18nGlobals } from './src/utils/translation';

// 记录 bundle 自身的 URL，供 DigitalHumanFrame 等模块在不硬编码 CDN 路径的情况下引用 SDK
(KeepworkSDK as { source?: string; sourceIsModule?: boolean }).source = import.meta.url;
(KeepworkSDK as { sourceIsModule?: boolean }).sourceIsModule = true;

if (typeof window !== 'undefined') {
  // ── 核心全局 ──
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
  window.ProfileWindow = ProfileWindow;
  window.SandboxToolEnv = SandboxToolEnv;
  window.CopilotTools = CopilotTools;
  window.CloudDrive = CloudDrive;
  window.LocalAPIKeySettings = LocalAPIKeySettings;
  window.AIGenerators = AIGenerators;
  window.UserWorks = UserWorks;
  window.SocialFriends = SocialFriends;

  // ── AIChat / DigitalHuman 全局 ──
  window.AIChat = AIChat;
  window.AIChatRTC = AIChatRTC;
  window.AIChatRTCLocal = AIChatRTCLocal;
  window.SpeechRTC = SpeechRTC;
  window.DigitalHuman = DigitalHuman;
  window.DigitalHumanFrame = DigitalHumanFrame;
  window.AgentConfig = AgentConfig;
  window.SummarizeTool = SummarizeTool;
  window.SummarizeAgent = SummarizeAgent;
  window.MinigameTools = MinigameTools;
  window.WorkspaceViewer = WorkspaceViewer;
  window.createWorkspaceViewer = createWorkspaceViewer;
  window.Translation = Translation;

  // 初始化 i18n 并注入向后兼容的全局（window.i18n、window.t 等）
  const i18n = new Translation({ autoInit: true });
  installI18nGlobals(i18n);

  // 创建默认 SDK 实例
  window.keepwork = new KeepworkSDK();

  // 初始化 NPL 消息监听器
  NPLUtil.initializeMessageListeners();
}

export {
  SDKLogger,
  KeepworkSDK, AudioEngine, PersonalPageStore, LocalStorageUtil, StorageUtil, YMLParser,
  NPLUtil, NPLJS, ParacraftEvent, RemoteLog,
  WxLaunchApp, WxAuth, WxUtils, LoginWindow, ProfileWindow,
  SandboxToolEnv, CopilotTools, CloudDrive, LocalAPIKeySettings, AIGenerators,
  UserWorks, SocialFriends,
  AIChat, AIChatRTC, AIChatRTCLocal, SpeechRTC,
  DigitalHuman, DigitalHumanFrame,
  AgentConfig, WorkspaceViewer, createWorkspaceViewer,
  SummarizeTool, SummarizeAgent, MinigameTools,
  Translation, installI18nGlobals,
};
