CREATE TABLE "commission_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_rep_id" text NOT NULL,
	"action" text NOT NULL,
	"target_rep_id" text,
	"path" text,
	"detail" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commission_audit_log" ADD CONSTRAINT "commission_audit_log_actor_rep_id_commission_reps_id_fk" FOREIGN KEY ("actor_rep_id") REFERENCES "public"."commission_reps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_audit_log" ADD CONSTRAINT "commission_audit_log_target_rep_id_commission_reps_id_fk" FOREIGN KEY ("target_rep_id") REFERENCES "public"."commission_reps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commission_audit_log_actor_idx" ON "commission_audit_log" USING btree ("actor_rep_id");--> statement-breakpoint
CREATE INDEX "commission_audit_log_at_idx" ON "commission_audit_log" USING btree ("at");