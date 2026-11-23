// The place the phone is at, as names only (CAP-100, features.md § Place from GPS), as an in-app Capacitor plugin like
// AppleSignInPlugin (CAP-65; no npm dependency). One call, `currentPlace()`: "when in use" location (asked the first
// time), one fix with reduced accuracy, then CLGeocoder on the device (free, no key, no server). Resolves
// `{ locality?, region?, countryCode?, deviceRegion? }` — `region` = subAdministrativeArea ?? administrativeArea —
// or `{}` on denial, error, no result or timeout. Never rejects; the fix itself never leaves this file.
// Calls made while a lookup is running share its answer. Registered by MainViewController.
import Capacitor
import CoreLocation

@objc(PlaceNamePlugin)
public class PlaceNamePlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "PlaceNamePlugin"
    public let jsName = "PlaceName"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "currentPlace", returnType: CAPPluginReturnPromise)
    ]

    /// Location fix plus reverse geocoding, once the permission is granted.
    // SPEC-GAP CAP-100: "≈ 3 s overall" is counted from the moment location is authorised: the one-time permission
    // alert is not timed, or the first cap would always come back empty while its owner reads the alert.
    static let timeout: TimeInterval = 3

    private var pending: [CAPPluginCall] = []
    private var manager: CLLocationManager?
    private var geocoder: CLGeocoder?
    private var deadline: DispatchWorkItem?
    private var locating = false

    @objc func currentPlace(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.pending.append(call)
            guard self.manager == nil else { return }
            let manager = CLLocationManager()
            manager.desiredAccuracy = kCLLocationAccuracyReduced
            self.manager = manager
            // The delegate is told the current authorisation right away (iOS 14+), which starts the lookup.
            manager.delegate = self
        }
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard manager === self.manager, !locating else { return }
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse, .authorizedAlways:
            locating = true
            let deadline = DispatchWorkItem { [weak self] in self?.finish([:]) }
            self.deadline = deadline
            DispatchQueue.main.asyncAfter(deadline: .now() + PlaceNamePlugin.timeout, execute: deadline)
            manager.requestLocation()
        default:
            finish([:])
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard manager === self.manager, geocoder == nil, let location = locations.last else { return }
        let geocoder = CLGeocoder()
        self.geocoder = geocoder
        geocoder.reverseGeocodeLocation(location) { [weak self] placemarks, _ in
            DispatchQueue.main.async {
                guard let self, self.geocoder === geocoder else { return }
                self.finish(PlaceNamePlugin.names(placemarks?.first))
            }
        }
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard manager === self.manager else { return }
        finish([:])
    }

    /// Answer every waiting call and drop the lookup (also cancels a geocoding still running after the deadline).
    private func finish(_ result: [String: Any]) {
        deadline?.cancel()
        deadline = nil
        geocoder?.cancelGeocode()
        geocoder = nil
        manager?.delegate = nil
        manager = nil
        locating = false
        let calls = pending
        pending = []
        for call in calls { call.resolve(result) }
    }

    /// The placemark's names: locality, then province or region, then the ISO country; plus the device's region.
    static func names(_ placemark: CLPlacemark?) -> [String: Any] {
        guard let placemark else { return [:] }
        var out: [String: Any] = [:]
        if let locality = placemark.locality { out["locality"] = locality }
        if let region = placemark.subAdministrativeArea ?? placemark.administrativeArea { out["region"] = region }
        if let country = placemark.isoCountryCode { out["countryCode"] = country }
        guard !out.isEmpty else { return [:] }
        let deviceRegion: String?
        if #available(iOS 16, *) {
            deviceRegion = Locale.current.region?.identifier
        } else {
            deviceRegion = Locale.current.regionCode
        }
        if let deviceRegion { out["deviceRegion"] = deviceRegion }
        return out
    }
}
