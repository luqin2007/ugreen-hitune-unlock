# HiTune 操控解锁 — 绿联耳机 LSPosed 模块

解锁绿联 App（`com.ugreen.iot`）里耳机的**操控自定义**：让每个手势都能选到 App 支持的全部功能，而不是被机型预设挡掉。

> **交付物**：`dist/HiTuneUnlock-1.0.apk` —— RSA-4096 正式签名，可直接安装
> **状态**：已在 HiTune S5 + LSPosed 2.1.1 (7790, API 102) / Android 16 上真机验证通过（见 §4.1）
> **许可**：MIT，仅覆盖本仓库自有的代码与文档，见 [LICENSE](LICENSE)

### 免责声明

这是个针对**你自己已购设备**的互操作性补丁。它做的是把 App 里**已经存在、只是被 UI 藏起来**的
选项显示出来 —— 不修改 App 本体、不篡改通信协议、不绕过任何付费、不包含绿联的任何代码或资源
（原始安装包 `base.apk` 刻意不入库）。

与绿联（Ugreen Group Limited）无任何关联，也未获其授权或支持。风险自负：
解锁出来的动作最终能否被耳机执行取决于**耳机固件**，模块不保证结果（详见 §5）。

---

## 1. 这个限制到底卡在哪

对 `base.apk`（`com.ugreen.iot` 2.3.1.802，targetSdk 36）做了完整静态分析，结论如下。

### 1.1 手势页面是 H5，不是原生

设备详情/耳机操控页是内嵌的 Vue3 H5：

```
file:///android_asset/static/device/index.html
  └─ ./assets/index-DSOWORxZ.js     ← 全部逻辑与数据（含 i18n）
  └─ ./assets/control-2bus1WSV.js   ← 操控矩阵页面（左耳/右耳 × 单击/双击/三击/长按）
```

### 1.2 能力表**完全内嵌在 JS 里，不联网**

`index-DSOWORxZ.js` 里装了 `axios-mock-adapter`，并且在模块初始化时**无条件**注册拦截：

```js
const f4 = (e, s) => $c.post(e, s);
const by = new Bq($c, { delayResponse: 10 });          // MockAdapter
const g4 = () => { by.onPost("/earbuds/device_info").reply(req => { ...35 个机型... }); };
g4();
const v4 = e => f4("/earbuds/device_info", { device_name: e });
// 页面启动： v4(locale_name).then(z => store.setConfig(z.data.device_info))
```

`onPost("/earbuds/device_info")` 覆盖全部 35 个在售机型且**没有 default 分支** —— 也就是说这个接口的真实请求根本不会发出去，机型能力表 100% 来自 APK 内嵌的这张表。

### 1.3 唯一的门控是「浅合并覆盖」

```js
// earPhoneStore 初始 state 里，默认选项表是全量的
is_left_ear_single_tap_options: [none(0), play_pause(1), increase_volume(2), decrease_volume(3)]
...
// setConfig 把机型的「缩水版」浅合并覆盖上去
setConfig(e) { this.config = Object.assign({}, this.config, e); }
```

实测数据（从 APK 提取，见 `module/test/fixtures.js`）：

| 机型 | `is_left_ear_single_tap_options` | 表现 |
|---|---|---|
| UGREEN HiTune S5 | `[0, 1]`（无、播放/暂停） | 与你的描述**逐字一致** |
| UGREEN HiTune S8 | 该键**不存在** → 回落默认 `[0,1,2,3]`（含音量±） | 与你的描述**逐字一致** |

对照组：行可见性由 8 个布尔开关控制（`is_left_ear_single_tap` … `is_right_ear_long_press`），但**默认全是 `true`**，不需要额外解锁。

### 1.4 协议层本来就是全量

`control.js` 写入时固定发 8 字节：

```js
C = [tap, double_tap, triple_tap, long_tap, right_tap, right_double_tap, right_triple_tap, right_long_tap]
$keyVoiceStatusChange(INSTRUCTION /*26*/, new Uint8Array(C))
```

8 个槽位永远全发，值域也覆盖全部动作（0 无 / 1 播放暂停 / 2 音量+ / 3 音量- / 4 下一曲 / 5 上一曲 / 6 语音助手 / 7 游戏模式 / 8 降噪 / 9 接听挂断 / 11 空间音频 / 12-14 AI）。**限制纯粹在 UI 层**。

> 注：`protocol_type === 2`（中科蓝讯 / Magic 系列）用的是另一套编号，模块已分别处理。

---

## 2. 模块怎么做的

LSPosed 在 Java 层，但门控在 JS 层，所以思路是**把载荷注入 WebView**：

1. Hook App 自己的两个 `WebViewClient` 子类的 `onPageFinished`
   （`com.ugreen.webview.refactor.WebViewUiManager$init$1`、`com.ugreen.webview.WebViewActivity$initWebView$1`）
2. Hook 框架层 `android.webkit.WebView#loadUrl`（全重载）与 `loadDataWithBaseURL` 兜底
3. 页面加载后用错开的延迟（0/350/900/1800/3500/6000/10000 ms）多次注入载荷
4. 载荷在页内做三件事：
   - 覆盖 `earPhoneStore.setConfig`，让**之后每次合并**都带上全量选项表
   - 直接修正当前 `config` 的 14 个 `is_*_options` 数组
   - 强制打开 12 个行可见性开关

载荷通过 `#app.__vue_app__` → `globalProperties.$pinia` / `provides` 找到 Pinia store（带 fallback 扫描），是**幂等**的，并且自己带 500 ms 重试循环以覆盖异步时序。

选项文案不是硬编码的：优先从 App 自己的默认表里**采集**已有 `{label, type}`（天然多语言），缺失的才回落到 `$t('earphone.control.*')`。

---

## 3. 安装与激活

> **从早期本地构建升级的注意**：如果你装过用临时 debug 密钥签的版本（证书 `CN=Android Debug`），
> 必须先卸载再装，否则会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`：
> ```
> adb uninstall com.ugreen.unlock
> ```
> 正式发布版一律由下面的发布密钥签名，之后 **1.0 → 后续版本** 可以直接覆盖升级。

1. 安装 `dist/HiTuneUnlock-1.0.apk`（模块本身不需要 root 权限）
   ```
   adb install -r dist/HiTuneUnlock-1.0.apk
   ```
2. 打开 **LSPosed 管理器 → 模块** → 启用「HiTune 操控解锁」
3. **作用域**勾选 `com.ugreen.iot`（模块已在清单里声明 `xposedscope`，通常会自动勾选）
4. **强制停止绿联 App**（设置 → 应用 → 强停），再重新打开 —— 必须重启进程，hook 只在新进程生效
5. 进入你的耳机 → 操控自定义

> LSPosed 2.1.1 (7790) / Android 16 (API 36) 直接可用；`xposedminversion` 设为 93。

### 3.1 校验安装包来源

发布版签名证书（在仓库之外保管，不入库）：

```
Subject : CN=UGREEN HiTune Unlock, O=ugreen_lsp, C=CN
SHA-256 : BB:C6:58:CB:90:D3:01:F5:DE:BF:0E:0C:89:24:18:A0:
          6F:C5:55:3D:46:88:52:AB:27:08:5E:27:19:FA:D4:99
算法    : RSA 4096 / SHA256withRSA，有效期至 2056-09
```

自己核对（不必安装）：

```bash
apksigner verify --print-certs dist/HiTuneUnlock-1.0.apk
# 或用 JDK 自带工具
keytool -printcert -jarfile dist/HiTuneUnlock-1.0.apk
```

指纹对不上就说明 APK 被人重签过，别装。

签名方案：v1 + v2 + v3 全部启用（`minSdk 24` 也带 v1，兼容个别 ROM 的安装器）。

---

## 4. 怎么确认生效

### 4.1 真机实测（已通过 ✅）

设备：UGREEN HiTune S5 + LSPosed 2.1.1 (7790, API 102) / Android 16。
进入耳机 → 操控自定义后的完整日志：

```
UgreenHiTuneUnlock: hooked onPageFinished: com.ugreen.webview.refactor.WebViewUiManager$init$1
UgreenHiTuneUnlock: hooked onPageFinished: com.ugreen.webview.WebViewActivity$initWebView$1
UgreenHiTuneUnlock: hooked WebView.loadUrl
UgreenHiTuneUnlock: hooked WebView.loadDataWithBaseURL
UgreenHiTuneUnlock: install ok (attempt 0, 4 hook points)
UgreenHiTuneUnlock: patching page: file:///android_asset/static/device/index.html#/earphone/index/control
UgreenHiTuneUnlock: payload status: "flag=1 store=1 hooked=1 ok=1 proto=1
    sig=0,1,2,3,4,5,6,7,8,9,11 diag=noPinia(app=0) log=setConfig hooked | unlocked UNIVERSAL -> 0,1,2,3,4,5,6,7,8,9,11"
```

| 指标 | 实测结果 |
|---|---|
| S5 左耳单击可选动作 | `[0, 1]`（无 / 播放暂停） → **`0,1,2,3,4,5,6,7,8,9,11`（11 项）** |
| 音量调整 | **已生效** —— 选到音量加减后耳机真的执行了 |
| hook 点 | 4/4 全部挂上 |
| `proto=1` | 走的是 UGREEN_Universal 分支，符合预期 |

界面速查：**左/右耳的单击现在也能选到音量加减、上下曲等**（S5 之前只有「无 / 播放暂停」）。

> 顺带一个细节：`diag` 只在**失败路径**才写入，所以 `store=1` 时它显示的
> `noPinia(app=0)` 是页面刚注入那一刻（Pinia 尚未实例化）留下的残留值，
> 可以直接忽略。**判断只看最后一条日志和 `sig`。**

### 4.2 为什么不用页内 console.log

第一版靠页内 `console.log('[UGUnlock] ...')` 观察，结果**一条都看不到** —— 这个 App 的
WebView 没有开启 chromium 的 console 转发（`logcat` 里 `chromium` 标签出现 0 次），
页内日志到不了 logcat。

改成**状态回传**：载荷把状态写进 `window.__UG_UNLOCK_STATUS__()`，Java 侧把它拼在
注入脚本末尾，通过 `evaluateJavascript(js, callback)` 的**回调返回值**读回来并打印：

```java
webView.evaluateJavascript(JsPayload.JS + STATUS_PROBE, value -> log("payload status: " + value));
```

这个办法不依赖任何 WebView 调试配置，是当前唯一可靠的观测手段。状态字段含义：

| 字段 | 含义 |
|---|---|
| `flag=1` | 载荷确实执行了（防重复执行的窗口标记已置位） |
| `store=1` | 找到了 Pinia 里的 `earPhoneStore` |
| `hooked=1` | `setConfig` 已被包一层（后续合并也会带全量选项） |
| `ok=1` | 当前 `config` 已被改成全量 |
| `proto` | 协议类型（1 = UGREEN_Universal，2 = 中科蓝讯） |
| `sig` | 改完后左耳单击的动作编号序列 |
| `diag` | 找不到 store 时的诊断：`noPinia(app=0)` / `stores[a,b,c]` 等 |

**`store=0` 是正常的**，只要还没进过耳机页：Pinia 的 store 是**懒创建**的，
不进耳机详情页 `earPhoneStore` 就不会出现在 `pinia._s` 里。
停在 App 原生首页时注入的是 `about:blank`，此时 `diag=noPinia(app=0)` 属于预期。

---

## 5. 覆盖范围与限制

**覆盖**：35 个在售机型（HiTune S3/S5/S6/S7/S8/T3/T6/T8/X8、Max2/5/5c/6、H5/H6、P3、A3、ClipBuds、LightBuds、FitBuds、Dots、G3 Air、Retro3、Studio 系列、各 Magic 系列）的
左耳/右耳 × 单击/双击/三击/长按、ANC 按键、音量键 —— 全部手势槽位全量放开。

**两个明确的限制**：

1. **App 只放开限制，不保证耳机固件认账。** 8 字节是全量下发的，但某个具体动作是否被固件执行取决于耳机本身。若选了没反应，说明该型号固件确实不支持 —— 这属于硬件层面，模块无法越过。
2. **只处理 H5 操控页。** 当前版本（2.3.1.802）已确认真机上的操控页**就是**这个 H5
   （注入时抓到的 URL 是 `file:///android_asset/static/device/index.html#/earphone/index/control`）。
   但绿联如果哪天把它换成 React Native 界面（`assets/headphones.bundle`，里面有
   `getKeyOptions` / `setKeyConfig` / `leftEarTapOptions` 等标识），那套逻辑就跑在
   Hermes 字节码里，本模块不覆盖 —— 需要另做一版（改 Hermes 包或 hook 原生桥）。
   判断方法：`adb logcat | grep "patching page"` 看它到底注入了哪个 URL。

**未做**（按需再加）：强制打开机型没有的功能开关（游戏模式、空间音频、Hi-Res、双连、佩戴检测等）。这些不只是 UI 开关，还牵扯协议与固件，风险比手势解锁高。

---

## 6. 自己改 / 重新构建

```
base.apk                      ← 需要你自己放进来的原始安装包（不入库）
tools/
  extract_apk.py              ← 从 base.apk 解出分析所需的 H5 设备页
  dexparse.py                 ← 极简 DEX 解析器（当初用来确认操控页不是原生实现）
module/
  js/unlock_payload.js        ← 注入的 WebView 载荷（改这里，全量选项表/开关都在这儿）
  src/com/ugreen/unlock/      ← 模块本体（hook 点）
  assets/xposed_init          ← LSPosed 入口声明
  res/                        ← 模块名与描述
  stubs/                      ← Xposed API 桩（仅编译期，不进 dex）
  tools/                      ← 载荷生成 + 夹具提取 + dex 往返校验
  test/                       ← 载荷行为测试
  build.sh                    ← 一键构建（纯离线）
```

```bash
bash module/build.sh
```

仓库里**没有** `base.apk`、`work/`、构建中间产物和签名密钥（见 `.gitignore`）。
从零 clone 之后的完整流程：

```bash
# 1. 把绿联 App 安装包放到仓库根目录并命名为 base.apk
# 2. 解出分析用的 H5 设备页（只取需要的 ~5MB，--all 才是全量）
python tools/extract_apk.py
# 3. 从设备页里提取真实机型数据，喂给行为测试
python module/tools/extract_fixtures.py
# 4. 构建（缺 keystore.properties 时会自动退回 debug 密钥并给出提示）
bash module/build.sh
```

工具链**不写死路径**，按 `ANDROID_HOME` → `JAVA_HOME` → PATH 顺序自动探测，
build-tools 和 platform 取本机最高的版本；可用 `BUILD_TOOLS_VERSION` /
`PLATFORM_VERSION` / `PY` / `NODE` 环境变量覆盖。构建流程**不需要 Gradle、不需要网络**。

| 步骤 | 工具 |
|---|---|
| 编译 | `javac --release 11` + `platforms/android-*/android.jar` |
| dex | `build-tools/*/lib/d8.jar` |
| 资源 | `aapt2 compile` / `aapt2 link` |
| 对齐签名 | `zipalign` + `lib/apksigner.jar` |

构建内置两道自动校验：

- **载荷行为测试**（`test/payload.test.js`，327 项断言）：用从 APK 里提取的**真实** S5 / S8 数据驱动，覆盖「payload 先装 → setConfig 后到」这个正常时序、二次合并、magic 协议编号、store 晚出现等场景。
  重新提取夹具：`python module/tools/extract_fixtures.py`
- **dex 往返校验**（`tools/verify_embedded_payload.py`）：确认烧进 dex 的 JS 与源文件**逐字节一致**。
  （这道校验不是摆设 —— 开发时生成器确实漏掉过换行符，把整个 JS 压成一行，那样第一个 `//` 注释就会废掉后面所有代码。）

### 6.1 签名与发布

**发布一定要签名。** Android 只安装已签名的 APK，`aapt2 link` 产出的 `unsigned.apk`
只是中间产物，连装都装不上。LSPosed 模块本身**不要求**特定签名（不上架、没有密钥证明依赖），
但有两条实际约束：

1. **更新一致性** —— 用户装过 v1.0 之后，v1.1 必须用**同一把密钥**签，否则报
   `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，只能先卸载再装。这个模块没有持久化数据，
   代价只是重新在 LSPosed 里授权一次，但仍然很难看。
2. **来源可验证** —— 固定的证书指纹让用户能确认手上的 APK 出自本仓库，
   而不是被人重签后塞进来的。指纹见 3.1 节。

所以发布密钥**只存在于维护者本地**，不进版本库：

```
module/keystore/release.keystore     ← RSA 4096，有效期至 2056-09
module/keystore.properties           ← 口令（明文，靠文件权限保护）
```

两者都在 `.gitignore` 里。**公开密钥库等于公开签名能力** —— 任何人都能签出可覆盖升级的
"官方"版本，这是典型的供应链攻击面，所以宁可麻烦也不要入库。

> ⚠️ **发布密钥丢失 = 再也发不出能覆盖升级的版本**，用户必须卸载重装。
> 请把这两个文件一起做离线备份（密码管理器 / 加密归档），不要只留在工作机上。

换机器或想在别处构建时，自己生成一把（注意：新密钥签出的 APK **不能**覆盖升级旧版本）：

```bash
mkdir -p module/keystore
PASS="$(python3 -c 'import secrets,string;print("".join(secrets.choice(string.ascii_letters+string.digits) for _ in range(40)))')"
keytool -genkeypair -keystore module/keystore/release.keystore -storetype PKCS12 \
  -storepass "$PASS" -keypass "$PASS" -alias ugreen-unlock \
  -keyalg RSA -keysize 4096 -sigalg SHA256withRSA -validity 10950 \
  -dname "CN=UGREEN HiTune Unlock, O=你的标识, C=CN"

cat > module/keystore.properties <<EOF
storeFile=keystore/release.keystore
storePassword=$PASS
keyAlias=ugreen-unlock
keyPassword=$PASS
EOF

bash module/build.sh
```

构建脚本用 `env:` 把口令交给 `apksigner`，**不经过命令行参数**，以免出现在进程列表里。
没有 `keystore.properties` 时会自动退回 debug 密钥，并在输出里明确提示该 APK 不能覆盖升级。

发布步骤：`bash module/build.sh` → `git tag v1.0` → 把 `dist/HiTuneUnlock-1.0.apk`
作为 GitHub Release 的附件上传（APK 是二进制产物，不进 git 历史）。

---

## 7. 改了 App 版本怎么办

模块作用在**数据层**（`config.is_*_options` 数组）而不是具体代码行，所以对 bundle 改名/压缩不敏感。只要满足以下条件就仍然有效：

- 页面仍由 WebView 加载（`loadUrl` / `onPageFinished` 仍会触发）
- 仍通过 Pinia store 持有 `config.is_*_options`
- 仍通过 `setConfig` 合并

若绿联大改架构，用 `adb logcat | grep UgreenHiTuneUnlock` 看 hook 是否还挂上，再决定是否更新。

---

## 8. 踩坑记录（真机调试实录）

### 8.1 【致命】Xposed API 的包名布局：`XC_MethodHook` 不在 `callbacks` 下

第一版模块装上后**四个 hook 点全部失败**，日志里只有一句：

```
hook onPageFinished failed: com.ugreen.webview.refactor.WebViewUiManager$init$1
```

堆栈被 `XposedBridge.log(t)` 打成了**不带我们 tag 的多行**，翻出来才是根因：

```
java.lang.NoClassDefFoundError: Failed resolution of: Lde/robv/android/xposed/callbacks/XC_MethodHook;
Caused by: java.lang.ClassNotFoundException: Didn't find class
    "de.robv.android.xposed.callbacks.XC_MethodHook"
    on path: DexPathList[[dex file "InMemoryDexFile[...]"], ...]
```

**编译期桩和真 API 的包名不一致** —— 桩照抄了老版本 Xposed 的布局，所以 `javac` 一路通过，
装到机器上才炸。反射探针（见 `UnlockModule.probe()`）打出的真相：

```
PROBE XposedBridge classloader = InMemoryDexClassLoader[...]        ← API 是注入的内存 dex
PROBE   java.util.Set hookAllMethods(java.lang.Class, java.lang.String,
                                     de.robv.android.xposed.XC_MethodHook)   ← 签名说明一切
PROBE [module] OK   de.robv.android.xposed.XC_MethodHook
PROBE [module] FAIL de.robv.android.xposed.callbacks.XC_MethodHook
```

**这台设备的 LSPosed 2.1.1 / API 102 用的是扁平包名
`de.robv.android.xposed.XC_MethodHook`，`callbacks` 下只有
`XCallback` / `XC_LoadPackage` / `XC_InitPackageResources`。**

修法：全项目只在 `HookAdapter.java` 里出现这个基类，其余代码一律不引用它，
这样包名再变只改一个文件。`WebViewHook` 把 `MethodHookParam` 当**不透明 Object**
用反射读 `thisObject` / `args`，于是"回调基类找不到"再也不会连带阻止别的类定义。

> **教训**：手写 Xposed API 桩省钱，但必须**用真机反射核对一次**。
> 桩写错编译器不会拦，只会让你在设备上看到一堆 `NoClassDefFoundError`。

### 8.2 日志被截断：异常堆栈不在你的 tag 下

`XposedBridge.log(Throwable)` 输出的每行**不带模块 tag**。用
`adb logcat | grep UgreenHiTuneUnlock` 只能看到"失败了"，看不到为什么。
要按**时间窗**捞：

```bash
adb logcat -v time | awk '/22:54:18\.69/,/22:54:19\.0/'
```

### 8.3 装完模块必须重启进程，否则一条日志都没有

LSPosed 在进程 fork 时才注入。改了模块 APK 之后如果目标 App 还在跑，
那个进程里是**旧代码**（甚至完全没有模块）。判断进程新旧**不要**用
`/proc/pid/stat` 的 `starttime` 去和 `/proc/uptime` 相减 ——
两者基准不同（`CLOCK_MONOTONIC` vs boottime，休眠时间算不算不一致），
算出来会差好几分钟，把人带偏。直接：

```bash
adb shell am force-stop com.ugreen.iot
adb shell am start -n com.ugreen.iot/.ui.SplashActivity
```

另外这台设备 logcat 很吵（`MSF.J.MSFProbeNewManager` 之类每秒好几条），
默认缓冲区**一分钟内就会把关键行刷掉**。要抓启动瞬间的日志，必须
`adb logcat | grep --line-buffered` **一边抓一边过滤**，不要事后 `logcat -d`。

