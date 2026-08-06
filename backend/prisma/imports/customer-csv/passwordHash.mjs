// ---------------------------------------------------------------------------
// Password generation + hashing for imported customers.
//
// We use the project's existing hashing utility (bcrypt, cost 10) so any
// password these accounts eventually set will round-trip through the same
// code path. The raw generated password is NOT logged — these accounts are
// effectively disabled (`isVerified=false`) and the credentials exist only
// to satisfy the schema's `password` NOT NULL constraint.
// ---------------------------------------------------------------------------

import crypto from "crypto";
import { hashPassword } from "../../../src/utils/crypto.mjs";

/**
 * Generate a secure random password and return its bcrypt hash. The plain
 * password is discarded after hashing.
 *
 * @returns {Promise<string>} bcrypt hash
 */
export async function generateHashedPassword() {
  // 24 random bytes → 32-char base64. Plenty of entropy; we never need to
  // log or reproduce it.
  const plain = crypto.randomBytes(24).toString("base64");
  return await hashPassword(plain);
}
