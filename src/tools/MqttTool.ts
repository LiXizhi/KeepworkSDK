/**
 * MqttTool.ts — MQTT 工具类（供 CopilotTools 注册为 'mqtt' 分类）
 *
 * 封装 MqttManager，向 LLM 暴露三个工具函数：
 * - `mqtt_publish`：向指定 topic 发布消息
 * - `mqtt_get`：读取指定 topic 的最新消息
 * - `mqtt_subscribe`：订阅指定 topic
 *
 * 使用示例（通过 CopilotTools）：
 * ```ts
 * const result = await copilot.mqtt_publish({ topic: 'light/control', message: 'on' });
 * ```
 */

import MqttManager from '../ai-chat/MqttManager';
import type { MqttConfig } from '../ai-chat/MqttManager';
import SDKLogger from '../utils/SDKLogger';

const console = SDKLogger.createModuleConsole('MqttTool');

/** 工具函数定义（OpenAI Function Calling 格式） */
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** MqttTool 运行时配置（继承 MqttConfig 并添加 topic 覆盖） */
export type MqttToolConfig = MqttConfig & {
  /** 覆盖 args.topic 的默认 topic */
  topic?: string;
};

class MqttTool {
  /** LLM 可见的工具定义列表 */
  static readonly definitions: ToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'mqtt_publish',
        description:
          '通过MQTT协议发送控制指令或数据。可用于控制各类智能设备（如灯光、开关、电机等）或发布状态。主题和消息内容灵活，不限于特定列表。',
        parameters: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              description:
                '目标主题(Topic)。根据实际设备定义填写，例如 \'light/pos2\', \'device/123/control\', \'water/pump\' 等。',
            },
            message: {
              type: 'string',
              description: "控制指令或数据(Payload)。例如 'on', 'off', '{\"speed\": 100}' 等。",
            },
          },
          required: ['topic', 'message'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mqtt_get',
        description: "获取MQTT变量的值。例如：获取土壤湿度(topic: 'humidity')等。",
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: "变量主题，如 'humidity'等" },
          },
          required: ['topic'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mqtt_subscribe',
        description: '订阅指定的MQTT主题，以接收实时消息推送。',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: '要订阅的主题(Topic)。' },
          },
          required: ['topic'],
        },
      },
    },
  ];

  private config: MqttToolConfig = {} as MqttToolConfig;
  private mqttManager: MqttManager;

  constructor() {
    this.mqttManager = new MqttManager();
  }

  /**
   * 更新工具运行时配置（由 CopilotTools.setToolConfig 调用）。
   * 同步将配置传递给底层 MqttManager。
   */
  setConfig(config: MqttToolConfig): void {
    this.config = config ?? ({} as MqttToolConfig);
    this.mqttManager.setConfig(this.config);
  }

  // ──────────────────── 工具分发 ────────────────────

  /**
   * 执行 MQTT 工具操作。
   *
   * @param name   - 工具名（'mqtt_publish' | 'mqtt_get' | 'mqtt_subscribe'）
   * @param args   - 工具参数（topic + message 等）
   * @param config - 运行时配置（可覆盖 this.config）
   */
  async execute(
    name: string,
    args: { topic?: string; message?: string } = {},
    config: MqttToolConfig = {} as MqttToolConfig
  ): Promise<string> {
    const mergedConfig: MqttToolConfig = { ...this.config, ...config };
    const topic = (mergedConfig.topic ?? args.topic) as string | undefined;

    if (name === 'mqtt_publish') {
      const { message } = args;
      if (!topic) return 'Failed: No topic provided';
      const msg = { type: args.topic, message: args.message };
      if (this.mqttManager.publish(topic, JSON.stringify(msg))) {
        return `Command sent to ${topic}: ${message}`;
      }
      return 'Failed to publish message: MQTT not connected or available';
    }

    if (name === 'mqtt_get') {
      if (!topic) return 'Failed: No topic provided';
      try {
        const value = await this.mqttManager.get(args.topic ?? topic);
        return `Value for ${topic}: ${value}`;
      } catch (e) {
        return `Failed to get value for ${topic}: ${(e as Error).message}`;
      }
    }

    if (name === 'mqtt_subscribe') {
      if (!topic) return 'Failed: No topic provided';
      this.mqttManager.subscribe(topic);
      return `Subscribed to ${topic}`;
    }

    return 'Unknown tool';
  }
}

export default MqttTool;
