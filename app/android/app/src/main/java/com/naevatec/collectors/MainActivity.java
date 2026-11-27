package com.naevatec.collectors;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * The Capacitor shell (CAP-112): registers the in-app plugins (place, CAP-112; Google sign-in, CAP-113) before the
 * bridge starts, as MainViewController does on iOS.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PlaceNamePlugin.class);
        registerPlugin(GoogleSignInPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
