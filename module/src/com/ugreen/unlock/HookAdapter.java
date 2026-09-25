package com.ugreen.unlock;

import de.robv.android.xposed.XC_MethodHook;

/**
 * The single place in this module that names the XC_MethodHook base class.
 *
 * Why this indirection exists: the callback base class is resolved by the
 * module's own class loader, so if the name does not match what the running
 * framework actually exposes, the class that mentions it simply fails to
 * define (NoClassDefFoundError) and no hook can ever be installed.
 *
 * On LSPosed 2.1.1 / API 102 the live name is
 *   de.robv.android.xposed.XC_MethodHook
 * (the older de.robv.android.xposed.callbacks.XC_MethodHook does not exist).
 * Keep the rest of the module free of this import so the variant is a
 * one-file change.
 */
final class HookAdapter extends XC_MethodHook {

    /** Receives the framework's MethodHookParam as an opaque Object. */
    interface Handler {
        void onParam(Object param);
    }

    private final Handler handler;

    HookAdapter(Handler handler) {
        this.handler = handler;
    }

    @Override
    protected void afterHookedMethod(MethodHookParam param) {
        handler.onParam(param);
    }
}
