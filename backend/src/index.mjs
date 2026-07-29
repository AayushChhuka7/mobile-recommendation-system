// import "dotenv/config";

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import express from "express";
import { router } from "./routes/main.mjs";
import cookieParser from "cookie-parser";
import session from "express-session";
import passport from "passport";
import { errorHandler } from "./middleware/errorHandler.mjs";
import { notFound } from "./utils/ApiError.mjs";
import connectPgSimple from "connect-pg-simple";

import cors from "cors";

const PgStore = connectPgSimple(session);
// The `session` table is owned by Prisma (see schema.prisma → model
// Session). connect-pg-simple must NOT create it at runtime, otherwise
// we re-introduce migration-history drift.
const store = new PgStore({
  conString: process.env.DATABASE_URL,
  createTableIfMissing: false,
});

const PORT = process.env.PORT || 8001;
const cookieSecret = process.env.COOKIE_SECRET;
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  }),
);
app.use(cookieParser());

app.use(
  session({
    store: store,
    secret: cookieSecret,
    saveUninitialized: false,
    resave: false,
    cookie: {
      secure: false,
      maxAge: 1000 * 60 * 3*60,

    },
  }),
);

app.use(passport.initialize());
app.use(passport.session());

app.get("/", (req, res, next) => {
  // Home endpoint intentionally returns plain text — it's the human
  // liveness ping, not part of the JSON API contract.
  return res.send("Home");
});
app.use("/api", router);

app.use((req, res, next) => {
  // Any URL that didn't match a route. Forward to the global error
  // handler so 404s get the standardized envelope.
  return next(notFound(`No route matches ${req.method} ${req.originalUrl}`));
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log("Running at port ", PORT);
});

// app.listen(PORT, "0.0.0.0", () => {
//   console.log("Running at port ", PORT);
// });
