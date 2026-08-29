-- CreateIndex
CREATE INDEX "candidates_normalizedName_idx" ON "candidates" USING GIN ("normalizedName" gin_trgm_ops);
