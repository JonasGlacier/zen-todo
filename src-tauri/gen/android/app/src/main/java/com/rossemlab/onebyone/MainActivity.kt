package com.rossemlab.onebyone

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private var multicastLock: WifiManager.MulticastLock? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onResume() {
    super.onResume()
    try {
      if (multicastLock == null) {
        val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        multicastLock = wifi?.createMulticastLock("onebyone-lan-sync")?.apply {
          setReferenceCounted(false)
        }
      }
      multicastLock?.acquire()
    } catch (_: Exception) {
      // Ignore if multicast lock is unavailable on cellular-only devices.
    }
  }

  override fun onPause() {
    try {
      if (multicastLock?.isHeld == true) {
        multicastLock?.release()
      }
    } catch (_: Exception) {}
    super.onPause()
  }
}
