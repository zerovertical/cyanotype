package net.cyanotype.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.Settings;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/* Everything the page needs from Android that a WebView cannot do on its own:

   - holding the process open while links are live (start / stop / keepVisible)
   - real notifications (the WebView has no Notification API at all)
   - saving received files (the WebView ignores <a download>)
   - staying connected with the screen off (battery optimisation)
   - finding contacts again on the same Wi-Fi (see LanLink)

   The page decides when each of these happens. The wrapper never guesses. */
@CapacitorPlugin(
        name = "Foreground",
        permissions = {
                @Permission(alias = "notify", strings = { Manifest.permission.POST_NOTIFICATIONS })
        }
)
public class ForegroundPlugin extends Plugin {

    static final String CH_MESSAGES = "cyanotype.messages";
    static final String CH_CALLS = "cyanotype.calls";
    static final String EXTRA_CONV = "net.cyanotype.app.CONV";

    // All alerts share one id and are told apart by tag, so a chat's
    // notification is replaced rather than stacked.
    private static final int ALERT_ID = 100;

    @Override
    public void load() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getContext().getSystemService(NotificationManager.class);
            if (nm == null) return;

            NotificationChannel msgs = new NotificationChannel(
                    CH_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH);
            msgs.setDescription("New messages, files and location shares.");
            msgs.enableVibration(true);
            msgs.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
            nm.createNotificationChannel(msgs);

            NotificationChannel calls = new NotificationChannel(
                    CH_CALLS, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
            calls.setDescription("Rings when someone calls you.");
            calls.enableVibration(true);
            calls.setVibrationPattern(new long[] { 0, 400, 300, 400, 300, 400 });
            calls.setSound(
                    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                    new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build());
            calls.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
            nm.createNotificationChannel(calls);
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Keeping the process alive                                          */
    /* ------------------------------------------------------------------ */

    @PluginMethod
    public void start(PluginCall call) {
        /* From Android 13 the notification is a runtime permission. Without it
           the service still runs, but silently — worth asking so the user can
           see the app is holding a link. */
        if (needsNotifyPermission()) {
            requestPermissionForAlias("notify", call, "afterStartPermission");
            return;
        }
        launch(call);
    }

    @PermissionCallback
    private void afterStartPermission(PluginCall call) {
        // Proceed either way: a missing notification is a cosmetic loss, not a
        // reason to leave the link unprotected.
        launch(call);
    }

    private void launch(PluginCall call) {
        Intent i = new Intent(getContext(), LinkService.class);
        i.setAction(LinkService.ACTION_START);
        i.putExtra(LinkService.EXTRA_TEXT, call.getString("text", "Holding a direct link to nearby phones."));
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(i);
            } else {
                getContext().startService(i);
            }
        } catch (Exception e) {
            /* Android 12+ refuses to start a foreground service from the
               background. The page retries next time it is in front. */
            call.reject("Could not start the service: " + e.getMessage());
            return;
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

       It costs battery. That is the trade, and it is the reason it only runs
       while LinkService is up, i.e. while a link is actually live. It is
       triggered from handleOnPause below, natively, so it does not depend on
       the page getting a chance to react as it goes to the background. */
    @PluginMethod
    public void keepVisible(PluginCall call) {
        if (!scheduleKeepVisible()) {
            call.reject("No WebView to keep visible.");
            return;
        }
        JSObject out = new JSObject();
        out.put("attempted", true);
        call.resolve(out);
    }

    private boolean scheduleKeepVisible() {
        final android.webkit.WebView web = getBridge().getWebView();
        if (web == null) return false;
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
        return true;
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent i = new Intent(getContext(), LinkService.class);
        i.setAction(LinkService.ACTION_STOP);
        try {
            getContext().startService(i);
        } catch (Exception ignored) {
            // Not running, or not allowed to be poked from here: either way it
            // is not holding anything open.
        }
        JSObject out = new JSObject();
        out.put("running", false);
        call.resolve(out);
    }

    /* ------------------------------------------------------------------ */
    /*  Staying connected with the screen off                              */
    /* ------------------------------------------------------------------ */

    /* Doze cuts an app's network off while the phone is locked, foreground
       service or not, unless the user has let it skip battery optimisation.
       Only the user can grant that; the page asks once and explains why. */
    private boolean batteryExempt() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    @PluginMethod
    public void batteryStatus(PluginCall call) {
        JSObject out = new JSObject();
        out.put("exempt", batteryExempt());
        call.resolve(out);
    }

    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        JSObject out = new JSObject();
        if (batteryExempt()) {
            out.put("exempt", true);
            call.resolve(out);
            return;
        }
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception e) {
            // Some phones hide the direct prompt; the full list still works.
            try {
                Intent j = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                j.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(j);
            } catch (Exception e2) {
                call.reject("This phone would not open its battery settings. Look for Cyanotype under Settings, Apps, Battery.");
                return;
            }
        }
        // The answer comes later: the page checks again when it is back in front.
        out.put("exempt", false);
        call.resolve(out);
    }

    /* ------------------------------------------------------------------ */
    /*  Finding contacts on the same Wi-Fi                                 */
    /* ------------------------------------------------------------------ */

    private LanLink lan;

    private synchronized LanLink lan() {
        if (lan == null) {
            lan = new LanLink(getContext(), new LanLink.Events() {
                @Override public void peer(String peer, boolean found) {
                    JSObject d = new JSObject();
                    d.put("peer", peer);
                    d.put("found", found);
                    notifyListeners("lanPeer", d);
                }
                @Override public void frame(String conn, String data) {
                    JSObject d = new JSObject();
                    d.put("conn", conn);
                    d.put("data", data);
                    notifyListeners("lanFrame", d);
                }
                @Override public void closed(String conn) {
                    JSObject d = new JSObject();
                    d.put("conn", conn);
                    notifyListeners("lanClosed", d);
                }
            });
        }
        return lan;
    }

    @PluginMethod
    public void lanStart(PluginCall call) {
        try {
            String name = lan().start();
            JSObject out = new JSObject();
            out.put("name", name);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("Could not look for phones on this network: " + e.getMessage());
        }
    }

    @PluginMethod
    public void lanStop(PluginCall call) {
        lan().stop();
        call.resolve();
    }

    /* Connecting can take a few seconds, so it never runs on the bridge thread. */
    @PluginMethod
    public void lanConnect(final PluginCall call) {
        final String peer = call.getString("peer");
        if (peer == null) { call.reject("No phone named."); return; }
        new Thread(() -> {
            try {
                String conn = lan().connect(peer);
                JSObject out = new JSObject();
                out.put("conn", conn);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("Could not reach that phone: " + e.getMessage());
            }
        }, "cyanotype-lan-connect").start();
    }

    @PluginMethod
    public void lanSend(PluginCall call) {
        try {
            lan().send(call.getString("conn", ""), call.getString("data", ""));
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void lanClose(PluginCall call) {
        lan().close(call.getString("conn", ""));
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (lan != null) lan.stop();
        super.handleOnDestroy();
    }

    /* ------------------------------------------------------------------ */
    /*  Notifications                                                      */
    /* ------------------------------------------------------------------ */

    private boolean needsNotifyPermission() {
        return Build.VERSION.SDK_INT >= 33 && getPermissionState("notify") != PermissionState.GRANTED;
    }

    @PluginMethod
    public void requestAlerts(PluginCall call) {
        if (needsNotifyPermission()) {
            requestPermissionForAlias("notify", call, "afterAlertPermission");
            return;
        }
        afterAlertPermission(call);
    }

    @PermissionCallback
    private void afterAlertPermission(PluginCall call) {
        JSObject out = new JSObject();
        out.put("granted", NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
        call.resolve(out);
    }

    /* Named showAlert rather than notify: Object already has a notify(). */
    @PluginMethod
    public void showAlert(PluginCall call) {
        String title = call.getString("title", "Cyanotype");
        String body = call.getString("body", "");
        String tag = call.getString("tag", "cyanotype");
        String convId = call.getString("convId");
        boolean isCall = "call".equals(call.getString("kind"));

        NotificationManagerCompat nm = NotificationManagerCompat.from(getContext());
        if (needsNotifyPermission() || !nm.areNotificationsEnabled()) {
            JSObject out = new JSObject();
            out.put("shown", false);
            call.resolve(out);
            return;
        }

        Intent open = new Intent(getContext(), MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (convId != null) open.putExtra(EXTRA_CONV, convId);
        PendingIntent tap = PendingIntent.getActivity(
                getContext(), tag.hashCode(), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        String channel = isCall ? CH_CALLS : CH_MESSAGES;

        /* Marked private, with this as the stand-in: phones set to hide
           sensitive content on the lock screen show this instead of the
           message until they are unlocked. */
        Notification publicVersion = new NotificationCompat.Builder(getContext(), channel)
                .setSmallIcon(isCall ? R.drawable.ic_stat_call : R.drawable.ic_stat_message)
                .setContentTitle("Cyanotype")
                .setContentText(isCall ? "Incoming call" : "New message")
                .build();

        NotificationCompat.Builder b = new NotificationCompat.Builder(getContext(), channel)
                .setSmallIcon(isCall ? R.drawable.ic_stat_call : R.drawable.ic_stat_message)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(tap)
                .setAutoCancel(true)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPublicVersion(publicVersion)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(isCall ? NotificationCompat.CATEGORY_CALL : NotificationCompat.CATEGORY_MESSAGE);
        if (isCall) b.setTimeoutAfter(45_000);

        try {
            nm.notify(tag, ALERT_ID, b.build());
        } catch (SecurityException e) {
            // Permission withdrawn between the check and the post.
            JSObject out = new JSObject();
            out.put("shown", false);
            call.resolve(out);
            return;
        }
        JSObject out = new JSObject();
        out.put("shown", true);
        call.resolve(out);
    }

    @PluginMethod
    public void clearAlert(PluginCall call) {
        String tag = call.getString("tag");
        NotificationManagerCompat nm = NotificationManagerCompat.from(getContext());
        if (tag != null) nm.cancel(tag, ALERT_ID);
        call.resolve();
    }

    /* Whether the app is really in front. The page cannot trust
       document.hidden once keepVisible() has told the WebView it is visible,
       and it needs the truth to decide on notifications and read receipts. */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        JSObject d = new JSObject();
        d.put("active", true);
        notifyListeners("appstate", d);
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        if (LinkService.running) scheduleKeepVisible();
        JSObject d = new JSObject();
        d.put("active", false);
        notifyListeners("appstate", d);
    }

    /* A tap on a notification while the app is still running arrives here. */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null) return;
        String convId = intent.getStringExtra(EXTRA_CONV);
        if (convId == null) return;
        intent.removeExtra(EXTRA_CONV);
        JSObject data = new JSObject();
        data.put("convId", convId);
        notifyListeners("open", data, true);
    }

    /* A tap that had to start the activity from scratch: the page asks for it
       once it has booted. */
    @PluginMethod
    public void launchTarget(PluginCall call) {
        JSObject out = new JSObject();
        if (getActivity() != null && getActivity().getIntent() != null) {
            Intent i = getActivity().getIntent();
            String convId = i.getStringExtra(EXTRA_CONV);
            if (convId != null) {
                out.put("convId", convId);
                i.removeExtra(EXTRA_CONV);
            }
        }
        call.resolve(out);
    }

    /* ------------------------------------------------------------------ */
    /*  Saving received files                                              */
    /* ------------------------------------------------------------------ */

    /* Files arrive in pieces so a 30 MB attachment is never one giant string
       crossing the bridge. */
    private static class PendingSave {
        OutputStream out;
        Uri uri;
        File file;
        String shownAs;
    }

    private final Map<String, PendingSave> saves = new HashMap<>();

    private static String safeName(String name) {
        String n = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (n.isEmpty() || n.equals(".") || n.equals("..")) n = "file";
        return n.length() > 120 ? n.substring(n.length() - 120) : n;
    }

    @PluginMethod
    public void saveStart(PluginCall call) {
        String name = safeName(call.getString("name", "file"));
        String mime = call.getString("mime", "application/octet-stream");
        PendingSave s = new PendingSave();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver r = getContext().getContentResolver();
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                cv.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Cyanotype");
                cv.put(MediaStore.MediaColumns.IS_PENDING, 1);
                s.uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (s.uri == null) throw new IllegalStateException("Downloads refused the file.");
                s.out = r.openOutputStream(s.uri);
                s.shownAs = "Downloads/Cyanotype/" + name;
            } else {
                /* Android 9 and older would need a storage permission for the
                   shared Downloads folder; the app's own folder needs none. */
                File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) throw new IllegalStateException("No storage available.");
                File f = new File(dir, name);
                int n = 1;
                while (f.exists()) f = new File(dir, "(" + (n++) + ") " + name);
                s.file = f;
                s.out = new FileOutputStream(f);
                s.shownAs = f.getAbsolutePath();
            }
        } catch (Exception e) {
            call.reject("Could not save: " + e.getMessage());
            return;
        }
        String id = UUID.randomUUID().toString();
        synchronized (saves) { saves.put(id, s); }
        JSObject out = new JSObject();
        out.put("id", id);
        call.resolve(out);
    }

    @PluginMethod
    public void saveChunk(PluginCall call) {
        PendingSave s;
        synchronized (saves) { s = saves.get(call.getString("id", "")); }
        if (s == null) { call.reject("Unknown save."); return; }
        try {
            s.out.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            call.resolve();
        } catch (Exception e) {
            abort(call.getString("id", ""));
            call.reject("Could not save: " + e.getMessage());
        }
    }

    @PluginMethod
    public void saveFinish(PluginCall call) {
        PendingSave s;
        synchronized (saves) { s = saves.remove(call.getString("id", "")); }
        if (s == null) { call.reject("Unknown save."); return; }
        try {
            s.out.close();
            if (s.uri != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContext().getContentResolver().update(s.uri, cv, null, null);
            }
        } catch (Exception e) {
            call.reject("Could not save: " + e.getMessage());
            return;
        }
        JSObject out = new JSObject();
        out.put("savedAs", s.shownAs);
        call.resolve(out);
    }

    @PluginMethod
    public void saveAbort(PluginCall call) {
        abort(call.getString("id", ""));
        call.resolve();
    }

    private void abort(String id) {
        PendingSave s;
        synchronized (saves) { s = saves.remove(id); }
        if (s == null) return;
        try { s.out.close(); } catch (Exception ignored) { }
        try {
            if (s.uri != null) getContext().getContentResolver().delete(s.uri, null, null);
            if (s.file != null) //noinspection ResultOfMethodCallIgnored
                s.file.delete();
        } catch (Exception ignored) { }
    }
}
