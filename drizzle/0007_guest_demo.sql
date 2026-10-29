CREATE TABLE "guest_throttle" (
	"ip_hash" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"starts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "guest_expires_at" timestamp with time zone;