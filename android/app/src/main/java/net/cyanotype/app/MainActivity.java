package net.cyanotype.app;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must be registered before super.onCreate, or the bridge starts
        // without knowing the plugin exists.
        registerPlugin(ForegroundPlugin.class);
        super.onCreate(savedInstanceState);

        /* The page has its own screens, not browser history, so the system
           back gesture is offered to the page first. If the page is already on
           its home screen, send the app to the background instead of closing
           it: closing would destroy the WebView and drop every live link. */
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = getBridge() != null ? getBridge().getWebView() : null;
                if (web == null) {
                    moveTaskToBack(true);
                    return;
                }
                web.evaluateJavascript(
                        "(function(){try{return !!(window.cyanotypeBack&&window.cyanotypeBack())}catch(e){return false}})()",
                        value -> {
                            if (!"true".equals(value)) moveTaskToBack(true);
                        });
            }
        });
    }

    @Override
    public void onDestroy() {
        /* The activity going away for good takes the WebView and its links
           with it, so the "connected" notification must go too. */
        if (isFinishing()) {
            Intent i = new Intent(this, LinkService.class);
            i.setAction(LinkService.ACTION_STOP);
            try {
                startService(i);
            } catch (Exception ignored) {
                // Not running, or not allowed from here — nothing to stop.
            }
        }
        super.onDestroy();
    }
}
