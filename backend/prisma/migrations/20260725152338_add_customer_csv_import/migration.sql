-- AlterTable
ALTER TABLE "user_preferences" ADD COLUMN     "preferred_brands" JSONB;

-- CreateTable
CREATE TABLE "payment_history" (
    "payment_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purchase_date" DATE,
    "purchase_amount_npr" DECIMAL(12,2),
    "payment_method" VARCHAR(60),
    "warranty_opted" VARCHAR(40),
    "exchange_history" JSONB,
    "phone_label" VARCHAR(200),
    "created_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_history_pkey" PRIMARY KEY ("payment_id")
);

-- CreateIndex
CREATE INDEX "payment_history_user_id_purchase_date_idx" ON "payment_history"("user_id", "purchase_date" DESC);

-- CreateIndex
CREATE INDEX "payment_history_purchase_date_idx" ON "payment_history"("purchase_date");

-- AddForeignKey
ALTER TABLE "payment_history" ADD CONSTRAINT "payment_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
