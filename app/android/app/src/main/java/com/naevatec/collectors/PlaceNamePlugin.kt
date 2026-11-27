// The place the phone is at, as names only (CAP-112, Android twin of ios/App/App/PlaceNamePlugin.swift; features.md
// § Place from GPS). Same JS API: `currentPlace()` → `{ locality?, region?, countryCode?, deviceRegion? }`, or `{}` on
// denial, error, no result or timeout; never rejects. Coarse location only (ACCESS_COARSE_LOCATION), one fix from the
// network or passive provider (`getCurrentLocation` on API 30+, else the last known fix), then the on-device Geocoder
// (async API on 33+). No Google Play services. The fix itself never leaves this file.
package com.naevatec.collectors

import android.Manifest
import android.location.Address
import android.location.Geocoder
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.util.Locale
import java.util.concurrent.Executors

@CapacitorPlugin(
    name = "PlaceName",
    permissions = [Permission(alias = PlaceNamePlugin.LOCATION, strings = [Manifest.permission.ACCESS_COARSE_LOCATION])],
)
class PlaceNamePlugin : Plugin() {
    companion object {
        const val LOCATION = "location"

        /** Location plus geocoding, counted once the permission is granted (as on iOS, SPEC-GAP CAP-100). */
        const val TIMEOUT_MS = 3000L
    }

    private val main = Handler(Looper.getMainLooper())
    private val background = Executors.newSingleThreadExecutor()
    private val pending = mutableListOf<PluginCall>()
    private var cancel: CancellationSignal? = null
    private var deadline: Runnable? = null
    /** Lookup in flight; answers from an older (timed-out) one are dropped. Main thread only. */
    private var lookup = 0

    @PluginMethod
    fun currentPlace(call: PluginCall) {
        main.post {
            pending.add(call)
            if (pending.size > 1) return@post
            if (getPermissionState(LOCATION) == PermissionState.GRANTED) locate()
            else requestPermissionForAlias(LOCATION, call, "onPermission")
        }
    }

    @PermissionCallback
    private fun onPermission(call: PluginCall) {
        if (getPermissionState(LOCATION) == PermissionState.GRANTED) locate() else finish(lookup, JSObject())
    }

    private fun locate() {
        val id = ++lookup
        val finish = { result: JSObject -> finish(id, result) }
        val timeout = Runnable { finish(JSObject()) }
        deadline = timeout
        main.postDelayed(timeout, TIMEOUT_MS)
        val manager = context.getSystemService(LocationManager::class.java)
        val provider = listOf(LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
            .firstOrNull { manager?.isProviderEnabled(it) == true }
        if (manager == null || provider == null) return finish(JSObject())
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val signal = CancellationSignal()
                cancel = signal
                manager.getCurrentLocation(provider, signal, background) { location ->
                    try {
                        geocodeOrFinish(location ?: manager.getLastKnownLocation(provider), finish)
                    } catch (_: SecurityException) {
                        finish(JSObject())
                    }
                }
            } else {
                geocodeOrFinish(manager.getLastKnownLocation(provider), finish)
            }
        } catch (_: SecurityException) {
            finish(JSObject())
        }
    }

    private fun geocodeOrFinish(location: Location?, finish: (JSObject) -> Unit) {
        if (location == null) finish(JSObject()) else geocode(location, finish)
    }

    private fun geocode(location: Location, finish: (JSObject) -> Unit) {
        if (!Geocoder.isPresent()) return finish(JSObject())
        val geocoder = Geocoder(context, Locale.getDefault())
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                geocoder.getFromLocation(location.latitude, location.longitude, 1, object : Geocoder.GeocodeListener {
                    override fun onGeocode(addresses: MutableList<Address>) = finish(names(addresses.firstOrNull()))
                    override fun onError(errorMessage: String?) = finish(JSObject())
                })
            } else {
                background.execute {
                    @Suppress("DEPRECATION")
                    val address = runCatching { geocoder.getFromLocation(location.latitude, location.longitude, 1) }
                        .getOrNull()?.firstOrNull()
                    finish(names(address))
                }
            }
        } catch (_: Exception) {
            finish(JSObject())
        }
    }

    /** Locality, then province or region, then the ISO country; plus the device's region. Names only. */
    private fun names(address: Address?): JSObject {
        val out = JSObject()
        if (address == null) return out
        address.locality?.let { out.put("locality", it) }
        (address.subAdminArea ?: address.adminArea)?.let { out.put("region", it) }
        address.countryCode?.let { out.put("countryCode", it) }
        if (out.length() == 0) return out
        Locale.getDefault().country.takeIf { it.isNotEmpty() }?.let { out.put("deviceRegion", it) }
        return out
    }

    /** Answer every waiting call once, from the main thread, and drop the lookup (a stale lookup's answer is ignored). */
    private fun finish(id: Int, result: JSObject) {
        main.post {
            if (id != lookup || pending.isEmpty()) return@post
            deadline?.let { main.removeCallbacks(it) }
            deadline = null
            cancel?.cancel()
            cancel = null
            val calls = pending.toList()
            pending.clear()
            calls.forEach { it.resolve(result) }
        }
    }
}
