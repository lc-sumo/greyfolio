CREATE TABLE "commission_trusted_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"rep_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commission_trusted_devices" ADD CONSTRAINT "commission_trusted_devices_rep_id_commission_reps_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."commission_reps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commission_trusted_devices_rep_idx" ON "commission_trusted_devices" USING btree ("rep_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_trusted_devices_hash_idx" ON "commission_trusted_devices" USING btree ("token_hash");