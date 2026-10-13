ALTER TABLE user_sessions ADD COLUMN family_id uuid NOT NULL DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE user_sessions ADD COLUMN revocation_reason varchar(32);
--> statement-breakpoint
ALTER TABLE user_sessions ADD COLUMN rotated_to_session_id uuid CONSTRAINT user_sessions_rotated_to_session_id_user_sessions_id_fk REFERENCES user_sessions (id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX user_sessions_user_family_idx ON user_sessions (user_id, family_id);
--> statement-breakpoint
CREATE UNIQUE INDEX user_sessions_rotation_child_unique ON user_sessions (rotated_to_session_id) WHERE rotated_to_session_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_rotation_not_self CHECK (rotated_to_session_id IS NULL OR rotated_to_session_id <> id);
