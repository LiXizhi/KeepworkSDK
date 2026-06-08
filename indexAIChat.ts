/**
 * KeepworkSDK AIChat chunk — AI / DigitalHuman 懒加载入口（TypeScript 版）
 *
 * 产物：keepworkSDK.AIChat.iife.js（独立 IIFE，可在 core bundle 之后按需加载）
 *
 * 加载前提：keepworkSDK.core.iife.js（或 keepworkSDK.iife.js）已先行加载，
 * 使 window.KeepworkSDK、window.SandboxToolEnv、window.YMLParser 等已就绪。
 *
 * 加载后行为：
 * 1. 将所有导出类挂载到 window
 * 2. 若 window.keepwork 已存在，调用 _patchAIChat() 动态绑定 keepwork.aiChat / keepwork.speechRTC
 *
 * @module indexAIChat
 */

import AIChat from './src/ai-chat/AIChat';
import AIChatRTC from './src/rtc/AIChatRTC';
import AIChatRTCLocal from './src/rtc/AIChatRTCLocal';
import SpeechRTC from './src/rtc/SpeechRTC';
import DigitalHuman from './src/digital-human/DigitalHuman';
import DigitalHumanFrame from './src/digital-human/DigitalHumanFrame';
import AgentConfig from './src/core/AgentConfig';
import SummarizeTool, { SummarizeAgent } from './src/tools/SummarizeTool';

export {
  AIChat, AIChatRTC, AIChatRTCLocal, SpeechRTC,
  DigitalHuman, DigitalHumanFrame,
  AgentConfig, SummarizeTool, SummarizeAgent,
};

if (typeof window !== 'undefined') {
  window.AIChat = AIChat;
  window.AIChatRTC = AIChatRTC;
  window.AIChatRTCLocal = AIChatRTCLocal;
  window.SpeechRTC = SpeechRTC;
  window.DigitalHuman = DigitalHuman;
  window.DigitalHumanFrame = DigitalHumanFrame;
  window.AgentConfig = AgentConfig;
  window.SummarizeTool = SummarizeTool;
  window.SummarizeAgent = SummarizeAgent;

  // 若 core bundle 已初始化默认 SDK 实例，执行 AIChat 补丁以绑定相关子服务
  if (window.keepwork && typeof (window.keepwork as Record<string, unknown>)['_patchAIChat'] === 'function') {
    (window.keepwork as Record<string, (...args: unknown[]) => unknown>)['_patchAIChat']();
  }
}
