import { validationResult, matchedData } from "express-validator";
import { hashPassword } from "../utils/crypto.mjs";
import { badRequest } from "../utils/ApiError.mjs";

export const validationWith = (schemas, allowedFields) => {
  const chain = Array.isArray(schemas) ? schemas : [schemas];

  return [
    ...chain,
    async (req, res, next) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        throw badRequest('Validation failed', errors.array());
      }

      if (allowedFields && req.body && typeof req.body === "object") {
        const unknown = Object.keys(req.body).filter(
          (f) => !allowedFields.includes(f),
        );
        if (unknown.length > 0) {
          throw badRequest(
            `Unknown fields: ${unknown.join(', ')}`
          );
        }
      }

      const data = matchedData(req, { locations: ["body"] });
      if (data.password) {
        data.password = await hashPassword(data.password);
      }
      req.data = data;

      next();
    },
  ];
};