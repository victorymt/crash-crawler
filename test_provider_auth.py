import unittest

from provider_auth import (
    ProviderAuthSessionError,
    bind_provider_auth_identity,
    merge_provider_auth_sessions,
    provider_auth_status,
    public_provider_auth_state,
)


class ProviderAuthSessionTests(unittest.TestCase):
    def test_identity_mismatch_is_structured_and_does_not_replace_session(self):
        current = merge_provider_auth_sessions({}, {
            "providerId": "relay",
            "origin": "https://relay.example",
            "userId": "42",
            "username": "alice",
            "authToken": "current-access",
            "updatedAt": "2026-08-05T10:00:00Z",
        })
        with self.assertRaises(ProviderAuthSessionError) as raised:
            bind_provider_auth_identity(
                current,
                {"data": {"id": "84", "username": "bob"}},
            )
        self.assertEqual(raised.exception.code, "account_mismatch")
        self.assertEqual(current["authToken"], "current-access")

    def test_stale_write_is_ignored_and_rotation_increments_generation(self):
        current = merge_provider_auth_sessions({}, {
            "providerId": "relay",
            "origin": "https://relay.example",
            "userId": "42",
            "authToken": "access-1",
            "updatedAt": "2026-08-05T10:00:00Z",
        })
        rotated = merge_provider_auth_sessions(current, {
            **current,
            "authToken": "access-2",
            "updatedAt": "2026-08-05T10:02:00Z",
        })
        stale = merge_provider_auth_sessions(rotated, {
            **rotated,
            "authToken": "stale-access",
            "generation": 99,
            "updatedAt": "2026-08-05T10:01:00Z",
        })
        self.assertEqual(rotated["generation"], current["generation"] + 1)
        self.assertEqual(stale, rotated)
        with self.assertRaises(ProviderAuthSessionError) as raised:
            merge_provider_auth_sessions({}, {
                "providerId": "other",
                "origin": "https://relay.example",
                "authToken": "wrong-provider",
            }, provider_id="relay", origin="https://relay.example")
        self.assertEqual(raised.exception.code, "provider_mismatch")

    def test_public_state_reports_health_without_identity_or_tokens(self):
        session = merge_provider_auth_sessions({}, {
            "providerId": "relay",
            "origin": "https://relay.example",
            "username": "alice",
            "authToken": "access",
            "refreshToken": "refresh",
            "expiresAt": "2000000",
            "updatedAt": "2026-08-05T10:00:00Z",
        })
        state = public_provider_auth_state(session, now_ms=1_000_000)
        self.assertEqual(provider_auth_status(session, 1_000_000), "authenticated")
        self.assertTrue(state["identityBound"])
        self.assertNotIn("authToken", state)
        self.assertNotIn("refreshToken", state)
        self.assertNotIn("username", state)


if __name__ == "__main__":
    unittest.main()
