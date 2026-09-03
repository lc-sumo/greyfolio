ALTER TABLE "commission_deal_draws" ADD COLUMN "term_days" integer;--> statement-breakpoint
ALTER TABLE "commission_deal_draws" ADD COLUMN "factor" numeric(8, 4);--> statement-breakpoint
ALTER TABLE "commission_deal_draws" ADD COLUMN "payback" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "commission_deal_draws" ADD COLUMN "payment" numeric(14, 2);