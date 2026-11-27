// Sign in with Google on Android (CAP-113; ADR-011 §1, §3), the in-app native plugin pattern of CAP-65. JS API:
// `signIn({ serverClientId, nonce })` → `{ idToken }` | `{ cancelled: true }` | `{ error }`; it never rejects.
// Android Credential Manager first offers a Google ID option for the **Web** client id (the ID token's `aud`, which
// the API checks against `google-client-ids`) with the PKCE nonce, any account and auto-select; when the device has no
// such credential it falls back to the "Sign in with Google" sheet. The ID token goes back to JS and is never logged.
package com.naevatec.collectors

import android.os.CancellationSignal
import androidx.core.content.ContextCompat
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential

@CapacitorPlugin(name = "GoogleSignIn")
class GoogleSignInPlugin : Plugin() {

    @PluginMethod
    fun signIn(call: PluginCall) {
        val serverClientId = call.getString("serverClientId")
        val nonce = call.getString("nonce")
        if (serverClientId.isNullOrEmpty() || nonce.isNullOrEmpty()) return answer(call, error("invalid_request"))
        val googleId = GetGoogleIdOption.Builder()
            .setServerClientId(serverClientId)
            .setNonce(nonce)
            .setFilterByAuthorizedAccounts(false)
            .setAutoSelectEnabled(true)
            .build()
        request(call, GetCredentialRequest.Builder().addCredentialOption(googleId).build()) {
            // No Google ID credential on the device: the explicit "Sign in with Google" sheet instead.
            val button = GetSignInWithGoogleOption.Builder(serverClientId).setNonce(nonce).build()
            request(call, GetCredentialRequest.Builder().addCredentialOption(button).build(), null)
        }
    }

    /** One Credential Manager request; `onNoCredential` (if any) runs instead of answering "no credential". */
    private fun request(call: PluginCall, request: GetCredentialRequest, onNoCredential: (() -> Unit)?) {
        val activity = activity ?: return answer(call, error("no_activity"))
        CredentialManager.create(activity).getCredentialAsync(
            activity,
            request,
            CancellationSignal(),
            ContextCompat.getMainExecutor(activity),
            object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                override fun onResult(result: GetCredentialResponse) = answer(call, token(result))

                override fun onError(e: GetCredentialException) = when {
                    e is NoCredentialException && onNoCredential != null -> onNoCredential()
                    e is GetCredentialCancellationException -> answer(call, JSObject().put("cancelled", true))
                    else -> answer(call, error(e.type))
                }
            },
        )
    }

    /** The Google ID token of the response, or an error when the credential is of another kind. */
    private fun token(response: GetCredentialResponse): JSObject {
        val credential = response.credential
        if (credential !is CustomCredential || credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
            return error("unexpected_credential")
        }
        return try {
            JSObject().put("idToken", GoogleIdTokenCredential.createFrom(credential.data).idToken)
        } catch (_: Exception) {
            error("invalid_credential")
        }
    }

    private fun error(code: String) = JSObject().put("error", code)

    private fun answer(call: PluginCall, result: JSObject) = call.resolve(result)
}
