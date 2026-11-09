// Native Sign in with Apple as an in-app Capacitor plugin (CAP-65; ADR-008 §4). Replaces
// @capacitor-community/apple-sign-in, whose only release pins Capacitor 7 and breaks the Capacitor 8 package graph.
// One call, `authorize({ nonce })`: an ASAuthorizationAppleIDProvider request with no scopes (no name or e-mail;
// the API keys the allow-list on `sub`) and the PKCE nonce passed as received, so the API's nonce check
// (base64url(SHA-256(codeVerifier)) in the identity token) is unchanged. Resolves
// `{ identityToken, authorizationCode?, user }`; rejects with code `cancelled` when the user closes the sheet,
// otherwise with the ASAuthorizationError code name. Registered by MainViewController.
import AuthenticationServices
import Capacitor
import UIKit

@objc(AppleSignInPlugin)
public class AppleSignInPlugin: CAPPlugin, CAPBridgedPlugin, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding
{
    public let identifier = "AppleSignInPlugin"
    public let jsName = "AppleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise)
    ]

    /// The call waiting for the sheet, and the controller kept alive until it answers.
    private var pendingCall: CAPPluginCall?
    private var controller: ASAuthorizationController?

    @objc func authorize(_ call: CAPPluginCall) {
        guard let nonce = call.getString("nonce"), !nonce.isEmpty else {
            call.reject("authorize needs a nonce", "invalidRequest")
            return
        }
        DispatchQueue.main.async {
            // A second tap while the sheet is up supersedes the first attempt.
            self.pendingCall?.reject("Superseded by a new sign-in attempt", "cancelled")
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = []
            request.nonce = nonce
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.pendingCall = call
            self.controller = controller
            controller.performRequests()
        }
    }

    private func finish() -> CAPPluginCall? {
        let call = pendingCall
        pendingCall = nil
        controller = nil
        return call
    }

    public func authorizationController(
        controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guard let call = finish() else { return }
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
            let tokenData = credential.identityToken,
            let identityToken = String(data: tokenData, encoding: .utf8)
        else {
            call.reject("Sign in with Apple returned no identity token", "invalidResponse")
            return
        }
        var result: [String: Any] = ["identityToken": identityToken, "user": credential.user]
        if let codeData = credential.authorizationCode, let code = String(data: codeData, encoding: .utf8) {
            result["authorizationCode"] = code
        }
        call.resolve(result)
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard let call = finish() else { return }
        call.reject(error.localizedDescription, AppleSignInPlugin.codeName(error), error)
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        bridge?.webView?.window ?? ASPresentationAnchor()
    }

    /// `cancelled` for a closed sheet (the app treats it as a silent cancel), else the ASAuthorizationError name.
    static func codeName(_ error: Error) -> String {
        guard let authError = error as? ASAuthorizationError else { return "unknown" }
        switch authError.code {
        case .canceled: return "cancelled"
        case .unknown: return "unknown"
        case .invalidResponse: return "invalidResponse"
        case .notHandled: return "notHandled"
        case .failed: return "failed"
        case .notInteractive: return "notInteractive"
        default: return "error\(authError.code.rawValue)"
        }
    }
}
