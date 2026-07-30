package com.syra.widgets

import com.syra.widgets.rooms.RoomsRefreshScheduler
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class SyraWidgetsModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("SyraWidgets")

        AsyncFunction("refreshLiveRooms") {
            val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
            RoomsRefreshScheduler.refreshNow(context)
        }
    }
}
