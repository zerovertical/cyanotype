package net.cyanotype.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

/* The entire point of this class.

   Android freezes background apps, which is what kills a WebRTC link when the
   phone locks. A foreground service tells the OS this process is doing
   something the user asked for, so it is left running — and because the WebView
   lives in this process, the page keeps running too.

   The permanent notification is not decoration. It is the price the platform
   charges for staying alive, and it cannot be hidden. The page starts the
   service only while a link is live and stops it when the last one goes, so the
   notification means what it says.
*/
public class LinkService extends Service {

    public static final String CHANNEL_ID = "cyanotype.link";
    public static final int NOTE_ID = 1;

    public static final String ACTION_START = "net.cyanotype.app.START_LINK";
    public static final String ACTION_STOP = "net.cyanotype.app.STOP_LINK";
    public static final String EXTRA_TEXT = "net.cyanotype.app.TEXT";

    /* Read by the plugin: the keep-visible workaround only runs while this
       service is holding a link open. */
    static volatile boolean running = false;

    /* Held only while the service is: that is, while a link is open or the page
       is looking for a contact that just dropped.

       The Wi-Fi lock stops the radio dozing between packets with the screen
       off, which otherwise lets the link's keep-alive checks go unanswered
       until WebRTC gives up on it. The wake lock keeps the CPU running the
       page's timers. Android honours both during deep sleep only when the user
       has let the app skip battery optimisation, which the page asks for. They
       cost battery, which is why they go the moment the service does. */
    private WifiManager.WifiLock wifiLock;
    private PowerManager.WakeLock wakeLock;

    @SuppressWarnings("deprecation")
    private void holdLocks() {
        try {
            if (wifiLock == null) {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
                if (wm != null) {
                    wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "cyanotype:link");
                    wifiLock.setReferenceCounted(false);
                }
            }
            if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "cyanotype:link");
                    wakeLock.setReferenceCounted(false);
                }
            }
            if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire();
        } catch (Exception ignored) {
            // Best effort: without the locks the link is more fragile, not broken.
        }
    }

    private void releaseLocks() {
        try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Exception ignored) { }
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) { }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID,
                    "Staying connected",
                    // LOW keeps it silent: it is a status indicator, not an alert.
                    NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while Cyanotype is holding a direct link to nearby phones.");
            ch.setShowBadge(false);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            /* A null intent means Android restarted us on its own. The page
               that owned the links died with the old process, so there is
               nothing to hold open: stop rather than show a false
               "connected". */
            running = false;
            releaseLocks();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        String text = intent.getStringExtra(EXTRA_TEXT);
        if (text == null) text = "Holding a direct link to nearby phones.";

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(
                this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification note = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Cyanotype is connected")
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_stat_link)
                .setContentIntent(tap)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();

        /* Android 10 and later want the service type declared at start as well
           as in the manifest. connectedDevice is the honest description: this
           process is maintaining a link to another device. Calling this again
           while running just updates the notification text. */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTE_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTE_ID, note);
        }
        running = true;
        holdLocks();

        /* NOT_STICKY: if the OS kills the process, the WebView and every link
           in it are gone too. Coming back on our own would only resurrect the
           notification, not the connection. */
        return START_NOT_STICKY;
    }

    /* Swiping the app away from recents destroys the page, and the links with
       it. Take the notification down too. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        running = false;
        releaseLocks();
        stopForeground(true);
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        releaseLocks();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
