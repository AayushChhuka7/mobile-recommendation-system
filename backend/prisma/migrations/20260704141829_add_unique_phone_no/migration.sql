/*
  Warnings:

  - A unique constraint covering the columns `[phone_no]` on the table `users` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "users_phone_no_key" ON "users"("phone_no");
