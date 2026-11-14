package com.rossemlab.onebyone

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var multicastLock: WifiManager.MulticastLock? = null

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    val finishEditing = """
      (() => {
        const editor = document.activeElement;
        if (editor instanceof HTMLTextAreaElement ||
            (editor instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit'].includes(editor.type)) ||
            (editor instanceof HTMLElement && editor.isContentEditable)) {
          editor.blur();
          return true;
        }
        return false;
      })()
    """.trimIndent()

    // The IME can consume Back before the Activity sees it. End the DOM edit
    // when that first Back hides the keyboard, so the toolbar also disappears
    // and the existing blur handler commits the text.
    var imeWasVisible = false
    webView.viewTreeObserver.addOnGlobalLayoutListener {
      val imeVisible = ViewCompat.getRootWindowInsets(webView)
        ?.isVisible(WindowInsetsCompat.Type.ime()) == true
      if (imeWasVisible && !imeVisible) {
        webView.evaluateJavascript(finishEditing, null)
      }
      imeWasVisible = imeVisible
    }

    // Covers Back with a hardware keyboard or an already-hidden IME as well.
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript(finishEditing) { handled ->
          if (handled == "true") {
            ViewCompat.getWindowInsetsController(webView)?.hide(WindowInsetsCompat.Type.ime())
          } else if (webView.canGoBack()) {
            webView.goBack()
          } else {
            isEnabled = false
            try {
              onBackPressedDispatcher.onBackPressed()
            } finally {
              isEnabled = true
            }
          }
        }
      }
    })
  }

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
