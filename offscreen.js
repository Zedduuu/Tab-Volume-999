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
  OFFSCREEN_EVENT: 'offscreen:event',
};

const VOLUME = { MIN: 0, MAX: 999, DEFAULT: 100 };

/** 全局共享的 AudioContext：所有标签页会话共用，比每会话一个更省电 */
const audioCtx = new AudioContext();

/** 正在播放中的会话表：tabId -> TabAudioSession */
const sessions = new Map();

/* --------------------------- 单个标签页的会话 --------------------------- */

class TabAudioSession {
  /**
   * @param {number}      tabId       目标标签页 ID
   * @param {MediaStream} stream      经 tabCapture 获取的该标签页音频流
   * @param {boolean}     priorMuted  接管前标签页是否已被静音（用于停止时还原）
   */
  constructor(tabId, stream, priorMuted) {
    this.tabId = tabId;
    this.stream = stream;
    this.priorMuted = priorMuted;

    // 信号链：音频流 → 增益节点 → 系统扬声器
    this.gainNode = audioCtx.createGain();
    this.gainNode.connect(audioCtx.destination);

    this.sourceNode = audioCtx.createMediaStreamSource(stream);
    this.sourceNode.connect(this.gainNode);

    // 页面刷新 / 跳转 / 标签页关闭时，浏览器会结束该捕获流
    this.endedHandler = () => this.handleStreamEnded();
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', this.endedHandler);
    }
    stream.addEventListener('inactive', this.endedHandler);
  }

  /**
   * 平滑地设置增益（0 = 静音，1 = 100%，9.99 = 999%）。
   * 用指数逼近曲线而非直接赋值，避免音量突变产生“咔哒”爆音。
   */
  setVolume(volume) {
    const target = Math.min(VOLUME.MAX, Math.max(VOLUME.MIN, volume)) / 100;
    this.gainNode.gain.setTargetAtTime(target, audioCtx.currentTime, 0.02);
  }

  /** 捕获流被系统中断（页面跳转等）时的回调 */
  handleStreamEnded() {
    this.release(true); // 保持标签页静音：新页面可能马上要重新接管
    notifyBackground({ event: 'ended', tabId: this.tabId });
  }

  /**
   * 释放本会话。
   * @param {boolean} keepMuted true  = 保留标签页静音（页面跳转待重捕）
   *                            false = 解除静音（停止接管 / 标签页关闭）
   */
  async release(keepMuted = false) {
    this.sourceNode.disconnect();
    this.gainNode.disconnect();
    for (const track of this.stream.getTracks()) {
      track.removeEventListener('ended', this.endedHandler);
      track.stop();
    }
    this.stream.removeEventListener('inactive', this.endedHandler);
    sessions.delete(this.tabId);

    if (!keepMuted) {
      // 还原到接管前的静音状态（避免把用户手动静音的标签页误开启）
      try { await chrome.tabCapture.setMuted(this.tabId, this.priorMuted); } catch { /* 忽略 */ }
    }
  }
}

/* ------------------------------ 工具函数 ------------------------------ */

/** i18n 取词简写 */
const t = (key, ...args) => chrome.i18n.getMessage(key, args);

/** 向 background 广播事件（fire-and-forget，不占用响应通道） */
function notifyBackground(payload) {
  chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_EVENT, ...payload }).catch(() => {});
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
    // 仅当失败源于约束写法本身（而非“标签页已被捕获”等）时，切换写法重试
    if (err.name === 'TypeError' || /constraint|mandatory|overconstrained/i.test(String(err.message))) {
      return navigator.mediaDevices.getUserMedia({ audio: base });
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

/** 把 getUserMedia 的错误翻译成用户可读的提示 */
function friendlyCaptureError(err) {
  const m = String(err?.message || '');
  const name = String(err?.name || '');
  if (/already|captur/i.test(m)) return t('errAlreadyCaptured');
  if (name === 'NotAllowedError') return t('errNotAllowed');
  if (name === 'NotSupportedError' || /constraint/i.test(m)) {
    return t('errNotSupported');
  }
  return `${name}: ${m}`;
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

  // 读取接管前的静音状态，以便停止时还原
  let priorMuted = false;
  try { priorMuted = await chrome.tabCapture.getMuted(tabId); } catch { /* 忽略 */ }

  // 用 streamId 换取标签页音频流
  let stream;
  try {
    stream = await getUserMediaTab(streamId);
  } catch (err) {
    notifyBackground({ event: 'error', tabId, error: String(err?.message || err) });
    return { ok: false, error: t('errCaptureFailed', [friendlyCaptureError(err)]) };
  }

  // 防止 AudioContext 被自动播放策略挂起
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch { /* 若仍失败则保持现状 */ }
  }

  const session = new TabAudioSession(tabId, stream, priorMuted);
  session.setVolume(volume);
  sessions.set(tabId, session);

  // 静音原标签页，否则会同时听到原生声音 + 本扩展回放（双重声音）
  try { await chrome.tabCapture.setMuted(tabId, true); } catch { /* 忽略 */ }

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

/** background 请求：停止接管 */
async function handleStop({ tabId }) {
  const session = sessions.get(tabId);
  if (session) await session.release(false); // 还原静音状态
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
  }[message.type];
  if (!handler) return false;

  handler(message)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

/* ---------------------- 页面销毁时的尽力而为清理 ---------------------- */

/** 离屏文档被销毁（如浏览器退出）前，尽量解除各标签页静音 */
self.addEventListener('pagehide', () => {
  for (const session of sessions.values()) {
    try { chrome.tabCapture.setMuted(session.tabId, session.priorMuted); } catch { /* 忽略 */ }
  }
  sessions.clear();
  try { audioCtx.close(); } catch { /* 忽略 */ }
});
