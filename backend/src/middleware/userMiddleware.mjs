// import { checkSchema } from "express-validator";

import { checkSchema, validationResult, matchedData } from "express-validator";
import { userCreationValidation } from "../validation/userValidation.mjs";
import { mockUsers } from "../mockData/userData.mjs";
import { prisma } from "../config/index.mjs";
import { asyncHandler } from "./errorHandler.mjs";

// export const validateAllowedKeys = (allowedKeys) => {
//   const schema = {};

//   allowedKeys.forEach((key) => {
//     console.log(schema[key]);
//     schema[key] = {
//       in: ["query"],
//       optional: true,
//     };
//   });

//   return [
//     checkSchema(schema),
//     (req, res, next) => {
//       const errors = validationResult(req);
//       if (!errors.isEmpty()) {
//         return res.status(400).json({ errors: errors.array() });
//       }

//       const incomingKeys = Object.keys(req.query);
//       const extraKeys = incomingKeys.filter(
//         (key) => !allowedKeys.includes(key),
//       );

//       if (extraKeys.length > 0) {
//         return res.status(400).json({
//           error: "Bad Request",
//           message: `Unexpected parameters found: ${extraKeys.join(", ")}`,
//         });
//       }

//       req.query = matchedData(req, { locations: ["query"] });

//       next();
//     },
//   ];
// };

export const validationWith = (...validations) => {
  return [
    ...validations,
    (req, res, next) => {
      const error = validationResult(req);
      if (!error.isEmpty()) {
        return res.status(400).json({ error: error.array() });
      }

      const data = matchedData(req, { locations: ["body"] });
      req.data = data;
      next();
    },
  ];
};

export const checkId = asyncHandler(async (req, res, next) => {
  const id = req.params.id;
  // const user = mockUsers.find((u) => u.id === id);
  const user = await prisma.users.findUnique({
    where: { userId: id },
  });
  if (!user) {
    const error = new Error("User Not Found");
    error.status = 400;
    return next(error);
  }
  req.checkUser = user;
  next();
});

export const generateRandomUUID = () => {
  let generatedId;
  do {
    generatedId = crypto.randomUUID().slice(0, 8);
  } while (mockUsers.find((u) => u.id === generatedId));
  return generatedId;
};

export const isAuthenticate = (req, res, next) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: "please login" });
  }
  next();
};
