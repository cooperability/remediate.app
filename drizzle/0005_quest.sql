ALTER TABLE "edges" DROP CONSTRAINT "edges_src_id_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "edges" DROP CONSTRAINT "edges_dst_id_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "quest_runs" DROP CONSTRAINT "quest_runs_current_node_id_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "review_log" ADD COLUMN "encounter_id" text;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_src_id_nodes_id_fk" FOREIGN KEY ("src_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_dst_id_nodes_id_fk" FOREIGN KEY ("dst_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_runs" ADD CONSTRAINT "quest_runs_current_node_id_nodes_id_fk" FOREIGN KEY ("current_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_edge_dst" ON "edges" USING btree ("user_id","dst_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_quest_run_user" ON "quest_runs" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_log_encounter" ON "review_log" USING btree ("encounter_id") WHERE encounter_id is not null;