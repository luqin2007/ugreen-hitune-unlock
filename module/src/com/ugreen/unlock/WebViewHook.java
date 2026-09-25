package com.ugreen.unlock;

import android.os.Handler;
import android.os.Looper;
import android.webkit.ValueCallback;
import android.webkit.WebView;

import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage;

import java.lang.reflect.Field;
import java.util.Map;

/**
 * Injects {@link JsPayload#JS} into the app's WebViews.
 *
 * The "device detail" H5 page (file:///android_asset/static/device/index.html)
 * holds the per-model capability table and applies it through
 * earPhoneStore.setConfig(); the payload rewrites that data at runtime.
 *
 * Injection points (all best-effort, each independently guarded):
 *   1. the two app WebViewClient subclasses that implement onPageFinished
 *   2. android.webkit.WebView#loadUrl and #loadDataWithBaseURL
 *
 * This class deliberately never mentions XC_MethodHook: the callback plumbing
 * lives in HookAdapter, and the framework's MethodHookParam is handled as an
 * opaque Object read through reflection. That way a mismatch in the callback
 * base class can no longer prevent this class from being defined.
 *
 * Timing: the page mounts and fetches its config asynchronously, so the
 * payload is pushed several times with increasing delays. The payload is
 * idempotent (guarded by a window flag) and keeps its own retry loop.
 */
final class WebViewHook {

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /** How long after page load to (re-)push the payload. */
    private static final int[] INJECT_DELAYS_MS = { 0, 350, 900, 1800, 3500, 6000, 10000 };

    private static final String[] PAGE_FINISHED_CLASSES = {
            "com.ugreen.webview.refactor.WebViewUiManager$init$1",
            "com.ugreen.webview.WebViewActivity$initWebView$1",
    };

    /** WebView instance methods that start a document load. */
    private static final String[] WEBVIEW_LOAD_METHODS = {
            "loadUrl", "loadDataWithBaseURL",
    };

    private static boolean paramShapeLogged;

    private static final HookAdapter.Handler SINK = new HookAdapter.Handler() {
        @Override
        public void onParam(Object param) {
            handle(param);
        }
    };

    private WebViewHook() {
    }

    /**
     * @return the number of successfully installed hook points. Throws when
     *         none could be installed, so the caller can retry once the app
     *         class loader is fully populated.
     */
    static int install(XC_LoadPackage.LoadPackageParam lpparam) {
        ClassLoader cl = lpparam.classLoader;
        int ok = 0;

        for (String className : PAGE_FINISHED_CLASSES) {
            ok += hookPageFinished(cl, className);
        }
        ok += hookWebViewLoads(cl);

        if (ok == 0) {
            throw new IllegalStateException("no hook point could be installed");
        }
        return ok;
    }

    // ------------------------------------------------------------------
    private static int hookPageFinished(ClassLoader cl, String className) {
        Class<?> clazz = null;
        try {
            clazz = XposedHelpers.findClassIfExists(className, cl);
        } catch (Throwable t) {
            UnlockModule.log("findClass failed: " + className, t);
        }
        if (clazz == null) {
            UnlockModule.log("class not present, skipping: " + className);
            return 0;
        }
        try {
            XposedBridge.hookAllMethods(clazz, "onPageFinished", new HookAdapter(SINK));
            UnlockModule.log("hooked onPageFinished: " + className);
            return 1;
        } catch (Throwable t) {
            UnlockModule.log("hook onPageFinished failed: " + className, t);
            return 0;
        }
    }

    private static int hookWebViewLoads(ClassLoader cl) {
        Class<?> webView;
        try {
            webView = Class.forName("android.webkit.WebView", false, cl);
        } catch (Throwable t) {
            UnlockModule.log("android.webkit.WebView not resolvable", t);
            return 0;
        }
        int ok = 0;
        for (String method : WEBVIEW_LOAD_METHODS) {
            try {
                // hookAllMethods covers every overload of the name
                XposedBridge.hookAllMethods(webView, method, new HookAdapter(SINK));
                UnlockModule.log("hooked WebView." + method);
                ok++;
            } catch (Throwable t) {
                UnlockModule.log("hook WebView." + method + " failed", t);
            }
        }
        return ok;
    }

    // ------------------------------------------------------------------
    private static void handle(Object param) {
        try {
            if (param == null) {
                return;
            }
            logParamShapeOnce(param);

            Object thisObject = readField(param, "thisObject");
            Object[] args = (Object[]) readField(param, "args");

            WebView webView = null;
            String url = null;

            // WebView.loadUrl / loadDataWithBaseURL are instance methods, so the
            // receiver is the WebView itself. WebViewClient.onPageFinished carries
            // it as the first argument instead.
            if (thisObject instanceof WebView) {
                webView = (WebView) thisObject;
            }
            if (args != null) {
                for (Object arg : args) {
                    if (webView == null && arg instanceof WebView) {
                        webView = (WebView) arg;
                    } else if (url == null && arg instanceof String) {
                        url = (String) arg;
                    }
                }
            }
            if (webView == null) {
                return;
            }
            if (url == null) {
                try {
                    url = webView.getUrl();
                } catch (Throwable ignored) {
                    // WebView may already be torn down
                }
            }
            if (!shouldPatch(url)) {
                return;
            }
            schedule(webView, url);
        } catch (Throwable t) {
            UnlockModule.log("handle() error", t);
        }
    }

    /** Reads a public/private field by walking up the hierarchy. */
    private static Object readField(Object target, String name) {
        for (Class<?> c = target.getClass(); c != null; c = c.getSuperclass()) {
            try {
                Field f = c.getDeclaredField(name);
                f.setAccessible(true);
                return f.get(target);
            } catch (NoSuchFieldException e) {
                // keep walking up
            } catch (Throwable t) {
                return null;
            }
        }
        return null;
    }

    /** One-shot dump so an API shape change is visible in the log. */
    private static void logParamShapeOnce(Object param) {
        if (paramShapeLogged) {
            return;
        }
        paramShapeLogged = true;
        try {
            StringBuilder sb = new StringBuilder("MethodHookParam class=" + param.getClass().getName()
                    + " fields=[");
            Field[] fs = param.getClass().getFields();
            for (int i = 0; i < fs.length; i++) {
                if (i > 0) sb.append(", ");
                sb.append(fs[i].getName());
            }
            sb.append(']');
            UnlockModule.log(sb.toString());
        } catch (Throwable ignored) {
            // purely informational
        }
    }

    /**
     * The payload is a no-op outside the device page, so the only thing worth
     * avoiding is remote web content. Local (file: / content: / localhost) and
     * not-yet-resolvable pages are all fine.
     */
    private static boolean shouldPatch(String url) {
        if (url == null) {
            return true;
        }
        if (url.startsWith("http://") || url.startsWith("https://")) {
            return url.contains("127.0.0.1") || url.contains("localhost");
        }
        return true;
    }

    private static void schedule(final WebView webView, final String url) {
        boolean first = true;
        for (final int delay : INJECT_DELAYS_MS) {
            if (first) {
                UnlockModule.log("patching page: " + url);
                first = false;
            }
            MAIN.postDelayed(new Runnable() {
                @Override
                public void run() {
                    evaluate(webView);
                }
            }, delay);
        }
    }

    /**
     * Appended to the payload so the callback of evaluateJavascript returns a
     * one-line status report. console.log never reaches logcat in this app, so
     * this is the only way to observe what the payload actually did.
     * Single quotes only - keeps it escaping-free in a Java string literal.
     */
    private static final String STATUS_PROBE =
            "\n;(function(){try{"
            + "return (window.__UG_UNLOCK_STATUS__&&window.__UG_UNLOCK_STATUS__())||'no-status';"
            + "}catch(e){return 'ERR:'+e}})()";

    private static String lastStatus;

    private static void evaluate(WebView webView) {
        try {
            webView.evaluateJavascript(JsPayload.JS + STATUS_PROBE, new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    // evaluateJavascript reports execution failures as the
                    // literal text "null", so surface it either way
                    if (value != null && value.equals(lastStatus)) {
                        return;
                    }
                    lastStatus = value;
                    UnlockModule.log("payload status: " + value);
                }
            });
        } catch (Throwable t) {
            // WebView destroyed / not attached - harmless, the next attempt covers it
            UnlockModule.log("evaluateJavascript failed: " + t);
        }
    }
}
