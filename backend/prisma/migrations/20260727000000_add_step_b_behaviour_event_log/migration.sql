-- CreateTable
CREATE TABLE "events" (
    "event_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "event_type" VARCHAR(40) NOT NULL,
    "phone_id" UUID,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "behavior_scores" (
    "user_id" UUID NOT NULL,
    "tag" VARCHAR(60) NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "behavior_scores_pkey" PRIMARY KEY ("user_id","tag")
);

-- CreateIndex
CREATE INDEX "events_user_id_created_at_idx" ON "events"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "events_event_type_idx" ON "events"("event_type");

-- CreateIndex
CREATE INDEX "events_phone_id_idx" ON "events"("phone_id");

-- CreateIndex
CREATE INDEX "behavior_scores_user_id_idx" ON "behavior_scores"("user_id");

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "behavior_scores" ADD CONSTRAINT "behavior_scores_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;