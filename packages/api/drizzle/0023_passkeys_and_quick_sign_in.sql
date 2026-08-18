-- Passkeys, and quick sign-in on a device that has already signed in (#24).
--
-- Two mechanisms, kept apart on purpose.
--
-- A passkey is a real credential: the authenticator holds the private key, the
-- server holds the public one, and the ceremony only completes after the
-- device has verified the person. It travels with them, so a passkey in a
-- phone's keychain signs them in on the next phone with nobody reissuing
-- anything. It stands in for the password and the second factor together.
--
-- A quick sign-in credential is not a factor (doc 01 §10). It is a secret this
-- one device holds, sealed behind the phone's fingerprint or a six-digit PIN,
-- and redeeming it gets back a session the account already earned by signing
-- in properly. It never leaves the device, it expires if it is not used, and
-- it is bound to the device it was issued to.
--
-- Neither replaces the password. An account with no password is an account an
-- admin cannot hand back to somebody who has lost their phone.

CREATE TABLE IF NOT EXISTS "webauthn_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  -- Base64url, as the authenticator reports it. Unique across the whole
  -- system: one credential belongs to one account and cannot be claimed twice.
  "credential_id" text NOT NULL,
  "public_key" bytea NOT NULL,
  -- Authenticators that keep one report a replay when it goes backwards.
  -- Plenty report zero forever, which is why it is a signal and not a gate.
  "sign_count" bigint DEFAULT 0 NOT NULL,
  "transports" text,
  -- True where the authenticator syncs the key, which is the cross-device case.
  "backed_up" boolean DEFAULT false NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "webauthn_credentials_credential_idx"
  ON "webauthn_credentials" ("credential_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "webauthn_credentials_user_idx"
  ON "webauthn_credentials" ("user_id");--> statement-breakpoint

-- The challenge half of both ceremonies. Single use, short lived, and stored
-- rather than signed, because a replayed challenge is the attack this exists
-- to stop and a stateless one cannot be retired.
CREATE TABLE IF NOT EXISTS "webauthn_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "challenge" text NOT NULL,
  -- Null on a sign-in: a discoverable credential says who it is afterwards,
  -- which is what lets somebody sign in without typing an email first.
  "user_id" uuid REFERENCES "users"("id") ON DELETE cascade,
  "purpose" text NOT NULL,
  "device_id" uuid,
  "platform" "device_platform",
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "webauthn_challenges_challenge_idx"
  ON "webauthn_challenges" ("challenge");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "device_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "device_id" uuid,
  -- Argon2, like a password, because it is redeemed the same way one is.
  "secret_hash" text NOT NULL,
  -- Which way the device releases it, for the list on the security screen.
  "method" text NOT NULL,
  "label" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "device_credentials_user_idx"
  ON "device_credentials" ("user_id");
