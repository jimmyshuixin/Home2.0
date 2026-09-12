# Administrator password provider

This directory verifies a single configured account using Firebase Auth REST. It
does not create users, implement public registration, store passwords, expose
Firebase tokens, provide cookies, or contact Google from the browser.

`createAuthProvider(config, dependencies)` returns a fail-closed provider if any
required runtime setting is missing or malformed. `FirebasePasswordProvider`
also validates configuration strictly when constructed directly. Inject `fetch`,
`now` (milliseconds), and `getGoogleAccessToken()` for testing. The latter must
return an OAuth access token for the configured Firebase project, with the
`firebaseauth.users.get` and `firebaseauth.users.update` permissions needed for
authoritative lookup and revocation. The caller owns service-credential handling;
no service-account secrets are loaded here.

The configuration is `projectId`, `apiKey`, `adminUid`, `adminUsername`,
`adminEmail`, `passwordResetUrl`. No actual administrator identity is hardcoded.
The API key is used only by the server; its policy must permit Firebase Auth
requests from the Worker. Confirm email/password login is enabled before live
testing. Having an existing anonymous Auth provider or Firestore access does not
establish this.

## Integration contract

- `signIn({ username, password })` returns only `{ uid, authTime }`. Persist both
  fields in the server-side opaque session; `authTime` is Unix seconds, not a
  session creation timestamp. A recent RS256 proof is checked against Google's
  fixed Secure Token JWK endpoint and the configured project/UID, then against
  the authoritative account state. No key URL is accepted from a JWT header.
- Every protected request must first validate the opaque session, then call
  `assertSession(identity)`. It checks the configured UID/email, disabled status,
  and Firebase `validSince` using service-authenticated account lookup. Lookup
  failure is a 503, never stale-session acceptance. Session expiry and idle timeout
  are enforced separately by SessionRepository.
- `changePassword({ uid, currentPassword, newPassword })` reauthenticates before
  updating Firebase. `confirmPasswordReset({ code, newPassword })` validates the
  action code and its fixed recipient before consuming it. On either success,
  revoke all opaque sessions, including the current one. An unavailable response
  during a remote mutation can be ambiguous: revoke local sessions in that case
  too and request fresh login/recovery; do not automatically retry password writes.
- `revokeAllSessions(uid)` updates Firebase `validSince`. Also increment the local
  authentication epoch/revoke local sessions: Firebase timestamps only have
  second precision and do not replace immediate local revocation.
- `requestPasswordReset({ username })` never accepts an email destination and
  silently does nothing for other usernames. Rate-limit this route independently.
  **Set Firebase Authentication's email-template custom action URL to
  `passwordResetUrl`.** REST `continueUrl` is a continuation parameter and does
  not itself replace the default Firebase-hosted action handler. The configured
  application must host this page and send code/new password to its own backend.
  Test actual link destination, expiry and delivery before marking recovery ready.
- New passwords use 15–128 Unicode code points. Existing passwords are not trimmed,
  normalized or truncated; input is capped at 1,024 UTF-16 code units. A stricter
  configured Firebase password policy may additionally reject a password.
- Router responsibilities: CSRF, exact Origin/CORS policy, request size limits,
  login/recovery throttling, `private, no-store`, secure cookies, and no credential
  logging. `AuthError` exposes only a fixed safe code/status/message. Never serialize
  request bodies or add upstream errors to the response or log.

All provider responses are bounded to 128 KiB, time out after 15 seconds, and
forbid redirects. No mock authentication implementation is exported. Tests inject
fake network responses and signing keys; they perform no live authentication.

## Official references, checked 2026-09-12

- [Firebase REST authentication and recovery](https://firebase.google.com/docs/reference/rest/auth/)
- [ID-token validation](https://firebase.google.com/docs/auth/admin/verify-id-tokens)
- [Authoritative account lookup](https://cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/lookup)
- [Account update and validSince](https://cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/update)
- [Revocation semantics](https://firebase.google.com/docs/auth/admin/manage-sessions)
- [Custom email action handlers](https://firebase.google.com/docs/auth/custom-email-handler)
- [OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
