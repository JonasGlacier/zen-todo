package com.rossemlab.onebyone

import android.app.appfunctions.AppFunctionException
import android.app.appfunctions.AppFunctionService
import android.app.appfunctions.ExecuteAppFunctionRequest
import android.app.appfunctions.ExecuteAppFunctionResponse
import android.app.appsearch.GenericDocument
import android.content.pm.SigningInfo
import android.os.Build
import android.os.CancellationSignal
import android.os.OutcomeReceiver
import androidx.annotation.RequiresApi
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Android 16+ (API 36+) App Functions service exposing OneByOne's nested todo list
 * engine directly to system AI Agents (Gemini).
 */
@RequiresApi(Build.VERSION_CODES.BAKLAVA)
class OneByOneAppFunctionService : AppFunctionService() {
    private val executor = Executors.newSingleThreadExecutor()

    override fun onExecuteFunction(
        request: ExecuteAppFunctionRequest,
        callingPackage: String,
        signingInfo: SigningInfo,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<ExecuteAppFunctionResponse, AppFunctionException>
    ) {
        executor.execute {
            if (cancellationSignal.isCanceled) {
                callback.onError(
                    AppFunctionException(AppFunctionException.ERROR_CANCELLED, "Request cancelled")
                )
                return@execute
            }

            try {
                val fnId = request.functionIdentifier
                val params = request.parameters

                if (fnId.endsWith("getAgentSchema")) {
                    val schema = JSONObject()
                        .put("protocolVersion", 2)
                        .put(
                            "guidance",
                            "First write a task list. Then consider each task and, where useful, break it down into more specific subtasks in its children array. Keep simple tasks as leaves."
                        )
                        .put("colors", JSONArray(listOf("yellow", "orange", "pink", "purple", "blue", "green")))
                        .toString()
                    callback.onResult(buildStringResponse(schema))
                    return@execute
                }

                val agentRequest = when {
                    fnId.endsWith("listTaskLists") -> {
                        JSONObject().put("command", "list")
                    }
                    fnId.endsWith("undoLastAction") -> {
                        JSONObject().put("command", "undo")
                    }
                    fnId.endsWith("createTaskList") -> {
                        val title = params.getPropertyString("title")?.trim().orEmpty()
                        if (title.isEmpty()) {
                            callback.onError(
                                AppFunctionException(
                                    AppFunctionException.ERROR_INVALID_ARGUMENT,
                                    "Parameter 'title' is required"
                                )
                            )
                            return@execute
                        }
                        val color = params.getPropertyString("color")?.takeIf { it.isNotBlank() }
                        val todosRaw = params.getPropertyString("todosJson")?.takeIf { it.isNotBlank() } ?: "[]"
                        val todosArray = JSONArray(todosRaw)
                        val action = JSONObject()
                            .put("mode", "create")
                            .put("title", title)
                            .put("todos", todosArray)
                        if (color != null) action.put("color", color)
                        JSONObject()
                            .put("command", "apply")
                            .put("action", action)
                    }
                    fnId.endsWith("updateTaskList") -> {
                        val listId = params.getPropertyString("listId")?.trim().orEmpty()
                        val revision = params.getPropertyString("revision")?.trim().orEmpty()
                        val todosRaw = params.getPropertyString("todosJson")?.trim().orEmpty()
                        if (listId.isEmpty() || revision.isEmpty() || todosRaw.isEmpty()) {
                            callback.onError(
                                AppFunctionException(
                                    AppFunctionException.ERROR_INVALID_ARGUMENT,
                                    "Parameters 'listId', 'revision', and 'todosJson' are required"
                                )
                            )
                            return@execute
                        }
                        val action = JSONObject()
                            .put("mode", "update")
                            .put("listId", listId)
                            .put("todos", JSONArray(todosRaw))
                        params.getPropertyString("title")?.takeIf { it.isNotBlank() }?.let { action.put("title", it) }
                        params.getPropertyString("color")?.takeIf { it.isNotBlank() }?.let { action.put("color", it) }
                        JSONObject()
                            .put("command", "apply")
                            .put("revision", revision)
                            .put("action", action)
                    }
                    else -> {
                        callback.onError(
                            AppFunctionException(
                                AppFunctionException.ERROR_FUNCTION_NOT_FOUND,
                                "Unknown function identifier: $fnId"
                            )
                        )
                        return@execute
                    }
                }

                val rawReply = AppFunctionBridge.nativeExecute(
                    applicationContext.filesDir.absolutePath,
                    agentRequest.toString()
                )
                val envelope = JSONObject(rawReply)
                if (envelope.optBoolean("ok", false)) {
                    callback.onResult(buildStringResponse(envelope.getJSONObject("result").toString()))
                } else {
                    val errMsg = envelope.optString("error", "Operation failed")
                    val code = if (errMsg.contains("locked", ignoreCase = true)) {
                        AppFunctionException.ERROR_DENIED
                    } else if (errMsg.contains("Conflict:", ignoreCase = true) || errMsg.contains("Invalid", ignoreCase = true)) {
                        AppFunctionException.ERROR_INVALID_ARGUMENT
                    } else {
                        AppFunctionException.ERROR_APP_UNKNOWN_ERROR
                    }
                    callback.onError(AppFunctionException(code, errMsg))
                }
            } catch (e: Exception) {
                callback.onError(
                    AppFunctionException(
                        AppFunctionException.ERROR_INVALID_ARGUMENT,
                        e.message ?: "AppFunction execution error"
                    )
                )
            }
        }
    }

    override fun onDestroy() {
        executor.shutdown()
        super.onDestroy()
    }

    private fun buildStringResponse(jsonPayload: String): ExecuteAppFunctionResponse {
        val doc = GenericDocument.Builder<GenericDocument.Builder<*>>("", "", "")
            .setPropertyString(ExecuteAppFunctionResponse.PROPERTY_RETURN_VALUE, jsonPayload)
            .build()
        return ExecuteAppFunctionResponse(doc)
    }
}
