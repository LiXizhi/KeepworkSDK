/**
 * SocialFriends.ts — 好友 / 私聊房间 / 站内信 相关 API（完整 TypeScript 实现）
 *
 * 封装 coreservice 路由：好友申请、好友关系、黑名单、私聊房间创建/举报、
 * 关注/粉丝查询、站内信（含奖励领取）、邮箱验证。内置请求限流与缓存。
 *
 * @example
 *   await keepwork.socialFriends.applyFriend(123, 'I am Alice');
 *   await keepwork.socialFriends.acceptApply(456);
 *   const friends = await keepwork.socialFriends.list();
 *   const room = await keepwork.socialFriends.createChatRoom(123);
 */

// ──────────────────── 类型 ────────────────────

/** 通用选项对象 */
export type SocialOptions = Record<string, unknown>;

/** 好友标识：id 或包含 friendId/targetId/userId/id 的对象 */
export type FriendRef =
  | string
  | number
  | { friendId?: string | number; targetId?: string | number; userId?: string | number; id?: string | number; [key: string]: unknown };

/** 限流错误（带额外字段） */
export interface RateLimitError extends Error {
  code: 'SOCIAL_RATE_LIMITED';
  action: string;
  rateLimitKey: string;
  retryAfter: number;
  retryAfterMs: number;
}

/** 缓存条目 */
interface CacheEntry {
  value: unknown;
  timestamp: number;
}

/** _requestEndpoint 选项 */
interface RequestEndpointOptions {
  method?: string;
  params?: Record<string, unknown>;
  body?: unknown;
}

/** _fixedCachedRequest 选项 */
interface FixedCachedOptions {
  forceRefresh?: boolean;
  shouldCache?: (value: unknown) => boolean;
}

/** sdk 需提供的最小接口 */
interface SocialFriendsSdk {
  baseURL?: string;
  getAuthHeaders(): Record<string, string>;
  request(path: string, options?: { method?: string; body?: unknown }): Promise<unknown>;
  get(path: string, params?: Record<string, unknown>): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
  put(path: string, body?: unknown): Promise<unknown>;
  delete(path: string): Promise<unknown>;
}

// ──────────────────── SocialFriends ────────────────────

export default class SocialFriends {
  static DefaultRateLimitMs = 10000;

  /** 各操作的限流间隔（ms）。 */
  static RateLimitMs: Readonly<Record<string, number>> = Object.freeze({
    applyFriend: 30000,
    processApply: 10000,
    listApplies: 10000,
    list: 10000,
    searchFriends: 10000,
    removeFriend: 10000,
    updateFriend: 10000,
    addToBlacklist: 10000,
    removeFromBlacklist: 10000,
    listBlacklist: 10000,
    setOnlineStatus: 10000,
    clearAllOnlineStatus: 10000,
    getFollowing: 10000,
    getFollowers: 10000,
    createChatRoom: 10000,
    reportChat: 30000,
    sendMail: 30000,
    listMails: 10000,
    deleteMail: 10000,
    setMailRead: 10000,
    getMailReward: 10000,
    readMail: 3000,
    sendEmailCaptcha: 60000,
    verifyEmail: 10000,
  });

  /** 好友申请状态枚举。 */
  static FriendApplyStatus: Readonly<Record<string, number>> = Object.freeze({
    PENDING: 1,
    AGREE: 2,
    REFUSE: 3,
    BLOCK: 4,
    PROCESSED: 5,
  });

  /** 好友关系状态枚举。 */
  static FriendshipStatus: Readonly<Record<string, number>> = Object.freeze({
    NORMAL: 1,
    DELETE: 2,
    BLOCK: 3,
    BLOCK_OTHER: 4,
  });

  sdk: SocialFriendsSdk;
  private _rateLimitState: Map<string, number>;
  private _rateLimitCache: Map<string, CacheEntry>;
  private _fixedResponseCache: Map<string, unknown>;

  constructor(sdk: unknown) {
    this.sdk = sdk as SocialFriendsSdk;
    this._rateLimitState = new Map();
    this._rateLimitCache = new Map();
    this._fixedResponseCache = new Map();
  }

  // ──────────── 限流 / 缓存内部 ────────────

  private _getRateLimitMs(action: string): number {
    const rateLimitMs = SocialFriends.RateLimitMs[action];
    return Number.isFinite(rateLimitMs) ? rateLimitMs : SocialFriends.DefaultRateLimitMs;
  }

  private _getRateLimitKey(action: string, keyParts?: unknown): string {
    if (keyParts === undefined) return action;
    return `${action}:${this._stableStringify(keyParts)}`;
  }

  /** 稳定序列化（键排序），用于生成确定性缓存 key。 */
  private _stableStringify(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(item => this._stableStringify(item)).join(',')}]`;

    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${this._stableStringify(obj[key])}`).join(',')}}`;
  }

  /** 强制限流；超限抛 RateLimitError。返回限流 key。 */
  private _enforceRateLimit(action: string, keyParts?: unknown): string | undefined {
    const rateLimitMs = this._getRateLimitMs(action);
    if (!rateLimitMs || rateLimitMs <= 0) return;

    const rateLimitKey = this._getRateLimitKey(action, keyParts);
    const now = Date.now();
    const nextAllowedAt = this._rateLimitState.get(rateLimitKey) || 0;
    if (now < nextAllowedAt) {
      const retryAfterMs = nextAllowedAt - now;
      const retryAfter = Math.ceil(retryAfterMs / 1000);
      const error = new Error(`SocialFriends: ${action} is rate limited. Please retry in ${retryAfter}s.`) as RateLimitError;
      error.code = 'SOCIAL_RATE_LIMITED';
      error.action = action;
      error.rateLimitKey = rateLimitKey;
      error.retryAfter = retryAfter;
      error.retryAfterMs = retryAfterMs;
      throw error;
    }

    this._rateLimitState.set(rateLimitKey, now + rateLimitMs);
    return rateLimitKey;
  }

  /** 限流 + 缓存：超限时若有缓存则返回缓存。 */
  private async _cachedRateLimitedRequest(action: string, keyParts: unknown, requestFn: () => Promise<unknown>): Promise<unknown> {
    const rateLimitKey = this._getRateLimitKey(action, keyParts);
    const cached = this._rateLimitCache.get(rateLimitKey);

    try {
      this._enforceRateLimit(action, keyParts);
    } catch (error) {
      if (error && (error as RateLimitError).code === 'SOCIAL_RATE_LIMITED' && cached) {
        return cached.value;
      }
      throw error;
    }

    const value = await requestFn();
    this._rateLimitCache.set(rateLimitKey, { value, timestamp: Date.now() });
    return value;
  }

  /** 固定缓存：命中即返回，否则请求后按 shouldCache 决定是否缓存。 */
  private async _fixedCachedRequest(action: string, keyParts: unknown, requestFn: () => Promise<unknown>, options: FixedCachedOptions = {}): Promise<unknown> {
    const cacheKey = this._getRateLimitKey(action, keyParts);
    if (!options.forceRefresh && this._fixedResponseCache.has(cacheKey)) {
      return this._fixedResponseCache.get(cacheKey);
    }

    const value = await requestFn();
    const shouldCache = typeof options.shouldCache === 'function' ? options.shouldCache(value) : true;
    if (shouldCache) this._fixedResponseCache.set(cacheKey, value);
    return value;
  }

  private _clearCachedAction(action: string): void {
    const prefix = `${action}:`;
    [this._rateLimitCache, this._fixedResponseCache].forEach(cache => {
      for (const key of cache.keys()) {
        if (key === action || key.startsWith(prefix)) cache.delete(key);
      }
    });
  }

  /** 清除站内信列表缓存。 */
  clearMailListCache(): void {
    this._clearCachedAction('listMails');
  }

  /** 递归判断是否已领取奖励。 */
  private _hasReceivedRewards(value: unknown): boolean {
    if (!value) return false;
    if (Array.isArray(value)) return value.some(item => this._hasReceivedRewards(item));
    if (typeof value !== 'object') return false;
    const obj = value as Record<string, unknown>;
    if (Number(obj.receivedRewards) === 1 || obj.receivedRewards === true) return true;
    return this._hasReceivedRewards(obj.data) || this._hasReceivedRewards(obj.mail) || this._hasReceivedRewards(obj.email);
  }

  /** 去除空值参数。 */
  private _compactParams(params: Record<string, unknown> = {}): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    Object.keys(params).forEach(key => {
      const value = params[key];
      if (value !== undefined && value !== null && value !== '') {
        result[key] = value;
      }
    });
    return result;
  }

  /** 把 core API 基地址改写为指定服务的端点。 */
  private _getServiceEndpoint(servicePath: string, path = ''): string {
    const baseURL = this.sdk.baseURL || 'https://api.keepwork.com/core/v0';
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    let serviceBase = baseURL.replace(/\/core\/v\d+\/?$/i, servicePath);

    if (serviceBase === baseURL) {
      try {
        const url = new URL(baseURL);
        url.pathname = servicePath;
        url.search = '';
        url.hash = '';
        serviceBase = url.toString().replace(/\/$/, '');
      } catch {
        serviceBase = servicePath;
      }
    }

    return `${serviceBase.replace(/\/$/, '')}${normalizedPath}`;
  }

  private _getPushManageEndpoint(path = ''): string {
    return this._getServiceEndpoint('/push-manage/v0', path);
  }

  /** 向指定端点发起请求（相对路径走 sdk.request，绝对 URL 走 fetch）。 */
  private async _requestEndpoint(endpoint: string, options: RequestEndpointOptions = {}): Promise<unknown> {
    const method = options.method || 'GET';
    const params = this._compactParams(options.params || {});
    const query = new URLSearchParams(this._compactParams(params) as Record<string, string>).toString();
    const url = query ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}${query}` : endpoint;
    if (!/^https?:\/\//i.test(url)) {
      const requestOptions: { method: string; body?: unknown } = { method };
      if (options.body !== undefined) requestOptions.body = options.body;
      return this.sdk.request(url, requestOptions);
    }

    const requestOptions: RequestInit = {
      method,
      headers: this.sdk.getAuthHeaders(),
    };
    if (options.body !== undefined) {
      requestOptions.body = typeof options.body === 'object' ? JSON.stringify(options.body) : (options.body as BodyInit);
    }

    const response = await fetch(url, requestOptions);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const contentType = response.headers.get('content-type');
    return contentType && contentType.includes('application/json') ? response.json() : response.text();
  }

  private _requireId(id: unknown, name = 'id'): string {
    if (id === undefined || id === null || id === '') {
      throw new Error(`SocialFriends: ${name} is required`);
    }
    return encodeURIComponent(String(id));
  }

  /** 从 id 或对象中提取好友 id。 */
  private _normalizeFriendId(friendOrOptions: FriendRef, name = 'friendId'): string | number | undefined {
    if (friendOrOptions && typeof friendOrOptions === 'object') {
      const o = friendOrOptions as Record<string, string | number | undefined>;
      return o[name] ?? o.friendId ?? o.targetId ?? o.userId ?? o.id;
    }
    return friendOrOptions;
  }

  /** 归一化申请状态（数字或枚举名）。 */
  private _normalizeApplyStatus(status: string | number): number {
    if (typeof status === 'number') return status;
    const normalized = String(status || '').trim().toUpperCase();
    const map = SocialFriends.FriendApplyStatus;
    if (map[normalized]) return map[normalized];
    throw new Error('SocialFriends: status must be one of PENDING, AGREE, REFUSE, BLOCK, PROCESSED or a numeric status');
  }

  // ==================== 好友申请 ====================

  /** 申请添加好友。 */
  async applyFriend(friendOrOptions: FriendRef, remark = ''): Promise<unknown> {
    const friendId = this._normalizeFriendId(friendOrOptions);
    const body = typeof friendOrOptions === 'object'
      ? { ...friendOrOptions, friendId }
      : { friendId, remark };
    this._requireId(body.friendId, 'friendId');
    this._enforceRateLimit('applyFriend');
    return this.sdk.post('/friendApply', this._compactParams(body));
  }

  apply(friendOrOptions: FriendRef, remark = ''): Promise<unknown> { return this.applyFriend(friendOrOptions, remark); }
  requestFriend(friendOrOptions: FriendRef, remark = ''): Promise<unknown> { return this.applyFriend(friendOrOptions, remark); }
  addFriend(friendOrOptions: FriendRef, remark = ''): Promise<unknown> { return this.applyFriend(friendOrOptions, remark); }

  /** 处理待处理的好友申请（status: 2/AGREE, 3/REFUSE, 4/BLOCK）。 */
  async processApply(applyId: string | number, status: string | number): Promise<unknown> {
    const normalizedApplyId = this._requireId(applyId, 'applyId');
    const normalizedStatus = this._normalizeApplyStatus(status);
    this._enforceRateLimit('processApply');
    return this.sdk.put(`/friendApply/${normalizedApplyId}`, { status: normalizedStatus });
  }

  acceptApply(applyId: string | number): Promise<unknown> { return this.processApply(applyId, SocialFriends.FriendApplyStatus.AGREE); }
  rejectApply(applyId: string | number): Promise<unknown> { return this.processApply(applyId, SocialFriends.FriendApplyStatus.REFUSE); }
  refuseApply(applyId: string | number): Promise<unknown> { return this.rejectApply(applyId); }
  blockApply(applyId: string | number): Promise<unknown> { return this.processApply(applyId, SocialFriends.FriendApplyStatus.BLOCK); }
  acceptFriendApply(applyId: string | number): Promise<unknown> { return this.acceptApply(applyId); }
  rejectFriendApply(applyId: string | number): Promise<unknown> { return this.rejectApply(applyId); }

  /** 列出发给当前用户的好友申请。 */
  async listApplies(options: SocialOptions = {}): Promise<unknown> {
    const params = this._compactParams(options);
    return this._cachedRateLimitedRequest('listApplies', params, () => this.sdk.get('/friendApply', params));
  }

  getApply(options: SocialOptions = {}): Promise<unknown> { return this.listApplies(options); }
  getApplies(options: SocialOptions = {}): Promise<unknown> { return this.listApplies(options); }
  listApplications(options: SocialOptions = {}): Promise<unknown> { return this.listApplies(options); }

  // ==================== 好友关系 / 黑名单 ====================

  /** 列出当前用户好友关系（含好友信息和在线状态）。 */
  async list(options: SocialOptions = {}): Promise<unknown> {
    const params = this._compactParams(options);
    return this._cachedRateLimitedRequest('list', params, () => this.sdk.get('/friendships', params));
  }

  getFriendships(options: SocialOptions = {}): Promise<unknown> { return this.list(options); }
  listFriends(options: SocialOptions = {}): Promise<unknown> { return this.list(options); }

  /** 通过用户名搜索当前用户的 Keepwork 好友（旧 /users/friends 路由）。 */
  async searchFriends(options: SocialOptions | string = {}): Promise<unknown> {
    const params = typeof options === 'string' ? { username: options } : options;
    const compactParams = this._compactParams(params);
    return this._cachedRateLimitedRequest('searchFriends', compactParams, () => this.sdk.get('/users/friends', compactParams));
  }

  getFriends(options: SocialOptions | string = {}): Promise<unknown> { return this.searchFriends(options); }

  async removeFriend(friendOrOptions: FriendRef): Promise<unknown> {
    const friendId = this._normalizeFriendId(friendOrOptions);
    const normalizedFriendId = this._requireId(friendId, 'friendId');
    this._enforceRateLimit('removeFriend');
    return this.sdk.delete(`/friendships/${normalizedFriendId}`);
  }

  deleteFriend(friendOrOptions: FriendRef): Promise<unknown> { return this.removeFriend(friendOrOptions); }
  delete(friendOrOptions: FriendRef): Promise<unknown> { return this.removeFriend(friendOrOptions); }
  remove(friendOrOptions: FriendRef): Promise<unknown> { return this.removeFriend(friendOrOptions); }

  async updateFriend(friendOrOptions: FriendRef, comment = ''): Promise<unknown> {
    const friendId = this._normalizeFriendId(friendOrOptions);
    const body = typeof friendOrOptions === 'object'
      ? { comment: (friendOrOptions as Record<string, unknown>).comment ?? (friendOrOptions as Record<string, unknown>).remark ?? comment }
      : { comment };
    const normalizedFriendId = this._requireId(friendId, 'friendId');
    this._enforceRateLimit('updateFriend');
    return this.sdk.put(`/friendships/${normalizedFriendId}`, body);
  }

  updateRemark(friendOrOptions: FriendRef, comment = ''): Promise<unknown> { return this.updateFriend(friendOrOptions, comment); }
  setFriendComment(friendOrOptions: FriendRef, comment = ''): Promise<unknown> { return this.updateFriend(friendOrOptions, comment); }

  async addToBlacklist(friendOrOptions: FriendRef): Promise<unknown> {
    const friendId = this._normalizeFriendId(friendOrOptions);
    this._requireId(friendId, 'friendId');
    this._enforceRateLimit('addToBlacklist');
    return this.sdk.post('/friendBlacklists', { friendId });
  }

  blockFriend(friendOrOptions: FriendRef): Promise<unknown> { return this.addToBlacklist(friendOrOptions); }
  blacklist(friendOrOptions: FriendRef): Promise<unknown> { return this.addToBlacklist(friendOrOptions); }

  async removeFromBlacklist(friendOrOptions: FriendRef): Promise<unknown> {
    const friendId = this._normalizeFriendId(friendOrOptions);
    const normalizedFriendId = this._requireId(friendId, 'friendId');
    this._enforceRateLimit('removeFromBlacklist');
    return this.sdk.delete(`/friendBlacklists/${normalizedFriendId}`);
  }

  unblockFriend(friendOrOptions: FriendRef): Promise<unknown> { return this.removeFromBlacklist(friendOrOptions); }
  unblacklist(friendOrOptions: FriendRef): Promise<unknown> { return this.removeFromBlacklist(friendOrOptions); }

  async listBlacklist(options: SocialOptions = {}): Promise<unknown> {
    const params = this._compactParams(options);
    return this._cachedRateLimitedRequest('listBlacklist', params, () => this.sdk.get('/friendBlacklists', params));
  }

  getBlacklist(options: SocialOptions = {}): Promise<unknown> { return this.listBlacklist(options); }

  /** 更新在线状态（需 API-key 权限的内部路由）。 */
  setOnlineStatus(userId: string | number, status: unknown): Promise<unknown> {
    this._requireId(userId, 'userId');
    this._enforceRateLimit('setOnlineStatus');
    return this.sdk.post('/friendships/setUserOnline', { userId, status: !!status });
  }

  clearAllOnlineStatus(): Promise<unknown> {
    this._enforceRateLimit('clearAllOnlineStatus');
    return this.sdk.post('/friendships/clearAllOnlineStatus');
  }

  // ==================== 关注 / 粉丝 ====================

  getFollowing(options: SocialOptions = {}): Promise<unknown> {
    const params = this._compactParams(options);
    return this._cachedRateLimitedRequest('getFollowing', params, () => this.sdk.get('/users/following', params));
  }

  getFollowers(options: SocialOptions = {}): Promise<unknown> {
    const params = this._compactParams(options);
    return this._cachedRateLimitedRequest('getFollowers', params, () => this.sdk.get('/users/followers', params));
  }

  // ==================== 私聊 P2P ====================

  /** 为当前用户和好友创建或获取私聊房间。 */
  async createChatRoom(targetOrOptions: FriendRef): Promise<unknown> {
    const targetId = this._normalizeFriendId(targetOrOptions, 'targetId');
    this._requireId(targetId, 'targetId');
    this._enforceRateLimit('createChatRoom');
    return this.sdk.post('/users/chatRoom', { targetId });
  }

  openPrivateChat(targetOrOptions: FriendRef): Promise<unknown> { return this.createChatRoom(targetOrOptions); }
  createP2PChat(targetOrOptions: FriendRef): Promise<unknown> { return this.createChatRoom(targetOrOptions); }
  createPrivateChatRoom(targetOrOptions: FriendRef): Promise<unknown> { return this.createChatRoom(targetOrOptions); }

  /** 举报私聊违规内容。 */
  async reportChat(options: SocialOptions = {}): Promise<unknown> {
    const o = options as Record<string, unknown>;
    const reportUserId = o.reportUserId ?? o.userId ?? o.friendId ?? o.targetId;
    this._requireId(reportUserId, 'reportUserId');
    this._enforceRateLimit('reportChat');
    return this.sdk.post('/users/chatReports', {
      reportUserId,
      content: o.content || '',
    });
  }

  reportUser(reportUserId: string | number, content = ''): Promise<unknown> { return this.reportChat({ reportUserId, content }); }
  reportChatUser(reportUserId: string | number, content = ''): Promise<unknown> { return this.reportChat({ reportUserId, content }); }

  // ==================== 站内信 ====================

  /** 通过 push-manage 发送站内信。 */
  async sendMail(options: SocialOptions = {}): Promise<unknown> {
    const { endpoint, url, mailUrl, ...body } = options as Record<string, unknown>;
    this._enforceRateLimit('sendMail');
    const result = await this._requestEndpoint(
      (endpoint || url || mailUrl || this._getPushManageEndpoint('/email')) as string,
      { method: 'POST', body: this._compactParams(body) },
    );
    this.clearMailListCache();
    return result;
  }

  /** 列出当前用户站内信。 */
  async listMails(options: SocialOptions = {}): Promise<unknown> {
    const { endpoint: _endpoint, url: _url, mailListUrl: _mailListUrl, ...params } = options as Record<string, unknown>;
    const endpoint = (_endpoint || _url || _mailListUrl || this._getPushManageEndpoint('/email')) as string;
    const compactParams = this._compactParams(params);
    return this._cachedRateLimitedRequest('listMails', { endpoint, params: compactParams }, () => this._requestEndpoint(endpoint, { params: compactParams }));
  }

  getMails(options: SocialOptions = {}): Promise<unknown> { return this.listMails(options); }
  listEmails(options: SocialOptions = {}): Promise<unknown> { return this.listMails(options); }
  getEmails(options: SocialOptions = {}): Promise<unknown> { return this.listMails(options); }

  async deleteMail(mailOrOptions: SocialOptions | string | number | Array<string | number>): Promise<unknown> {
    const options = mailOrOptions && typeof mailOrOptions === 'object' && !Array.isArray(mailOrOptions)
      ? mailOrOptions as Record<string, unknown>
      : { ids: mailOrOptions };
    const { endpoint, url, mailUrl, id, mailId, ids, ...body } = options;
    const normalizedIds = ids !== undefined ? ids : (id !== undefined ? [id] : (mailId !== undefined ? [mailId] : undefined));
    if (normalizedIds !== undefined) (body as Record<string, unknown>).ids = Array.isArray(normalizedIds) ? normalizedIds : [normalizedIds];
    this._enforceRateLimit('deleteMail');
    const result = await this._requestEndpoint(
      (endpoint || url || mailUrl || this._getPushManageEndpoint('/email')) as string,
      { method: 'DELETE', body: this._compactParams(body) },
    );
    this.clearMailListCache();
    this._clearCachedAction('readMail');
    return result;
  }

  delEmail(mailOrOptions: SocialOptions | string | number | Array<string | number>): Promise<unknown> { return this.deleteMail(mailOrOptions); }
  removeMail(mailOrOptions: SocialOptions | string | number | Array<string | number>): Promise<unknown> { return this.deleteMail(mailOrOptions); }

  async setMailRead(options: SocialOptions | string | number | Array<string | number> = {}): Promise<unknown> {
    const normalizedOptions = options && typeof options === 'object' && !Array.isArray(options)
      ? options as Record<string, unknown>
      : { ids: options };
    const { endpoint, url, mailUrl, id, mailId, ids, ...body } = normalizedOptions;
    const normalizedIds = ids !== undefined ? ids : (id !== undefined ? [id] : (mailId !== undefined ? [mailId] : undefined));
    if (normalizedIds !== undefined) (body as Record<string, unknown>).ids = Array.isArray(normalizedIds) ? normalizedIds : [normalizedIds];
    this._enforceRateLimit('setMailRead');
    const result = await this._requestEndpoint(
      (endpoint || url || mailUrl || this._getPushManageEndpoint('/email')) as string,
      { method: 'PUT', body: this._compactParams(body) },
    );
    this.clearMailListCache();
    return result;
  }

  setEmailReaded(options: SocialOptions = {}): Promise<unknown> { return this.setMailRead(options); }
  markMailRead(options: SocialOptions = {}): Promise<unknown> { return this.setMailRead(options); }

  async getMailReward(options: SocialOptions = {}): Promise<unknown> {
    const { endpoint, url, rewardUrl, ...body } = options as Record<string, unknown>;
    this._enforceRateLimit('getMailReward');
    const result = await this._requestEndpoint(
      (endpoint || url || rewardUrl || this._getPushManageEndpoint('/email/rewards')) as string,
      { method: 'POST', body: this._compactParams(body) },
    );
    this.clearMailListCache();
    return result;
  }

  getEmailReward(options: SocialOptions = {}): Promise<unknown> { return this.getMailReward(options); }
  claimMailReward(options: SocialOptions = {}): Promise<unknown> { return this.getMailReward(options); }

  async readMail(mailOrOptions: SocialOptions | string | number): Promise<unknown> {
    const options = mailOrOptions && typeof mailOrOptions === 'object' ? mailOrOptions as Record<string, unknown> : { id: mailOrOptions };
    const { endpoint, url, mailUrl, id, forceRefresh = false, ...params } = options;
    const normalizedMailId = this._requireId(id, 'mailId');
    const resolvedEndpoint = (endpoint || url || mailUrl || this._getPushManageEndpoint(`/email/${normalizedMailId}`)) as string;
    const compactParams = this._compactParams(params);
    return this._fixedCachedRequest('readMail', { endpoint: resolvedEndpoint, params: compactParams }, () => {
      return this._cachedRateLimitedRequest('readMail', { endpoint: resolvedEndpoint, params: compactParams }, () => this._requestEndpoint(resolvedEndpoint, { params: compactParams }));
    }, { forceRefresh: forceRefresh as boolean, shouldCache: value => this._hasReceivedRewards(value) });
  }

  readEmail(mailOrOptions: SocialOptions | string | number): Promise<unknown> { return this.readMail(mailOrOptions); }
  openMail(mailOrOptions: SocialOptions | string | number): Promise<unknown> { return this.readMail(mailOrOptions); }

  // ==================== 邮箱 ====================

  /** 请求 Keepwork 邮箱验证码。 */
  async sendEmailCaptcha(emailOrOptions: string | { email?: string }): Promise<unknown> {
    const email = typeof emailOrOptions === 'object' ? emailOrOptions.email : emailOrOptions;
    if (!email) throw new Error('SocialFriends: email is required');
    this._enforceRateLimit('sendEmailCaptcha');
    return this.sdk.get('/users/email_captcha', { email });
  }

  requestEmailCaptcha(emailOrOptions: string | { email?: string }): Promise<unknown> { return this.sendEmailCaptcha(emailOrOptions); }
  getEmailCaptcha(emailOrOptions: string | { email?: string }): Promise<unknown> { return this.sendEmailCaptcha(emailOrOptions); }

  /** 验证邮箱验证码并绑定/解绑当前用户邮箱。 */
  async verifyEmail(options: SocialOptions = {}): Promise<unknown> {
    if (!(options as Record<string, unknown>).email) throw new Error('SocialFriends: email is required');
    this._enforceRateLimit('verifyEmail');
    return this.sdk.post('/users/email_captcha', this._compactParams(options));
  }

  bindEmail(email: string, captcha: string): Promise<unknown> { return this.verifyEmail({ email, captcha, isBind: true }); }
  unbindEmail(email: string, captchaOrPassword?: string): Promise<unknown> {
    const body: Record<string, unknown> = { email, isBind: false };
    if (captchaOrPassword) {
      body.captcha = captchaOrPassword;
      body.password = captchaOrPassword;
    }
    return this.verifyEmail(body);
  }
}
