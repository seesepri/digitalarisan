-- Phone-only signup: email remains optional for legacy profiles; account creation
-- and wallet/session provisioning happen only after a provider-approved SMS OTP.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
--> statement-breakpoint
CREATE TYPE phone_verification_purpose AS ENUM ('SIGNUP', 'LOGIN_VERIFY', 'PASSWORD_RESET');
--> statement-breakpoint

CREATE TABLE phone_verification_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone varchar(24) NOT NULL,
  purpose phone_verification_purpose NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  verification_attempts integer NOT NULL DEFAULT 0,
  verification_token uuid,
  verification_started_at timestamptz,
  last_sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT phone_verification_challenges_attempts_valid CHECK (verification_attempts >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX phone_verification_challenges_phone_unique ON phone_verification_challenges(phone);
--> statement-breakpoint
CREATE INDEX phone_verification_challenges_expires_idx ON phone_verification_challenges(expires_at);
