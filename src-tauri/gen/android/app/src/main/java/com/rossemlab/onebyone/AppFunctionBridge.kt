package com.rossemlab.onebyone

object AppFunctionBridge {
    init {
        System.loadLibrary("onebyone_lib")
    }

    @JvmStatic
    external fun nativeExecute(dataDir: String, requestJson: String): String
}
