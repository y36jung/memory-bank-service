ALTER TABLE "chat_sessions" ADD COLUMN "device_id" text;--> statement-breakpoint
CREATE INDEX "chat_sessions_user_device_idx" ON "chat_sessions" USING btree ("user_id","device_id");