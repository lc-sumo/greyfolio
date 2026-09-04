ALTER TABLE "commission_deals" ADD COLUMN "line_rate" numeric(7, 5);--> statement-breakpoint
ALTER TABLE "commission_deals" ADD COLUMN "line_fee" numeric(14, 2) DEFAULT 0 NOT NULL;