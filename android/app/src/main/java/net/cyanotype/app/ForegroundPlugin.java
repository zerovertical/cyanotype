package net.cyanotype.app;

import android.Manifest;
import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/* Bridges the foreground service to the page, so the web app decides when to
   hold the process open rather than the wrapper guessing. */
@CapacitorPlugin(
        name = "Foreground",
        permissions = {
                @Permission(alias = "notify", strings = { Manifest.permission.POST_NOTIFICATIONS })
        }
)
public class ForegroundPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        /* From Android 13 the notification is a runtime permission. Without it
           the service still runs, but silently — worth asking so the user can
           see the app is holding a link. */
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notify") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("notify", call, "afterNotifyPermission");
            return;
        }
        launch(call);
    }

    @PermissionCallback
    private void afterNotifyPermission(PluginCall call) {
        // Proceed either way: a missing notification is a cosmetic loss, not a
        // reason to leave the link unprotected.
        launch(call);
    }

    private void launch(PluginCall call) {
        Intent i = new Intent(getContext(), LinkService.class);
        i.setAction(LinkService.ACTION_START);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(i);
        } else {
            getContext().startService(i);
        }
        JSObject out = new JSObject();
        out.put("running", true);
        call.resolve(out);
    }

    /* A foreground service keeps the *process* alive. It does nothing about
       Chromium, which throttles a WebView it believes is not visible and, after
       roughly five minutes, backgrounds the renderer outright. Timers stop, and
       anything living in the renderer stops with them.

       The only lever from outside Chromium is to tell the view hierarchy the
       WebView is still visible. This is what the Cordova background-mode plugin
       has done for years. It is a workaround, not an API, so treat it as
       something to verify on your own devices rather than rely on.

       Call this AFTER the app has gone to the background: doing it earlier has
       no effect, because nothing has been throttled yet.

       It costs battery. That is the trade, and it is the reason this is a
       separate call rather than something start() does automatically. */
    @PluginMethod
    public void keepVisible(PluginCall call) {
        final android.webkit.WebView web = getBridge().getWebView();
        if (web == null) {
            call.reject("No WebView to keep visible.");
            return;
        }
        // A short delay lets the pause finish first, or the change is undone.
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(
                new Runnable() {
                    @Override
                    public void run() {
                        try {
                            web.onResume();
                            web.resumeTimers();
                            web.dispatchWindowVisibilityChanged(android.view.View.VISIBLE);
                        } catch (Exception ignored) {
                            // Best effort: a failure here means throttling stays,
                            // not that anything breaks.
                        }
                    }
                }, 1000);

        JSObject out = new JSObject();
        out.put("attempted", true);
        call.resolve(out);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent i = new Intent(getContext(), LinkService.class);
        i.setAction(LinkService.ACTION_STOP);
        getContext().startService(i);
        JSObject out = new JSObject();
        out.put("running", false);
        call.resolve(out);
    }
}
