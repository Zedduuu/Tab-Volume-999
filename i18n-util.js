/* =========================================================================
 * i18n-util.js — 可手动切换语言的 i18n 运行时（四语言：zh_CN / en / ja / ko）
 *
 * 为什么需要：chrome.i18n 只跟随浏览器语言、无法运行时切换。本文件自建
 * 轻量语言包加载（fetch _locales/<lang>/messages.json）与取词，供
 * background（importScripts）、offscreen（<script>）、popup（<script>）共用。
 *
 * 全局导出：I18N
 * ========================================================================= */
'use strict';

(function (global) {
  /** 支持的语言（目录名）与默认语言 */
  const SUPPORTED = ['zh_CN', 'en', 'ja', 'ko'];
  const DEFAULT = 'zh_CN';

  /** 语言自名（语言切换菜单里用，无需翻译） */
  const LANG_NAMES = {
    zh_CN: '简体中文',
    en: 'English',
    ja: '日本語',
    ko: '한국어',
  };

  /** 语言 → <html lang> 值 */
  const HTML_LANGS = { zh_CN: 'zh-CN', en: 'en', ja: 'ja', ko: 'ko' };

  /** 用户手动选择语言时写入 storage.local 的键 */
  const STORAGE_KEY = 'preferredLocale';

  /** 语言包内存缓存：lang -> messages object */
  const cache = {};

  /**
   * 把浏览器语言（如 zh-CN / en-US / ja / ko-KR）归一化到扩展语言。
   * 未知语言回退到默认（zh_CN）。
   */
  function normalizeLocale(raw) {
    if (!raw) return DEFAULT;
    const base = String(raw).replace(/_/g, '-').toLowerCase().split('-')[0];
    if (base === 'zh') return 'zh_CN';
    if (base === 'en') return 'en';
    if (base === 'ja') return 'ja';
    if (base === 'ko') return 'ko';
    return DEFAULT;
  }

  /** 读取用户偏好的语言（未设置时按浏览器语言推导） */
  async function getPreferredLocale() {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      const saved = data[STORAGE_KEY];
      if (SUPPORTED.includes(saved)) return saved;
    } catch { /* storage 不可用时走浏览器语言 */ }
    return normalizeLocale(chrome.i18n.getUILanguage());
  }

  /** 保存用户偏好的语言 */
  async function setPreferredLocale(lang) {
    if (!SUPPORTED.includes(lang)) lang = DEFAULT;
    await chrome.storage.local.set({ [STORAGE_KEY]: lang });
    return lang;
  }

  /** 加载某个语言的语言包（带缓存），失败时回退默认语言 */
  async function loadMessages(lang) {
    if (cache[lang]) return cache[lang];
    try {
      const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`load ${lang} failed: ${resp.status}`);
      cache[lang] = await resp.json();
      return cache[lang];
    } catch {
      if (lang !== DEFAULT) return loadMessages(DEFAULT);
      return {};
    }
  }

  /** 替换 message 中的 $1 / $2 … 占位符 */
  function format(message, args) {
    if (!args || !args.length) return message;
    return String(message).replace(/\$(\d+)/g, (_, n) => {
      const idx = Number(n) - 1;
      return idx < args.length ? String(args[idx]) : '';
    });
  }

  /** 异步取词（background / offscreen 用）：按用户偏好语言，逐级回退 */
  async function getText(key, args) {
    const lang = await getPreferredLocale();
    const messages = await loadMessages(lang);
    const m = messages[key];
    if (m && typeof m.message === 'string') return format(m.message, args);
    const fb = chrome.i18n.getMessage(key, args);
    return fb || key;
  }

  global.I18N = {
    SUPPORTED,
    DEFAULT,
    LANG_NAMES,
    HTML_LANGS,
    normalizeLocale,
    getPreferredLocale,
    setPreferredLocale,
    loadMessages,
    format,
    getText,
  };
})(typeof self !== 'undefined' ? self : this);
