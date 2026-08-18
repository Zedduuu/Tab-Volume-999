/* =========================================================================
 * popup.js — Tab Volume 999 弹窗脚本
 *
 * 交互：
 *   - 在面板任意位置滚动鼠标滚轮：±5%
 *   - 按住鼠标左键再滚：±20%（快速调节）
 *   - 滑块：0~999，100% 位于物理中心（滑块 0~1000，中点 = 100%）
 *   - −/＋ 按钮：±5%
 *   - ↺ 重置 100%  /  🔇 静音（静音会记住上次音量，取消后恢复）
 *
 * 数据流：本地状态 → chrome.storage.local（由后台持久化）→ background
 *         → offscreen 的 GainNode 立即生效。
 * ========================================================================= */

'use strict';

/* ------------------------------ 常量定义 ------------------------------ */

const MSG = {
  START: 'start',
  CAPTURE: 'capture',
  GET_STREAM_ID: 'getStreamId',
  STOP: 'stop',
  SET_VOLUME: 'setVolume',
  OFFSCREEN_EVENT: 'offscreen:event',
};

const STORAGE_KEY = 'tabVolumeSessions';

const VOLUME = { MIN: 0, MAX: 999, DEFAULT: 100, STEP: 5, FAST_STEP: 20 };

/** 圆弧总长度（2πr，r = 84），与 CSS 中的 stroke-dasharray 对应 */
const ARC_LENGTH = 2 * Math.PI * 84;

/** 当前标签页 ID、本地状态与“是否已释放接管”标记 */
let currentTabId = null;
let state = { volume: VOLUME.DEFAULT, muted: false, lastVolume: VOLUME.DEFAULT };
let sessionReleased = false; // true 表示本页已释放接管（恢复原生播放）

/* ------------------------------ DOM 引用 ------------------------------ */

const $ = (id) => document.getElementById(id);
const elValue = $('volume-value');
const elGauge = $('gauge-arc');
const elTag = $('volume-tag');
const elSlider = $('slider');
const elMute = $('btn-mute');
const elStatus = $('status');
const elDomain = $('tab-domain');

/* ------------------------------ 工具函数 ------------------------------ */

const clamp = (v) => Math.min(VOLUME.MAX, Math.max(VOLUME.MIN, Math.round(Number(v) || 0)));

/**
 * 滑块位置与音量互转（滑块 0~1000，物理中点 500 = 100%）：
 * 0~100 占滑块左半段（精细），100~999 占右半段。
 */
function volumeToSlider(volume) {
  return volume <= 100 ? volume * 5 : 500 + ((volume - 100) * 500) / 899;
}
function sliderToVolume(slider) {
  return slider <= 500
    ? Math.round(slider / 5)
    : Math.round(100 + ((slider - 500) * 899) / 500);
}

/** 环形仪表盘填充比例（0~1），以 100% 为中心：0~100 占半圈，100~999 占另半圈 */
function gaugeRatio(volume) {
  return volume <= 100 ? volume / 200 : 0.5 + (volume - 100) / 1798;
}

/**
 * 音量 → 主题色（主黑副白）：
 *   0 为深灰，1~99 为浅灰，100 为纯白，>100 为略带回蓝的冷白（暗示“增益中”）。
 */
function accentColor(volume) {
  if (volume <= 0) return '#4d4d50';
  if (volume < 100) return '#d4d4d6';
  if (volume === 100) return '#ffffff';
  return '#f2f6ff';
}

/* ------------------------------ 渲染函数 ------------------------------ */

/** 根据 state 刷新全部 UI */
function render() {
  const effective = state.muted ? 0 : state.volume;

  // 大数字 + 环形仪表盘（以 100% 为中心）
  elValue.textContent = String(effective);
  elGauge.style.strokeDashoffset = String(ARC_LENGTH * (1 - gaugeRatio(effective)));
  const color = accentColor(effective);
  elGauge.style.stroke = color;
  elGauge.style.filter = `drop-shadow(0 0 6px ${color}66)`;

  // 音量语义标签
  elTag.textContent = state.muted
    ? '已静音'
    : effective === 0 ? '音量归零'
    : effective < 100 ? '降低音量'
    : effective === 100 ? '正常音量'
    : '增益中 >100%';

  // 滑块（物理中心 = 100%）与静音按钮状态
  elSlider.value = String(volumeToSlider(effective));
  elSlider.style.accentColor = color;
  elMute.textContent = state.muted ? '🔊 恢复' : '🔇 静音';
  elMute.classList.toggle('muted', state.muted);
}

/** 更新底部状态栏（ok / error / warn / idle），失败时显示“重试”按钮 */
function setStatus(kind, text) {
  elStatus.className = `status status-${kind}`;
  elStatus.textContent = text;
  $('btn-retry').classList.toggle('hidden', kind !== 'error');
}

/** 显示一条短暂的 toast 提示 */
function showToast(text) {
  const toast = $('toast');
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.remove('show'), 1600);
}

/* --------------------------- 状态变更与同步 --------------------------- */

/**
 * 修改音量的统一入口。
 * 控件始终可操作（即使暂时接管失败，也会先把设置保存下来，
 * 会话建立或恢复时会自动套用）。
 * @param {object} opts - { volume?: number, muted?: boolean }
 */
function applyVolume({ volume, muted } = {}) {
  // 已释放接管时，任何调节操作都视为“重新接管”（异步建立会话）
  if (sessionReleased) {
    sessionReleased = false;
    $('btn-release').textContent = '⇤ 释放接管';
    $('btn-release').classList.remove('released');
    startCapture();
  }

  const next = { ...state };

  // 处理静音开关
  if (typeof muted === 'boolean') {
    if (muted) {
      next.lastVolume = next.volume > 0 ? next.volume : next.lastVolume; // 记住当前音量
    } else {
      next.volume = next.lastVolume > 0 ? next.lastVolume : VOLUME.DEFAULT; // 恢复上次音量
    }
    next.muted = muted;
  }

  // 处理音量数值
  if (typeof volume === 'number') {
    next.volume = clamp(volume);
    if (next.volume > 0) {
      next.lastVolume = next.volume;
      next.muted = false; // 调大音量时自动取消静音
    }
  }

  state = next;
  render();
  sync();
}

/** 状态同步节流：连续调节（滚轮/滑块）时合并为一次写入，避免高频存储与消息 */
let syncTimer = null;

/** 把状态写入 storage，并通知后台在离屏文档中生效（40ms 节流） */
function sync() {
  if (currentTabId == null) return; // 尚未初始化
  clearTimeout(syncTimer);
  syncTimer = setTimeout(doSync, 40);
}

async function doSync() {
  syncTimer = null;
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const sessions = data[STORAGE_KEY] || {};
    sessions[currentTabId] = state;
    await chrome.storage.local.set({ [STORAGE_KEY]: sessions });

    await chrome.runtime.sendMessage({
      type: MSG.SET_VOLUME,
      tabId: currentTabId,
      volume: state.volume,
      muted: state.muted,
    });
  } catch {
    // 扩展上下文可能已失效（如正在更新/卸载），静默忽略
  }
}

/* ------------------------------ 接管流程 ------------------------------ */

/** 初始化：获取当前标签页、读取已有状态、开始接管音频 */
async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.id !== 'number') throw new Error('无法获取当前标签页');
    currentTabId = tab.id;

    // 显示域名（activeTab 授权下可读取 url）
    try {
      const url = new URL(tab.url);
      elDomain.textContent = url.hostname || '当前标签页';
    } catch { elDomain.textContent = '当前标签页'; }

    // 读取该标签页已保存的音量设置
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const saved = data[STORAGE_KEY]?.[currentTabId];
    if (saved) {
      state = {
        volume: VOLUME.DEFAULT,
        muted: false,
        lastVolume: VOLUME.DEFAULT,
        ...saved,
      };
    }
    render();

    await startCapture();
  } catch (err) {
    setStatus('error', `出错了：${err.message}`);
  }
}

let isStarting = false; // 接管进行中锁：防止「重试」连点 / 释放后连调导致并发接管

/**
 * 建立音频接管：
 * 第一步先“探测”该标签页是否已有会话（避免对正在捕获的标签页重复
 * 获取 streamId 而失败）；确认无会话后，才在本弹窗（用户手势上下文）
 * 中获取 streamId 并完成捕获。
 */
async function startCapture() {
  if (isStarting) return;
  isStarting = true;
  setStatus('idle', '正在连接本页音频…');
  try {
    // 1) 探测：会话已存在则直接复用
    const probe = await chrome.runtime.sendMessage({ type: MSG.START, tabId: currentTabId });
    if (probe?.ok) {
      setStatus('ok', probe.alreadyActive ? '✓ 音频已接管' : '✓ 已接管本页音频');
      return;
    }
    // 探测失败且有明确原因（非“需要新建捕获”）时直接报错
    if (!probe?.needsCapture) {
      throw new Error(probe?.error || '连接失败');
    }

    // 2) 新建捕获：在本弹窗（用户手势上下文）中获取 streamId
    const streamId = await getMediaStreamIdWithRetry();
    const resp = await chrome.runtime.sendMessage({
      type: MSG.CAPTURE,
      tabId: currentTabId,
      streamId,
      volume: state.muted ? 0 : state.volume,
    });
    if (!resp?.ok) throw new Error(resp?.error || '接管失败');
    setStatus('ok', resp.alreadyActive ? '✓ 音频已接管' : '✓ 已接管本页音频');
  } catch (err) {
    setStatus('error', `无法接管音频：${err.message}`);
  } finally {
    isStarting = false;
  }
}

/**
 * 获取 streamId：先在本弹窗（用户手势上下文）尝试；
 * 失败则稍等后改由后台代为获取，覆盖不同版本浏览器的差异。
 */
async function getMediaStreamIdWithRetry() {
  try {
    return await chrome.tabCapture.getMediaStreamId({ targetTabId: currentTabId });
  } catch (err) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const resp = await chrome.runtime.sendMessage({
      type: MSG.GET_STREAM_ID,
      tabId: currentTabId,
    });
    if (resp?.ok) return resp.streamId;
    throw new Error(resp?.error || '无法获取音频流');
  }
}

/* ------------------------------ 事件绑定 ------------------------------ */

/** 鼠标左键按住状态：按住左键 + 滚轮 = 快速调节（±20%） */
let leftButtonDown = false;
document.addEventListener('mousedown', (e) => {
  if (e.button === 0) leftButtonDown = true;
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) leftButtonDown = false;
});
// 光标离开面板 / 面板失焦时重置，避免状态残留
document.addEventListener('mouseleave', () => { leftButtonDown = false; });
window.addEventListener('blur', () => { leftButtonDown = false; });

/** 滚轮：面板任意位置 ±5%；按住鼠标左键时 ±20%。
 * 说明面板是覆盖层、不占用布局，因此滚轮始终只负责调音量。 */
document.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const step = leftButtonDown ? VOLUME.FAST_STEP : VOLUME.STEP;
    applyVolume({ volume: state.volume + (e.deltaY < 0 ? step : -step) });
  },
  { passive: false }
);

/** 滑块 */
elSlider.addEventListener('input', () => {
  applyVolume({ volume: sliderToVolume(Number(elSlider.value)) });
});

/** − / ＋ 按钮：±5% */
$('btn-minus').addEventListener('click', () => {
  applyVolume({ volume: state.volume - VOLUME.STEP });
});
$('btn-plus').addEventListener('click', () => {
  applyVolume({ volume: state.volume + VOLUME.STEP });
});

/** 重置 100% */
$('btn-reset').addEventListener('click', () => {
  applyVolume({ volume: VOLUME.DEFAULT });
  showToast('已重置为 100%');
});

/** 静音 / 恢复 */
$('btn-mute').addEventListener('click', () => {
  applyVolume({ muted: !state.muted });
  showToast(state.muted ? '已静音' : '已恢复声音');
});

/** 接管失败后的手动重试 */
$('btn-retry').addEventListener('click', () => {
  startCapture();
});

/**
 * 左侧说明面板：展开 / 收起。
 * 展开时整个弹窗加宽（340px → 680px），说明面板从最左侧“长出”，
 * 主面板完整右移、不被遮挡；滚轮始终只用于调音量。
 */
$('btn-info').addEventListener('click', () => {
  document.body.classList.toggle('info-open');
});
$('btn-info-close').addEventListener('click', () => {
  document.body.classList.remove('info-open');
});

/**
 * 释放接管 / 重新接管：
 * - 已接管时点击 → 停止捕获、解除静音、清除设置，恢复原生播放（消除延迟）；
 * - 已释放时点击 → 重新建立接管。
 */
$('btn-release').addEventListener('click', () => {
  if (sessionReleased) {
    // 重新接管
    sessionReleased = false;
    $('btn-release').textContent = '⇤ 释放接管';
    $('btn-release').classList.remove('released');
    startCapture();
    return;
  }
  // 释放接管
  sessionReleased = true;
  chrome.runtime.sendMessage({ type: MSG.STOP, tabId: currentTabId }).catch(() => {});
  state = { volume: VOLUME.DEFAULT, muted: false, lastVolume: VOLUME.DEFAULT };
  render();
  setStatus('ok', '✓ 已释放接管，恢复原生播放');
  $('btn-release').textContent = '重新接管';
  $('btn-release').classList.add('released');
  showToast('已释放本页接管');
});

/** 被动监听后台广播：页面跳转导致流中断时给出提示（不占用响应通道） */
chrome.runtime.onMessage.addListener((message) => {
  if (
    message?.type === MSG.OFFSCREEN_EVENT &&
    message.event === 'ended' &&
    message.tabId === currentTabId
  ) {
    setStatus('warn', '页面跳转，正在自动重新接管…');
  }
  return false;
});

/* ------------------------------ 启动 ------------------------------ */

// 脚本位于 body 末尾，正常情况下监听 DOMContentLoaded 即可；
// 加上 readyState 判断，避免极端情况下（已加载完成）错过事件
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
