// The app's bridge view controller (CAP-65): Capacitor's CAPBridgeViewController plus the in-app plugins that are not
// npm packages — today only AppleSignInPlugin (native Sign in with Apple). Used by SceneDelegate and Main.storyboard.
import Capacitor
import UIKit

class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AppleSignInPlugin())
    }
}
