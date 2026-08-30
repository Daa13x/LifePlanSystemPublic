package com.lifeplansystem.wear;

import android.app.Activity;
import android.os.Bundle;

// Deliberately the smallest possible compiling, installable Wear OS
// activity -- proves the module builds and launches on a real watch before
// any phone<->watch communication is attempted. The Wearable Data Layer
// API bridge (next task, Done/Later, quick capture) is a separate, larger
// piece of work that needs a paired phone app and physical/emulated watch
// to verify at all; see android/wear/README.md for the honest state of
// what this module does and does not do yet.
public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
    }
}
