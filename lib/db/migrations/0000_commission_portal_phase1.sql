CREATE TABLE "commission_clawbacks" (
	"id" text PRIMARY KEY NOT NULL,
	"deal_id" text NOT NULL,
	"date" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"recovered" numeric(14, 2) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_deal_draws" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" text NOT NULL,
	"n" integer NOT NULL,
	"ref" text NOT NULL,
	"date" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"comm_rate" numeric(7, 5) NOT NULL,
	"gross" numeric(14, 2) NOT NULL,
	"referral_fee" numeric(14, 2) DEFAULT 0 NOT NULL,
	"net" numeric(14, 2) NOT NULL,
	"collected" numeric(14, 2),
	"schedule" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_deals" (
	"id" text PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"business" text NOT NULL,
	"lender" text NOT NULL,
	"product" text NOT NULL,
	"funded" numeric(14, 2) NOT NULL,
	"factor" numeric(8, 4),
	"term_days" integer,
	"payback" numeric(14, 2),
	"comm_rate" numeric(7, 5) NOT NULL,
	"referral_partner" text,
	"referral_rate" numeric(7, 5) DEFAULT 0 NOT NULL,
	"gross" numeric(14, 2) NOT NULL,
	"referral_fee" numeric(14, 2) DEFAULT 0 NOT NULL,
	"net" numeric(14, 2) NOT NULL,
	"opener_id" text,
	"opener_rate" numeric(7, 5) DEFAULT 0 NOT NULL,
	"closer_id" text,
	"closer_rate" numeric(7, 5) DEFAULT 0 NOT NULL,
	"override_id" text,
	"override_rate" numeric(7, 5) DEFAULT 0 NOT NULL,
	"deal_status" text DEFAULT 'Performing' NOT NULL,
	"rep_paid" date,
	"lender_paid" date,
	"lead_source" text,
	"notes" text,
	"opportunity_id" text NOT NULL,
	"parent_id" text,
	"merchant_contact" text DEFAULT '' NOT NULL,
	"merchant_email" text DEFAULT '' NOT NULL,
	"merchant_phone" text DEFAULT '' NOT NULL,
	"credit_line" numeric(14, 2),
	"draw_initial_pct" numeric(7, 5),
	"draw_subsequent_pct" numeric(7, 5),
	"psf_pct" numeric(7, 5) DEFAULT 0 NOT NULL,
	"origination_fee" numeric(14, 2) DEFAULT 0 NOT NULL,
	"comm_collected" numeric(14, 2),
	"comm_schedule" jsonb,
	"frequency" text DEFAULT 'Daily' NOT NULL,
	"apr" numeric(8, 4),
	"crm_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_payout_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"deal_id" text NOT NULL,
	"segment_key" text,
	"role" text NOT NULL,
	"rep_id" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"run_id" text,
	"clawback_id" text,
	"paid_at" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_payroll_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"start" date NOT NULL,
	"end" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"qb_posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_reps" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'rep' NOT NULL,
	"opener_rate" numeric(7, 5) DEFAULT 0.2 NOT NULL,
	"closer_rate" numeric(7, 5) DEFAULT 0.2 NOT NULL,
	"override_rate" numeric(7, 5),
	"team_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_sheets_sync" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"spreadsheet_id" text,
	"auto_push" boolean DEFAULT true NOT NULL,
	"last_push_at" timestamp with time zone,
	"last_pull_at" timestamp with time zone,
	"tab_hashes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_teams" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"leader_rep_id" text,
	"override_rate" numeric(7, 5) DEFAULT 0.05 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commission_clawbacks" ADD CONSTRAINT "commission_clawbacks_deal_id_commission_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."commission_deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_deal_draws" ADD CONSTRAINT "commission_deal_draws_deal_id_commission_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."commission_deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_deals" ADD CONSTRAINT "commission_deals_opener_id_commission_reps_id_fk" FOREIGN KEY ("opener_id") REFERENCES "public"."commission_reps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_deals" ADD CONSTRAINT "commission_deals_closer_id_commission_reps_id_fk" FOREIGN KEY ("closer_id") REFERENCES "public"."commission_reps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_deals" ADD CONSTRAINT "commission_deals_override_id_commission_reps_id_fk" FOREIGN KEY ("override_id") REFERENCES "public"."commission_reps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_deals" ADD CONSTRAINT "commission_deals_parent_id_commission_deals_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."commission_deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_payout_lines" ADD CONSTRAINT "commission_payout_lines_deal_id_commission_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."commission_deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_payout_lines" ADD CONSTRAINT "commission_payout_lines_rep_id_commission_reps_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."commission_reps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_payout_lines" ADD CONSTRAINT "commission_payout_lines_run_id_commission_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."commission_payroll_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_payout_lines" ADD CONSTRAINT "commission_payout_lines_clawback_id_commission_clawbacks_id_fk" FOREIGN KEY ("clawback_id") REFERENCES "public"."commission_clawbacks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_reps" ADD CONSTRAINT "commission_reps_team_id_commission_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."commission_teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_teams" ADD CONSTRAINT "commission_teams_leader_rep_id_commission_reps_id_fk" FOREIGN KEY ("leader_rep_id") REFERENCES "public"."commission_reps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commission_clawbacks_deal_idx" ON "commission_clawbacks" USING btree ("deal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_deal_draws_deal_n_idx" ON "commission_deal_draws" USING btree ("deal_id","n");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_deal_draws_deal_ref_idx" ON "commission_deal_draws" USING btree ("deal_id","ref");--> statement-breakpoint
CREATE INDEX "commission_deals_date_idx" ON "commission_deals" USING btree ("date");--> statement-breakpoint
CREATE INDEX "commission_deals_merchant_email_idx" ON "commission_deals" USING btree ("merchant_email");--> statement-breakpoint
CREATE INDEX "commission_deals_opportunity_idx" ON "commission_deals" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "commission_deals_opener_idx" ON "commission_deals" USING btree ("opener_id");--> statement-breakpoint
CREATE INDEX "commission_deals_closer_idx" ON "commission_deals" USING btree ("closer_id");--> statement-breakpoint
CREATE INDEX "commission_deals_override_idx" ON "commission_deals" USING btree ("override_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_payout_lines_key_idx" ON "commission_payout_lines" USING btree ("key");--> statement-breakpoint
CREATE INDEX "commission_payout_lines_rep_idx" ON "commission_payout_lines" USING btree ("rep_id");--> statement-breakpoint
CREATE INDEX "commission_payout_lines_run_idx" ON "commission_payout_lines" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "commission_payout_lines_deal_idx" ON "commission_payout_lines" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "commission_payout_lines_clawback_idx" ON "commission_payout_lines" USING btree ("clawback_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_reps_email_idx" ON "commission_reps" USING btree ("email");