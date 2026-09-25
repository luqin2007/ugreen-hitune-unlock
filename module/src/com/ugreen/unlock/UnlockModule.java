package com.ugreen.unlock;

import android.os.Handler;
import android.os.Looper;

import de.robv.android.xposed.IXposedHookLoadPackage;
import de.robv.android.xposed.IXposedHookZygoteInit;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.callbacks.XC_LoadPackage;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

/**
 * Entry point (declared in assets/xposed_init).
 *
 * Target: UGREEN IoT  (com.ugreen.iot)
 * Purpose: lift the app-side restriction on which earbud control actions
 * (single / double / triple / long press, per ear and per hardware button)
 * may be assigned, so every gesture can be mapped to every action the
 * protocol supports.
 *
 * NOTE: this class must never reference XC_MethodHook (directly or via a
 * method signature). The hook plumbing lives in WebViewHook and the adapter in
 * HookAdapter, so a resolution problem there cannot prevent the module entry
 * point itself from being defined - which is what we need in order to
 * diagnose it.
 */
public class UnlockModule implements IXposedHookLoadPackage, IXposedHookZygoteInit {

    static final String TAG = "UgreenHiTuneUnlock";

    static final String TARGET_PACKAGE = "com.ugreen.iot";

    /** Delays used to (re)try installing the hooks, in case the app class
     *  loader is not fully populated while handleLoadPackage runs. */
    private static final int[] INSTALL_RETRY_MS = { 300, 1000, 3000 };

    private static volatile boolean installed;

    @Override
    public void initZygote(StartupParam startupParam) throws Throwable {
        // nothing to do this early; kept so the module advertises zygote support
    }

    @Override
    public void handleLoadPackage(XC_LoadPackage.LoadPackageParam lpparam) throws Throwable {
        if (lpparam == null || !TARGET_PACKAGE.equals(lpparam.packageName)) {
            return;
        }
        log("loaded into " + lpparam.packageName + " / " + lpparam.processName);

        // ---- diagnostics -------------------------------------------------
        try {
            probe(lpparam);
        } catch (Throwable t) {
            log("probe failed", t);
        }

        // ---- hook installation -------------------------------------------
        attemptInstall(lpparam, 0);
    }

    private static void attemptInstall(final XC_LoadPackage.LoadPackageParam lpparam, final int index) {
        if (installed) {
            return;
        }
        try {
            int n = WebViewHook.install(lpparam);
            installed = true;
            log("install ok (attempt " + index + ", " + n + " hook points)");
            return;
        } catch (Throwable t) {
            log("install attempt " + index + " failed: " + t);
        }
        if (index >= INSTALL_RETRY_MS.length) {
            return;
        }
        try {
            new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                @Override
                public void run() {
                    attemptInstall(lpparam, index + 1);
                }
            }, INSTALL_RETRY_MS[index]);
        } catch (Throwable t) {
            log("cannot schedule retry", t);
        }
    }

    // ---------------------------------------------------------------------
    // Diagnostics: find out exactly which Xposed API classes this module's
    // class loader can see, and what shape the framework's callback API has.
    // ---------------------------------------------------------------------
    private static final String[] API_CLASSES = {
            "de.robv.android.xposed.XposedBridge",
            "de.robv.android.xposed.XposedHelpers",
            "de.robv.android.xposed.IXposedHookLoadPackage",
            "de.robv.android.xposed.XC_MethodHook",
            "de.robv.android.xposed.XC_MethodHook$MethodHookParam",
            "de.robv.android.xposed.XC_MethodHook$Unhook",
            "de.robv.android.xposed.XC_MethodReplacement",
            "de.robv.android.xposed.callbacks.XCallback",
            "de.robv.android.xposed.callbacks.XC_LoadPackage",
            "de.robv.android.xposed.callbacks.XC_MethodHook",
    };

    private static void probe(XC_LoadPackage.LoadPackageParam lpparam) {
        ClassLoader moduleCl = UnlockModule.class.getClassLoader();
        ClassLoader bridgeCl = XposedBridge.class.getClassLoader();

        log("PROBE moduleCl = " + describe(moduleCl));
        int i = 0;
        for (ClassLoader c = moduleCl; c != null; c = c.getParent()) {
            log("PROBE   chain[" + (i++) + "] = " + describe(c));
        }
        log("PROBE bridgeCl = " + describe(bridgeCl));
        log("PROBE appCl    = " + describe(lpparam.classLoader));

        // Resolvability across every class loader we can reach.
        ClassLoader[] cls = { moduleCl, bridgeCl, lpparam.classLoader, ClassLoader.getSystemClassLoader() };
        String[] tags = { "module", "bridge", "app", "system" };
        for (int k = 0; k < cls.length; k++) {
            for (String name : API_CLASSES) {
                try {
                    Class.forName(name, false, cls[k]);
                    log("PROBE [" + tags[k] + "] OK   " + name);
                } catch (Throwable t) {
                    log("PROBE [" + tags[k] + "] FAIL " + name + " : " + t.getClass().getSimpleName());
                }
            }
        }

        // The exact shape the framework expects from a callback implementation.
        dumpClass("de.robv.android.xposed.XC_MethodHook", bridgeCl);
    }

    private static void dumpClass(String name, ClassLoader cl) {
        Class<?> c;
        try {
            c = Class.forName(name, false, cl);
        } catch (Throwable t) {
            log("PROBE dump " + name + " unavailable");
            return;
        }
        try {
            Class<?> sup = c.getSuperclass();
            log("PROBE dump " + name + " extends " + (sup == null ? "null" : sup.getName()));

            for (Class<?> n : c.getDeclaredClasses()) {
                log("PROBE   nested " + n.getName());
            }
            for (Field f : c.getFields()) {
                log("PROBE   field  " + f.getType().getName() + " " + f.getName());
            }
            for (Constructor<?> k : c.getDeclaredConstructors()) {
                StringBuilder sb = new StringBuilder("PROBE   ctor   (");
                Class<?>[] ps = k.getParameterTypes();
                for (int j = 0; j < ps.length; j++) {
                    if (j > 0) sb.append(", ");
                    sb.append(ps[j].getName());
                }
                log(sb.append(')').toString());
            }
            for (Method m : c.getDeclaredMethods()) {
                if (m.isSynthetic() || m.getName().startsWith("access$")) {
                    continue;
                }
                StringBuilder sb = new StringBuilder("PROBE   method ");
                sb.append(java.lang.reflect.Modifier.toString(m.getModifiers())).append(' ');
                sb.append(m.getReturnType().getName()).append(' ').append(m.getName()).append('(');
                Class<?>[] ps = m.getParameterTypes();
                for (int j = 0; j < ps.length; j++) {
                    if (j > 0) sb.append(", ");
                    sb.append(ps[j].getName());
                }
                sb.append(')');
                log(sb.toString());
            }
        } catch (Throwable t) {
            log("PROBE dump " + name + " failed", t);
        }
    }

    private static String describe(ClassLoader cl) {
        if (cl == null) {
            return "null(boot)";
        }
        String s = cl.toString();
        if (s.length() > 260) {
            s = s.substring(0, 260) + "...";
        }
        return s;
    }

    static void log(String msg) {
        XposedBridge.log(TAG + ": " + msg);
    }

    static void log(String msg, Throwable t) {
        XposedBridge.log(TAG + ": " + msg);
        XposedBridge.log(t);
    }
}
