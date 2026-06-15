import { checkSchema } from "express-validator";
import { mockUsers } from "../mockData/userData.mjs";

const checkEmail = {
  in: ["body"],
  trim: true,
  notEmpty: { errorMessage: "Should not be Empty" },
  matches: {
    options: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
    errorMessage: "please enter validate email",
  },
  custom: {
    options: (value) => {
      const exist = mockUsers.find((u) => u.email === value);
      if (exist) throw new Error("Email is already registered");
      return true;
    },
  },
};

const checkPassword = {
  in: ["body"],
  notEmpty: { errorMessage: "Should not be Empty" },
  isLength: {
    options: { min: 8, max: 120 },
    errorMessage:
      "Password must be at least 8 characters long and at most 120 characters long.",
  },
  matches: {
    options: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*(),.?":{}|<>]).+$/,
    errorMessage:
      "Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character.",
  },
};

const checkPhoneNo = {
  in: ["body"],
  trim: true,

  optional: {
    //empty lai ni ignore hanxha
    options: { checkFalsy: true },
  },
  matches: {
    options: /^(\+?\d{1,4}\-?\d{10}|\d{10}|\d{9})$/,
    errorMessage:
      "Please enter a valid 10-digit mobile number (with or without a country code) or a 9-digit landline number.",
  },

  custom: {
    options: (value) => {
      const exist = mockUsers.find((u) => u.phoneNo === value);
      if (exist) throw new Error("phoneNo is already registered");
      return true;
    },
  },
};

const checkUserName = {
  in: ["body"],
  trim: true,
  notEmpty: {
    errorMessage: "Should not Be empty",
  },
  isLength: {
    options: {
      min: 4,
      max: 120,
    },
    errorMessage:
      "Should be atleast 4 character long or at mmost 120 character long",
  },
};

export const userCreationValidation = checkSchema({
  name: checkUserName,
  email: checkEmail,
  password: checkPassword,
  phoneNo: checkPhoneNo,
});

export const userUpdateValidation = checkSchema({
  name: {
    ...checkUserName,
    optional: true,
  },
  email: {
    ...checkEmail,
    optional: true,
  },
  password: {
    ...checkPassword,
    optional: true,
  },
  phoneNo: { ...checkPhoneNo, optional: true },
});
