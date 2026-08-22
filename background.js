/* =========================================================================
 * background.js — Tab Volume 999 扩展的 Service Worker（后台主脚本）
 *
 * 职责：
 *   1. 消息路由：把 popup 的指令转发给离屏文档，把离屏文档的事件回传；
 *   2. 离屏文档生命周期：按需创建承载音频播放的 offscreen.html；
 *   3. 状态持久化：把每个标签页的音量写入 chrome.storage.local；
 *   4. 接管与释放：按需建立 / 主动释放音频接管；
 *   5. 断线重捕：页面刷新 / 跳转导致音频流中断后自动重新接管；
 *   6. 标签页清理：标签页关闭时释放捕获、解除静音。
 *
 * 消息协议（全部走 chrome.runtime.sendMessage，各端按 type 过滤）：
 *   popup → background      : { type:'start',       tabId }                  // 探测会话
 *                              { type:'capture',     tabId, streamId, volume } // 新建捕获
 *                              { type:'getStreamId', tabId }                  // 后台代取 streamId
 *                              { type:'stop',        tabId }                  // 释放接管
 *                              { type:'setVolume',   tabId, volume, muted }
 *   background → offscreen  : { type:'offscreen:start',      tabId }         // 探测
 *                              { type:'offscreen:capture',   tabId, streamId, volume }
 *                              { type:'offscreen:setVolume', tabId, volume }
 *                              { type:'offscreen:stop',      tabId }
 *   offscreen → background  : { type:'offscreen:event', event, tabId, error? }
 * ========================================================================= */

'use strict';

importScripts('i18n-util.js');

/* ------------------------------ 常量定义 ------------------------------ */

/** 消息类型（popup / background / offscreen 三端共享同一套命名） */
const MSG = {
  START: 'start',                      // popup → background：探测会话是否已存在
  CAPTURE: 'capture',                  // popup → background：用 streamId 新建捕获
  GET_STREAM_ID: 'getStreamId',        // popup → background：请求后台代为获取 streamId
  STOP: 'stop',                        // popup → background：释放接管
  SET_VOLUME: 'setVolume',             // popup → background：修改音量
  OFFSCREEN_START: 'offscreen:start',  // background → offscreen：探测
  OFFSCREEN_CAPTURE: 'offscreen:capture', // background → offscreen：新建捕获
  OFFSCREEN_SET_VOLUME: 'offscreen:setVolume',
  OFFSCREEN_STOP: 'offscreen:stop',
  OFFSCREEN_EVENT: 'offscreen:event',
};

/** 音量范围与默认值（0% ~ 999%，100% 为基准点） */
const VOLUME = { MIN: 0, MAX: 999, DEFAULT: 100 };

/** 会话数据在 chrome.storage.local 中的键 */
const STORAGE_KEY = 'tabVolumeSessions';

/** 离屏文档地址（承载实际发声的 AudioContext） */
const OFFSCREEN_URL = 'offscreen.html';

/** 页面跳转导致流中断后的重新捕获策略 */
const RECAPTURE = { DELAY_MS: 1500, MAX_ATTEMPTS: 3 };

/** 存放「重新捕获」定时器句柄：tabId -> setTimeout id */
const recaptureTimers = {};

/** 处于「等待标签页恢复播放」状态的 tabId（暂停/无音频导致自动重捕失败后进入） */
const waitingRecapture = new Set();

/** 等待恢复期间的兜底重试定时器：tabId -> setTimeout id（每 WAITING_RETRY_MS 尝试一轮） */
const recaptureRetryTimers = {};
const WAITING_RETRY_MS = 10000;

/** 进入「等待恢复」状态：标记 + 启动兜底定时重试（audible 快速路径失效时的保险） */
function enterWaiting(tabId) {
  waitingRecapture.add(tabId);
  clearTimeout(recaptureRetryTimers[tabId]);
  recaptureRetryTimers[tabId] = setTimeout(() => {
    delete recaptureRetryTimers[tabId];
    recaptureTab(tabId, 1);
  }, WAITING_RETRY_MS);
}

/** 退出「等待恢复」状态：移出集合 + 停掉兜底定时器 */
function stopWaiting(tabId) {
  waitingRecapture.delete(tabId);
  clearTimeout(recaptureRetryTimers[tabId]);
  delete recaptureRetryTimers[tabId];
}

/* ------------------------------ 工具函数 ------------------------------ */

/** i18n 取词简写：按用户偏好语言（async，返回 Promise） */
const t = (key, args) => I18N.getText(key, args);

/** 把音量夹紧到 0 ~ 200 并取整 */
function clampVolume(value) {
  const v = Math.round(Number(value));
  if (Number.isNaN(v)) return VOLUME.DEFAULT;
  return Math.min(VOLUME.MAX, Math.max(VOLUME.MIN, v));
}

/** 读取所有会话数据：{ [tabId]: { volume, muted, lastVolume } } */
async function loadSessions() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || {};
}

/** 读取某个标签页的会话状态（不存在时返回 null） */
async function loadSession(tabId) {
  const sessions = await loadSessions();
  return sessions[tabId] || null;
}

/** 删除某个标签页的会话状态并清除图标徽标 */
async function clearSession(tabId) {
  const sessions = await loadSessions();
  if (sessions[tabId]) {
    delete sessions[tabId];
    await chrome.storage.local.set({ [STORAGE_KEY]: sessions });
  }
  // 图标恢复为基础样式（无数字）
  await updateBadge(tabId, null);
}

/* ------------------- 动态图标徽标（数字直接绘制在图标上） ------------------- */

/**
 * 背景说明：Edge 对 chrome.action 徽标（badge）的“透明背景”支持不可靠——
 * 实测会渲染成纯白小条，且徽标内文字排版无法控制。
 * 因此改为：把音量数字用 canvas 直接绘制到扩展图标右下角（setIcon），
 * 数字无背景、颜色随音量区间变化、位置精确可控。
 */

/** 图标位图缓存：16 / 32 两档（工具栏实际渲染 16dp，高分屏用 32dp） */
let iconBitmaps = null;

async function getIconBitmaps() {
  if (iconBitmaps) return iconBitmaps;
  const map = {};
  for (const size of [16, 32]) {
    const resp = await fetch(chrome.runtime.getURL(`icons/icon${size}.png`));
    const blob = await resp.blob();
    map[size] = await createImageBitmap(blob);
  }
  iconBitmaps = map;
  return map;
}

/** 在图标右下角绘制数字（深色描边 + 彩色填充，数字尽量大、可占满图标宽度） */
function drawVolumeNumber(ctx, size, text, color) {
  const cy = size * 0.80; // 数字中心纵坐标：偏下
  let fontSize = size >= 32 ? 14 : 9; // 尽量大
  ctx.font = `bold ${fontSize}px "Segoe UI", Arial, sans-serif`;

  // 数字宽度最多占图标宽度的 92%；超宽时缩小字号（保证不出界）
  const maxWidth = size * 0.92;
  let textWidth = ctx.measureText(text).width;
  if (textWidth > maxWidth) {
    fontSize = Math.max(5, Math.floor((fontSize * maxWidth) / textWidth));
    ctx.font = `bold ${fontSize}px "Segoe UI", Arial, sans-serif`;
    textWidth = ctx.measureText(text).width;
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 水平位置：默认靠右下；若数字过宽则左移，保证不超出图标左右边界
  const cx = Math.min(size * 0.60, size - textWidth / 2 - 1);

  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, size * 0.10);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)'; // 深色描边
  ctx.strokeText(text, cx, cy);
  ctx.fillStyle = color; // 彩色填充
  ctx.fillText(text, cx, cy);
}

/** 基于基础图标生成 ImageData（可选叠加数字） */
async function buildIconImageData(overlay) {
  const bitmaps = await getIconBitmaps();
  const imageData = {};
  for (const size of [16, 32]) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmaps[size], 0, 0, size, size);
    if (overlay) drawVolumeNumber(ctx, size, overlay.text, overlay.color);
    imageData[size] = ctx.getImageData(0, 0, size, size);
  }
  return imageData;
}

/** 把文本绘制到图标右下角并应用 */
async function renderBadgeText(tabId, text, color) {
  const imageData = await buildIconImageData({ text, color });
  safeSetIcon(tabId, imageData);
}

/** 把标签页图标恢复为“无数字”基础样式 */
async function resetIcon(tabId) {
  const imageData = await buildIconImageData(null);
  safeSetIcon(tabId, imageData);
}

/** 徽标重绘去抖：滚轮连续调音量时合并为一次绘制 */
const badgeTimers = new Map();

/**
 * 更新某标签页的图标徽标。
 * @param {number} tabId
 * @param {object|null} state 会话状态（含 volume / muted）；null 表示清除徽标
 */
function updateBadge(tabId, state) {
  clearTimeout(badgeTimers.get(tabId));
  badgeTimers.set(tabId, setTimeout(() => {
    badgeTimers.delete(tabId);
    if (!state) {
      resetIcon(tabId);
      return;
    }
    const effective = state.muted ? 0 : state.volume;
    // 0/静音 = 红；1~100 = 绿；101~999 = 紫
    const color = effective === 0 ? '#ff453a' : effective <= 100 ? '#30d158' : '#bf5af2';
    renderBadgeText(tabId, String(effective), color);
  }, 80));
}

/**
 * 向离屏文档发送消息。
 * 离屏文档刚创建时可能尚未加载完成，因此带少量重试。
 */
async function sendToOffscreen(message, retries = 8, delayMs = 150) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/** 确保离屏文档存在（扩展全局最多允许创建一份） */
async function ensureOffscreenDocument() {
  // 新版浏览器可用 getContexts 查询；旧版无此 API 时直接尝试创建
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length > 0) return;
  } catch { /* 忽略，走直接创建 */ }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['AUDIO_PLAYBACK'],
      justification: await t('offscreenJustification'),
    });
  } catch (err) {
    // 并发创建时可能出现“已存在”，属正常，放行即可
    if (!/only a single|already|exist/i.test(String(err.message))) throw err;
  }
}

/** 安全设置静音：传 callback 消费 lastError，避免“Unchecked runtime.lastError”（兼容 callback / promise 两种实现） */
function safeSetMuted(tabId, muted) {
  try {
    chrome.tabCapture.setMuted(tabId, muted, () => void chrome.runtime.lastError);
  } catch { /* 同步异常忽略 */ }
}

/** 安全设置图标：callback 消费 lastError，避免“Unchecked runtime.lastError” */
function safeSetIcon(tabId, imageData) {
  try {
    chrome.action.setIcon({ tabId, imageData }, () => void chrome.runtime.lastError);
  } catch { /* 同步异常忽略 */ }
}

/** 安全设置徽标文本：callback 消费 lastError */
function safeSetBadgeText(tabId, text) {
  try {
    chrome.action.setBadgeText({ tabId, text }, () => void chrome.runtime.lastError);
  } catch { /* 同步异常忽略 */ }
}

/** 解除标签页静音（仅在确认是扩展静音时才调用） */
async function unmuteTab(tabId) {
  safeSetMuted(tabId, false);
}

/* --------------------------- 各消息的处理函数 --------------------------- */

/**
 * popup 请求：探测该标签页是否已有音频会话。
 * 关键点：不在此处获取 streamId —— 若标签页正被离屏文档接管，
 * 重复调用 getMediaStreamId 会失败，导致面板控件全部失效。
 */
async function handleStart({ tabId }) {
  if (typeof tabId !== 'number') return { ok: false, error: await t('errInvalidParams') };
  await ensureOffscreenDocument();
  const resp = await sendToOffscreen({ type: MSG.OFFSCREEN_START, tabId });
  if (resp?.alreadyActive) {
    // 会话已存在：恢复该标签页的徽标数字
    stopWaiting(tabId);
    const state = await loadSession(tabId);
    if (state) await updateBadge(tabId, state);
  }
  return resp;
}

/**
 * popup 请求：用 streamId 新建捕获。
 * 仅在 offscreen 探测后确认“无会话”时才由 popup 调用（保证携带用户手势）。
 */
async function handleCapture({ tabId, streamId, volume }) {
  if (typeof tabId !== 'number' || typeof streamId !== 'string') {
    return { ok: false, error: await t('errMissingParams') };
  }
  await ensureOffscreenDocument();
  const resp = await sendToOffscreen({
    type: MSG.OFFSCREEN_CAPTURE,
    tabId,
    streamId,
    volume: clampVolume(volume),
  });
  if (resp?.ok) {
    // 接管成功：显示该标签页的徽标数字
    stopWaiting(tabId);
    console.log('[bg] handleCapture 成功：tabId =', tabId);
    const state = await loadSession(tabId);
    if (state) await updateBadge(tabId, state);
  } else {
    console.warn('[bg] handleCapture 失败：tabId =', tabId, ', error =', resp?.error);
  }
  return resp;
}

/**
 * popup 请求：后台代为获取 streamId。
 * 当 popup 自身的 getMediaStreamId 因手势/上下文限制失败时作为兜底。
 */
async function handleGetStreamId({ tabId }) {
  if (typeof tabId !== 'number') return { ok: false, error: await t('errInvalidParams') };
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    return { ok: true, streamId };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * popup 请求：释放接管。
 * 停止捕获、还原标签页静音状态、清除音量设置与徽标，恢复原生播放（消除延迟）。
 */
async function handleStop({ tabId }) {
  if (typeof tabId !== 'number') return { ok: false, error: await t('errInvalidParams') };
  try {
    await sendToOffscreen({ type: MSG.OFFSCREEN_STOP, tabId });
  } catch { /* 离屏可能未运行 */ }
  await clearSession(tabId);
  return { ok: true };
}

/** popup 请求：修改音量（写入存储 + 转发离屏立即生效） */
async function handleSetVolume({ tabId, volume, muted }) {
  if (typeof tabId !== 'number') return { ok: false, error: await t('errInvalidParams') };

  // 1) 持久化：无论离屏是否在运行都先落盘，重捕/刷新时可据此恢复
  const sessions = await loadSessions();
  const prev = sessions[tabId] || { volume: VOLUME.DEFAULT, muted: false, lastVolume: VOLUME.DEFAULT };
  const next = { ...prev };

  if (typeof muted === 'boolean') {
    // 静音时记住当前非零音量；音量数值本身保留，方便取消静音后恢复
    if (muted && next.volume > 0) next.lastVolume = next.volume;
    next.muted = muted;
  }
  if (typeof volume === 'number') {
    next.volume = clampVolume(volume);
    if (next.volume > 0) next.lastVolume = next.volume;
  }

  sessions[tabId] = next;
  await chrome.storage.local.set({ [STORAGE_KEY]: sessions });
  await updateBadge(tabId, next);

  // 2) 转发给离屏文档立即生效（离屏未运行则静默忽略，状态已存好）
  try {
    await sendToOffscreen({
      type: MSG.OFFSCREEN_SET_VOLUME,
      tabId,
      volume: next.muted ? 0 : next.volume,
    });
  } catch { /* 无会话：稍后 start 时会用存储值初始化 */ }

  return { ok: true, state: next };
}

/** 离屏文档上报的事件（started / ended / error） */
async function handleOffscreenEvent({ tabId, event, error }) {
  console.log('[bg] offscreen 事件：', event, ', tabId =', tabId, error ? `, error = ${error}` : '');
  switch (event) {
    case 'ended':
      // 音频流被系统切断（页面刷新 / 跳转 / 关闭）→ 稍作延迟后尝试重新接管
      clearTimeout(recaptureTimers[tabId]);
      recaptureTimers[tabId] = setTimeout(() => recaptureTab(tabId, 1), RECAPTURE.DELAY_MS);
      break;
    case 'error':
      // 启动失败：图标右下角绘制红色感叹号
      clearTimeout(badgeTimers.get(tabId));
      badgeTimers.delete(tabId);
      renderBadgeText(tabId, '!', '#ff453a');
      break;
    default:
      break;
  }
  return { ok: true };
}

/* ------------------------ 重新接管（页面跳转后） ------------------------ */

/** 页面跳转后尝试重新捕获音频，最多尝试 MAX_ATTEMPTS 次 */
async function recaptureTab(tabId, attempt) {
  console.log('[bg] recaptureTab 开始：tabId =', tabId, ', attempt =', attempt);
  delete recaptureTimers[tabId];

  const state = await loadSession(tabId);
  if (!state) {
    // 没有已保存的音量设置：之前只是接管了默认音量，直接解除静音即可
    stopWaiting(tabId);
    await unmuteTab(tabId);
    return;
  }

  // 标签页可能已关闭
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    stopWaiting(tabId);
    await clearSession(tabId);
    return;
  }

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    console.log('[bg] getMediaStreamId 成功：tabId =', tabId, ', streamId 前 12 位 =', String(streamId).slice(0, 12));
    const resp = await sendToOffscreen({
      type: MSG.OFFSCREEN_CAPTURE,
      tabId,
      streamId,
      volume: state.muted ? 0 : state.volume,
    });
    console.log('[bg] offscreen 重捕结果：tabId =', tabId, ', ok =', resp?.ok, ', error =', resp?.error);
    if (!resp?.ok) throw new Error(resp?.error || (await t('errRecapture')));
    // 重捕成功：退出等待状态，恢复徽标
    stopWaiting(tabId);
    await updateBadge(tabId, state);
    console.log('[bg] 重捕成功：tabId =', tabId, ', volume =', state.volume);
  } catch (err) {
    console.warn('[bg] 重捕失败：tabId =', tabId, ', attempt =', attempt, ', error =', err?.message);
    if (attempt < RECAPTURE.MAX_ATTEMPTS) {
      recaptureTimers[tabId] = setTimeout(() => recaptureTab(tabId, attempt + 1), RECAPTURE.DELAY_MS);
    } else {
      // 多次失败：标签页多半已暂停/无音频，浏览器拒绝提供捕获流。
      // 解除静音恢复原生播放（暂停时本来无声，用户无感知），
      // 并进入「等待恢复」：audible 快速路径 + 兜底定时重试双保险，
      // 保证标签页一恢复出声，音量就自动回到用户设置值而不是永远停在原生。
      await unmuteTab(tabId);
      await updateBadge(tabId, null);
      console.warn('[bg] 进入等待恢复：tabId =', tabId);
      enterWaiting(tabId);
    }
  }
}

/* --------------------------- 标签页生命周期监听 --------------------------- */

/**
 * 标签页从「暂停/无声音」恢复播放（audible 变为 true）时，重新接管音量。
 * 解决场景：暂停视频 → tabCapture 流被浏览器终止 → 自动重捕失败进入等待；
 * 恢复播放时本监听触发重捕，音量回到用户设置值而不是原生音量。
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!waitingRecapture.has(tabId)) return;
  console.log('[bg] onUpdated 触发等待重捕：tabId =', tabId, ', audible =', changeInfo.audible, ', status =', changeInfo.status);
  // audible=true = 标签页开始出声；status=complete = 页面加载完成（导航场景兜底）
  if (changeInfo.audible === true || changeInfo.status === 'complete') {
    stopWaiting(tabId);
    recaptureTab(tabId, 1);
  }
});

/** 标签页关闭：停止接管 + 解除静音 + 清理状态 */
chrome.tabs.onRemoved.addListener((tabId) => {
  clearTimeout(recaptureTimers[tabId]);
  delete recaptureTimers[tabId];
  stopWaiting(tabId);
  sendToOffscreen({ type: MSG.OFFSCREEN_STOP, tabId }).catch(() => {});
  clearSession(tabId);
});

/* ------------------------------ 消息入口 ------------------------------ */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // 只处理本脚本负责的消息类型；其余消息不占用响应通道
  const handler = {
    [MSG.START]: handleStart,
    [MSG.CAPTURE]: handleCapture,
    [MSG.GET_STREAM_ID]: handleGetStreamId,
    [MSG.STOP]: handleStop,
    [MSG.SET_VOLUME]: handleSetVolume,
    [MSG.OFFSCREEN_EVENT]: handleOffscreenEvent,
  }[message?.type];
  if (!handler) return false;

  handler(message)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true; // 保持消息通道开放，等待异步结果
});

/* ------------------------- 浏览器重启后的安全清理 ------------------------- */

/** 浏览器重启后：离屏文档与捕获流已全部消失，把可能残留的静音标签页恢复原状 */
chrome.runtime.onStartup.addListener(async () => {
  const sessions = await loadSessions();
  const tabIds = Object.keys(sessions).map(Number);
  await chrome.storage.local.remove(STORAGE_KEY);
  for (const tabId of tabIds) {
    // 浏览器重启后旧标签页 ID 已全部失效：先确认标签页仍存在再处理，避免 No tab with id
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) continue;
    await unmuteTab(tabId);
    // 图标恢复为基础样式，并清掉旧版徽标文本残留
    await updateBadge(tabId, null);
    safeSetBadgeText(tabId, '');
  }
});
