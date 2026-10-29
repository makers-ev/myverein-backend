ALTER TABLE "document_acknowledgements" ADD COLUMN "given_by" text;--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ADD COLUMN "proof_date" date;--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ADD COLUMN "proof_source" text;--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ADD COLUMN "requires_reauth" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ADD CONSTRAINT "document_ack_given_by_chk" CHECK ("document_acknowledgements"."given_by" IS NULL OR "document_acknowledgements"."given_by" IN ('self', 'guardian', 'board_paper'));--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ADD CONSTRAINT "document_ack_paper_proof_chk" CHECK ("document_acknowledgements"."given_by" IS DISTINCT FROM 'board_paper' OR ("document_acknowledgements"."proof_date" IS NOT NULL AND "document_acknowledgements"."proof_source" IS NOT NULL));