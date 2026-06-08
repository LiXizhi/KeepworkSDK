/**
 * AIChatRTCLocal.ts — 本地语音会话模块入口
 *
 * 拆分结构：
 * - AIChatRTCLocal.backends.ts : ASR/TTS backend 类
 * - AIChatRTCLocal.core.ts     : AIChatRTCLocal 主类
 * - AIChatRTCLocal.session.ts  : LocalRTCSession 会话类
 */

// AIChatRTCLocal.backends 仅定义 backend 类，无顶层副作用注册，
// 已由 AIChatRTCLocal.core 有绑定地 import 使用，无需在此再做纯副作用 import。
import _AIChatRTCLocal from './AIChatRTCLocal.core';
import { LocalRTCSession } from './AIChatRTCLocal.session';

const AIChatRTCLocal = _AIChatRTCLocal;
export default AIChatRTCLocal;
export { AIChatRTCLocal, LocalRTCSession };
