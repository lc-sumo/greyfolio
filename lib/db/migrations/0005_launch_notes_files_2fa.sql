CREATE TABLE "commission_deal_files" (
	"id" text PRIMARY KEY NOT NULL,
	"deal_id" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"data" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_deal_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"deal_id" text NOT NULL,
	"author_rep_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_password_resets" (
	"id" text PRIMARY KEY NOT NULL,
	"rep_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commission_reps" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "commission_reps" ADD COLUMN "totp_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "commission_deal_files" ADD CONSTRAINT "commission_deal_files_deal_id_commission_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."commission_deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_deal_files" ADD CONSTRAINT "commission_deal_files_uploaded_by_commission_reps_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."commission_reps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_deal_notes" ADD CONSTRAINT "commission_deal_notes_deal_id_commission_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."commission_deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_deal_notes" ADD CONSTRAINT "commission_deal_notes_author_rep_id_commission_reps_id_fk" FOREIGN KEY ("author_rep_id") REFERENCES "public"."commission_reps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_password_resets" ADD CONSTRAINT "commission_password_resets_rep_id_commission_reps_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."commission_reps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commission_deal_files_deal_idx" ON "commission_deal_files" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "commission_deal_notes_deal_idx" ON "commission_deal_notes" USING btree ("deal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_password_resets_token_idx" ON "commission_password_resets" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "commission_password_resets_rep_idx" ON "commission_password_resets" USING btree ("rep_id");