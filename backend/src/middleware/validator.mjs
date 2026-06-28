import { validationResult, matchedData } from "express-validator";
import { hashPassword } from "../utils/crypto.mjs";

// validationWith(schemas, allowedFields?)
//
// Runs express-validator chains, hashes `data.password`, attaches cleaned
// data to `req.data`. If `allowedFields` is given, any extra body keys
// cause 400.
//
// usage:
//   validationWith(mySchema)                          // accept anything matchedData passes through
//   validationWith(mySchema, ["name", "phoneNo"])     // strict whitelist

export const validationWith = (schemas, allowedFields) => {
  const chain = Array.isArray(schemas) ? schemas : [schemas];

  return [
    ...chain,
    async (req, res, next) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array() });
      }

      if (allowedFields && req.body && typeof req.body === "object") {
        const unknown = Object.keys(req.body).filter(
          (f) => !allowedFields.includes(f),
        );
        if (unknown.length > 0) {
          return res.status(400).json({
            error: "Bad Request",
            message: `Unknown fields: ${unknown.join(", ")}`,
          });
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
