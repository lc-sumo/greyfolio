ALTER TABLE "commission_reps" ADD COLUMN "super_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "commission_reps" ADD COLUMN "perms" jsonb;