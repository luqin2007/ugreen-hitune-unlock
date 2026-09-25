/*
 * UGREEN HiTune Unlock — injected WebView payload
 * ------------------------------------------------------------------
 * Injected into the "device detail" H5 page of com.ugreen.iot
 * (file:///android_asset/static/device/index.html).
 *
 * Background
 *   The page keeps the whole per-model capability table inside the
 *   bundled chunk assets/index-*.js (an axios-mock-adapter answers
 *   POST /earbuds/device_info straight from a local table; no network).
 *   On boot the page calls  earPhoneStore.setConfig(device_info),
 *   which shallow-merges the *reduced* per-model option lists over the
 *   store defaults -- that merge is the only thing gating the UI.
 *
 *   e.g. UGREEN HiTune S5 -> is_left_ear_single_tap_options = [none, play_pause]
 *        UGREEN HiTune S8 -> (key absent) -> defaults to [none, play_pause, vol+, vol-]
 *
 * What this does
 *   1) hooks earPhoneStore.setConfig so every future merge keeps the full
 *      option list, and
 *   2) overwrites the live config's option lists with the full set, and
 *   3) forces the 12 row-visibility flags on.
 *
 * The page renders whatever is in those arrays, so every gesture
 * (single / double / triple / long press, per ear and per button) then
 * offers every action the protocol understands.
 *
 * Note: whether the earbud *firmware* honours a given action is a
 * separate question -- this only removes the app-side restriction.
 * The wire format is a fixed 8-byte payload
 * [leftSingle, leftDouble, leftTriple, leftLong,
 *  rightSingle, rightDouble, rightTriple, rightLong]
 * so all slots are always transmitted; the app just never let you pick.
 */
(function () {
  'use strict';

  var FLAG = '__UG_HITUNE_UNLOCK_V1__';
  if (window[FLAG]) return;
  window[FLAG] = true;

  var TAG = '[UGUnlock] ';

  // ---- status channel -----------------------------------------------
  // console.log does NOT reach logcat in this app (the WebView does not
  // enable chromium console logging), so the same information is also kept
  // in a ring buffer and exposed through a global. The Java side reads it
  // back as the return value of evaluateJavascript, which makes the payload
  // observable without any WebView debug setup.
  var LOGBUF = [];

  function log() {
    try {
      LOGBUF.push(Array.prototype.slice.call(arguments).join(' '));
      if (LOGBUF.length > 60) LOGBUF.shift();
      console.log.apply(console, [TAG].concat(Array.prototype.slice.call(arguments)));
    } catch (e) { /* ignore */ }
  }

  // Deliberately re-runs apply(): it is idempotent, so this doubles as a
  // "is everything still unlocked?" check.
  window.__UG_UNLOCK_STATUS__ = function () {
    var hasStore = false;
    var ok = false;
    var sig = '-';
    var proto = '-';
    var hooked = false;
    try {
      var st = findStore();
      hasStore = !!st;
      if (st) {
        hooked = !!st.__ugUnlockHooked;
        if (st.config) {
          proto = (st.config.protocol_type === undefined) ? '-' : st.config.protocol_type;
          ok = !!apply();
          sig = signature(buildFull(st.config)) || '-';
        }
      }
    } catch (e) {
      return 'ERR ' + e;
    }
    return 'flag=1 store=' + (hasStore ? 1 : 0)
      + ' hooked=' + (hooked ? 1 : 0)
      + ' ok=' + (ok ? 1 : 0)
      + ' proto=' + proto
      + ' sig=' + sig
      + ' diag=' + DIAG
      + ' log=' + LOGBUF.slice(-6).join(' | ');
  };

  // ---- action type tables -------------------------------------------
  // UNIVERSAL (UGREEN_Universal, protocol_type == 1) numbering
  var UNIV_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11];
  var UNIV_LABEL = {
    0: 'none', 1: 'play_pause', 2: 'increase_volume', 3: 'decrease_volume',
    4: 'next_track', 5: 'previous_track', 6: 'voice_assistant',
    7: 'game_mode_music_mode', 8: 'noise_control1', 9: 'answer_hang_up',
    11: 'spatial_audio_music_mode',
    12: 'AI_dialogue', 13: 'AI_chat', 14: 'AI_recording'
  };

  // MAGIC (Zhongke_Lanxun / BlueTrum, protocol_type == 2) numbering
  var MAGIC_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  var MAGIC_LABEL = {
    0: 'none', 1: null, 2: 'voice_assistant', 3: 'previous_track',
    4: 'next_track', 5: 'increase_volume', 6: 'decrease_volume',
    7: 'play_pause', 8: 'game_mode', 9: 'noise_control1',
    12: 'AI_dialogue', 13: 'AI_chat', 14: 'AI_recording'
  };
  // the page itself hardcodes this one (see MAPPINGMAGIC)
  var MAGIC_LITERAL = { 1: '回拨电话' };

  var AI_ORDER = [12, 13, 14];

  var OPTION_KEYS = [
    'is_left_ear_single_tap_options',
    'is_left_ear_single_double_options',
    'is_left_ear_single_triple_options',
    'is_left_ear_single_long_options',
    'is_right_ear_single_tap_options',
    'is_right_ear_single_double_options',
    'is_right_ear_single_triple_options',
    'is_right_ear_single_long_options',
    'is_ANC_ear_single_tap_options',
    'is_ANC_ear_single_double_options',
    'is_ANC_ear_single_triple_options',
    'is_ANC_ear_single_long_options',
    'is_volume_add_ear_single_tap_options',
    'is_volume_minus_ear_single_tap_options'
  ];

  var ROW_FLAGS = [
    'is_left_ear_single_tap', 'is_left_ear_double_tap',
    'is_left_ear_triple_tap', 'is_left_ear_long_press',
    'is_right_ear_single_tap', 'is_right_ear_double_tap',
    'is_right_ear_triple_tap', 'is_right_ear_long_press',
    'is_ANC_ear_single_tap', 'is_ANC_ear_double_tap',
    'is_ANC_ear_triple_tap', 'is_ANC_ear_long_press'
  ];

  // ---- Vue / Pinia discovery ----------------------------------------
  var _app = null, _pinia = null, _store = null;
  var DIAG = '';

  function findApp() {
    if (_app) return _app;
    try {
      var el = document.getElementById('app') || document.body;
      if (el && el.__vue_app__) {
        _app = el.__vue_app__;
        return _app;
      }
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        if (all[i].__vue_app__) {
          _app = all[i].__vue_app__;
          return _app;
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function findPinia() {
    if (_pinia) return _pinia;
    var app = findApp();
    if (!app) return null;
    try {
      var gp = app.config && app.config.globalProperties;
      if (gp && gp.$pinia) {
        _pinia = gp.$pinia;
        return _pinia;
      }
    } catch (e) { /* ignore */ }
    try {
      var prov = app._context && app._context.provides;
      if (prov) {
        var syms = Object.getOwnPropertySymbols(prov);
        for (var i = 0; i < syms.length; i++) {
          var v = prov[syms[i]];
          if (v && v._s && typeof v._s.get === 'function') {
            _pinia = v;
            return _pinia;
          }
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function findStore() {
    if (_store && _store.config) return _store;
    var pinia = findPinia();
    if (!pinia) {
      DIAG = 'noPinia(app=' + (findApp() ? 1 : 0) + ')';
      return null;
    }
    if (!pinia._s) {
      DIAG = 'pinia-no-_s';
      return null;
    }
    var s = null;
    try {
      s = pinia._s.get('earPhoneStore');
    } catch (e) { /* ignore */ }
    if (!s || !s.config) {
      s = null;
      try {
        var names = [];
        pinia._s.forEach(function (st, key) {
          names.push(key);
          if (!s && st && st.config &&
              typeof st.config.is_left_ear_single_tap_options !== 'undefined') {
            s = st;
          }
        });
        DIAG = 'stores[' + names.join(',') + ']';
      } catch (e) { DIAG = 'scanErr:' + e; }
    }
    if (s && s.config) _store = s;
    return _store;
  }

  function translate(key) {
    if (!key) return null;
    try {
      var app = findApp();
      var gp = app && app.config && app.config.globalProperties;
      if (gp && typeof gp.$t === 'function') {
        var v = gp.$t('earphone.control.' + key);
        if (typeof v === 'string' && v && v.indexOf('earphone.control.') !== 0) return v;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // ---- build the full option list -----------------------------------
  function harvestLabels(cfg) {
    var pool = {};
    var keys = Object.keys(cfg);
    for (var i = 0; i < keys.length; i++) {
      if (!/options$/.test(keys[i])) continue;
      var arr = cfg[keys[i]];
      if (!Array.isArray(arr)) continue;
      for (var j = 0; j < arr.length; j++) {
        var o = arr[j];
        if (o && typeof o.type === 'number' && pool[o.type] === undefined &&
            typeof o.label === 'string' && o.label) {
          pool[o.type] = o.label;
        }
      }
    }
    return pool;
  }

  function buildFull(cfg) {
    var magic = cfg.protocol_type === 2;
    var pool = harvestLabels(cfg);
    var order = (magic ? MAGIC_ORDER : UNIV_ORDER).slice();
    var labelMap = magic ? MAGIC_LABEL : UNIV_LABEL;

    var hasAi = false;
    for (var i = 0; i < OPTION_KEYS.length; i++) {
      var arr = cfg[OPTION_KEYS[i]];
      if (!Array.isArray(arr)) continue;
      for (var j = 0; j < arr.length; j++) {
        var ty = arr[j] && arr[j].type;
        if (ty === 12 || ty === 13 || ty === 14) hasAi = true;
      }
    }
    if (hasAi) order = order.concat(AI_ORDER);

    var out = [];
    for (var n = 0; n < order.length; n++) {
      var type = order[n];
      var label = null;
      if (magic) {
        // magic numbering is incompatible with the universal defaults that
        // refreshLanguage() writes, so translate by key first
        label = translate(labelMap[type]);
        if (!label && MAGIC_LITERAL[type]) label = MAGIC_LITERAL[type];
        if (!label && pool[type] !== undefined) label = pool[type];
      } else {
        label = pool[type] !== undefined ? pool[type] : translate(labelMap[type]);
      }
      if (!label) label = labelMap[type] ? labelMap[type] : String(type);
      out.push({ label: label, type: type });
    }
    return out;
  }

  function signature(arr) {
    if (!Array.isArray(arr)) return '';
    var s = [];
    for (var i = 0; i < arr.length; i++) s.push(arr[i] && arr[i].type);
    return s.join(',');
  }

  function clone(arr) {
    var out = [];
    for (var i = 0; i < arr.length; i++) out.push({ label: arr[i].label, type: arr[i].type });
    return out;
  }

  function stampInto(target, full) {
    for (var i = 0; i < OPTION_KEYS.length; i++) target[OPTION_KEYS[i]] = clone(full);
    for (var j = 0; j < ROW_FLAGS.length; j++) target[ROW_FLAGS[j]] = true;
  }

  // ---- apply --------------------------------------------------------
  function apply() {
    var store = findStore();
    if (!store) return false;
    var cfg = store.config;
    if (!cfg) return false;

    // (1) one-time: keep the full lists across every future setConfig()
    if (!store.__ugUnlockHooked) {
      var orig = store.setConfig;
      if (typeof orig === 'function') {
        try {
          store.setConfig = function (incoming) {
            try {
              if (incoming && typeof incoming === 'object') {
                var merged = {};
                var base = (this && this.config) || cfg;
                var k;
                for (k in base) {
                  if (Object.prototype.hasOwnProperty.call(base, k) && !isFn(base[k])) merged[k] = base[k];
                }
                for (k in incoming) {
                  if (Object.prototype.hasOwnProperty.call(incoming, k)) merged[k] = incoming[k];
                }
                stampInto(incoming, buildFull(merged));
              }
            } catch (err) {
              log('setConfig pre-patch failed', err);
            }
            return orig.apply(this, arguments);
          };
          store.__ugUnlockHooked = true;
          log('setConfig hooked');
        } catch (e) { log('cannot hook setConfig', e); }
      }
    }

    // (2) fix whatever config is live right now
    var full, sig;
    try {
      full = buildFull(cfg);
      sig = signature(full);
    } catch (e2) {
      log('buildFull failed', e2);
      return false;
    }
    if (!full || !full.length) return false;

    var changed = false;
    for (var a = 0; a < OPTION_KEYS.length; a++) {
      var key = OPTION_KEYS[a];
      if (signature(cfg[key]) !== sig) {
        cfg[key] = clone(full);
        changed = true;
      }
    }
    for (var b = 0; b < ROW_FLAGS.length; b++) {
      if (cfg[ROW_FLAGS[b]] !== true) {
        cfg[ROW_FLAGS[b]] = true;
        changed = true;
      }
    }
    if (changed) {
      log('unlocked ' + (cfg.protocol_type === 2 ? 'MAGIC' : 'UNIVERSAL') + ' -> ' + sig);
    }
    return true;
  }

  function isFn(v) {
    return typeof v === 'function';
  }

  // ---- retry loop ---------------------------------------------------
  // The page mounts and fetches its config asynchronously, so keep poking
  // until the store shows up (and re-assert for a while afterwards).
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    var ok = false;
    try { ok = apply(); } catch (e) { log('loop error', e); }
    if (tries > 1200) {
      clearInterval(timer);
      log('stopped after ' + tries + ' tries (ok=' + ok + ')');
    }
  }, 500);

  try { apply(); } catch (e) { /* ignore */ }

  window.__UG_UNLOCK_APPLY__ = apply;
})();
