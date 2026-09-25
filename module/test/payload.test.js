/*
 * Behavioural test for module/js/unlock_payload.js
 *
 * Re-creates the parts of the H5 page the payload touches (Vue app handle,
 * Pinia store, the earPhoneStore.setConfig shallow merge) and drives real
 * per-model data extracted from the APK, then asserts every gesture slot
 * ends up offering the full action set.
 *
 * Run:  node module/test/payload.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const F = require('./fixtures.js');

const PAYLOAD = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'unlock_payload.js'), 'utf8');

const OPTION_KEYS = [
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
  'is_volume_minus_ear_single_tap_options',
];

const ROW_FLAGS = [
  'is_left_ear_single_tap', 'is_left_ear_double_tap',
  'is_left_ear_triple_tap', 'is_left_ear_long_press',
  'is_right_ear_single_tap', 'is_right_ear_double_tap',
  'is_right_ear_triple_tap', 'is_right_ear_long_press',
  'is_ANC_ear_single_tap', 'is_ANC_ear_double_tap',
  'is_ANC_ear_triple_tap', 'is_ANC_ear_long_press',
];

const UNIVERSAL_CORE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11];
const MAGIC_CORE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

let failures = 0;
let checks = 0;

function ok(cond, msg) {
  checks++;
  if (!cond) {
    failures++;
    console.log('  FAIL  ' + msg);
  }
}

function eq(actual, expected, msg) {
  ok(JSON.stringify(actual) === JSON.stringify(expected),
    msg + ' (expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) + ')');
}

function types(list) {
  return list.map(function (o) { return o.type; });
}

// --------------------------------------------------------------------------
// environment
// --------------------------------------------------------------------------
function makeEnv(opts) {
  opts = opts || {};
  const logs = [];
  const timers = [];

  const store = {
    id: 'earPhoneStore',
    config: Object.assign({}, opts.defaults || F.DEFAULTS),
    // this mirrors the real action:
    //   setConfig(e) { this.config = Object.assign({}, this.config, e) }
    setConfig: function (e) {
      this.config = Object.assign({}, this.config, e);
    },
  };

  const pinia = { _s: new Map([['earPhoneStore', store]]) };
  const app = {
    config: {
      globalProperties: {
        $pinia: pinia,
        $t: function (key) { return 'T:' + key; },
      },
    },
    _context: { provides: {} },
  };

  const win = {};
  const el = { __vue_app__: app };
  const doc = {
    body: {},
    getElementById: function (id) { return id === 'app' ? el : null; },
    querySelectorAll: function () { return []; },
  };

  return {
    win: win,
    doc: doc,
    app: app,
    pinia: pinia,
    store: store,
    logs: logs,
    console: {
      log: function () { logs.push(Array.prototype.join.call(arguments, ' ')); },
      warn: function () { },
      error: function () { },
    },
    setInterval: function (fn) { timers.push(fn); return timers.length; },
    clearInterval: function () { },
    tick: function (n) { for (let i = 0; i < (n || 1); i++) timers.forEach(function (f) { f(); }); },
    fire: function () { timers.forEach(function (f) { f(); }); },
  };
}

function install(env) {
  const fn = new Function(
    'window', 'document', 'console', 'setInterval', 'clearInterval', PAYLOAD);
  fn(env.win, env.doc, env.console, env.setInterval, env.clearInterval);
}

function assertUnlocked(env, label, core, extra) {
  const cfg = env.store.config;
  const expected = core.concat(extra || []);
  OPTION_KEYS.forEach(function (key) {
    const list = cfg[key];
    ok(Array.isArray(list) && list.length > 0, label + ': ' + key + ' is a non-empty array');
    if (Array.isArray(list)) {
      eq(types(list), expected, label + ': ' + key + ' types');
      ok(list.every(function (o) {
        return o && typeof o.label === 'string' && o.label.length > 0;
      }), label + ': ' + key + ' every option has a label');
    }
  });
  ROW_FLAGS.forEach(function (flag) {
    ok(cfg[flag] === true, label + ': row flag ' + flag + ' forced true');
  });
}

// --------------------------------------------------------------------------
// 1. S5 - the model from the bug report (single tap left = none/play-pause only)
// --------------------------------------------------------------------------
console.log('\n[1] HiTune S5, payload runs BEFORE the config is fetched');
{
  const env = makeEnv();
  eq(types(env.store.config.is_left_ear_single_tap_options),
    types(F.DEFAULTS.is_left_ear_single_tap_options),
    'baseline: untouched store defaults (the state the page ships with)');
  install(env);
  env.store.setConfig(F.MODEL_S5);   // the model table arrives
  env.tick(2);
  console.log('  S5 left-single tap -> ' + types(env.store.config.is_left_ear_single_tap_options).join(','));
  assertUnlocked(env, 'S5', UNIVERSAL_CORE);
  ok(types(env.store.config.is_left_ear_single_tap_options).indexOf(2) >= 0,
    'S5: increase_volume is now offered on left single tap');
}

// --------------------------------------------------------------------------
// 2. S8 - already has volume on some slots, keep them and widen
// --------------------------------------------------------------------------
console.log('\n[2] HiTune S8');
{
  const env = makeEnv();
  install(env);
  env.store.setConfig(F.MODEL_S8);
  env.tick(2);
  console.log('  S8 left-single tap -> ' + types(env.store.config.is_left_ear_single_tap_options).join(','));
  // S8 is AI-capable (its triple-press list carries type 14)
  assertUnlocked(env, 'S8', UNIVERSAL_CORE, [12, 13, 14]);
}

// --------------------------------------------------------------------------
// 3. race: setConfig arrives AFTER the payload has already patched
//    (this is the normal order - the page fetches its config async)
// --------------------------------------------------------------------------
console.log('\n[3] race: setConfig re-issued later (model switch without reload)');
{
  const env = makeEnv();
  install(env);
  env.tick(3);                       // payload finds the store and patches it
  env.store.setConfig(F.MODEL_S5);   // ...then the real merge happens
  env.tick(1);
  assertUnlocked(env, 'S5 (late merge)', UNIVERSAL_CORE);

  // and again with another model on the same page instance
  env.store.setConfig(F.MODEL_S8);
  env.tick(1);
  assertUnlocked(env, 'S8 (second merge)', UNIVERSAL_CORE, [12, 13, 14]);
}

// --------------------------------------------------------------------------
// 4. magic protocol (Zhongke_Lanxun / protocol_type 2) uses its own numbering
// --------------------------------------------------------------------------
console.log('\n[4] magic protocol model (protocol_type = 2)');
{
  const magicModel = {
    device_name: 'UGREEN HiTune T6 Magic',
    protocol_type: 2,
    is_head_phones: false,
    is_ANC: false,
    is_left_ear_single_tap_options: [
      { label: F.Ue('earphone.control.none'), type: 0 },
      { label: F.Ue('earphone.control.play_pause'), type: 7 },
    ],
    is_right_ear_single_tap_options: [
      { label: F.Ue('earphone.control.none'), type: 0 },
      { label: F.Ue('earphone.control.play_pause'), type: 7 },
    ],
  };
  const env = makeEnv();
  install(env);
  env.store.setConfig(magicModel);
  env.tick(2);
  console.log('  magic left-single tap -> ' + types(env.store.config.is_left_ear_single_tap_options).join(','));
  assertUnlocked(env, 'magic', MAGIC_CORE);
  ok(env.store.config.protocol_type === 2, 'magic: protocol_type preserved');
}

// --------------------------------------------------------------------------
// 5. the store is not on the page yet (payload must keep retrying, not throw)
// --------------------------------------------------------------------------
console.log('\n[5] store appears late (payload already installed on the document)');
{
  const env = makeEnv();
  // simulate a page where #app has no __vue_app__ at first
  const saved = env.doc.getElementById;
  env.doc.getElementById = function () { return { }; };
  env.doc.querySelectorAll = function () { return []; };
  install(env);
  env.tick(3);                       // nothing found - must not blow up
  // ...now the page finishes mounting
  env.doc.getElementById = saved;
  env.tick(2);
  assertUnlocked(env, 'late store', UNIVERSAL_CORE);
}

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') +
  ' - ' + (checks - failures) + '/' + checks + ' checks ok');
process.exit(failures === 0 ? 0 : 1);
