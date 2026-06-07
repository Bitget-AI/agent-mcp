// KMS-encrypted npm token for publishing under the `@bitget-ai` scope.
//
// Format (provided by @Sec Ma):
//   kms#<KMS-key-ARN>#<base64-encrypted-AES-key>#<MD5-of-AES-key>#<base64-AES-GCM-encrypted-token>
//
// The npm token's scope is `@bitget-ai`, not a single package, so the same
// encrypted blob is shared by every `@bitget-ai/*` package published from the
// same Spug EC2 host.
//
// Rotation: every 90 days. Procedure:
//   1. @Evan Zhe creates a new npm Granular Access Token (scope @bitget-ai,
//      Read+Write, Bypass 2FA, IP-restricted to the EC2 publisher).
//   2. @Sec Ma KMS-encrypts the raw token (KMS alias
//      bk-2721-morph-department-configEncryption) and returns the encrypted
//      blob over a secure channel.
//   3. Release manager replaces the TOKEN string below, bumps the
//      "Expires" comment, commits, and re-runs the Spug publish job to verify.
//
// Expires: 2026-08-30
export const TOKEN =
  "kms#arn:aws:kms:ap-northeast-1:491191455325:key/mrk-26584cf6e42e4235b0f7da562b2a383f#AgV4nvxvyWX8hy1+ZQbI0T4/6i/pKuBt3tHAQQ7c23l/K2EAdQACABVhd3MtY3J5cHRvLXB1YmxpYy1rZXkAREFuaTBIRldvK1JtaVM1NEVpVjNTUVA1N2wxMWFVVS9iQWllNzhEeFJ4MDFobmMra0ZKUlRoZXJuRytvSHloTmVRZz09AAp1cGV4QXBvbGxvAAhwcm9wZXJ0eQABAAdhd3Mta21zAFBhcm46YXdzOmttczphcC1ub3J0aGVhc3QtMTo0OTExOTE0NTUzMjU6a2V5L21yay0yNjU4NGNmNmU0MmU0MjM1YjBmN2RhNTYyYjJhMzgzZgC4AQIBAHistBbTiNv38Cosuy1V3uB/y8NiZFjaJHayV29G4K7SEQFUsKzjjZLGPqlVJAlTpr/9AAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMruKqALHpgFFUJZfcAgEQgDuKQaJk0T6GJqSUSeWrVlFniwBjuQOsdeAQM/i9kmgnFMkt06+3KNxKzup59zTkQzDvxo/s8utVNYuBeAIAABAAkEUR90ExuHkorQFmvGNh6E9QcIg8StZCBQ+sJ1lP766qadeVdsbXiJ5PcAZQcL6+/////wAAAAEAAAAAAAAAAAAAAAEAAAAgU1voF0Ylhp1XfHdVdZ4DQxFxk3aqunB32GZJI2Ac57KoTMFo8b1tGX8o4gJqqHA0AGcwZQIwCH57Hvf79GAOvZwmYByWfRkrVwvERKfjY/nHqcgzooI94rlsJ+uulZ7nJXmqLK/4AjEA4vxQKB89a6IsJD0YIHaDlAa53MuNuoPu6xczhhYWxrbazl8V0ASkrF5IyfSp5Iwz#3B52D88AA478109D751CB7467016C128#zOSElKSBNuRwKaupjjOv16puVTVBoX+cCH7OAx044FaJ8sJpjVslbhWr7ZaNBhaQsjhJKKWMwiIrkvvmnI48anKe0pqdCkIP";
