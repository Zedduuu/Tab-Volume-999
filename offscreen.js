/* =========================================================================
 * offscreen.js — 离屏文档脚本（Tab Volume 999 的“音频引擎”）
 *
 * 为每个标签页建立一条音频链路：
 *     标签页音频流 → MediaStreamAudioSourceNode → GainNode → audioCtx.destination
 *   GainNode 增益范围 0 ~ 9.99 对应音量 0% ~ 999%。
 *   同时负责把原标签页静音（避免双份声音）与按需解除静音。
 * ========================================================================= */

'use strict';

/* ------------------------------ 常量定义 ------------------------------ */

const MSG = {
  OFFSCREEN_START: 'offscreen:start',
  OFFSCREEN_CAPTURE: 'offscreen:capture',
  OFFSCREEN_SET_VOLUME: 'offscreen:setVolume',
  OFFSCREEN_STOP: 'offscreen:stop',
  OFFSCREEN_ACTIVATE: 'offscreen:activate',
  OFFSCREEN_EVENT: 'offscreen:event',
};

const VOLUME = { MIN: 0, MAX: 999, DEFAULT: 100 };

/** 离屏文档唯一标识：用于排查是否存在多个 offscreen 文档（Edge 可能残留） */
const DOC_ID = Math.random().toString(36).slice(2, 8);

/** 全局共享的 AudioContext：所有标签页会话共用，比每会话一个更省电 */
const audioCtx = new AudioContext();

// 监听 AudioContext 状态变化（标签页切后台/窗口节流可能导致挂起）
audioCtx.onstatechange = () => {
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch((e) => console.error('[offscreen] AudioContext resume 失败:', e?.message || e));
  }
};

/** 正在播放中的会话表：tabId -> TabAudioSession */
const sessions = new Map();

/* --------------------------- 单个标签页的会话 --------------------------- */

class TabAudioSession {
  /**
   * @param {number}      tabId   目标标签页 ID
   * @param {MediaStream} stream  经 tabCapture 获取的该标签页音频流
   */
  constructor(tabId, stream) {
    this.tabId = tabId;
    this.stream = stream;

    // 信号链：标签页音频流 → 增益节点 → MediaStreamDestination → <audio> 元素播放
    // 注意：offscreen 中直接连接 audioCtx.destination 在 Edge 上实测不可靠（不输出），
    //       改用 Chrome 官方推荐的 MediaStreamDestination + Audio 元素模式。
    this.gainNode = audioCtx.createGain();
    this.destNode = audioCtx.createMediaStreamDestination();
    this.gainNode.connect(this.destNode);

    this.sourceNode = audioCtx.createMediaStreamSource(stream);
    this.sourceNode.connect(this.gainNode);

    this.audioEl = new Audio();
    this.audioEl.srcObject = this.destNode.stream;
    this.audioEl.play().catch(() => {});

    // 页面刷新 / 跳转 / 标签页关闭时，浏览器会结束该捕获流
    this.endedHandler = () => this.handleStreamEnded();
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', this.endedHandler);
    }
    stream.addEventListener('inactive', this.endedHandler);
  }

  /**
   * 设置增益（0 = 静音，1 = 100%，9.99 = 999%）。
   * 注意：用 setTargetAtTime 指数逼近在 offscreen 的 AudioContext 中
   * 实测不推进（gain 卡在旧值），这里改用直接赋值，立即生效。
   */
  setVolume(volume) {
    const target = Math.min(VOLUME.MAX, Math.max(VOLUME.MIN, volume)) / 100;
    this.gainNode.gain.value = target;
  }

  /** 捕获流被系统中断（页面跳转等）时的回调 */
  handleStreamEnded() {
    this.release();
    notifyBackground({ event: 'ended', tabId: this.tabId });
  }

  /**
   * 释放本会话。
   * 注意：标签页的静音/解除静音由 background 统一管理——
   * offscreen 文档中 chrome.tabCapture API 不可用（Edge 限制）。
   */
  async release() {
    this.sourceNode.disconnect();
    this.gainNode.disconnect();
    this.audioEl.pause();
    this.audioEl.srcObject = null;
    for (const track of this.stream.getTracks()) {
      track.removeEventListener('ended', this.endedHandler);
      track.stop();
    }
    this.stream.removeEventListener('inactive', this.endedHandler);
    sessions.delete(this.tabId);
  }
}

/* ------------------------------ 工具函数 ------------------------------ */

/** i18n 说明：offscreen 文档中 chrome.i18n 不可用（Edge 限制），
 * 因此 offscreen 不再调用 chrome.i18n / tabCapture API；
 * 需要翻译的错误统一返回错误码，由 background 用 chrome.i18n 翻译。 */

/** 把 getUserMedia 的错误映射为稳定的错误码，交 background 翻译 */
function captureErrorCode(err) {
  const m = String(err?.message || '');
  const name = String(err?.name || '');
  if (/already|captur/i.test(m)) return 'already-captured';
  if (name === 'NotAllowedError') return 'not-allowed';
  if (name === 'NotSupportedError' || /constraint/i.test(m)) return 'not-supported';
  return `${name}:${m}`;
}

/** 向 background 广播事件（fire-and-forget，不占用响应通道；附文档 ID 便于排查多文档并存） */
function notifyBackground(payload) {
  chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_EVENT, docId: DOC_ID, ...payload }).catch(() => {});
}

/**
 * 通过 getUserMedia 以“标签页”为音频源获取流。
 * 兼容新旧两种约束写法：旧版需 mandatory 包裹，新版可直接传约束。
 */
async function getUserMediaTab(streamId) {
  const base = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { mandatory: base } });
  } catch (err) {
    // Edge 对 mandatory 旧写法支持差（常报 AbortError/TypeError），
    // 除「标签页已被捕获」类错误外一律切换新写法重试。
    if (!/already|captur/i.test(String(err.message))) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: base });
      } catch (err2) {
        console.error('[offscreen] getUserMedia 失败：', err2.name, '-', err2.message);
        throw err2;
      }
    }
    throw err;
  }
}

/* --------------------------- 各指令的处理函数 --------------------------- */

/**
 * background 请求：探测该标签页是否已有音频会话。
 * 若已存在则直接复用（popup 不再重复获取 streamId，避免“已被捕获”报错）。
 */
async function handleStart({ tabId }) {
  const existing = sessions.get(tabId);
  if (existing && existing.stream.active) {
    return { ok: true, alreadyActive: true };
  }
  // 会话残留但流已失效（ended 事件偶发延迟）：清理并让 popup 重新捕获，
  // 同时通知后台安排重捕兜底（避免标签页停留在被静音状态）。
  if (existing) {
    try { await existing.release(true); } catch { /* 忽略 */ }
    notifyBackground({ event: 'ended', tabId });
  }
  return { ok: false, needsCapture: true };
}

/**
 * background 请求：用 streamId 新建捕获会话（真正的“接管”）。
 * 仅在 popup 探测确认无会话后才调用。
 */
async function handleCapture({ tabId, streamId, volume }) {
  // 去重：同一标签页已有会话（例如 popup 反复打开）则直接复用
  const existing = sessions.get(tabId);
  if (existing) {
    existing.setVolume(volume);
    return { ok: true, alreadyActive: true };
  }

  // 用 streamId 换取标签页音频流
  let stream;
  try {
    stream = await getUserMediaTab(streamId);
  } catch (err) {
    // 竞态兜底：可能另一路 CAPTURE（如后台重捕）已抢先建立会话，
    // 此时 getUserMedia 会报 Invalid state / Cannot capture，直接复用已有会话避免报错。
    const reExisting = sessions.get(tabId);
    if (reExisting && reExisting.stream.active) {
      reExisting.setVolume(volume);
      return { ok: true, alreadyActive: true };
    }
    console.error('[offscreen] 捕获失败：tabId =', tabId, ', name =', err?.name, ', message =', err?.message);
    notifyBackground({ event: 'error', tabId, error: String(err?.message || err) });
    // 返回错误码，由 background 用 chrome.i18n 翻译成用户语言
    return { ok: false, error: `capture:${captureErrorCode(err)}` };
  }

  // 防止 AudioContext 被自动播放策略挂起
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch { /* 若仍失败则保持现状 */ }
  }

  const session = new TabAudioSession(tabId, stream);
  session.setVolume(volume);
  sessions.set(tabId, session);

  // 标签页静音由 background 完成（offscreen 中 chrome.tabCapture 不可用）
  notifyBackground({ event: 'started', tabId });
  return { ok: true };
}

/** background 请求：修改音量 */
async function handleSetVolume({ tabId, volume }) {
  const session = sessions.get(tabId);
  if (!session) return { ok: true, applied: false }; // 会话不存在（可能刚跳转），状态已由后台存好
  session.setVolume(volume);
  return { ok: true, applied: true };
}

/**
 * background 请求：在用户手势上下文中激活所有会话的音频输出。
 * 自动播放策略：无手势时 <audio> 元素 / AudioContext 输出会被抑制，
 * 用户点开扩展图标（手势）时调用本函数，让声音恢复。
 */
async function handleActivate() {
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch { /* 忽略 */ }
  }
  for (const session of sessions.values()) {
    if (session.audioEl) session.audioEl.play().catch(() => {});
  }
  return { ok: true };
}

/** background 请求：停止接管 */
async function handleStop({ tabId }) {
  const session = sessions.get(tabId);
  if (session) await session.release(); // 静音还原由 background 管理
  return { ok: true };
}

/* ------------------------------ 消息入口 ------------------------------ */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // 只处理发给离屏文档的指令；其余消息（如 popup → background）不占用响应通道
  if (!message?.type || !message.type.startsWith('offscreen:')) return false;

  const handler = {
    [MSG.OFFSCREEN_START]: handleStart,
    [MSG.OFFSCREEN_CAPTURE]: handleCapture,
    [MSG.OFFSCREEN_SET_VOLUME]: handleSetVolume,
    [MSG.OFFSCREEN_STOP]: handleStop,
    [MSG.OFFSCREEN_ACTIVATE]: handleActivate,
  }[message.type];
  if (!handler) return false;

  handler(message)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

/* ---------------------- 页面销毁时的尽力而为清理 ---------------------- */

/** 离屏文档被销毁（如浏览器退出）前：会话与音频资源直接清理（静音由 background 管理） */
self.addEventListener('pagehide', () => {
  sessions.clear();
  try { audioCtx.close(); } catch { /* 忽略 */ }
});
