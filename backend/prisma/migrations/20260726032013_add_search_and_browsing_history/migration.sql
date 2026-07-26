-- CreateTable
CREATE TABLE "search_history" (
    "search_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "search_query" VARCHAR(200) NOT NULL,
    "searched_at" TIMESTAMP(6),
    "source_line" INTEGER,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "search_history_pkey" PRIMARY KEY ("search_id")
);

-- CreateTable
CREATE TABLE "browsing_history" (
    "browsing_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "phone_label" VARCHAR(200) NOT NULL,
    "brand_name" VARCHAR(60),
    "viewed_at" TIMESTAMP(6),
    "source_line" INTEGER,
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "browsing_history_pkey" PRIMARY KEY ("browsing_id")
);

-- CreateIndex
CREATE INDEX "search_history_user_id_searched_at_idx" ON "search_history"("user_id", "searched_at" DESC);

-- CreateIndex
CREATE INDEX "search_history_searched_at_idx" ON "search_history"("searched_at");

-- CreateIndex
CREATE INDEX "browsing_history_user_id_viewed_at_idx" ON "browsing_history"("user_id", "viewed_at" DESC);

-- CreateIndex
CREATE INDEX "browsing_history_viewed_at_idx" ON "browsing_history"("viewed_at");

-- AddForeignKey
ALTER TABLE "search_history" ADD CONSTRAINT "search_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browsing_history" ADD CONSTRAINT "browsing_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
