#!/usr/bin/env bash
#
# Offline build for the HiTune Unlock LSPosed module.
# Uses only a local Android SDK + JDK. No Gradle, no network.
#
# Signing:
#   module/keystore.properties present -> release key   (module/keystore/release.keystore)
#   otherwise                          -> debug key     (module/keystore/debug.keystore,
#                                                        generated on first run)
# Neither keystore nor keystore.properties is in version control.
#
set -euo pipefail

# ---------------------------------------------------------------- version ---
VERSION_CODE=1
VERSION_NAME=1.0

# ------------------------------------------------------------ toolchain ----
_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v cygpath >/dev/null 2>&1; then
  # javac / aapt2 are native Windows binaries and need Windows-style paths
  MODULE_DIR="$(cygpath -m "$_here")"
else
  MODULE_DIR="$_here"
fi

exists() { [ -n "${1:-}" ] && { [ -x "$1" ] || [ -f "$1" ]; }; }

first_existing() {
  local c
  for c in "$@"; do
    if exists "$c"; then printf '%s\n' "$c"; return 0; fi
  done
  return 1
}

die() { printf '\n[ERROR] %s\n' "$*" >&2; exit 1; }

# --- Android SDK -------------------------------------------------------------
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ ! -d "${SDK:-/nonexistent}" ]; then
  SDK="$(first_existing \
      "${LOCALAPPDATA:-}/Android/Sdk" \
      "$HOME/AppData/Local/Android/Sdk" \
      "$HOME/Android/Sdk" \
      "$HOME/Library/Android/Sdk" \
      "/usr/lib/android-sdk" || true)"
fi
[ -d "${SDK:-/nonexistent}" ] || die "Android SDK not found. Set ANDROID_HOME."

BT_VER="${BUILD_TOOLS_VERSION:-$(ls "$SDK/build-tools" 2>/dev/null | sort -V | tail -1)}"
[ -n "$BT_VER" ] || die "no build-tools under $SDK/build-tools"
BUILD_TOOLS="$SDK/build-tools/$BT_VER"

PLAT_VER="${PLATFORM_VERSION:-$(ls "$SDK/platforms" 2>/dev/null | grep -E '^android-[0-9]+$' | sed 's/^android-//' | sort -n | tail -1)}"
[ -n "$PLAT_VER" ] || die "no platforms under $SDK/platforms"
PLATFORM_JAR="$SDK/platforms/android-$PLAT_VER/android.jar"

# --- JDK ---------------------------------------------------------------------
JDK="${JAVA_HOME:-}"
if [ ! -f "${JDK:-/nonexistent}/bin/javac.exe" ] && [ ! -f "${JDK:-/nonexistent}/bin/javac" ]; then
  javac_bin="$(command -v javac || true)"
  if [ -n "$javac_bin" ]; then
    jdk_dir="$(cd "$(dirname "$javac_bin")/.." && pwd)"
    JDK="$(cygpath -m "$jdk_dir" 2>/dev/null || printf '%s' "$jdk_dir")"
  fi
fi
[ -f "$JDK/bin/javac.exe" ] || [ -f "$JDK/bin/javac" ] || die "JDK not found. Set JAVA_HOME."

JAVA="$(first_existing "$JDK/bin/java.exe" "$JDK/bin/java")"
JAVAC="$(first_existing "$JDK/bin/javac.exe" "$JDK/bin/javac")"
KEYTOOL="$(first_existing "$JDK/bin/keytool.exe" "$JDK/bin/keytool")"

# --- python / node (only needed for payload generation + tests) --------------
WB_BIN="${USERPROFILE:-$HOME}/.workbuddy/binaries"
PY="${PY:-$(first_existing \
      "$WB_BIN/python/versions/"*/python.exe \
      "$(command -v python3 || true)" \
      "$(command -v python || true)" || true)}"
NODE="${NODE:-$(first_existing \
      "$WB_BIN/node/versions/"*/node.exe \
      "$(command -v node || true)" || true)}"

AAPT2="$BUILD_TOOLS/aapt2.exe"
[ -f "$AAPT2" ] || AAPT2="$BUILD_TOOLS/aapt2"
D8_JAR="$BUILD_TOOLS/lib/d8.jar"
APKSIGNER_JAR="$BUILD_TOOLS/lib/apksigner.jar"
ZIPALIGN="$BUILD_TOOLS/zipalign.exe"
[ -f "$ZIPALIGN" ] || ZIPALIGN="$BUILD_TOOLS/zipalign"

for f in "$AAPT2" "$D8_JAR" "$APKSIGNER_JAR" "$ZIPALIGN"; do
  [ -f "$f" ] || die "missing build-tool: $f"
done
[ -n "$PY" ]   || die "python not found (needed for payload generation). Set PY."
[ -n "$NODE" ] || die "node not found (needed for the payload test). Set NODE."

BUILD="$MODULE_DIR/build"
OUT="$MODULE_DIR/../dist"
APK_NAME="HiTuneUnlock-$VERSION_NAME.apk"

echo "==> [0/8] toolchain"
echo "    SDK          $SDK  (build-tools $BT_VER, platform android-$PLAT_VER)"
echo "    JDK          $JDK"
echo "    python       $PY"
echo "    node         $NODE"

rm -rf "$BUILD"
mkdir -p "$BUILD/classes" "$BUILD/stubs" "$BUILD/dex" "$OUT"

echo "==> [1/8] generating JS payload"
"$PY" "$MODULE_DIR/tools/gen_payload.py"

# Behaviour test for the payload, driven by real per-model data extracted from
# the APK (module/tools/extract_fixtures.py). Skipped if fixtures are absent.
if [ -f "$MODULE_DIR/test/fixtures.js" ]; then
    echo "==> [1b] payload behaviour test"
    "$NODE" "$MODULE_DIR/test/payload.test.js"
else
    echo "==> [1b] payload test skipped (run: python module/tools/extract_fixtures.py)"
fi

echo "==> [2/8] compiling Xposed API stubs (compile-time only, not shipped)"
find "$MODULE_DIR/stubs" -name '*.java' > "$BUILD/stubs.txt"
"$JAVAC" -encoding UTF-8 -nowarn --release 11 \
    -cp "$PLATFORM_JAR" \
    -d "$BUILD/stubs" @"$BUILD/stubs.txt"

echo "==> [3/8] compiling module sources"
find "$MODULE_DIR/src" -name '*.java' > "$BUILD/src.txt"
"$JAVAC" -encoding UTF-8 -nowarn --release 11 \
    -cp "$PLATFORM_JAR;$BUILD/stubs" \
    -d "$BUILD/classes" @"$BUILD/src.txt"

echo "==> [4/8] dexing"
find "$BUILD/classes" -name '*.class' > "$BUILD/classes.txt"
"$JAVA" -cp "$D8_JAR" com.android.tools.r8.D8 \
    --min-api 24 --lib "$PLATFORM_JAR" \
    --output "$BUILD/dex" @"$BUILD/classes.txt"

echo "==> [4b] verifying embedded payload round-trip"
"$PY" "$MODULE_DIR/tools/verify_embedded_payload.py" \
    "$BUILD/dex/classes.dex" "$MODULE_DIR/js/unlock_payload.js"

echo "==> [5/8] compiling resources"
"$AAPT2" compile --dir "$MODULE_DIR/res" -o "$BUILD/res.zip"

echo "==> [6/8] linking resources + manifest"
"$AAPT2" link \
    -o "$BUILD/base.apk" \
    --manifest "$MODULE_DIR/AndroidManifest.xml" \
    -I "$PLATFORM_JAR" \
    -A "$MODULE_DIR/assets" \
    --min-sdk-version 24 \
    --target-sdk-version 36 \
    --version-code "$VERSION_CODE" \
    --version-name "$VERSION_NAME" \
    "$BUILD/res.zip"

echo "==> [7/8] packaging dex + aligning"
"$PY" - "$BUILD/base.apk" "$BUILD/dex/classes.dex" "$BUILD/unsigned.apk" <<'PYEOF'
import os, shutil, sys, zipfile
src, dex, dst = sys.argv[1], sys.argv[2], sys.argv[3]
shutil.copyfile(src, dst)
with zipfile.ZipFile(dst, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
print('    packaged', os.path.getsize(dex), 'byte classes.dex')
PYEOF

"$ZIPALIGN" -f 4 "$BUILD/unsigned.apk" "$BUILD/aligned.apk"

# ------------------------------------------------------------- signing ------
# Credentials are passed through the environment, never on the command line.
prop() { sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//p" "$1" | head -1 | tr -d '\r' | tr -d '\n'; }

echo "==> [8/8] signing"
KS_PROPS="$MODULE_DIR/keystore.properties"
if [ -f "$KS_PROPS" ]; then
    KS_REL="$(prop "$KS_PROPS" storeFile)"
    KS="$MODULE_DIR/${KS_REL:-keystore/release.keystore}"
    export KS_PASS="$(prop "$KS_PROPS" storePassword)"
    export KEY_PASS="$(prop "$KS_PROPS" keyPassword)"
    KS_ALIAS="$(prop "$KS_PROPS" keyAlias)"
    SIGN_MODE="release"
    [ -f "$KS" ] || die "keystore.properties exists but $KS does not"
    [ -n "$KS_PASS" ] || die "storePassword missing in keystore.properties"
else
    echo "    keystore.properties not found -> falling back to a debug key"
    echo "    (a debug-signed APK cannot be updated over a release-signed one)"
    KS="$MODULE_DIR/keystore/debug.keystore"
    KS_PASS="android"; KEY_PASS="android"; KS_ALIAS="androiddebugkey"
    SIGN_MODE="debug"
    if [ ! -f "$KS" ]; then
        mkdir -p "$(dirname "$KS")"
        "$KEYTOOL" -genkeypair -keystore "$KS" -storepass "$KS_PASS" -keypass "$KEY_PASS" \
            -alias "$KS_ALIAS" -keyalg RSA -keysize 2048 -validity 10950 \
            -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
        echo "    generated debug keystore"
    fi
fi

"$JAVA" -jar "$APKSIGNER_JAR" sign \
    --ks "$KS" \
    --ks-pass "env:KS_PASS" --key-pass "env:KEY_PASS" \
    --ks-key-alias "$KS_ALIAS" \
    --v1-signing-enabled true \
    --v2-signing-enabled true \
    --v3-signing-enabled true \
    --v4-signing-enabled false \
    --out "$OUT/$APK_NAME" \
    "$BUILD/aligned.apk"

unset KS_PASS KEY_PASS

echo
"$JAVA" -jar "$APKSIGNER_JAR" verify --print-certs "$OUT/$APK_NAME" | head -6
echo
echo "signing mode: $SIGN_MODE  (keystore: $KS)"
echo "OK -> $OUT/$APK_NAME  ($(du -h "$OUT/$APK_NAME" | cut -f1))"
