DROP INDEX "channel_links_channel_user_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "channel_links_channel_user_id_uniq" ON "channel_links" USING btree ("channel","channel_user_id");