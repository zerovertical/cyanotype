package net.cyanotype.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must be registered before super.onCreate, or the bridge starts
        // without knowing the plugin exists.
        registerPlugin(ForegroundPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
