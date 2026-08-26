package net.cyanotype.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/* The entire point of this class.

   Android freezes background apps, which is what kills a WebRTC link when the
   phone locks. A foreground service tells the OS this process is doing
   something the user asked for, so it is left running — and because the WebView
   lives in this process, the page keeps running too.

   The permanent notification is not decoration. It is the price the platform
   charges for staying alive, and it cannot be hidden.
*/
public class LinkService extends Service {

    public static final String CHANNEL_ID = "cyanotype.link";
    public static final int NOTE_ID = 1;

    public static final String ACTION_START = "net.cyanotype.app.START_LINK";
    public static final String ACTION_STOP = "net.cyanotype.app.STOP_LINK";

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
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(
                this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification note = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Cyanotype is connected")
                .setContentText("Holding a direct link to nearby phones.")
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentIntent(tap)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();

        /* Android 10 and later want the service type declared at start as well
           as in the manifest. connectedDevice is the honest description: this
           process is maintaining a link to another device. */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTE_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTE_ID, note);
        }

        // START_STICKY: if the OS kills us under memory pressure, come back.
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
