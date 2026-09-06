CREATE TABLE "commission_playbook_firings" (
	"id" text PRIMARY KEY NOT NULL,
	"playbook_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"rep_id" text,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "commission_playbooks" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"rule" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_rep_files" (
	"id" text PRIMARY KEY NOT NULL,
	"rep_id" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"data" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"deal_id" text NOT NULL,
	"rep_id" text NOT NULL,
	"playbook_id" text,
	"title" text NOT NULL,
	"due_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"outcome" text,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "commission_deals" ADD COLUMN "referral_paid_at" date;--> statement-breakpoint
ALTER TABLE "commission_deals" ADD COLUMN "renewed_from_id" text;--> statement-breakpoint
ALTER TABLE "commission_reps" ADD COLUMN "session_cutoff" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commission_reps" ADD COLUMN "calendar_token" text;--> statement-breakpoint
ALTER TABLE "commission_playbook_firings" ADD CONSTRAINT "commission_playbook_firings_playbook_id_commission_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."commission_playbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_playbook_firings" ADD CONSTRAINT "commission_playbook_firings_deal_id_commission_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."commission_deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_playbook_firings" ADD CONSTRAINT "commission_playbook_firings_rep_id_commission_reps_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."commission_reps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rep_files" ADD CONSTRAINT "commission_rep_files_rep_id_commission_reps_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."commission_reps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rep_files" ADD CONSTRAINT "commission_rep_files_uploaded_by_commission_reps_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."commission_reps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_tasks" ADD CONSTRAINT "commission_tasks_deal_id_commission_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."commission_deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_tasks" ADD CONSTRAINT "commission_tasks_rep_id_commission_reps_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."commission_reps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_tasks" ADD CONSTRAINT "commission_tasks_playbook_id_commission_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."commission_playbooks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_tasks" ADD CONSTRAINT "commission_tasks_created_by_commission_reps_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."commission_reps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commission_playbook_firings_deal_idx" ON "commission_playbook_firings" USING btree ("deal_id","playbook_id");--> statement-breakpoint
CREATE INDEX "commission_rep_files_rep_idx" ON "commission_rep_files" USING btree ("rep_id");--> statement-breakpoint
CREATE INDEX "commission_tasks_rep_idx" ON "commission_tasks" USING btree ("rep_id","status");--> statement-breakpoint
CREATE INDEX "commission_tasks_deal_idx" ON "commission_tasks" USING btree ("deal_id");