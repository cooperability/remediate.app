CREATE INDEX "idx_harvest_status" ON "harvests" USING btree ("user_id","status","id");--> statement-breakpoint
CREATE INDEX "idx_harvest_hash" ON "harvests" USING btree ("user_id","content_hash");