package com.naevatec.collectors;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/** The Capacitor shell (CAP-112): registers the in-app plugins before the bridge starts, as MainViewController on iOS. */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PlaceNamePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
