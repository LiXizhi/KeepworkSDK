/**
 * YMLParser — Keepwork 页面数据专用 YAML 序列化/反序列化工具
 *
 * 实现了一个轻量级的 YAML 子集解析器，用于读写存储在 PersonalPage 中的结构化数据。
 * 支持 front-matter 格式（`---` 分隔的 YAML 头 + 正文），常用于页面元数据 + 内容分离。
 *
 * 注意：这不是一个完整的 YAML 实现；设计目标是覆盖 Keepwork 页面数据的实际存储格式，
 * 保持与现有 Lua 端（KeepworkReposApi）序列化行为的兼容。
 */

/** objectToYaml 的选项 */
export interface ObjectToYamlOptions {
  /** 是否按字母顺序排序键，默认 true */
  isSortKeys?: boolean;
  /** 是否使用 front-matter 格式（将 content 键序列化为 --- 块后的正文），默认 false */
  useFrontMatter?: boolean;
}

/** yamlToObject 的选项 */
export interface YamlToObjectOptions {
  /** 是否解析 front-matter 格式，默认 false */
  useFrontMatter?: boolean;
}

/** 可序列化的 YAML 值类型（递归） */
export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

class YMLParser {
  /**
   * 将 JavaScript 对象序列化为 YAML 字符串。
   *
   * 当 `useFrontMatter=true` 且对象含有 `content` 键时，
   * 输出格式为：
   * ```
   * ---
   * key1: value1
   * ---
   * <content 字符串>
   * ```
   *
   * @param obj           - 要序列化的对象
   * @param isSortKeys    - 是否按字母排序键（默认 true）
   * @param useFrontMatter - 是否使用 front-matter 格式（默认 false）
   * @returns 序列化后的 YAML 字符串
   */
  static objectToYaml(
    obj: Record<string, YamlValue>,
    isSortKeys = true,
    useFrontMatter = false
  ): string {
    if (!obj || typeof obj !== 'object') return '';

    const yamlLines: string[] = [];

    function convertValue(value: YamlValue, indent = ''): string {
      if (value === null || value === undefined) return 'null';
      if (typeof value === 'string') {
        const escapedValue = value
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t');
        return `"${escapedValue}"`;
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
      if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        const allSingleItem = value.every(
          (item) => typeof item === 'number' || typeof item === 'string'
        );
        if (allSingleItem) {
          const formattedItems = value.map((item) =>
            typeof item === 'string'
              ? `"${(item as string).replace(/"/g, '\\"')}"`
              : String(item)
          );
          return `[${formattedItems.join(',')}]`;
        }
        const items = value.map(
          (item) => `${indent}- ${convertValue(item as YamlValue, indent + '  ')}`
        );
        return '\n' + items.join('\n');
      }
      if (typeof value === 'object') {
        const keys = isSortKeys
          ? Object.keys(value as Record<string, unknown>).sort()
          : Object.keys(value as Record<string, unknown>);
        if (keys.length === 0) return '{}';
        const items = keys.map(
          (key) =>
            `${indent}${key}: ${convertValue((value as Record<string, YamlValue>)[key]!, indent + '  ')}`
        );
        return '\n' + items.join('\n');
      }
      return String(value);
    }

    const hasContent = useFrontMatter && Object.prototype.hasOwnProperty.call(obj, 'content');
    const keys = isSortKeys ? Object.keys(obj).sort() : Object.keys(obj);

    for (const key of keys) {
      if (hasContent && key === 'content') continue;
      yamlLines.push(`${key}: ${convertValue(obj[key]!, '  ')}`);
    }

    const yamlPart = yamlLines.join('\n');

    if (hasContent) {
      const contentStr = obj['content'] != null ? String(obj['content']) : '';
      if (yamlPart) return `---\n${yamlPart}\n---\n${contentStr}`;
      return `---\n---\n${contentStr}`;
    }

    return yamlPart;
  }

  /**
   * 将 YAML 字符串反序列化为 JavaScript 对象。
   *
   * 解析顺序：
   * 1. 若启用 `useFrontMatter` 且以 `---` 开头，先尝试 front-matter 解析
   * 2. 回退尝试 JSON.parse（兼容旧版 JSON 存储格式）
   * 3. 最终使用自有 YAML 行解析器
   *
   * @param yamlString    - YAML/JSON 字符串
   * @param useFrontMatter - 是否解析 front-matter 格式（默认 false）
   * @returns 解析后的对象，失败时返回空对象 `{}`
   */
  static yamlToObject(
    yamlString: string,
    useFrontMatter = false
  ): Record<string, YamlValue> | YamlValue[] {
    if (!yamlString || typeof yamlString !== 'string') return {};

    if (
      useFrontMatter &&
      (yamlString.startsWith('---\n') || yamlString.startsWith('---\r\n'))
    ) {
      const fmResult = YMLParser._parseFrontMatter(yamlString);
      if (fmResult) return fmResult;
    }

    try {
      return JSON.parse(yamlString) as Record<string, YamlValue>;
    } catch {
      try {
        const lines = yamlString
          .split('\n')
          .filter((line) => line.trim() && !line.trim().startsWith('#'));
        return YMLParser.parseYamlLines(lines);
      } catch (error) {
        console.warn('Failed to parse YAML:', error);
        return {};
      }
    }
  }

  /**
   * 递归解析 YAML 行数组，返回结构化对象。
   * 支持嵌套对象、数组、标量值，兼容 YAML 缩进层级。
   *
   * @param lines - 预过滤的 YAML 行（已去除空行和注释行）
   * @returns 解析结果对象或数组
   */
  static parseYamlLines(lines: string[]): Record<string, YamlValue> | YamlValue[] {
    const result: Record<string, YamlValue> = {};
    let i = 0;

    // 若整体是纯数组格式（顶层均为 `- ` 开头），直接解析为数组
    if (
      lines.length > 0 &&
      (lines[0]!.trim().startsWith('- ') || lines[0]!.trim() === '-') &&
      lines[0]!.length - lines[0]!.trimStart().length === 0
    ) {
      const allArrayItems = lines.every((line) => {
        const trimmed = line.trim();
        const indent = line.length - line.trimStart().length;
        return (
          trimmed === '' ||
          trimmed.startsWith('#') ||
          (indent === 0 && (trimmed.startsWith('- ') || trimmed === '-')) ||
          indent > 0
        );
      });
      if (allArrayItems) {
        return YMLParser.parseArrayItems(lines, 0) as YamlValue[];
      }
    }

    while (i < lines.length) {
      const line = lines[i]!;
      const trimmed = line.trim();
      const indent = line.length - line.trimStart().length;

      if (trimmed.startsWith('- ') || trimmed === '-') {
        const arrayItems = YMLParser.parseArrayItems(lines.slice(i), indent);
        let j = i;
        const baseIndent = indent;
        while (j < lines.length) {
          const currentLine = lines[j]!;
          const currentIndent = currentLine.length - currentLine.trimStart().length;
          const currentTrimmed = currentLine.trim();
          if (
            currentIndent < baseIndent ||
            (currentIndent === baseIndent &&
              !(currentTrimmed.startsWith('- ') || currentTrimmed === '-'))
          ) {
            break;
          }
          j++;
        }
        i = j;

        if (indent === 0 && Object.keys(result).length === 0) {
          return arrayItems as YamlValue[];
        }

        let arrayKey = 'items';
        let counter = 0;
        while (Object.prototype.hasOwnProperty.call(result, arrayKey)) {
          arrayKey = `items${++counter}`;
        }
        result[arrayKey] = arrayItems as YamlValue;
        continue;
      } else {
        const colonIndex = trimmed.indexOf(':');
        if (colonIndex <= 0) { i++; continue; }

        const key = trimmed.substring(0, colonIndex).trim();
        const value = trimmed.substring(colonIndex + 1).trim();

        if (value === '' || value === '{}' || value === '[]') {
          if (i + 1 < lines.length) {
            const nextLine = lines[i + 1]!;
            const nextIndent = nextLine.length - nextLine.trimStart().length;

            if (nextIndent > indent) {
              const nestedLines: string[] = [];
              let j = i + 1;
              while (j < lines.length) {
                const nestedLine = lines[j]!;
                const nestedIndent = nestedLine.length - nestedLine.trimStart().length;
                if (nestedIndent <= indent) break;
                nestedLines.push(nestedLine);
                j++;
              }
              if (nestedLines.length > 0) {
                const firstLineTrimmed = nestedLines[0]!.trim();
                if (firstLineTrimmed.startsWith('- ') || firstLineTrimmed === '-') {
                  const arrayIndent = nestedLines[0]!.length - nestedLines[0]!.trimStart().length;
                  result[key] = YMLParser.parseArrayItems(nestedLines, arrayIndent) as YamlValue;
                } else {
                  result[key] = YMLParser.parseYamlLines(nestedLines) as YamlValue;
                }
              } else {
                result[key] = value === '[]' ? [] : value === '{}' ? {} : null;
              }
              i = j;
              continue;
            }
          }
          result[key] = value === '[]' ? [] : value === '{}' ? {} : null;
        } else {
          result[key] = YMLParser.parseYamlValue(value);
        }
      }
      i++;
    }
    return result;
  }

  /**
   * 从 YAML 行数组中解析指定缩进层级的数组元素。
   *
   * @param lines      - YAML 行数组
   * @param baseIndent - 数组元素所在的缩进列数
   * @returns 解析出的数组
   */
  static parseArrayItems(lines: string[], baseIndent: number): YamlValue[] {
    const arrayItems: YamlValue[] = [];
    let i = 0;

    while (i < lines.length) {
      const currentLine = lines[i]!;
      const currentTrimmed = currentLine.trim();
      const currentIndent = currentLine.length - currentLine.trimStart().length;

      if (currentIndent < baseIndent) break;

      if (
        currentIndent !== baseIndent ||
        !(currentTrimmed.startsWith('- ') || currentTrimmed === '-')
      ) {
        i++;
        continue;
      }

      const itemValue = currentTrimmed.startsWith('- ')
        ? currentTrimmed.substring(2).trim()
        : '';

      if (itemValue === '') {
        // 空数组元素：收集嵌套行后递归解析
        const nestedLines: string[] = [];
        let j = i + 1;
        while (j < lines.length) {
          const nestedLine = lines[j]!;
          const nestedIndent = nestedLine.length - nestedLine.trimStart().length;
          const nestedTrimmed = nestedLine.trim();
          if (nestedIndent <= currentIndent) {
            if (
              nestedIndent === currentIndent &&
              (nestedTrimmed.startsWith('- ') || nestedTrimmed === '-')
            ) break;
            if (nestedIndent < currentIndent) break;
          }
          nestedLines.push(nestedLine);
          j++;
        }
        if (nestedLines.length > 0) {
          arrayItems.push(YMLParser.parseYamlLines(nestedLines) as YamlValue);
        } else {
          arrayItems.push(null);
        }
        i = j;
      } else if (itemValue.includes(':')) {
        // 内联属性对象（`- key: value`），可能有多行续行
        const colonIndex = itemValue.indexOf(':');
        const key = itemValue.substring(0, colonIndex).trim();
        const value = itemValue.substring(colonIndex + 1).trim();
        const contentIndent = currentIndent + 2;
        const nestedLines: string[] = [];
        let j = i + 1;
        while (j < lines.length) {
          const nl = lines[j]!;
          const ni = nl.length - nl.trimStart().length;
          if (ni < contentIndent) break;
          nestedLines.push(nl);
          j++;
        }
        if (nestedLines.length > 0) {
          const obj: Record<string, YamlValue> = { [key]: YMLParser.parseYamlValue(value) };
          const nested = YMLParser.parseYamlLines(nestedLines) as Record<string, YamlValue>;
          Object.assign(obj, nested);
          arrayItems.push(obj);
        } else {
          arrayItems.push({ [key]: YMLParser.parseYamlValue(value) });
        }
        i = j;
      } else {
        arrayItems.push(YMLParser.parseYamlValue(itemValue));
        i++;
      }
    }

    return arrayItems;
  }

  /**
   * 将 YAML 标量字符串解析为对应的 JS 原生类型。
   *
   * 支持：null/~、boolean、整数、浮点数、单引号/双引号字符串、
   * 内联 JSON 对象/数组，其余回退为字符串。
   *
   * @param value - 原始 YAML 标量字符串（已 trim）
   * @returns 解析后的值
   */
  static parseYamlValue(value: string): YamlValue {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();

    if (trimmed === 'null' || trimmed === '~') return null;
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;

    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed
        .slice(1, -1)
        .replace(/\\\\/g, '\\')
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t');
    }

    if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
    if (/^-?\d*\.\d+$/.test(trimmed)) return parseFloat(trimmed);

    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try { return JSON.parse(trimmed) as YamlValue; } catch { return trimmed; }
    }
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try { return JSON.parse(trimmed) as YamlValue; } catch { return trimmed; }
    }

    if (trimmed.includes('\n')) return trimmed;

    return trimmed;
  }

  /**
   * 解析 front-matter 格式字符串：`---\n<yaml>\n---\n<content>`
   *
   * 解析成功后，YAML 头部字段与 `content`（正文字符串）合并到同一对象。
   * 若格式不匹配（缺少第二个 `---`）则返回 null。
   *
   * @param str - 以 `---` 开头的字符串
   * @returns 包含 content 键的解析对象，或 null（格式不符）
   */
  static _parseFrontMatter(str: string): Record<string, YamlValue> | null {
    const lines = str.split('\n');
    if (lines[0]!.replace(/\r$/, '').trim() !== '---') return null;

    let closingLine = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.replace(/\r$/, '').trim() === '---') {
        closingLine = i;
        break;
      }
    }
    if (closingLine === -1) return null;

    const frontMatterLines = lines.slice(1, closingLine);
    const contentStr = lines.slice(closingLine + 1).join('\n');

    let result: Record<string, YamlValue> = {};
    const filteredLines = frontMatterLines.filter(
      (line) => line.trim() && !line.trim().startsWith('#')
    );
    if (filteredLines.length > 0) {
      try {
        result = YMLParser.parseYamlLines(filteredLines) as Record<string, YamlValue>;
      } catch (e) {
        console.warn('Failed to parse front matter:', e);
      }
    }

    result['content'] = contentStr;
    return result;
  }
}

export default YMLParser;
