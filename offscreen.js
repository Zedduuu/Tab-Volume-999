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

// 监听 AudioContext 状态变化（标签页切后台/窗口节流可能导致挂起）
audioCtx.onstatechange = () => {
  console.log('[offscreen] AudioContext 状态 →', audioCtx.state, ', currentTime =', audioCtx.currentTime.toFixed(2));
  if (audioCtx.state === 'suspended') {
    console.log('[offscreen] AudioContext 被挂起，尝试自动恢复');
    audioCtx.resume().catch((e) => console.error('[offscreen] resume 失败:', e?.message || e));
  }
};

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
    console.log('[offscreen] setVolume：tabId =', this.tabId, ', gain →', target);
  }

  /** 捕获流被系统中断（页面跳转等）时的回调 */
  handleStreamEnded() {
    console.warn('[offscreen] 流已 ended，tabId =', this.tabId);
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
      safeSetMuted(this.tabId, this.priorMuted);
    }
  }
}

/* ------------------------------ 工具函数 ------------------------------ */

/** i18n 取词简写：按用户偏好语言（async，返回 Promise） */
const t = (key, args) => I18N.getText(key, args);

/** 安全设置静音：callback 消费 lastError，避免“Unchecked runtime.lastError”；返回是否成功 */
function safeSetMuted(tabId, muted) {
  return new Promise((resolve) => {
    try {
      chrome.tabCapture.setMuted(tabId, muted, () => {
        if (chrome.runtime.lastError) {
          console.error('[offscreen] setMuted(', muted, ') 失败：tabId =', tabId, ', 原因 =', chrome.runtime.lastError.message);
          notifyBackground({ event: 'debug', tabId, msg: `setMuted(${muted}) 失败：${chrome.runtime.lastError.message}` });
          resolve(false);
        } else {
          console.log('[offscreen] setMuted(', muted, ') 成功：tabId =', tabId);
          resolve(true);
        }
      });
    } catch (e) {
      console.error('[offscreen] setMuted 同步异常：', e?.message || e);
      notifyBackground({ event: 'debug', tabId, msg: `setMuted 同步异常：${e?.message || e}` });
      resolve(false);
    }
  });
}

/** 安全读取静音状态：Promise 返回结果并消费 lastError */
function safeGetMuted(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabCapture.getMuted(tabId, (muted) => {
        void chrome.runtime.lastError;
        resolve(Boolean(muted));
      });
    } catch { resolve(false); }
  });
}

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
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: base } });
    console.log('[offscreen] getUserMedia(旧写法) 成功，tracks =', stream.getAudioTracks().length);
    return stream;
  } catch (err) {
    console.error('[offscreen] getUserMedia(旧写法) 失败:', err.name, '-', err.message);
    // 仅当失败源于约束写法本身（而非“标签页已被捕获”等）时，切换写法重试
    if (err.name === 'TypeError' || /constraint|mandatory|overconstrained/i.test(String(err.message))) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: base });
        console.log('[offscreen] getUserMedia(新写法) 成功，tracks =', stream.getAudioTracks().length);
        return stream;
      } catch (err2) {
        console.error('[offscreen] getUserMedia(新写法) 失败:', err2.name, '-', err2.message);
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

/** 把 getUserMedia 的错误翻译成用户可读的提示 */
async function friendlyCaptureError(err) {
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
    console.log('[offscreen] 复用已有会话，tabId =', tabId);
    return { ok: true, alreadyActive: true };
  }

  // 读取接管前的静音状态，以便停止时还原
  const priorMuted = await safeGetMuted(tabId);
  console.log('[offscreen] handleCapture 开始：tabId =', tabId, ', priorMuted =', priorMuted, ', volume =', volume);

  // 用 streamId 换取标签页音频流
  let stream;
  try {
    stream = await getUserMediaTab(streamId);
  } catch (err) {
    console.error('[offscreen] 捕获失败：tabId =', tabId, ', name =', err?.name, ', message =', err?.message);
    notifyBackground({ event: 'error', tabId, error: String(err?.message || err) });
    const friendly = await friendlyCaptureError(err);
    return { ok: false, error: await t('errCaptureFailed', [friendly]) };
  }
  // 调试上报：流是否真的有音频轨且 active
  notifyBackground({
    event: 'debug',
    tabId,
    msg: `getUserMedia 成功，audioTracks=${stream.getAudioTracks().length}, active=${stream.active}`,
  });

  // 防止 AudioContext 被自动播放策略挂起
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch { /* 若仍失败则保持现状 */ }
  }

  const session = new TabAudioSession(tabId, stream, priorMuted);
  session.setVolume(volume);
  sessions.set(tabId, session);

  // 静音原标签页，否则会同时听到原生声音 + 本扩展回放（双重声音）
  const mutedOk = await safeSetMuted(tabId, true);
  console.log('[offscreen] 会话创建成功：tabId =', tabId, ', 已静音原标签页');
  const verifyMuted = await safeGetMuted(tabId);
  console.log('[offscreen] 静音验证：tabId =', tabId, ', muted =', verifyMuted);
  notifyBackground({
    event: 'debug',
    tabId,
    msg: `会话建立，setMuted 结果=${mutedOk}, 静音验证 muted=${verifyMuted}, audioCtx.state=${audioCtx.state}`,
  });

  notifyBackground({ event: 'started', tabId });
  return { ok: true };
}

/** background 请求：修改音量 */
async function handleSetVolume({ tabId, volume }) {
  const session = sessions.get(tabId);
  if (!session) return { ok: true, applied: false }; // 会话不存在（可能刚跳转），状态已由后台存好
  session.setVolume(volume);
  console.log('[offscreen] handleSetVolume：tabId =', tabId, ', volume =', volume);
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
    // 关键：保持标签页静音，不要解除——offscreen 常被浏览器空闲回收，
    // 一旦解除静音，标签页就会漏出原生音量；后台会自动重建文档并恢复接管。
    safeSetMuted(session.tabId, true);
  }
  sessions.clear();
  try { audioCtx.close(); } catch { /* 忽略 */ }
});
